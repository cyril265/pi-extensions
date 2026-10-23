import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

export interface TerminalChildOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  pipeStderr?: boolean;
}

export interface TerminalChildExit {
  started: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  error?: Error;
}

export function runInTerminal(
  ctx: ExtensionCommandContext,
  command: string,
  args: readonly string[],
  options: TerminalChildOptions = {},
): Promise<TerminalChildExit> {
  if (ctx.mode !== "tui" || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("This action requires Pi's interactive TUI in a terminal.");
  }
  return ctx.ui.custom<TerminalChildExit>((tui, _theme, _keybindings, done) => {
    tui.stop();
    process.stdout.write("\u001b[2J\u001b[H");
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["inherit", "inherit", options.pipeStderr ? "pipe" : "inherit"],
    });
    let started = false;
    let stderr = "";
    let error: Error | undefined;
    child.once("spawn", () => {
      started = true;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (childError) => {
      error = childError;
    });
    child.once("close", (code, signal) => {
      tui.start();
      tui.requestRender(true);
      done({ started, code, signal, stderr, ...(error ? { error } : {}) });
    });
    return { render: () => [], invalidate: () => {} };
  });
}
