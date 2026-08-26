import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chmodSync, closeSync, constants, existsSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export default function registerRemoteCompanion(pi: ExtensionAPI) {
  const control = process.env.PI_REMOTE_HANDOFF_CONTROL;
  if (!control) throw new Error("PI_REMOTE_HANDOFF_CONTROL is required");
  const activeSessionFile = join(control, "active-session");

  const writeState = (state: string) => {
    const temporary = join(control, `state.tmp.${process.pid}`);
    writeFileSync(temporary, `${state}\n`);
    renameSync(temporary, join(control, "state"));
  };

  let timer: NodeJS.Timeout | undefined;
  let stopStarted = false;

  const requestDetach = () => {
    const fifo = join(control, "attachment-control");
    const stat = lstatSync(fifo);
    if (!stat.isFIFO() || stat.isSymbolicLink()) {
      throw new Error("The Remote Handoff attachment control channel is invalid");
    }
    const descriptor = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    try {
      writeSync(descriptor, "detach\n");
    } finally {
      closeSync(descriptor);
    }
  };

  pi.registerCommand("remote-handoff", {
    description: "Manage this Remote Handoff run",
    handler: async (args, ctx) => {
      if (args.trim()) throw new Error("Run /remote-handoff without arguments.");
      const detach = "Detach and return to local Pi";
      const stop = "Stop and prepare result";
      const status = "Show status";
      const selected = await ctx.ui.select("Remote Handoff", [detach, stop, status]);
      if (!selected) return;
      if (selected === status) {
        const stateFile = join(control, "state");
        const state = existsSync(stateFile) ? readFileSync(stateFile, "utf8").trim() : "starting";
        ctx.ui.notify(`Remote Pi is ${state}.`, "info");
        return;
      }
      if (selected === detach) {
        requestDetach();
        return;
      }
      if (await ctx.ui.confirm("Stop remote work?", "Abort the active turn, stop Pi, and prepare the result?")) {
        writeFileSync(join(control, "stop-request"), "", { mode: 0o600 });
        stopStarted = true;
        writeState("stopping");
        if (!ctx.isIdle()) await ctx.abort();
        ctx.shutdown();
      }
    },
  });

  pi.on("session_before_switch", (event, ctx) => {
    const command = event.reason === "new" ? "/new" : "/resume";
    ctx.ui.notify(`${command} is blocked during this Remote Handoff.`, "warning");
    return { cancel: true };
  });
  pi.on("session_before_fork", (event, ctx) => {
    const command = event.position === "at" ? "/clone" : "/fork";
    ctx.ui.notify(`${command} is blocked during this Remote Handoff.`, "warning");
    return { cancel: true };
  });

  pi.on("session_start", (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile || !isAbsolute(sessionFile)) {
      rmSync(activeSessionFile, { force: true });
      throw new Error("The remote Pi session must be persisted at an absolute path");
    }
    const temporary = `${activeSessionFile}.tmp-${process.pid}`;
    try {
      writeFileSync(temporary, `${sessionFile}\n`, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, activeSessionFile);
    } catch (error) {
      rmSync(temporary, { force: true });
      rmSync(activeSessionFile, { force: true });
      throw error;
    }

    writeState("idle");
    timer = setInterval(async () => {
      if (stopStarted || !existsSync(join(control, "stop-request"))) return;
      stopStarted = true;
      writeState("stopping");
      try {
        if (!ctx.isIdle()) await ctx.abort();
      } finally {
        ctx.shutdown();
      }
    }, 250);
    timer.unref();
  });

  pi.on("agent_start", () => {
    if (!stopStarted) writeState("running");
  });
  pi.on("agent_settled", () => {
    if (!stopStarted) writeState("idle");
  });
  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
  });
}
