import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { withFileLock } from "./file-lock.js";
import { validateSshTarget } from "./remotes.js";

interface TaskMetadata {
  version: 7;
  id: string;
  host: string;
  repoRoot: string;
  commonGitDir: string;
  localDir: string;
  remoteDir: string;
  remoteAgentDir: string;
  remotePiCommand: string;
  herdrSession: string;
  remoteHerdrCommand: string;
  herdrVersion: string;
  handoffCommit: string;
  handoffRef: string;
  resultRef: string;
  originalSessionFile: string;
  originalSessionId: string;
  originalSessionCwd: string;
  originalSessionExisted: boolean;
  originalSessionSnapshotFile: string;
  originalSessionSha256: string;
  controlSessionFile: string;
}

export interface PendingAuthentication {
  kind: "pending";
  localAgentDir: string;
}

export interface ReturnedAuthentication {
  kind: "returned";
}

export interface ApplyPlan {
  resultCommit: string;
  beforeTree: string;
  afterTree: string;
  includedPaths: string[];
  patchFile: string;
  patchSha256: string;
  returnedSessionFile: string;
  returnedSessionSha256: string;
}

export interface ReservedTaskState extends TaskMetadata {
  phase: "reserved";
  reservationKind: "start" | "continue";
  launchId: string;
  authentication: PendingAuthentication;
}

export interface ActiveTaskState extends TaskMetadata {
  phase: "active";
  launchId: string;
  authentication: PendingAuthentication;
}

export interface StoppedTaskState extends TaskMetadata {
  phase: "stopped";
  launchId: string;
  authentication: PendingAuthentication;
}

export interface PreparedTaskState extends TaskMetadata {
  phase: "prepared";
  launchId: string;
  authentication: PendingAuthentication;
}

export interface ApplyingTaskState extends TaskMetadata {
  phase: "applying";
  authentication: ReturnedAuthentication;
  applyPlan: ApplyPlan;
}

export interface DiscardReturningTaskState extends TaskMetadata {
  phase: "returning";
  returnReason: "discard";
  authentication: ReturnedAuthentication;
}

export interface AbandonReturningTaskState extends TaskMetadata {
  phase: "returning";
  returnReason: "abandon";
  authentication: PendingAuthentication | ReturnedAuthentication;
}

export interface CleanupPendingTaskState extends TaskMetadata {
  phase: "cleanup-pending";
  authentication: ReturnedAuthentication;
}

export type ReturningTaskState = DiscardReturningTaskState | AbandonReturningTaskState;
export type RemoteOwnedTaskState = ActiveTaskState | StoppedTaskState | PreparedTaskState;
export type PendingAuthenticationTaskState =
  | ReservedTaskState
  | RemoteOwnedTaskState
  | (AbandonReturningTaskState & { authentication: PendingAuthentication });
export type TaskState =
  | ReservedTaskState
  | RemoteOwnedTaskState
  | ApplyingTaskState
  | ReturningTaskState
  | CleanupPendingTaskState;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function isPathEqualOrInside(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function stringField(value: Record<string, unknown>, name: keyof TaskMetadata): string {
  const field = value[name];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Version 7 Remote Handoff metadata has an invalid ${name} field.`);
  }
  return field;
}

function absolutePathField(value: Record<string, unknown>, name: keyof TaskMetadata): string {
  const field = stringField(value, name);
  if (!isAbsolute(field)) {
    throw new Error(`Version 7 Remote Handoff metadata has a non-absolute ${name} field.`);
  }
  return resolve(field);
}

function parsePendingAuthentication(value: unknown): PendingAuthentication {
  if (!isRecord(value) || value.kind !== "pending" || typeof value.localAgentDir !== "string") {
    throw new Error("Version 7 Remote Handoff metadata has invalid pending authentication state.");
  }
  if (!isAbsolute(value.localAgentDir)) {
    throw new Error("Version 7 Remote Handoff authentication owner must be an absolute path.");
  }
  return { kind: "pending", localAgentDir: resolve(value.localAgentDir) };
}

function parseReturnedAuthentication(value: unknown): ReturnedAuthentication {
  if (!isRecord(value) || value.kind !== "returned") {
    throw new Error("Version 7 Remote Handoff metadata has invalid returned authentication state.");
  }
  return { kind: "returned" };
}

function validateObjectId(value: string, name: string): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new Error(`Version 7 Remote Handoff metadata has an invalid ${name} field.`);
  }
  return value;
}

function validateHash(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`Version 7 Remote Handoff metadata has an invalid ${name} field.`);
  }
  return value;
}

function parseLaunchId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error("Version 7 Remote Handoff metadata has an invalid launchId field.");
  }
  return value;
}

function parseApplyPlan(value: unknown, localDir: string): ApplyPlan {
  if (!isRecord(value)) {
    throw new Error("Version 7 Remote Handoff metadata has an invalid apply plan.");
  }
  const string = (name: keyof ApplyPlan): string => {
    const field = value[name];
    if (typeof field !== "string" || field.length === 0) {
      throw new Error(`Version 7 Remote Handoff apply plan has an invalid ${name} field.`);
    }
    return field;
  };
  const absolutePath = (name: "patchFile" | "returnedSessionFile"): string => {
    const field = string(name);
    if (!isAbsolute(field)) {
      throw new Error(`Version 7 Remote Handoff apply plan has a non-absolute ${name} field.`);
    }
    return resolve(field);
  };
  const patchFile = absolutePath("patchFile");
  if (!isPathEqualOrInside(localDir, patchFile)) {
    throw new Error("Version 7 Remote Handoff apply patch must be under the task local directory.");
  }
  const returnedSessionFile = absolutePath("returnedSessionFile");
  if (!isPathEqualOrInside(localDir, returnedSessionFile)) {
    throw new Error("Version 7 returned conversation must be under the task local directory.");
  }
  if (!Array.isArray(value.includedPaths)) {
    throw new Error("Version 7 Remote Handoff apply plan has invalid includedPaths.");
  }
  const includedPaths: string[] = [];
  for (const path of value.includedPaths) {
    if (
      typeof path !== "string"
      || path.length === 0
      || isAbsolute(path)
      || path.split(/[\\/]/).includes("..")
    ) {
      throw new Error("Version 7 Remote Handoff apply plan has an invalid included path.");
    }
    includedPaths.push(path);
  }
  return {
    resultCommit: validateObjectId(string("resultCommit"), "applyPlan.resultCommit"),
    beforeTree: validateObjectId(string("beforeTree"), "applyPlan.beforeTree"),
    afterTree: validateObjectId(string("afterTree"), "applyPlan.afterTree"),
    includedPaths,
    patchFile,
    patchSha256: validateHash(value.patchSha256, "applyPlan.patchSha256"),
    returnedSessionFile,
    returnedSessionSha256: validateHash(value.returnedSessionSha256, "applyPlan.returnedSessionSha256"),
  };
}

function parseMetadata(value: Record<string, unknown>): TaskMetadata {
  const id = stringField(value, "id");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
    throw new Error("Version 7 Remote Handoff metadata has an invalid id field.");
  }
  const host = validateSshTarget(stringField(value, "host"));
  const repoRoot = absolutePathField(value, "repoRoot");
  const commonGitDir = absolutePathField(value, "commonGitDir");
  const localDir = absolutePathField(value, "localDir");
  if (localDir !== taskDirectory(commonGitDir)) {
    throw new Error("Version 7 Remote Handoff local directory must be under the Git common directory.");
  }

  const remoteDir = absolutePathField(value, "remoteDir");
  const remoteAgentDir = absolutePathField(value, "remoteAgentDir");
  if (!isPathEqualOrInside(remoteDir, remoteAgentDir)) {
    throw new Error("Version 7 Remote Handoff remote agent directory must be under the remote workspace.");
  }
  const remotePiCommand = absolutePathField(value, "remotePiCommand");
  const remoteHerdrCommand = absolutePathField(value, "remoteHerdrCommand");

  const herdrSession = stringField(value, "herdrSession");
  if (
    herdrSession === "default" ||
    herdrSession.length > 64 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(herdrSession)
  ) {
    throw new Error("Version 7 Remote Handoff metadata has an invalid herdrSession field.");
  }
  const herdrVersion = stringField(value, "herdrVersion");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(herdrVersion)) {
    throw new Error("Version 7 Remote Handoff metadata has an invalid herdrVersion field.");
  }

  const handoffCommit = validateObjectId(stringField(value, "handoffCommit"), "handoffCommit");
  const handoffRef = stringField(value, "handoffRef");
  const resultRef = stringField(value, "resultRef");
  const refPattern = /^refs\/pi-remote-handoff\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
  if (!refPattern.test(handoffRef) || !refPattern.test(resultRef)) {
    throw new Error("Version 7 Remote Handoff metadata has an invalid Git reference.");
  }

  const originalSessionFile = absolutePathField(value, "originalSessionFile");
  if (isPathEqualOrInside(localDir, originalSessionFile)) {
    throw new Error("Version 7 Remote Handoff original session must be outside the task local directory.");
  }
  const originalSessionId = stringField(value, "originalSessionId");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(originalSessionId)) {
    throw new Error("Version 7 Remote Handoff metadata has an invalid originalSessionId field.");
  }
  const originalSessionCwd = absolutePathField(value, "originalSessionCwd");
  if (typeof value.originalSessionExisted !== "boolean") {
    throw new Error("Version 7 Remote Handoff metadata has an invalid originalSessionExisted field.");
  }
  const originalSessionSnapshotFile = absolutePathField(value, "originalSessionSnapshotFile");
  if (!isPathEqualOrInside(localDir, originalSessionSnapshotFile)) {
    throw new Error("Version 7 original conversation snapshot must be under the task local directory.");
  }
  const originalSessionSha256 = validateHash(value.originalSessionSha256, "originalSessionSha256");
  const controlSessionFile = absolutePathField(value, "controlSessionFile");
  if (controlSessionFile !== join(localDir, "control", "session.jsonl")) {
    throw new Error("Version 7 Remote Handoff control session must be under the task local directory.");
  }

  return {
    version: 7,
    id,
    host,
    repoRoot,
    commonGitDir,
    localDir,
    remoteDir,
    remoteAgentDir,
    remotePiCommand,
    herdrSession,
    remoteHerdrCommand,
    herdrVersion,
    handoffCommit,
    handoffRef,
    resultRef,
    originalSessionFile,
    originalSessionId,
    originalSessionCwd,
    originalSessionExisted: value.originalSessionExisted,
    originalSessionSnapshotFile,
    originalSessionSha256,
    controlSessionFile,
  };
}

function parseTask(value: unknown): TaskState {
  if (!isRecord(value)) throw new Error("Remote Handoff metadata must be a JSON object.");
  if (value.version !== 7) {
    throw new Error(`Unsupported Remote Handoff task version: ${JSON.stringify(value.version)}.`);
  }
  const metadata = parseMetadata(value);

  switch (value.phase) {
    case "reserved": {
      if (value.reservationKind !== "start" && value.reservationKind !== "continue") {
        throw new Error("Version 7 Remote Handoff metadata has an invalid reservationKind field.");
      }
      return {
        ...metadata,
        phase: "reserved",
        reservationKind: value.reservationKind,
        launchId: parseLaunchId(value.launchId),
        authentication: parsePendingAuthentication(value.authentication),
      };
    }
    case "active":
      return {
        ...metadata,
        phase: "active",
        launchId: parseLaunchId(value.launchId),
        authentication: parsePendingAuthentication(value.authentication),
      };
    case "stopped":
      return {
        ...metadata,
        phase: "stopped",
        launchId: parseLaunchId(value.launchId),
        authentication: parsePendingAuthentication(value.authentication),
      };
    case "prepared":
      return {
        ...metadata,
        phase: "prepared",
        launchId: parseLaunchId(value.launchId),
        authentication: parsePendingAuthentication(value.authentication),
      };
    case "applying":
      return {
        ...metadata,
        phase: "applying",
        authentication: parseReturnedAuthentication(value.authentication),
        applyPlan: parseApplyPlan(value.applyPlan, metadata.localDir),
      };
    case "returning":
      if (value.returnReason === "discard") {
        return {
          ...metadata,
          phase: "returning",
          returnReason: "discard",
          authentication: parseReturnedAuthentication(value.authentication),
        };
      }
      if (value.returnReason === "abandon") {
        const authentication = isRecord(value.authentication) && value.authentication.kind === "returned"
          ? parseReturnedAuthentication(value.authentication)
          : parsePendingAuthentication(value.authentication);
        return {
          ...metadata,
          phase: "returning",
          returnReason: "abandon",
          authentication,
        };
      }
      throw new Error("Version 7 Remote Handoff metadata has an invalid return reason.");
    case "cleanup-pending":
      return {
        ...metadata,
        phase: "cleanup-pending",
        authentication: parseReturnedAuthentication(value.authentication),
      };
    default:
      throw new Error(`Version 7 Remote Handoff metadata has an invalid phase: ${JSON.stringify(value.phase)}.`);
  }
}

export function taskDirectory(commonGitDir: string): string {
  if (!isAbsolute(commonGitDir)) throw new Error("The Git common directory must be absolute.");
  return resolve(commonGitDir, "pi-remote-handoff");
}

export function taskFile(commonGitDir: string): string {
  return join(taskDirectory(commonGitDir), "task.json");
}

function legacyTaskFile(commonGitDir: string): string {
  return join(resolve(commonGitDir), "pi-cloud-resume", "task.json");
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function currentTaskContents(commonGitDir: string): Promise<string | undefined> {
  const currentPath = taskFile(commonGitDir);
  const legacyPath = legacyTaskFile(commonGitDir);
  const [current, legacy] = await Promise.all([
    readOptionalFile(currentPath),
    readOptionalFile(legacyPath),
  ]);

  if (current !== undefined && legacy !== undefined) {
    throw new Error(
      `Remote Handoff found both task files: ${JSON.stringify(legacyPath)} and ${JSON.stringify(currentPath)}. Choose the authoritative handoff, safely discard the other one, then retry.`,
    );
  }
  if (legacy === undefined) return current;

  let value: unknown;
  try {
    value = JSON.parse(legacy);
  } catch {
    throw new Error(`Pre-rename Remote Handoff metadata at ${JSON.stringify(legacyPath)} contains invalid JSON.`);
  }
  if (!isRecord(value) || value.version !== 7) {
    const version = isRecord(value) ? value.version : undefined;
    throw new Error(`Unsupported pre-rename Remote Handoff task version: ${JSON.stringify(version)}.`);
  }
  throw new Error(
    `A pre-rename version 7 Remote Handoff exists at ${JSON.stringify(legacyPath)}. Finish or discard it with the pre-rename extension before starting a new handoff in this repository.`,
  );
}

export async function loadTask(commonGitDir: string): Promise<TaskState | undefined> {
  const expectedCommonGitDir = resolve(commonGitDir);
  const contents = await currentTaskContents(expectedCommonGitDir);
  if (contents === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("Remote Handoff metadata contains invalid JSON.");
  }
  const task = parseTask(value);
  if (task.commonGitDir !== expectedCommonGitDir) {
    throw new Error(
      `Remote Handoff metadata belongs to a different Git common directory: expected ${JSON.stringify(expectedCommonGitDir)}, found ${JSON.stringify(task.commonGitDir)}.`,
    );
  }
  return task;
}

export async function saveTask(task: TaskState): Promise<void> {
  const path = taskFile(task.commonGitDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.task-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(task, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function removeTaskFiles(task: TaskState): Promise<void> {
  await rm(task.localDir, { recursive: true, force: true });
}

async function runWithRepositoryOperationLock<T>(
  commonGitDir: string,
  operation: (checkLock: () => void) => Promise<T>,
  wait: boolean,
): Promise<T> {
  await currentTaskContents(commonGitDir);
  const directory = taskDirectory(commonGitDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = `${directory}.operation`;
  return withFileLock(lockPath, wait, async (checkLock) => {
    await currentTaskContents(commonGitDir);
    checkLock();
    return operation(checkLock);
  });
}

export function withRepositoryOperationLock<T>(
  commonGitDir: string,
  operation: (checkLock: () => void) => Promise<T>,
): Promise<T> {
  return runWithRepositoryOperationLock(commonGitDir, operation, true);
}

export async function tryWithRepositoryOperationLock(
  commonGitDir: string,
  operation: (checkLock: () => void) => Promise<void>,
): Promise<boolean> {
  try {
    await runWithRepositoryOperationLock(commonGitDir, operation, false);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ELOCKED")) return false;
    throw error;
  }
}
