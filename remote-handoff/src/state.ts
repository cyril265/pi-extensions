import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { atomicWrite } from "./atomic-write.js";
import { hasErrorCode } from "./errors.js";
import { withFileLock } from "./file-lock.js";
import type { RepositoryPaths } from "./git.js";

interface TaskMetadataBase {
  version: 8;
  id: string;
  host: string;
  localDir: string;
  remoteDir: string;
  remoteAgentDir: string;
  herdrSession: string;
  remoteHerdrCommand: string;
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

type TaskMetadata = TaskMetadataBase & RepositoryPaths;

const derivedFields = new Set(["localDir", "controlSessionFile", "remoteAgentDir", "privateGitDir"]);

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

export type ReservedTaskState = TaskMetadata & {
  phase: "reserved";
  reservationKind: "start" | "continue";
  launchId: string;
  authentication: PendingAuthentication;
};

export type RemoteTaskState = TaskMetadata & {
  phase: "remote";
  launchId: string;
  authentication: PendingAuthentication;
};

export type ApplyingTaskState = TaskMetadata & {
  phase: "applying";
  authentication: ReturnedAuthentication;
  applyPlan: ApplyPlan;
};

export type DiscardReturningTaskState = TaskMetadata & {
  phase: "returning";
  returnReason: "discard";
  authentication: ReturnedAuthentication;
};

export type AbandonReturningTaskState = TaskMetadata & {
  phase: "returning";
  returnReason: "abandon";
  authentication: PendingAuthentication | ReturnedAuthentication;
};

export type CleanupPendingTaskState = TaskMetadata & {
  phase: "cleanup-pending";
  authentication: ReturnedAuthentication;
};

export type ReturningTaskState = DiscardReturningTaskState | AbandonReturningTaskState;
export type PendingAuthenticationTaskState =
  | ReservedTaskState
  | RemoteTaskState
  | (AbandonReturningTaskState & { authentication: PendingAuthentication });
export type TaskState =
  | ReservedTaskState
  | RemoteTaskState
  | ApplyingTaskState
  | ReturningTaskState
  | CleanupPendingTaskState;

export function taskDirectory(commonGitDir: string): string {
  if (!isAbsolute(commonGitDir)) throw new Error("The repository namespace must be absolute.");
  return resolve(commonGitDir, "pi-remote-handoff");
}

function taskFile(commonGitDir: string): string {
  return join(taskDirectory(commonGitDir), "task.json");
}

export async function loadTask(commonGitDir: string): Promise<TaskState | undefined> {
  const expectedCommonGitDir = resolve(commonGitDir);
  const path = taskFile(expectedCommonGitDir);
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
  const stored = JSON.parse(contents);
  if (stored.version !== 8) {
    throw new Error(`Unsupported Remote Handoff task version ${JSON.stringify(stored.version)} in ${path}.`);
  }
  if (stored.commonGitDir !== expectedCommonGitDir) {
    throw new Error(
      `Remote Handoff metadata belongs to a different repository namespace: expected ${JSON.stringify(expectedCommonGitDir)}, found ${JSON.stringify(stored.commonGitDir)}.`,
    );
  }
  const localDir = taskDirectory(expectedCommonGitDir);
  return {
    ...stored,
    localDir,
    controlSessionFile: join(localDir, "control", "session.jsonl"),
    remoteAgentDir: posix.join(stored.remoteDir, "profile", "home", ".pi", "agent"),
    ...(stored.repositoryKind === "directory" ? { privateGitDir: join(expectedCommonGitDir, "repository.git") } : {}),
  };
}

export async function saveTask(task: TaskState): Promise<void> {
  const path = taskFile(task.commonGitDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const stored = JSON.stringify(task, (key, value) => derivedFields.has(key) ? undefined : value, 2);
  await atomicWrite(path, `${stored}\n`);
}

export async function removeTaskFiles(task: TaskState): Promise<void> {
  await rm(task.localDir, { recursive: true, force: true });
}

async function runWithRepositoryOperationLock<T>(
  commonGitDir: string,
  operation: (checkLock: () => void) => Promise<T>,
  wait: boolean,
): Promise<T> {
  const directory = taskDirectory(commonGitDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = `${directory}.operation`;
  return withFileLock(lockPath, wait, async (checkLock) => {
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
