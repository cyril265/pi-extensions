import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const sshOptions = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=10",
  "-o", "ServerAliveInterval=5",
];

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface HerdrInstallation {
  output: string;
  version: string;
}

export class RemoteCommandError extends Error {
  constructor(
    message: string,
    readonly command: "ssh" | "scp",
    readonly exitCode: number | undefined,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "RemoteCommandError";
  }
}

export class SshHostUnreachableError extends Error {
  readonly exitCode = 255;

  constructor(
    readonly command: "ssh" | "scp",
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`${command} failed (255): ${stderr || stdout}`.trim());
    this.name = "SshHostUnreachableError";
  }
}

export function isSshHostUnreachableError(error: unknown): error is SshHostUnreachableError {
  return error instanceof SshHostUnreachableError;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function remoteCommand(args: readonly string[]): string {
  return args.map(shellQuote).join(" ");
}

function lockedKeyMessage(output: string): boolean {
  return /no identities|sign_and_send_pubkey: signing failed|incorrect passphrase|agent refused operation/i.test(output);
}

function exitCode(error: Error): number | undefined {
  if (!("code" in error) || typeof error.code !== "number") return undefined;
  return error.code;
}

function failureMessage(command: string, code: number | undefined, stdout: string, stderr: string): string {
  return `${command} failed (${code ?? "unknown"}): ${stderr || stdout}`.trim();
}

function runLocal(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string; timeout?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: options.timeout,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ stdout, stderr });
          return;
        }
        reject(new Error(failureMessage(command, exitCode(error), stdout, stderr)));
      },
    );
    child.stdin?.end(options.input);
  });
}

interface RemoteExitMarker {
  marker: string;
  command: string;
}

function markedRemoteCommand(command: string): RemoteExitMarker {
  const marker = `PI_REMOTE_HANDOFF_REMOTE_EXIT_${randomUUID()}`;
  const script = [
    `marker=${shellQuote(marker)}`,
    `trap 'status=$?; trap - EXIT; printf "\\n%s:%s\\n" "$marker" "$status" >&2; exit "$status"' EXIT`,
    command,
  ].join("\n");
  return { marker, command: remoteCommand(["bash", "-c", script]) };
}

function remoteExit(stderr: string, marker: string): { stderr: string; status: number } | undefined {
  const suffix = new RegExp(`\\n${marker}:(\\d+)\\n?$`);
  const match = stderr.match(suffix);
  if (!match?.[1]) return undefined;
  return { stderr: stderr.slice(0, match.index), status: Number(match[1]) };
}

function rejectRemoteFailure(
  reject: (reason: Error) => void,
  command: "ssh" | "scp",
  code: number | undefined,
  stdout: string,
  stderr: string,
  marker?: string,
): void {
  if (lockedKeyMessage(`${stdout}\n${stderr}`)) {
    reject(new Error("Your SSH key is locked"));
    return;
  }
  const markedExit = marker ? remoteExit(stderr, marker) : undefined;
  const cleanStderr = markedExit?.stderr ?? stderr;
  if (code === 255 && !markedExit) {
    reject(new SshHostUnreachableError(command, stdout, cleanStderr));
    return;
  }
  reject(new RemoteCommandError(
    failureMessage(command, markedExit?.status ?? code, stdout, cleanStderr),
    command,
    markedExit?.status ?? code,
    stdout,
    cleanStderr,
  ));
}

function runRemote(
  command: "ssh" | "scp",
  args: string[],
  options: { timeout?: number; marker?: string } = {},
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: options.timeout,
      },
      (error, stdout, stderr) => {
        const markedExit = options.marker ? remoteExit(stderr, options.marker) : undefined;
        if (!error) {
          resolvePromise({ stdout, stderr: markedExit?.stderr ?? stderr });
          return;
        }
        rejectRemoteFailure(
          reject,
          command,
          exitCode(error),
          stdout,
          stderr,
          options.marker,
        );
      },
    );
  });
}

export async function localHerdrInstallation(): Promise<HerdrInstallation> {
  let result: CommandResult;
  try {
    result = await runLocal("herdr", ["--version"]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Local Herdr is required. Install Herdr and make it available on PATH. ${detail}`);
  }
  const output = result.stdout.trim();
  const match = output.match(/^herdr ((\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?)$/);
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) {
    throw new Error(`Local Herdr returned an invalid version: ${JSON.stringify(output)}`);
  }
  const major = Number(match[2]);
  const minor = Number(match[3]);
  const patch = Number(match[4]);
  if (major === 0 && (minor < 8 || (minor === 8 && patch < 2))) {
    throw new Error(`Local Herdr ${match[1]} is unsupported. Install Herdr 0.8.2 or newer.`);
  }
  return { output, version: match[1] };
}

export function ssh(host: string, command: string): Promise<CommandResult> {
  const remote = markedRemoteCommand(command);
  return runRemote(
    "ssh",
    [...sshOptions, host, remote.command],
    { marker: remote.marker },
  );
}

export function sshStreaming(
  host: string,
  command: string,
  onStdoutLine: (line: string) => void,
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const remote = markedRemoteCommand(command);
    const child = spawn("ssh", [...sshOptions, host, remote.command], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let pendingLine = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      pendingLine += chunk;
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop()!;
      for (const line of lines) onStdoutLine(line.replace(/\r$/, ""));
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (pendingLine) onStdoutLine(pendingLine.replace(/\r$/, ""));
      if (code === 0) {
        resolvePromise({ stdout, stderr: remoteExit(stderr, remote.marker)?.stderr ?? stderr });
        return;
      }
      rejectRemoteFailure(reject, "ssh", code ?? undefined, stdout, stderr, remote.marker);
    });
  });
}

export function scpTo(host: string, localPath: string, remotePath: string): Promise<CommandResult> {
  return runRemote("scp", ["-q", ...sshOptions, localPath, `${host}:${remotePath}`]);
}

export function scpFrom(host: string, remotePath: string, localPath: string): Promise<CommandResult> {
  return runRemote("scp", ["-q", ...sshOptions, `${host}:${remotePath}`, localPath]);
}

interface HerdrTerminalFrame {
  type: "terminal.frame";
  bytes: string;
}

interface HerdrTerminalClosed {
  type: "terminal.closed";
  reason: string | null;
}

function parseTerminalMessage(line: string): HerdrTerminalFrame | HerdrTerminalClosed {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`Herdr terminal controller returned malformed JSON: ${JSON.stringify(line)}`);
  }
  if (value === null || typeof value !== "object") {
    throw new Error(`Herdr terminal controller returned an invalid message: ${line}`);
  }
  if ("type" in value && value.type === "terminal.frame" && "bytes" in value && typeof value.bytes === "string") {
    return { type: "terminal.frame", bytes: value.bytes };
  }
  if (
    "type" in value &&
    value.type === "terminal.closed" &&
    "reason" in value &&
    (typeof value.reason === "string" || value.reason === null)
  ) {
    return { type: "terminal.closed", reason: value.reason };
  }
  throw new Error(`Herdr terminal controller returned an invalid message: ${line}`);
}

function sshArgs(host: string, command: string): { args: string[]; marker: string } {
  const remote = markedRemoteCommand(command);
  return {
    args: [...sshOptions, host, remote.command],
    marker: remote.marker,
  };
}

export interface AttachHerdrTerminalOptions {
  host: string;
  remoteHerdrCommand: string;
  herdrSession: string;
  paneId: string;
  controlDirectory: string;
}

export type TerminalAttachmentEnd = "detached" | "remote-process-exited";

export interface TerminalAttachmentLifecycle {
  takeInput(): void;
  releaseInput(): void;
}

export async function attachHerdrTerminal(
  options: AttachHerdrTerminalOptions,
  lifecycle: TerminalAttachmentLifecycle,
): Promise<TerminalAttachmentEnd> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Attaching to remote Pi requires an interactive terminal.");
  }
  const controlFifo = `${options.controlDirectory}/attachment-control`;
  let stopWatcher: (() => void) | undefined;
  let watcherClosed: Promise<void> | undefined;
  let stoppingWatcher = false;
  let outcome: TerminalAttachmentEnd | undefined;
  let operationError: Error | undefined;

  try {
    const watcherScript = [
      "set -eu",
      `fifo=${shellQuote(controlFifo)}`,
      "reader=",
      "cleanup() {",
      "  status=$?",
      "  trap - EXIT",
      "  if test -n \"$reader\"; then kill \"$reader\" 2>/dev/null || :; wait \"$reader\" 2>/dev/null || :; fi",
      "  rm -f -- \"$fifo\" || status=$?",
      "  exit \"$status\"",
      "}",
      "trap cleanup EXIT",
      "rm -f -- \"$fifo\"",
      "mkfifo -m 600 \"$fifo\"",
      "exec 3<>\"$fifo\"",
      "printf 'ready\\n'",
      "(",
      "  IFS= read -r event <&3",
      "  test \"$event\" = detach",
      "  printf '%s\\n' \"$event\"",
      ") &",
      "reader=$!",
      "IFS= read -r command",
      "test \"$command\" = stop",
    ].join("\n");
    const watcherSsh = sshArgs(options.host, remoteCommand(["bash", "-c", watcherScript]));
    const activeWatcher = spawn("ssh", watcherSsh.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    stopWatcher = () => {
      if (!activeWatcher.stdin.destroyed) activeWatcher.stdin.end("stop\n");
    };
    watcherClosed = new Promise((resolvePromise) => {
      activeWatcher.once("close", () => resolvePromise());
    });
    activeWatcher.stdout.setEncoding("utf8");
    activeWatcher.stderr.setEncoding("utf8");
    let watcherOutput = "";
    let watcherError = "";
    activeWatcher.stderr.on("data", (chunk: string) => {
      watcherError += chunk;
    });

    await new Promise<void>((resolvePromise, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolvePromise();
      };
      const timer = setTimeout(
        () => settle(new Error("Remote Handoff attachment control did not become ready within 10 seconds.")),
        10_000,
      );
      timer.unref();
      const onData = (chunk: string) => {
        watcherOutput += chunk;
        if (!watcherOutput.startsWith("ready\n")) return;
        activeWatcher.stdout.off("data", onData);
        watcherOutput = watcherOutput.slice("ready\n".length);
        settle();
      };
      activeWatcher.stdout.on("data", onData);
      activeWatcher.once("error", (error) => settle(error));
      activeWatcher.once("close", (code, signal) => {
        if (lockedKeyMessage(watcherError)) {
          settle(new Error("Your SSH key is locked"));
          return;
        }
        if (code === 255 && !remoteExit(watcherError, watcherSsh.marker)) {
          settle(new SshHostUnreachableError("ssh", watcherOutput, watcherError));
          return;
        }
        const detail = watcherError.trim() || (signal ? `ssh received ${signal}` : `ssh exited with status ${code}`);
        settle(new Error(`Remote Handoff attachment control failed before connecting: ${detail}`));
      });
    });

    let controller: ReturnType<typeof spawn> | undefined;
    let watcherFailure: Error | undefined;
    activeWatcher.once("close", (code, signal) => {
      if (stoppingWatcher) return;
      const detail = watcherError.trim() || (signal ? `ssh received ${signal}` : `ssh exited with status ${code}`);
      if (lockedKeyMessage(detail)) {
        watcherFailure = new Error("Your SSH key is locked");
      } else if (code === 255 && !remoteExit(watcherError, watcherSsh.marker)) {
        watcherFailure = new SshHostUnreachableError("ssh", watcherOutput, watcherError);
      } else {
        watcherFailure = new Error(`Remote Handoff attachment control ended unexpectedly: ${detail}`);
      }
      controller?.kill();
    });

    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const controllerCommand = remoteCommand([
      options.remoteHerdrCommand,
      "--session",
      options.herdrSession,
      "terminal",
      "session",
      "control",
      options.paneId,
      "--takeover",
      "--cols",
      String(cols),
      "--rows",
      String(rows),
    ]);
    const controllerSsh = sshArgs(options.host, controllerCommand);
    const activeController = spawn("ssh", controllerSsh.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    controller = activeController;
    activeController.stdout.setEncoding("utf8");
    activeController.stderr.setEncoding("utf8");
    let controllerError = "";
    let pendingOutput = "";
    let closedReason: string | null | undefined;
    let failure: Error | undefined;
    activeController.stderr.on("data", (chunk: string) => {
      controllerError += chunk;
    });

    const send = (message: object) => {
      if (!activeController.stdin.destroyed) activeController.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const onInput = (data: Buffer | string) => {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      send({ type: "terminal.input", bytes: bytes.toString("base64") });
    };
    const onResize = () => {
      send({
        type: "terminal.resize",
        cols: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24,
      });
    };
    activeController.stdout.on("data", (chunk: string) => {
      pendingOutput += chunk;
      const lines = pendingOutput.split("\n");
      pendingOutput = lines.pop()!;
      try {
        for (const line of lines) {
          if (!line) continue;
          const message = parseTerminalMessage(line);
          if (message.type === "terminal.frame") {
            process.stdout.write(Buffer.from(message.bytes, "base64"));
          } else {
            closedReason = message.reason;
          }
        }
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        activeController.kill();
      }
    });
    let detachSent = false;
    const sendDetach = () => {
      if (detachSent || !watcherOutput.includes("detach\n")) return;
      detachSent = true;
      send({ type: "terminal.release" });
    };
    activeWatcher.stdout.on("data", (chunk: string) => {
      watcherOutput += chunk;
      sendDetach();
    });
    sendDetach();

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    let inputTaken = false;
    try {
      lifecycle.takeInput();
      inputTaken = true;
      stdin.setRawMode?.(true);
      stdin.resume();
      stdin.on("data", onInput);
      process.stdout.on("resize", onResize);

      await new Promise<void>((resolvePromise, reject) => {
        activeController.once("error", reject);
        activeController.once("close", (code, signal) => {
          if (watcherFailure) {
            reject(watcherFailure);
            return;
          }
          if (failure) {
            reject(failure);
            return;
          }
          if (code === 0) {
            resolvePromise();
            return;
          }
          const detail = controllerError.trim() || (signal ? `ssh received ${signal}` : `ssh exited with status ${code}`);
          if (lockedKeyMessage(detail)) {
            reject(new Error("Your SSH key is locked"));
            return;
          }
          if (code === 255 && !remoteExit(controllerError, controllerSsh.marker)) {
            reject(new SshHostUnreachableError("ssh", pendingOutput, controllerError));
            return;
          }
          reject(new Error(`Unable to attach to remote Herdr terminal: ${detail}`));
        });
      });
      if (closedReason === "detached") outcome = "detached";
      else if (closedReason?.includes("exited")) outcome = "remote-process-exited";
      else if (closedReason) throw new Error(`Remote Herdr terminal closed: ${closedReason}`);
      else throw new Error("Remote Herdr terminal closed without a reason.");
    } finally {
      stdin.off("data", onInput);
      process.stdout.off("resize", onResize);
      stdin.setRawMode?.(wasRaw ?? false);
      activeController.stdin.destroy();
      if (inputTaken) lifecycle.releaseInput();
    }
  } catch (error) {
    operationError = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (stopWatcher) {
      stoppingWatcher = true;
      stopWatcher();
      await watcherClosed;
    }
  }

  if (operationError) throw operationError;
  if (!outcome) throw new Error("Remote attachment ended without an outcome.");
  return outcome;
}
