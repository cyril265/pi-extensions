import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { asError, hasErrorCode } from "./errors.js";

const baseSshOptions = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=10",
  "-o", "ServerAliveInterval=5",
];
const maxControlPathLength = 85;

let multiplexDirectory: string | null | undefined;

function privateMultiplexDirectory(): string | null {
  if (multiplexDirectory !== undefined) return multiplexDirectory;
  multiplexDirectory = null;
  if (process.platform === "win32" || typeof process.getuid !== "function") return null;
  const uid = process.getuid();
  const directory = join(tmpdir(), `pi-rh-${uid}`);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) return null;
  }
  try {
    const stats = lstatSync(directory);
    if (!stats.isDirectory() || stats.uid !== uid || (stats.mode & 0o077) !== 0) return null;
  } catch {
    return null;
  }
  multiplexDirectory = directory;
  return directory;
}

function sshOptions(host: string): string[] {
  const directory = privateMultiplexDirectory();
  if (!directory) return baseSshOptions;
  const controlPath = join(directory, createHash("sha256").update(host).digest("hex").slice(0, 16));
  if (controlPath.length > maxControlPathLength || /[\s"'%]/.test(controlPath)) return baseSshOptions;
  return [
    ...baseSshOptions,
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${controlPath}`,
    "-o", "ControlPersist=60",
  ];
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export class SshHostUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshHostUnreachableError";
  }
}

export function isSshHostUnreachableError(error: unknown): error is SshHostUnreachableError {
  return error instanceof SshHostUnreachableError;
}

export class SshKeyLockedError extends Error {
  constructor() {
    super("Your SSH key is locked");
    this.name = "SshKeyLockedError";
  }
}

export function isSshKeyLockedError(error: unknown): error is SshKeyLockedError {
  return error instanceof SshKeyLockedError;
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
    reject(new SshKeyLockedError());
    return;
  }
  const markedExit = marker ? remoteExit(stderr, marker) : undefined;
  const cleanStderr = markedExit?.stderr ?? stderr;
  if (code === 255 && !markedExit) {
    reject(new SshHostUnreachableError(failureMessage(command, 255, stdout, cleanStderr)));
    return;
  }
  reject(new Error(failureMessage(command, markedExit?.status ?? code, stdout, cleanStderr)));
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

export function ssh(host: string, command: string): Promise<CommandResult> {
  const remote = sshArgs(host, command);
  return runRemote("ssh", remote.args, { marker: remote.marker });
}

export interface SshStreamOptions {
  onStdoutLine?: (line: string) => void;
  writeInput?: (stdin: Writable, signal: AbortSignal) => Promise<void>;
}

export function sshStream(
  host: string,
  command: string,
  options: SshStreamOptions,
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const remote = sshArgs(host, command);
    const child = spawn("ssh", remote.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const inputAbort = new AbortController();
    let inputError: Error | undefined;
    let stdout = "";
    let stderr = "";
    let pendingLine = "";
    const emitLine = (line: string) => {
      try {
        options.onStdoutLine?.(line.replace(/\r$/, ""));
      } catch (error) {
        inputError ??= asError(error);
        child.kill();
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      pendingLine += chunk;
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop()!;
      for (const line of lines) emitLine(line);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const stdin = child.stdin;
    stdin.on("error", () => {});
    if (!options.writeInput) {
      stdin.end();
    } else {
      options.writeInput(stdin, inputAbort.signal).catch((error: unknown) => {
        if (inputAbort.signal.aborted) return;
        inputError ??= asError(error);
        stdin.destroy();
        child.kill();
      });
    }
    child.on("error", (error) => {
      inputAbort.abort();
      reject(error);
    });
    child.on("close", (code) => {
      inputAbort.abort();
      if (pendingLine) emitLine(pendingLine);
      if (code === 0 && !inputError) {
        resolvePromise({ stdout, stderr: remoteExit(stderr, remote.marker)?.stderr ?? stderr });
        return;
      }
      const markedExit = remoteExit(stderr, remote.marker);
      if (inputError && (code === 0 || !markedExit || markedExit.status === 0)) {
        reject(inputError);
        return;
      }
      rejectRemoteFailure(reject, "ssh", code ?? undefined, stdout, stderr, remote.marker);
    });
  });
}

export function scpFrom(host: string, remotePath: string, localPath: string): Promise<CommandResult> {
  return runRemote("scp", ["-q", ...sshOptions(host), `${host}:${remotePath}`, localPath]);
}

function sshArgs(host: string, command: string): { args: string[]; marker: string } {
  const remote = markedRemoteCommand(command);
  return {
    args: [...sshOptions(host), host, remote.command],
    marker: remote.marker,
  };
}

export function sshTerminalArgs(host: string, command: string): string[] {
  return ["-t", ...sshOptions(host), host, command];
}

export function sshTerminalFailure(code: number | null, stderr: string): Error | undefined {
  if (lockedKeyMessage(stderr)) return new SshKeyLockedError();
  if (code === 255) return new SshHostUnreachableError(failureMessage("ssh", 255, "", stderr));
  return undefined;
}
