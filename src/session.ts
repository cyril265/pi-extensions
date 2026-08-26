import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const currentSessionVersion = 3;
const sessionIdPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

interface SessionManagerView {
  getBranch(): readonly unknown[];
  getHeader(): object | null;
  getSessionFile(): string | undefined;
  getSessionId(): string;
}

export interface ExportedSession {
  sourcePath: string;
  sessionId: string;
  sourceCwd: string;
  sourceExisted: boolean;
  originalSnapshotPath: string;
  originalSha256: string;
}

export interface SessionBoundaryHeader {
  id: string;
  cwd: string;
}

export interface PreparedSessionFile {
  path: string;
  sha256: string;
}

type SessionHeader = Record<string, unknown> & {
  type: "session";
  id: string;
  timestamp: string;
  cwd: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && sessionIdPattern.test(value);
}

function isSessionHeader(value: unknown): value is SessionHeader {
  return isRecord(value) &&
    value.type === "session" &&
    validSessionId(value.id) &&
    typeof value.timestamp === "string" &&
    typeof value.cwd === "string";
}

function validateHeader(value: unknown, source: string): SessionHeader {
  if (!isSessionHeader(value)) throw new Error(`${source} has no valid session header.`);
  return value;
}

function validateBoundaryHeader(value: unknown, source: string): SessionBoundaryHeader {
  if (
    !isRecord(value) ||
    value.type !== "session" ||
    !validSessionId(value.id) ||
    typeof value.cwd !== "string" ||
    !isAbsolute(value.cwd)
  ) {
    throw new Error(`${source} has no valid session identity header.`);
  }
  return { id: value.id, cwd: value.cwd };
}

export async function readSessionBoundaryHeader(sessionFile: string): Promise<SessionBoundaryHeader> {
  if (!isAbsolute(sessionFile)) throw new Error("The Pi conversation path is not absolute.");
  const input = createReadStream(sessionFile, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      return validateBoundaryHeader(value, `Pi conversation ${JSON.stringify(sessionFile)}`);
    }
    throw new Error(`Pi conversation ${JSON.stringify(sessionFile)} is empty.`);
  } finally {
    lines.close();
    input.destroy();
  }
}

function serialize(lines: readonly unknown[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function parseJsonl(contents: string, source: string): Record<string, unknown>[] {
  const rawLines = contents.split("\n");
  if (rawLines.at(-1) === "") rawLines.pop();
  if (rawLines.length === 0) throw new Error(`${source} is empty.`);

  return rawLines.map((line, index) => {
    if (!line) throw new Error(`${source} contains an empty JSONL line at ${index + 1}.`);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`${source} contains invalid JSON on line ${index + 1}.`);
    }
    if (!isRecord(value)) throw new Error(`${source} contains a non-object value on line ${index + 1}.`);
    return value;
  });
}

function validateReturnedHeader(
  lines: Record<string, unknown>[],
  source: string,
  expectedSessionId: string,
): SessionHeader {
  if (!validSessionId(expectedSessionId)) throw new Error("The expected Pi conversation ID is invalid.");
  const header = validateHeader(lines[0], source);
  if (header.version !== currentSessionVersion) {
    throw new Error(`${source} has unsupported version ${JSON.stringify(header.version)}.`);
  }
  if (header.id !== expectedSessionId) {
    throw new Error(`${source} ID ${JSON.stringify(header.id)} does not match the handed-off conversation.`);
  }
  return header;
}

export async function hashFileSha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function writeTemporarySession(
  destination: string,
  lines: readonly unknown[],
): Promise<PreparedSessionFile> {
  try {
    await writeFile(destination, serialize(lines), { flag: "wx", mode: 0o600 });
    await chmod(destination, 0o600);
    return { path: destination, sha256: await hashFileSha256(destination) };
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
}

export async function exportActiveBranch(
  sessionManager: SessionManagerView,
  destination: string,
  remoteCwd: string,
  originalSnapshotDestination: string,
): Promise<ExportedSession> {
  const sourcePath = sessionManager.getSessionFile();
  if (!sourcePath) throw new Error("The active Pi conversation is not persisted and cannot be transferred.");
  if (!isAbsolute(sourcePath)) throw new Error("The active Pi conversation path is not absolute.");
  let sourceExisted: boolean;
  try {
    if (!(await stat(sourcePath)).isFile()) throw new Error("The active Pi conversation path is not a regular file.");
    sourceExisted = true;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    sourceExisted = false;
  }
  if (!isAbsolute(remoteCwd)) throw new Error("The remote repository path is not absolute.");
  if (!isAbsolute(originalSnapshotDestination)) {
    throw new Error("The original Pi conversation snapshot path is not absolute.");
  }

  const sourceHeader = validateHeader(sessionManager.getHeader(), "The active Pi conversation");
  if (!isAbsolute(sourceHeader.cwd)) throw new Error("The active Pi conversation cwd is not absolute.");
  const sessionId = sessionManager.getSessionId();
  if (!validSessionId(sessionId) || sourceHeader.id !== sessionId) {
    throw new Error("The active Pi conversation has inconsistent session identity metadata.");
  }
  const header = {
    ...sourceHeader,
    version: currentSessionVersion,
    cwd: remoteCwd,
  };
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, serialize([header, ...sessionManager.getBranch()]), { mode: 0o600 });
  await writeFile(
    originalSnapshotDestination,
    serialize([{ ...sourceHeader, version: currentSessionVersion }, ...sessionManager.getBranch()]),
    { flag: "wx", mode: 0o600 },
  );
  return {
    sourcePath,
    sessionId,
    sourceCwd: sourceHeader.cwd,
    sourceExisted,
    originalSnapshotPath: originalSnapshotDestination,
    originalSha256: await hashFileSha256(sourceExisted ? sourcePath : originalSnapshotDestination),
  };
}

export async function createControlSession(controlSessionFile: string, localCwd: string): Promise<void> {
  if (!isAbsolute(controlSessionFile)) throw new Error("The control session path must be absolute.");
  if (!isAbsolute(localCwd)) throw new Error("The local repository path must be absolute.");
  const header = {
    type: "session",
    version: currentSessionVersion,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: localCwd,
  };
  await mkdir(dirname(controlSessionFile), { recursive: true });
  await writeFile(controlSessionFile, serialize([header]), { flag: "wx", mode: 0o600 });
  await chmod(controlSessionFile, 0o600);
}

export async function prepareReturnedSession(
  remoteSessionPath: string,
  originalSessionFile: string,
  originalCwd: string,
  expectedSessionId: string,
): Promise<PreparedSessionFile> {
  if (!isAbsolute(remoteSessionPath)) throw new Error("The returned Pi conversation path is not absolute.");
  if (!isAbsolute(originalSessionFile)) throw new Error("The original Pi conversation path is not absolute.");
  if (!isAbsolute(originalCwd)) throw new Error("The original Pi conversation cwd is not absolute.");
  const lines = parseJsonl(await readFile(remoteSessionPath, "utf8"), "Returned Pi session");
  const header = validateReturnedHeader(lines, "Returned Pi session", expectedSessionId);
  const temporary = join(dirname(originalSessionFile), `.${randomUUID()}.pi-remote-handoff.tmp`);
  return writeTemporarySession(temporary, [{ ...header, cwd: originalCwd }, ...lines.slice(1)]);
}

export async function createReviewSession(
  returnedSessionPath: string,
  destinationDirectory: string,
  reviewCwd: string,
  expectedSessionId: string,
): Promise<PreparedSessionFile> {
  if (!isAbsolute(returnedSessionPath)) throw new Error("The returned Pi conversation path is not absolute.");
  if (!isAbsolute(destinationDirectory)) throw new Error("The review conversation directory is not absolute.");
  if (!isAbsolute(reviewCwd)) throw new Error("The merge review cwd is not absolute.");
  const lines = parseJsonl(await readFile(returnedSessionPath, "utf8"), "Merge review Pi session");
  const header = validateReturnedHeader(lines, "Merge review Pi session", expectedSessionId);
  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
  const destination = join(resolve(destinationDirectory), `.review-${randomUUID()}.jsonl`);
  return writeTemporarySession(destination, [{ ...header, cwd: reviewCwd }, ...lines.slice(1)]);
}
