import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type {
  ActiveTaskState,
  PreparedTaskState,
  RemoteOwnedTaskState,
  ReservedTaskState,
  StoppedTaskState,
  TaskState,
} from "./state.js";
import {
  attachHerdrTerminal,
  remoteCommand,
  scpFrom,
  scpTo,
  shellQuote,
  ssh,
  sshStreaming,
  type AttachHerdrTerminalOptions,
  type HerdrInstallation,
  type TerminalAttachmentEnd,
} from "./remote.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requiredRemoteCommands = ["bash", "git", "node", "npm", "tar", "flock", "ssh"];
const remoteProgressPrefix = "PI_REMOTE_HANDOFF_PROGRESS\t";

type RemoteLifecycleState =
  | "preparing"
  | "running"
  | "idle"
  | "stopping"
  | "preparing-result"
  | "prepared"
  | "failed";

type LaunchReconciliation =
  | { kind: "not-launched" }
  | { kind: "matching-starting" }
  | { kind: "matching-live" }
  | { kind: "matching-stopped" }
  | { kind: "matching-unacknowledged" }
  | { kind: "conflicting"; recordedLaunchId: string; processRunning: boolean };

type PreparedResultObservation =
  | { kind: "none" }
  | { kind: "prepared" }
  | { kind: "mismatched"; resultLaunchId: string | null };

export type RemoteWorkspaceStatus =
  | { kind: "incomplete"; error?: string }
  | { kind: "active"; state: RemoteLifecycleState }
  | { kind: "stopped"; state: RemoteLifecycleState; error?: string }
  | { kind: "prepared"; state: RemoteLifecycleState; processRunning: boolean; error?: string };

export interface RemoteWorkspaceObservation {
  status: RemoteWorkspaceStatus;
  reconciliation: LaunchReconciliation;
  result: PreparedResultObservation;
  attachment: { paneId: string } | null;
}

interface RemoteWorkspacePaths {
  control: string;
  repository: string;
  profile: string;
  runtime: string;
  runner: string;
  companion: string;
  prepareProfile: string;
  session: string;
  resultBundle: string;
}

interface LaunchRemoteRunOptions {
  task: ReservedTaskState | ActiveTaskState | StoppedTaskState;
  piVersion: string;
  trustMode: "--approve" | "--no-approve";
}

type RemotePiEnvironmentProblem =
  | "profile-missing"
  | "profile-invalid"
  | "authentication-missing"
  | "runtime-missing"
  | "runtime-version";

interface NewRemoteWorkspace {
  host: string;
  remoteDir: string;
  remoteAgentDir: string;
  remotePiCommand: string;
  remoteHerdrCommand: string;
  profileHome: string;
  conversationCwd: string;
}

interface ResolveNewRemoteWorkspaceOptions {
  host: string;
  repoRoot: string;
  commonGitDir: string;
  herdr: HerdrInstallation;
}

interface ProvisionInitialRemoteWorkspaceOptions {
  task: ReservedTaskState;
  artifacts: {
    handoffBundle: string;
    portableSession: string;
    profileArchive: string;
    authenticationBaseline: string;
  };
  piVersion: string;
  onProgress: (message: string) => void;
}

interface PrepareRemoteContinuationOptions {
  task: StoppedTaskState;
  piVersion: string;
  onProgress: (message: string) => void;
}

interface DownloadedPreparedResult {
  bundle: string;
  session: string;
}

interface ControlObservation {
  state: RemoteLifecycleState | null;
  error: string | null;
  launchId: string | null;
  launchStartedId: string | null;
  resultLaunchId: string | null;
  runnerLaunchId: string | null;
  paneId: string | null;
  runnerPid: number | null;
  resultBundle: boolean;
  processRunning: boolean;
}

interface HerdrServerStatus {
  running: boolean;
  version: string | null;
  compatible: boolean | null;
}

interface RemotePreflight {
  home: string;
  remoteHerdrCommand: string;
}

const observeScript = String.raw`
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const control = process.argv[1];
const herdr = process.argv[2];
const session = process.argv[3];

const read = (name) => {
  const path = control + "/" + name;
  try {
    const stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid control file: " + path);
    return fs.readFileSync(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
};
const file = (name) => {
  const path = control + "/" + name;
  try {
    const stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid control file: " + path);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
};
const run = (args) => {
  const result = spawnSync(herdr, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};
const parse = (contents, source) => {
  try { return JSON.parse(contents); }
  catch { throw new Error(source + " returned malformed JSON: " + JSON.stringify(contents)); }
};

const serverResult = run(["--session", session, "status", "server", "--json"]);
if (serverResult.status !== 0) throw new Error(serverResult.stderr || serverResult.stdout);
const server = parse(serverResult.stdout, "Herdr server status");
const pane = read("herdr-pane");
const runnerContents = read("runner");
const runner = runnerContents === null ? null : parse(runnerContents, "Remote runner metadata");
if (runner !== null && (typeof runner.launchId !== "string" || !Number.isSafeInteger(runner.pid) || runner.pid <= 0)) {
  throw new Error("Remote runner metadata is invalid");
}
let processRunning = false;
if (server.running === true && pane !== null && runner !== null) {
  const paneId = pane.trim();
  const processResult = run(["--session", session, "pane", "process-info", "--pane", paneId]);
  const processInfo = parse(processResult.stdout || processResult.stderr, "Herdr pane process lookup");
  if (processResult.status === 0) {
    processRunning = processInfo?.result?.type === "pane_process_info"
      && processInfo.result.process_info?.pane_id === paneId
      && processInfo.result.process_info.shell_pid === runner.pid;
  } else if (processInfo?.error?.code !== "pane_not_found") {
    throw new Error(processResult.stderr || processResult.stdout);
  }
}

process.stdout.write(JSON.stringify({
  state: read("state"),
  error: read("error"),
  launchId: read("launch-id"),
  launchStartedId: read("launch-started-id"),
  resultLaunchId: read("result/result-launch-id"),
  runnerLaunchId: runner === null ? null : runner.launchId,
  paneId: pane,
  runnerPid: runner === null ? null : String(runner.pid),
  resultBundle: file("result/result.bundle"),
  processRunning,
  server,
}));
`;

const launchScript = String.raw`
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const control = process.argv[1];
const herdr = process.argv[2];
const session = process.argv[3];
const repository = process.argv[4];
const label = process.argv[5];
const launchId = process.argv[6];
const expectedHerdrVersion = process.argv[7];
const runnerCommand = process.argv[8];

const path = (name) => control + "/" + name;
const read = (name) => {
  try { return fs.readFileSync(path(name), "utf8").trim(); }
  catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
};
const write = (name, value) => {
  const temporary = path(name + ".tmp." + process.pid);
  fs.writeFileSync(temporary, value + "\n", { mode: 0o600 });
  fs.renameSync(temporary, path(name));
};
const run = (args) => {
  const result = spawnSync(herdr, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "Herdr command failed");
  return result.stdout;
};
const json = (contents, source) => {
  try { return JSON.parse(contents); }
  catch { throw new Error(source + " returned malformed JSON: " + JSON.stringify(contents)); }
};
const serverStatus = () => {
  const value = json(run(["--session", session, "status", "server", "--json"]), "Herdr server status");
  if (value.running === true && (value.version !== expectedHerdrVersion || value.compatible !== true)) {
    throw new Error("Remote Herdr session is running with an incompatible build");
  }
  return value;
};
const runnerMetadata = () => {
  const contents = read("runner");
  if (contents === null) return null;
  const value = json(contents, "Remote runner metadata");
  if (typeof value?.launchId !== "string" || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new Error("Remote runner metadata is invalid");
  }
  return value;
};
const runnerIsLive = () => {
  if (serverStatus().running !== true) return false;
  const paneId = read("herdr-pane");
  const runner = runnerMetadata();
  if (!paneId || runner === null) return false;
  const result = spawnSync(herdr, ["--session", session, "pane", "process-info", "--pane", paneId], { encoding: "utf8" });
  if (result.error) throw result.error;
  const value = json(result.stdout || result.stderr, "Herdr pane process lookup");
  if (result.status !== 0) {
    if (value?.error?.code === "pane_not_found") return false;
    throw new Error(result.stderr || result.stdout);
  }
  return value?.result?.type === "pane_process_info"
    && value.result.process_info?.pane_id === paneId
    && value.result.process_info.shell_pid === runner.pid;
};
const stopAndDeleteSession = () => {
  if (serverStatus().running === true) run(["session", "stop", session, "--json"]);
  run(["session", "delete", session, "--json"]);
};
const wait = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

let recordedLaunchId = read("launch-id");
let launchStartedId = read("launch-started-id");
let runnerLaunchId = runnerMetadata()?.launchId ?? null;
let live = runnerIsLive();
if (recordedLaunchId === launchId && launchStartedId === launchId && runnerLaunchId !== launchId) {
  for (let attempt = 0; attempt < 200; attempt++) {
    wait(50);
    runnerLaunchId = runnerMetadata()?.launchId ?? null;
    if (runnerLaunchId === launchId) {
      live = runnerIsLive();
      break;
    }
  }
  if (runnerLaunchId !== launchId) {
    stopAndDeleteSession();
    write("error", "Remote Pi runner did not acknowledge its launch ID within 10 seconds");
    write("state", "failed");
    process.stdout.write(JSON.stringify({ result: "already-stopped" }));
    process.exit(0);
  }
}
if (recordedLaunchId === launchId && live && runnerLaunchId === launchId) {
  process.stdout.write(JSON.stringify({ result: "already-live" }));
  process.exit(0);
}
if (recordedLaunchId === launchId && !live && (launchStartedId === launchId || runnerLaunchId === launchId || read("result/result-launch-id") === launchId)) {
  process.stdout.write(JSON.stringify({ result: "already-stopped" }));
  process.exit(0);
}
if (recordedLaunchId !== null && recordedLaunchId !== launchId && live) {
  throw new Error("A conflicting Remote Handoff launch is still running: " + recordedLaunchId);
}
if (recordedLaunchId === launchId && live) {
  throw new Error("The matching remote runner is live but did not acknowledge its launch ID");
}
if (fs.existsSync(path("result"))) {
  throw new Error("Invalidate the prepared result before starting another remote run");
}

process.on("uncaughtException", (error) => {
  try {
    write("error", error instanceof Error ? error.message : String(error));
    write("state", "failed");
  } catch {}
  console.error(error);
  process.exit(1);
});
stopAndDeleteSession();
for (const name of ["runner", "launch-started-id", "herdr-pane", "stop-request", "error", "pi.log"]) {
  fs.rmSync(path(name), { force: true });
}
for (const name of fs.readdirSync(control)) {
  if (name.startsWith("result.tmp.")) fs.rmSync(path(name), { recursive: true, force: true });
}
write("launch-id", launchId);
write("state", "preparing");

const server = spawn(herdr, ["--session", session, "server"], { detached: true, stdio: "ignore" });
server.unref();
for (let attempt = 0; attempt < 40 && serverStatus().running !== true; attempt++) wait(250);
if (serverStatus().running !== true) throw new Error("Remote Herdr session did not start within 10 seconds");

const workspace = json(run([
  "--session", session, "workspace", "create", "--cwd", repository, "--label", label, "--no-focus",
]), "Herdr workspace creation");
const paneId = workspace?.result?.root_pane?.pane_id;
if (typeof paneId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(paneId)) {
  throw new Error("Herdr workspace creation returned invalid pane metadata");
}
write("herdr-pane", paneId);
write("launch-started-id", launchId);
run(["--session", session, "pane", "run", paneId, runnerCommand]);
for (let attempt = 0; attempt < 200; attempt++) {
  if (runnerMetadata()?.launchId === launchId) {
    process.stdout.write(JSON.stringify({ result: "launched" }));
    process.exit(0);
  }
  wait(50);
}
stopAndDeleteSession();
throw new Error("Remote Pi runner did not acknowledge its launch ID within 10 seconds");
`;

const credentialValidationScript = String.raw`
const validCredential = (credential) => {
  if (credential === null || typeof credential !== "object" || Array.isArray(credential)) return false;
  if (credential.type === "api_key") {
    if (Object.hasOwn(credential, "key") && typeof credential.key !== "string") return false;
    if (!Object.hasOwn(credential, "env")) return true;
    return credential.env !== null
      && typeof credential.env === "object"
      && !Array.isArray(credential.env)
      && Object.values(credential.env).every((entry) => typeof entry === "string");
  }
  return credential.type === "oauth"
    && typeof credential.access === "string"
    && typeof credential.refresh === "string"
    && typeof credential.expires === "number"
    && Number.isFinite(credential.expires);
};
const validAuthentication = (authentication) => authentication !== null
  && typeof authentication === "object"
  && !Array.isArray(authentication)
  && Object.values(authentication).every(validCredential);
`;

const validateRemoteProfileScript = String.raw`
const fs = require("node:fs");
const path = require("node:path");
${credentialValidationScript}
try {
  const profile = process.argv[1];
  const home = path.join(profile, "home");
  const agent = path.join(home, ".pi", "agent");
  const regularJson = (target) => {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) process.exit(1);
    const value = JSON.parse(fs.readFileSync(target, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) process.exit(1);
    return value;
  };
  const manifest = regularJson(path.join(profile, "profile.json"));
  regularJson(path.join(agent, "settings.json"));
  const authentication = regularJson(path.join(agent, "auth.json"));
  if (!validAuthentication(authentication)) process.exit(1);
  if (manifest.version !== 1 || !Array.isArray(manifest.packageDirectories)) process.exit(1);
  for (const entry of manifest.packageDirectories) {
    if (typeof entry !== "string") process.exit(1);
    const target = path.resolve(home, entry);
    if ((target !== home && !target.startsWith(home + path.sep)) || !fs.statSync(target).isDirectory()) process.exit(1);
  }
} catch {
  process.exit(1);
}
`;

const validateRemoteAuthenticationScript = String.raw`
const fs = require("node:fs");
${credentialValidationScript}
try {
  const target = process.argv[1];
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) process.exit(1);
  const authentication = JSON.parse(fs.readFileSync(target, "utf8"));
  if (!validAuthentication(authentication)) process.exit(1);
} catch {
  process.exit(1);
}
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(contents: string, source: string): unknown {
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(`${source} returned malformed JSON: ${JSON.stringify(contents)}`);
  }
}

function trimmedString(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`Remote observation has an invalid ${name} field.`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Remote observation has an empty ${name} field.`);
  return trimmed;
}

function parseLifecycleState(value: unknown): RemoteLifecycleState | null {
  const state = trimmedString(value, "state");
  switch (state) {
    case null:
    case "preparing":
    case "running":
    case "idle":
    case "stopping":
    case "preparing-result":
    case "prepared":
    case "failed":
      return state;
    default:
      throw new Error(`Remote observation has an invalid lifecycle state: ${JSON.stringify(state)}`);
  }
}

function parsePaneId(value: unknown): string | null {
  const paneId = trimmedString(value, "paneId");
  if (paneId !== null && !/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(paneId)) {
    throw new Error(`Remote Herdr pane metadata is malformed: ${JSON.stringify(paneId)}`);
  }
  return paneId;
}

function parseRunnerPid(value: unknown): number | null {
  const pid = trimmedString(value, "runnerPid");
  if (pid === null) return null;
  if (!/^[1-9]\d*$/.test(pid)) throw new Error(`Remote runner PID is malformed: ${JSON.stringify(pid)}`);
  const parsed = Number(pid);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Remote runner PID is malformed: ${JSON.stringify(pid)}`);
  return parsed;
}

function parseServerStatus(value: unknown, task: TaskState): HerdrServerStatus {
  if (
    !isRecord(value)
    || typeof value.running !== "boolean"
    || (typeof value.version !== "string" && value.version !== null)
    || (typeof value.compatible !== "boolean" && value.compatible !== null)
    || value.status !== (value.running ? "running" : "not_running")
  ) {
    throw new Error(`Remote Herdr status has an invalid shape: ${JSON.stringify(value)}`);
  }
  if (value.running && (value.version !== task.herdrVersion || value.compatible !== true)) {
    throw new Error(
      `Remote Herdr session ${JSON.stringify(task.herdrSession)} uses ${JSON.stringify(value.version)}; expected ${task.herdrVersion}.`,
    );
  }
  return { running: value.running, version: value.version, compatible: value.compatible };
}

function parseControlObservation(
  contents: string,
  task: ReservedTaskState | RemoteOwnedTaskState,
): ControlObservation {
  const value = parseJson(contents, "Remote workspace observation");
  if (!isRecord(value) || typeof value.resultBundle !== "boolean" || typeof value.processRunning !== "boolean") {
    throw new Error(`Remote workspace observation has an invalid shape: ${JSON.stringify(value)}`);
  }
  const server = parseServerStatus(value.server, task);
  if (value.processRunning && !server.running) {
    throw new Error("Remote observation reports a live runner without a live Herdr session.");
  }
  return {
    state: parseLifecycleState(value.state),
    error: trimmedString(value.error, "error"),
    launchId: trimmedString(value.launchId, "launchId"),
    launchStartedId: trimmedString(value.launchStartedId, "launchStartedId"),
    resultLaunchId: trimmedString(value.resultLaunchId, "resultLaunchId"),
    runnerLaunchId: trimmedString(value.runnerLaunchId, "runnerLaunchId"),
    paneId: parsePaneId(value.paneId),
    runnerPid: parseRunnerPid(value.runnerPid),
    resultBundle: value.resultBundle,
    processRunning: value.processRunning,
  };
}

function reconciliation(control: ControlObservation, launchId: string): LaunchReconciliation {
  if (control.launchId === null) return { kind: "not-launched" };
  if (control.launchId !== launchId) {
    return {
      kind: "conflicting",
      recordedLaunchId: control.launchId,
      processRunning: control.processRunning,
    };
  }
  if (control.processRunning && control.runnerLaunchId === launchId) return { kind: "matching-live" };
  if (control.processRunning) {
    return {
      kind: "conflicting",
      recordedLaunchId: control.runnerLaunchId ?? control.launchId,
      processRunning: true,
    };
  }
  if (
    control.launchStartedId === launchId
    && control.runnerLaunchId === null
    && control.state === "preparing"
  ) {
    return { kind: "matching-starting" };
  }
  if (
    control.launchStartedId === launchId
    || control.runnerLaunchId === launchId
    || control.resultLaunchId === launchId
  ) {
    return { kind: "matching-stopped" };
  }
  return { kind: "matching-unacknowledged" };
}

function resultObservation(control: ControlObservation, launchId: string): PreparedResultObservation {
  if (!control.resultBundle && control.resultLaunchId === null) return { kind: "none" };
  if (control.resultBundle && control.resultLaunchId === launchId) return { kind: "prepared" };
  return { kind: "mismatched", resultLaunchId: control.resultLaunchId };
}

function workspaceStatus(
  control: ControlObservation,
  launch: LaunchReconciliation,
  result: PreparedResultObservation,
): RemoteWorkspaceStatus {
  if (result.kind === "prepared") {
    if (control.state === null) throw new Error("A prepared remote result has no lifecycle state.");
    return control.error
      ? { kind: "prepared", state: control.state, processRunning: control.processRunning, error: control.error }
      : { kind: "prepared", state: control.state, processRunning: control.processRunning };
  }
  if (launch.kind === "conflicting") {
    return { kind: "incomplete", error: `Remote workspace belongs to launch ${launch.recordedLaunchId}.` };
  }
  if (launch.kind === "matching-starting") return { kind: "active", state: "preparing" };
  if (control.processRunning) {
    if (control.state === null) throw new Error("A live remote runner has no lifecycle state.");
    return { kind: "active", state: control.state };
  }
  if (control.state === null) {
    return control.error ? { kind: "incomplete", error: control.error } : { kind: "incomplete" };
  }
  if (result.kind === "mismatched" && control.state === "prepared") {
    return { kind: "incomplete", error: "Remote result does not belong to this launch." };
  }
  return control.error
    ? { kind: "stopped", state: control.state, error: control.error }
    : { kind: "stopped", state: control.state };
}

function validateLaunchResult(contents: string): void {
  const value = parseJson(contents, "Remote launch");
  if (!isRecord(value)) throw new Error(`Remote launch returned an invalid response: ${JSON.stringify(value)}`);
  switch (value.result) {
    case "launched":
    case "already-live":
    case "already-stopped":
      return;
    default:
      throw new Error(`Remote launch returned an invalid response: ${JSON.stringify(value)}`);
  }
}

function validateHerdrMutation(contents: string, task: TaskState, operation: "stopped" | "deleted"): void {
  const value = parseJson(contents, `Herdr session ${operation}`);
  if (
    !isRecord(value)
    || value[operation] !== true
    || !isRecord(value.session)
    || value.session.name !== task.herdrSession
    || value.session.default !== false
    || value.session.running !== false
  ) {
    throw new Error(`Herdr session ${operation} response has an invalid shape: ${JSON.stringify(value)}`);
  }
}

async function herdrServerStatus(task: TaskState): Promise<HerdrServerStatus> {
  const result = await ssh(
    task.host,
    remoteCommand([
      task.remoteHerdrCommand,
      "--session",
      task.herdrSession,
      "status",
      "server",
      "--json",
    ]),
  );
  return parseServerStatus(parseJson(result.stdout, "Herdr server status"), task);
}

async function stopRecordedHerdrSession(task: TaskState): Promise<void> {
  const status = await herdrServerStatus(task);
  if (!status.running) return;
  const result = await ssh(
    task.host,
    remoteCommand([task.remoteHerdrCommand, "session", "stop", task.herdrSession, "--json"]),
  );
  validateHerdrMutation(result.stdout, task, "stopped");
}

async function deleteRecordedHerdrSession(task: TaskState): Promise<void> {
  await stopRecordedHerdrSession(task);
  const result = await ssh(
    task.host,
    remoteCommand([task.remoteHerdrCommand, "session", "delete", task.herdrSession, "--json"]),
  );
  validateHerdrMutation(result.stdout, task, "deleted");
}

function workspaceName(repoRoot: string, commonGitDir: string): string {
  const name = basename(repoRoot).replaceAll(/[^A-Za-z0-9_-]/g, "-") || "repository";
  const hash = createHash("sha256").update(commonGitDir).digest("hex").slice(0, 8);
  return `${name}-${hash}`;
}

function remoteWorkspacePaths(task: TaskState): RemoteWorkspacePaths {
  const control = `${task.remoteDir}/control`;
  return {
    control,
    repository: `${task.remoteDir}/repository`,
    profile: `${task.remoteDir}/profile`,
    runtime: `${posix.dirname(posix.dirname(task.remoteDir))}/runtime`,
    runner: `${control}/runner.sh`,
    companion: `${control}/companion.ts`,
    prepareProfile: `${control}/prepare-profile.sh`,
    session: `${control}/session.jsonl`,
    resultBundle: `${control}/result/result.bundle`,
  };
}

async function preflightRemoteHost(host: string, expectedHerdrOutput: string): Promise<RemotePreflight> {
  const result = await ssh(
    host,
    [
      "set -eu",
      `for command in ${requiredRemoteCommands.join(" ")}; do`,
      "  if ! command -v \"$command\" >/dev/null; then",
      "    printf 'Missing remote command: %s\\n' \"$command\" >&2",
      "    exit 1",
      "  fi",
      "done",
      "path_herdr=$(command -v herdr || true)",
      "direct_herdr=$HOME/.local/bin/herdr",
      "herdr_command=",
      "for candidate in \"$path_herdr\" \"$direct_herdr\"; do",
      "  case \"$candidate\" in /*) ;; *) continue ;; esac",
      `  if test -x "$candidate" && test "$("$candidate" --version 2>/dev/null)" = ${shellQuote(expectedHerdrOutput)}; then`,
      "    herdr_command=$candidate",
      "    break",
      "  fi",
      "done",
      "if test -z \"$herdr_command\"; then",
      `  printf '%s\\n' ${shellQuote(`Remote Herdr does not match ${expectedHerdrOutput}. Install the exact build on PATH or at $HOME/.local/bin/herdr.`)} >&2`,
      "  exit 1",
      "fi",
      "node_version=$(node -p 'process.versions.node')",
      "node -e 'const [major, minor] = process.versions.node.split(\".\").map(Number); if (major < 22 || (major === 22 && minor < 19)) process.exit(1)' || {",
      "  printf 'Remote Node.js 22.19.0 or newer is required; found %s.\\n' \"$node_version\" >&2",
      "  exit 1",
      "}",
      "printf '%s\\n%s\\n' \"$HOME\" \"$herdr_command\"",
    ].join("\n"),
  );
  const [home, remoteHerdrCommand, ...extra] = result.stdout.trimEnd().split("\n");
  if (
    extra.length !== 0
    || !home?.startsWith("/")
    || !remoteHerdrCommand?.startsWith("/")
  ) {
    throw new Error(`The remote host returned invalid preflight metadata: ${JSON.stringify(result.stdout)}`);
  }
  return { home, remoteHerdrCommand };
}

export async function resolveNewRemoteWorkspace(
  options: ResolveNewRemoteWorkspaceOptions,
): Promise<NewRemoteWorkspace> {
  const preflight = await preflightRemoteHost(options.host, options.herdr.output);
  const remoteDir = `${preflight.home}/.pi-remote-handoff/workspaces/${workspaceName(options.repoRoot, options.commonGitDir)}`;
  const profileHome = `${remoteDir}/profile/home`;
  return {
    host: options.host,
    remoteDir,
    remoteAgentDir: `${profileHome}/.pi/agent`,
    remotePiCommand: `${preflight.home}/.pi-remote-handoff/runtime/node_modules/.bin/pi`,
    remoteHerdrCommand: preflight.remoteHerdrCommand,
    profileHome,
    conversationCwd: `${remoteDir}/repository`,
  };
}

export async function assertRemoteWorkspaceAvailable(
  workspace: NewRemoteWorkspace,
): Promise<void> {
  await ssh(workspace.host, `test ! -e ${shellQuote(workspace.remoteDir)}`);
}

export async function refreshStoppedRemoteWorkspace(
  task: StoppedTaskState,
  herdr: HerdrInstallation,
): Promise<StoppedTaskState> {
  const preflight = await preflightRemoteHost(task.host, herdr.output);
  return {
    ...task,
    remoteHerdrCommand: preflight.remoteHerdrCommand,
    herdrVersion: herdr.version,
    remotePiCommand: `${preflight.home}/.pi-remote-handoff/runtime/node_modules/.bin/pi`,
  };
}

export async function provisionInitialRemoteWorkspace(
  options: ProvisionInitialRemoteWorkspaceOptions,
): Promise<void> {
  const { task } = options;
  const paths = remoteWorkspacePaths(task);
  const prepareProfile = join(packageRoot, "remote", "prepare-profile.sh");

  options.onProgress("Creating private remote workspace...");
  await ssh(
    task.host,
    `umask 077 && mkdir -p -m 700 ${shellQuote(paths.control)} && chmod 700 ${shellQuote(task.remoteDir)} ${shellQuote(paths.control)}`,
  );
  await scpTo(task.host, options.artifacts.handoffBundle, `${paths.control}/handoff.bundle`);
  await scpTo(task.host, options.artifacts.portableSession, paths.session);
  await scpTo(task.host, options.artifacts.profileArchive, `${paths.control}/profile.tar.gz`);
  await scpTo(task.host, options.artifacts.authenticationBaseline, `${paths.control}/initial-auth.json`);
  await scpTo(task.host, prepareProfile, paths.prepareProfile);
  await ssh(
    task.host,
    [
      `chmod 600 ${shellQuote(`${paths.control}/handoff.bundle`)} ${shellQuote(paths.session)} ${shellQuote(`${paths.control}/profile.tar.gz`)} ${shellQuote(`${paths.control}/initial-auth.json`)}`,
      `chmod 700 ${shellQuote(paths.prepareProfile)}`,
    ].join(" && "),
  );

  options.onProgress(`Preparing remote profile and shared Pi ${options.piVersion}...`);
  await sshStreaming(
    task.host,
    remoteCommand([
      paths.prepareProfile,
      `${paths.control}/profile.tar.gz`,
      paths.profile,
      paths.runtime,
      options.piVersion,
      "both",
      "initial",
    ]),
    (line) => {
      if (line.startsWith(remoteProgressPrefix)) {
        options.onProgress(line.slice(remoteProgressPrefix.length));
      }
    },
  );

  options.onProgress("Creating remote repository...");
  await ssh(
    task.host,
    [
      "export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_ATTR_NOSYSTEM=1",
      `umask 077 && mkdir -m 700 ${shellQuote(paths.repository)}`,
      `git -C ${shellQuote(paths.repository)} init -q`,
      `git -C ${shellQuote(paths.repository)} fetch -q ${shellQuote(`${paths.control}/handoff.bundle`)} ${shellQuote(`${task.handoffRef}:${task.handoffRef}`)}`,
      `git -C ${shellQuote(paths.repository)} checkout -q --detach ${shellQuote(task.handoffCommit)}`,
    ].join(" && "),
  );

  await uploadRemoteRunFiles(task);
}

export async function observeRemoteWorkspace(
  task: ReservedTaskState | RemoteOwnedTaskState,
): Promise<RemoteWorkspaceObservation> {
  const paths = remoteWorkspacePaths(task);
  const result = await ssh(
    task.host,
    remoteCommand(["node", "-e", observeScript, paths.control, task.remoteHerdrCommand, task.herdrSession]),
  );
  const control = parseControlObservation(result.stdout, task);
  const launch = reconciliation(control, task.launchId);
  const preparedResult = resultObservation(control, task.launchId);
  const attachment = launch.kind === "matching-live" && control.paneId !== null
    ? { paneId: control.paneId }
    : null;
  return {
    status: workspaceStatus(control, launch, preparedResult),
    reconciliation: launch,
    result: preparedResult,
    attachment,
  };
}

export async function launchRemoteRun(options: LaunchRemoteRunOptions): Promise<void> {
  const { task } = options;
  const paths = remoteWorkspacePaths(task);
  const runnerArgs = [
    "env",
    "GIT_CONFIG_GLOBAL=/dev/null",
    "GIT_CONFIG_NOSYSTEM=1",
    "GIT_ATTR_NOSYSTEM=1",
    paths.runner,
    paths.control,
    paths.repository,
    paths.session,
    paths.companion,
    task.resultRef,
    options.trustMode,
    task.remotePiCommand,
    task.remoteAgentDir,
    options.piVersion,
    task.remoteHerdrCommand,
    task.herdrSession,
    `${paths.control}/herdr-pane`,
    task.herdrVersion,
    task.launchId,
  ];
  const command = remoteCommand([
    "flock",
    "-x",
    `${paths.control}/launch.lock`,
    "node",
    "-e",
    launchScript,
    paths.control,
    task.remoteHerdrCommand,
    task.herdrSession,
    paths.repository,
    `pi-remote-handoff: ${workspaceName(task.repoRoot, task.commonGitDir)}`,
    task.launchId,
    task.herdrVersion,
    remoteCommand(["exec", ...runnerArgs]),
  ]);
  validateLaunchResult((await ssh(task.host, command)).stdout);
}

async function attachmentMetadata(task: ActiveTaskState): Promise<AttachHerdrTerminalOptions> {
  const observation = await observeRemoteWorkspace(task);
  if (
    observation.reconciliation.kind !== "matching-live"
    || observation.attachment === null
    || observation.status.kind !== "active"
    || (
      observation.status.state !== "preparing"
      && observation.status.state !== "running"
      && observation.status.state !== "idle"
    )
  ) {
    throw new Error("The recorded remote launch is not ready for attachment.");
  }
  return {
    host: task.host,
    remoteHerdrCommand: task.remoteHerdrCommand,
    herdrSession: task.herdrSession,
    paneId: observation.attachment.paneId,
    controlDirectory: remoteWorkspacePaths(task).control,
  };
}

export async function attachRemoteRun(task: ActiveTaskState): Promise<TerminalAttachmentEnd> {
  return attachHerdrTerminal(await attachmentMetadata(task));
}

export async function requestGracefulStop(
  task: ActiveTaskState,
  timeoutMs: number,
): Promise<RemoteWorkspaceObservation> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Remote stop timeout must be positive.");
  const before = await observeRemoteWorkspace(task);
  if (before.reconciliation.kind !== "matching-live") {
    throw new Error("The recorded remote launch is not live.");
  }
  const control = remoteWorkspacePaths(task).control;
  await ssh(
    task.host,
    [
      "umask 077",
      `temporary=${shellQuote(`${control}/stop-request.tmp.$$`)}`,
      "printf 'stop\\n' > \"$temporary\"",
      `mv -f "$temporary" ${shellQuote(`${control}/stop-request`)}`,
    ].join(" && "),
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(250);
    const observation = await observeRemoteWorkspace(task);
    if (observation.status.kind !== "active") return observation;
  }
  return observeRemoteWorkspace(task);
}

export async function forceStopRemoteRun(task: ActiveTaskState): Promise<RemoteWorkspaceObservation> {
  await stopRecordedHerdrSession(task);
  return observeRemoteWorkspace(task);
}

export async function invalidatePreparedResult(task: PreparedTaskState): Promise<void> {
  const control = remoteWorkspacePaths(task).control;
  const script = [
    "set -eu",
    `recorded=$(cat ${shellQuote(`${control}/result/result-launch-id`)})`,
    `test "$recorded" = ${shellQuote(task.launchId)}`,
    `rm -r -- ${shellQuote(`${control}/result`)}`,
  ].join("\n");
  await ssh(
    task.host,
    remoteCommand(["flock", "-x", `${control}/launch.lock`, "bash", "-c", script]),
  );
}

export async function settleUnstartedReservation(
  task: ReservedTaskState,
  removeWorkspace: boolean,
): Promise<boolean> {
  const control = remoteWorkspacePaths(task).control;
  const script = [
    "set -eu",
    `control=${shellQuote(control)}`,
    `remote_dir=${shellQuote(task.remoteDir)}`,
    `launch_id=${shellQuote(task.launchId)}`,
    "recorded=$(cat \"$control/launch-id\" 2>/dev/null || true)",
    "if test -n \"$recorded\" && test \"$recorded\" != \"$launch_id\"; then printf 'started'; exit 0; fi",
    "if test -e \"$control/launch-started-id\" || test -e \"$control/runner\" || test -e \"$control/result\"; then printf 'started'; exit 0; fi",
    removeWorkspace ? "rm -rf -- \"$remote_dir\"" : ":",
    "printf 'unstarted'",
  ].join("\n");
  const result = await ssh(
    task.host,
    [
      `if test -d ${shellQuote(control)}; then`,
      `  ${remoteCommand(["flock", "-x", `${control}/launch.lock`, "bash", "-c", script])}`,
      "else",
      removeWorkspace ? `  rm -rf -- ${shellQuote(task.remoteDir)}` : "  :",
      "  printf 'unstarted'",
      "fi",
    ].join("\n"),
  );
  if (result.stdout === "unstarted") return true;
  if (result.stdout === "started") return false;
  throw new Error(`Remote reservation settlement returned an invalid response: ${JSON.stringify(result.stdout)}`);
}

async function remotePiEnvironmentProblems(
  task: StoppedTaskState,
  piVersion: string,
): Promise<RemotePiEnvironmentProblem[]> {
  const paths = remoteWorkspacePaths(task);
  const validateProfile = remoteCommand(["node", "-e", validateRemoteProfileScript, paths.profile]);
  const validateAuthentication = remoteCommand([
    "node",
    "-e",
    validateRemoteAuthenticationScript,
    `${task.remoteAgentDir}/auth.json`,
  ]);
  const result = await ssh(
    task.host,
    [
      `if ! test -d ${shellQuote(task.remoteAgentDir)} || ! test -f ${shellQuote(`${task.remoteAgentDir}/settings.json`)} || ! test -f ${shellQuote(`${paths.profile}/profile.json`)}; then printf 'profile-missing\\n'; elif ${validateProfile}; then :; else printf 'profile-invalid\\n'; fi`,
      `if ${validateAuthentication}; then :; else printf 'authentication-missing\\n'; fi`,
      `if ! test -x ${shellQuote(task.remotePiCommand)}; then printf 'runtime-missing\\n'; elif test "$(${shellQuote(task.remotePiCommand)} --version 2>/dev/null)" != ${shellQuote(piVersion)}; then printf 'runtime-version\\n'; fi`,
    ].join("\n"),
  );
  if (!result.stdout.trim()) return [];
  const problems: RemotePiEnvironmentProblem[] = [];
  for (const value of result.stdout.trim().split("\n")) {
    switch (value) {
      case "profile-missing":
      case "profile-invalid":
      case "authentication-missing":
      case "runtime-missing":
      case "runtime-version":
        problems.push(value);
        break;
      default:
        throw new Error(`Remote Pi environment check returned an invalid value: ${JSON.stringify(value)}`);
    }
  }
  return problems;
}

async function repairRemoteEnvironment(
  task: StoppedTaskState,
  piVersion: string,
  problems: readonly RemotePiEnvironmentProblem[],
  onProgress: (message: string) => void,
): Promise<void> {
  if (problems.length === 0) return;
  const paths = remoteWorkspacePaths(task);
  const profile = problems.some(
    (problem) => problem.startsWith("profile-") || problem === "authentication-missing",
  );
  const runtime = problems.some((problem) => problem.startsWith("runtime-"));
  const mode = profile && runtime ? "both" : profile ? "profile" : "runtime";
  const authenticationMode = problems.includes("authentication-missing") ? "initial" : "preserve";
  await scpTo(task.host, join(packageRoot, "remote", "prepare-profile.sh"), paths.prepareProfile);
  if (authenticationMode === "initial") {
    await scpTo(
      task.host,
      join(task.localDir, "auth-base.json"),
      `${paths.control}/initial-auth.json`,
    );
  }
  await sshStreaming(
    task.host,
    [
      profile
        ? `test -f ${shellQuote(`${paths.control}/profile.tar.gz`)} || { printf 'The uploaded profile archive is missing.\\n' >&2; exit 1; }`
        : ":",
      `chmod 700 ${shellQuote(paths.prepareProfile)}`,
      remoteCommand([
        paths.prepareProfile,
        `${paths.control}/profile.tar.gz`,
        paths.profile,
        paths.runtime,
        piVersion,
        mode,
        authenticationMode,
      ]),
    ].join(" && "),
    (line) => {
      if (line.startsWith(remoteProgressPrefix)) onProgress(line.slice(remoteProgressPrefix.length));
    },
  );
}

async function uploadRemoteRunFiles(
  task: ReservedTaskState | RemoteOwnedTaskState,
): Promise<void> {
  const paths = remoteWorkspacePaths(task);
  await scpTo(task.host, join(packageRoot, "remote", "runner.sh"), paths.runner);
  await scpTo(task.host, join(packageRoot, "remote", "companion.ts"), paths.companion);
  await ssh(
    task.host,
    `chmod 700 ${shellQuote(paths.runner)} && chmod 600 ${shellQuote(paths.companion)} ${shellQuote(paths.session)}`,
  );
}

export async function prepareRemoteContinuation(
  options: PrepareRemoteContinuationOptions,
): Promise<void> {
  const problems = await remotePiEnvironmentProblems(options.task, options.piVersion);
  await repairRemoteEnvironment(
    options.task,
    options.piVersion,
    problems,
    options.onProgress,
  );
  await uploadRemoteRunFiles(options.task);
}

export async function downloadPreparedResult(task: PreparedTaskState): Promise<DownloadedPreparedResult> {
  const observation = await observeRemoteWorkspace(task);
  if (observation.result.kind !== "prepared") {
    throw new Error("The remote result does not belong to the recorded launch.");
  }
  await mkdir(task.localDir, { recursive: true });
  const bundle = join(task.localDir, "result.bundle");
  const session = join(task.localDir, "remote-session.jsonl");
  const paths = remoteWorkspacePaths(task);
  await scpFrom(task.host, paths.resultBundle, bundle);
  await scpFrom(task.host, paths.session, session);
  return { bundle, session };
}

export async function cleanupRemoteWorkspace(task: TaskState): Promise<void> {
  await deleteRecordedHerdrSession(task);
  await ssh(
    task.host,
    `if test -e ${shellQuote(task.remoteDir)}; then rm -r -- ${shellQuote(task.remoteDir)}; fi`,
  );
}
