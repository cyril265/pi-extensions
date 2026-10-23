const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");

const [command, control, herdr, session, ...rest] = process.argv.slice(1);

const path = (name) => `${control}/${name}`;
const read = (name) => {
  try {
    return fs.readFileSync(path(name), "utf8").trim();
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
};
const write = (name, value) => {
  const temporary = path(`${name}.tmp.${process.pid}`);
  fs.writeFileSync(temporary, `${value}\n`, { mode: 0o600 });
  fs.renameSync(temporary, path(name));
};
const wait = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

const herdrJson = (args) => {
  const result = spawnSync(herdr, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  const output = (result.stdout || result.stderr).trim();
  if (result.status === 0) return output ? JSON.parse(output) : null;
  let value;
  try {
    value = JSON.parse(output);
  } catch {}
  if (value?.error?.code === "pane_not_found") return null;
  throw new Error(`herdr ${args.join(" ")} failed: ${output}`);
};
const serverRunning = () => herdrJson(["--session", session, "status", "server", "--json"]).running === true;
const compatibleServerRunning = () => {
  const status = herdrJson(["--session", session, "status", "server", "--json"]);
  if (status.running && status.compatible !== true) {
    throw new Error(`Remote Herdr session ${session} runs an incompatible server ${status.version}`);
  }
  return status.running === true;
};
const stopSession = () => {
  if (serverRunning()) herdrJson(["session", "stop", session, "--json"]);
};
const deleteSession = () => {
  stopSession();
  herdrJson(["session", "delete", session, "--json"]);
};
const runner = () => {
  const contents = read("runner");
  return contents === null ? null : JSON.parse(contents);
};
const liveTerminal = () => {
  const pane = read("herdr-pane");
  const currentRunner = runner();
  if (pane === null || currentRunner === null || !compatibleServerRunning()) return null;
  const processInfo = herdrJson(["--session", session, "pane", "process-info", "--pane", pane]);
  if (
    processInfo === null
    || processInfo.result.process_info.pane_id !== pane
    || processInfo.result.process_info.shell_pid !== currentRunner.pid
  ) {
    return null;
  }
  const paneInfo = herdrJson(["--session", session, "pane", "get", pane]);
  return paneInfo === null ? null : paneInfo.result.pane.terminal_id;
};

function observe() {
  const terminalId = liveTerminal();
  process.stdout.write(JSON.stringify({
    state: read("state"),
    error: read("error"),
    launchId: read("launch-id"),
    launchStartedId: read("launch-started-id"),
    resultLaunchId: read("result/result-launch-id"),
    runnerLaunchId: runner()?.launchId ?? null,
    terminalId,
    resultBundle: fs.existsSync(path("result/result.bundle")),
    processRunning: terminalId !== null,
  }));
}

function launch() {
  const [repository, label, launchId, runnerCommand] = rest;
  const recordedLaunchId = read("launch-id");
  const launchStartedId = read("launch-started-id");
  let runnerLaunchId = runner()?.launchId ?? null;
  let live = liveTerminal() !== null;
  if (recordedLaunchId === launchId && launchStartedId === launchId && runnerLaunchId !== launchId) {
    for (let attempt = 0; attempt < 200; attempt++) {
      wait(50);
      runnerLaunchId = runner()?.launchId ?? null;
      if (runnerLaunchId === launchId) {
        live = liveTerminal() !== null;
        break;
      }
    }
    if (runnerLaunchId !== launchId) {
      deleteSession();
      write("error", "Remote Pi runner did not acknowledge its launch ID within 10 seconds");
      write("state", "failed");
      return;
    }
  }
  if (recordedLaunchId === launchId && live && runnerLaunchId === launchId) return;
  if (
    recordedLaunchId === launchId
    && !live
    && (launchStartedId === launchId || runnerLaunchId === launchId || read("result/result-launch-id") === launchId)
  ) {
    return;
  }
  if (recordedLaunchId !== null && recordedLaunchId !== launchId && live) {
    throw new Error(`A conflicting Remote Handoff launch is still running: ${recordedLaunchId}`);
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
  deleteSession();
  for (const name of ["runner", "launch-started-id", "herdr-pane", "stop-request", "error", "pi.log"]) {
    fs.rmSync(path(name), { force: true });
  }
  for (const name of fs.readdirSync(control)) {
    if (name.startsWith("result.tmp.")) fs.rmSync(path(name), { recursive: true, force: true });
  }
  write("launch-id", launchId);
  write("state", "preparing");

  spawn(herdr, ["--session", session, "server"], { detached: true, stdio: "ignore" }).unref();
  for (let attempt = 0; attempt < 200 && !compatibleServerRunning(); attempt++) wait(50);
  if (!compatibleServerRunning()) throw new Error("Remote Herdr session did not start within 10 seconds");

  const workspace = herdrJson([
    "--session", session, "workspace", "create", "--cwd", repository, "--label", label, "--no-focus",
  ]);
  const paneId = workspace.result.root_pane.pane_id;
  write("herdr-pane", paneId);
  write("launch-started-id", launchId);
  herdrJson(["--session", session, "pane", "run", paneId, runnerCommand]);
  for (let attempt = 0; attempt < 200; attempt++) {
    if (runner()?.launchId === launchId) return;
    wait(50);
  }
  deleteSession();
  throw new Error("Remote Pi runner did not acknowledge its launch ID within 10 seconds");
}

switch (command) {
  case "observe":
    observe();
    break;
  case "launch":
    launch();
    observe();
    break;
  case "stop":
    stopSession();
    break;
  case "delete":
    deleteSession();
    break;
  default:
    throw new Error(`Unknown Remote Handoff control command: ${command}`);
}
