import { createHash } from "node:crypto";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ensureRemoteHerdr } from "./herdr-runtime.js";
import { packageRoot } from "./paths.js";
import type { PortableProfile } from "./profile.js";
import type { RemoteTaskState, ReservedTaskState, TaskState } from "./state.js";
import {
  remoteCommand,
  scpFrom,
  shellQuote,
  ssh,
  sshTerminalArgs,
  sshTerminalFailure,
} from "./remote.js";
import { runInTerminal } from "./terminal.js";
import {
  contentTransferFile,
  localTransferFile,
  packagedTransferFile,
  runTransfer,
  type TransferFile,
} from "./transfer.js";

export type RemoteLifecycleState =
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
  | { kind: "stopped"; error?: string }
  | { kind: "prepared"; error?: string };

export interface RemoteWorkspaceObservation {
  status: RemoteWorkspaceStatus;
  reconciliation: LaunchReconciliation;
  result: PreparedResultObservation;
  attachment: { terminalId: string } | null;
}

interface RemoteWorkspacePaths {
  root: string;
  objects: string;
  control: string;
  repository: string;
  profile: string;
  runner: string;
  companion: string;
  session: string;
  resultBundle: string;
}

interface LaunchRemoteRunOptions {
  task: ReservedTaskState | RemoteTaskState;
  piVersion: string;
  trustMode: "--approve" | "--no-approve";
}

interface NewRemoteWorkspace {
  host: string;
  remoteDir: string;
  remoteAgentDir: string;
  remoteHerdrCommand: string;
  profileHome: string;
  conversationCwd: string;
  available: boolean;
}

interface ResolveNewRemoteWorkspaceOptions {
  host: string;
  repoRoot: string;
  commonGitDir: string;
}

interface ProvisionInitialRemoteWorkspaceOptions {
  task: ReservedTaskState;
  artifacts: {
    handoffBundle: string;
    portableSession: string;
  };
  profile: PortableProfile;
  piVersion: string;
  onProgress: (message: string) => void;
}

interface PrepareRemoteContinuationOptions {
  task: RemoteTaskState;
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
  terminalId: string | null;
  resultBundle: boolean;
  processRunning: boolean;
}

const controlScript = readFileSync(join(packageRoot, "remote", "control.cjs"), "utf8");
const remoteScripts = [
  { name: "prepare-profile.sh", mode: 0o700 },
  { name: "profile.cjs", mode: 0o600 },
  { name: "validate-profile.cjs", mode: 0o600 },
  { name: "validate-authentication.cjs", mode: 0o600 },
  { name: "runner.sh", mode: 0o700 },
  { name: "companion.ts", mode: 0o600 },
] as const;

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
    return control.error ? { kind: "prepared", error: control.error } : { kind: "prepared" };
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
  return control.error ? { kind: "stopped", error: control.error } : { kind: "stopped" };
}

function controlArgs(task: TaskState, command: "observe" | "launch" | "stop" | "delete", ...args: string[]): string[] {
  return [
    "node",
    "-e",
    controlScript,
    command,
    remoteWorkspacePaths(task).control,
    task.remoteHerdrCommand,
    task.herdrSession,
    ...args,
  ];
}

async function deleteRecordedHerdrSession(task: TaskState): Promise<void> {
  await ssh(task.host, remoteCommand(controlArgs(task, "delete")));
}

function workspaceName(repoRoot: string, commonGitDir: string): string {
  const name = basename(repoRoot).replaceAll(/[^A-Za-z0-9_-]/g, "-") || "repository";
  const hash = createHash("sha256").update(commonGitDir).digest("hex").slice(0, 8);
  return `${name}-${hash}`;
}

function remoteWorkspacePaths(task: TaskState): RemoteWorkspacePaths {
  const control = `${task.remoteDir}/control`;
  const root = posix.dirname(posix.dirname(task.remoteDir));
  return {
    root,
    objects: `${root}/profile-objects`,
    control,
    repository: `${task.remoteDir}/repository`,
    profile: `${task.remoteDir}/profile`,
    runner: `${control}/runner.sh`,
    companion: `${control}/companion.ts`,
    session: `${control}/session.jsonl`,
    resultBundle: `${control}/result/result.bundle`,
  };
}

function remotePiCommand(task: TaskState, piVersion: string): string {
  return `${remoteWorkspacePaths(task).root}/runtime/${piVersion}/node_modules/.bin/pi`;
}

export async function resolveNewRemoteWorkspace(
  options: ResolveNewRemoteWorkspaceOptions,
): Promise<NewRemoteWorkspace> {
  const name = workspaceName(options.repoRoot, options.commonGitDir);
  const remoteHerdr = await ensureRemoteHerdr(options.host, name);
  const remoteDir = `${remoteHerdr.home}/.pi-remote-handoff/workspaces/${name}`;
  const profileHome = `${remoteDir}/profile/home`;
  return {
    host: options.host,
    remoteDir,
    remoteAgentDir: `${profileHome}/.pi/agent`,
    remoteHerdrCommand: remoteHerdr.command,
    profileHome,
    conversationCwd: `${remoteDir}/repository`,
    available: remoteHerdr.workspaceAvailable !== false,
  };
}

export function assertRemoteWorkspaceAvailable(workspace: NewRemoteWorkspace): void {
  if (!workspace.available) {
    throw new Error(
      `Remote workspace ${workspace.host}:${workspace.remoteDir} already exists, but this repository has no Remote Handoff task. Remove it on the remote host to start a new handoff.`,
    );
  }
}

export async function refreshRemoteHerdr(task: RemoteTaskState): Promise<RemoteTaskState> {
  const remoteHerdr = await ensureRemoteHerdr(task.host);
  return { ...task, remoteHerdrCommand: remoteHerdr.command };
}

async function remoteScriptFiles(): Promise<TransferFile[]> {
  return Promise.all(remoteScripts.map(({ name, mode }) => packagedTransferFile(name, mode)));
}

function prepareProfileCommand(task: ReservedTaskState | RemoteTaskState, piVersion: string): string {
  const paths = remoteWorkspacePaths(task);
  return `${remoteCommand([
    "bash",
    `${paths.control}/prepare-profile.sh`,
    paths.control,
    paths.profile,
    paths.root,
    piVersion,
  ])} </dev/null`;
}

function transferPrelude(task: ReservedTaskState | RemoteTaskState): string[] {
  const paths = remoteWorkspacePaths(task);
  return [
    "set -euo pipefail",
    "umask 077",
    `mkdir -p -m 700 ${shellQuote(paths.control)} ${shellQuote(paths.objects)}`,
    `chmod 700 ${shellQuote(task.remoteDir)} ${shellQuote(paths.control)}`,
  ];
}

export async function provisionInitialRemoteWorkspace(
  options: ProvisionInitialRemoteWorkspaceOptions,
): Promise<void> {
  const { task } = options;
  const paths = remoteWorkspacePaths(task);
  const repository = shellQuote(paths.repository);
  const files = [
    ...(await remoteScriptFiles()),
    await localTransferFile("handoff.bundle", options.artifacts.handoffBundle),
    await localTransferFile("session.jsonl", options.artifacts.portableSession),
    await localTransferFile("initial-auth.json", join(task.localDir, "auth-base.json")),
    contentTransferFile("profile-manifest.json", options.profile.manifest),
  ];
  await runTransfer({
    host: task.host,
    control: paths.control,
    objectStore: paths.objects,
    prelude: transferPrelude(task),
    epilogue: [
      prepareProfileCommand(task, options.piVersion),
      "printf 'PI_REMOTE_HANDOFF_PROGRESS\\t%s\\n' 'Creating remote repository'",
      "export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_ATTR_NOSYSTEM=1",
      `mkdir -m 700 ${repository}`,
      `git -C ${repository} init -q`,
      `git -C ${repository} fetch -q ${shellQuote(`${paths.control}/handoff.bundle`)} ${shellQuote(`${task.handoffRef}:${task.handoffRef}`)} </dev/null`,
      `git -C ${repository} checkout -q --detach ${shellQuote(task.handoffCommit)}`,
    ],
    files,
    objects: options.profile.objects,
    onProgress: options.onProgress,
  });
}

function parseObservation(
  task: ReservedTaskState | RemoteTaskState,
  output: string,
): RemoteWorkspaceObservation {
  const control = JSON.parse(output) as ControlObservation;
  const launch = reconciliation(control, task.launchId);
  const preparedResult = resultObservation(control, task.launchId);
  const attachment = launch.kind === "matching-live" && control.terminalId !== null
    ? { terminalId: control.terminalId }
    : null;
  return {
    status: workspaceStatus(control, launch, preparedResult),
    reconciliation: launch,
    result: preparedResult,
    attachment,
  };
}

export async function observeRemoteWorkspace(
  task: ReservedTaskState | RemoteTaskState,
): Promise<RemoteWorkspaceObservation> {
  const result = await ssh(task.host, remoteCommand(controlArgs(task, "observe")));
  return parseObservation(task, result.stdout);
}

export async function launchRemoteRun(options: LaunchRemoteRunOptions): Promise<RemoteWorkspaceObservation> {
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
    remotePiCommand(task, options.piVersion),
    task.remoteAgentDir,
    task.remoteHerdrCommand,
    task.herdrSession,
    task.launchId,
    task.handoffRef,
  ];
  const command = remoteCommand([
    "flock",
    "-x",
    `${paths.control}/launch.lock`,
    ...controlArgs(
      task,
      "launch",
      paths.repository,
      `pi-remote-handoff: ${workspaceName(task.repoRoot, task.commonGitDir)}`,
      task.launchId,
      remoteCommand(["exec", ...runnerArgs]),
    ),
  ]);
  const result = await ssh(task.host, command);
  return parseObservation(task, result.stdout);
}

async function attachableTerminal(task: RemoteTaskState): Promise<string> {
  const observation = await observeRemoteWorkspace(task);
  if (
    observation.attachment === null
    || observation.status.kind !== "active"
    || (
      observation.status.state !== "preparing"
      && observation.status.state !== "running"
      && observation.status.state !== "idle"
    )
  ) {
    throw new Error("The recorded remote launch is not ready for attachment.");
  }
  return observation.attachment.terminalId;
}

export async function attachRemoteRun(
  ctx: ExtensionCommandContext,
  task: RemoteTaskState,
): Promise<number | null> {
  const terminalId = await attachableTerminal(task);
  const attach = remoteCommand([
    "exec",
    task.remoteHerdrCommand,
    "--session",
    task.herdrSession,
    "terminal",
    "attach",
    terminalId,
    "--takeover",
  ]);
  const exit = await runInTerminal(ctx, "ssh", sshTerminalArgs(task.host, attach), { pipeStderr: true });
  if (exit.error) throw exit.error;
  const failure = sshTerminalFailure(exit.code, exit.stderr);
  if (failure) throw failure;
  return exit.code;
}

export async function requestGracefulStop(
  task: RemoteTaskState,
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

export async function forceStopRemoteRun(task: RemoteTaskState): Promise<RemoteWorkspaceObservation> {
  await ssh(task.host, remoteCommand(controlArgs(task, "stop")));
  return observeRemoteWorkspace(task);
}

export async function invalidatePreparedResult(task: RemoteTaskState): Promise<void> {
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

export async function prepareRemoteContinuation(
  options: PrepareRemoteContinuationOptions,
): Promise<void> {
  const { task } = options;
  const paths = remoteWorkspacePaths(task);
  await runTransfer({
    host: task.host,
    control: paths.control,
    objectStore: paths.objects,
    prelude: transferPrelude(task),
    epilogue: [prepareProfileCommand(task, options.piVersion)],
    files: [
      ...(await remoteScriptFiles()),
      await localTransferFile("initial-auth.json", join(task.localDir, "auth-base.json")),
    ],
    objects: new Map(),
    onProgress: options.onProgress,
  });
}

export async function downloadPreparedResult(task: RemoteTaskState): Promise<DownloadedPreparedResult> {
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
