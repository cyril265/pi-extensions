import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { atomicWrite } from "./atomic-write.js";
import { captureAuthenticationSnapshot, returnRemoteAuthentication } from "./auth.js";
import { asError, errorMessage, hasErrorCode } from "./errors.js";
import {
  acquireFileLock,
  fileLockIsHeld,
  isFileLockUnavailable,
  type FileLockLease,
} from "./file-lock.js";
import {
  applyDelta,
  checkApplyPatch,
  createBinaryPatch,
  createBundle,
  createSnapshot,
  deleteRef,
  analyzeApplyPaths,
  assertRepositoryHasCommits,
  importResult,
  initializeRepository,
  rejectUnsupportedRepository,
  removeRepositoryData,
  resolveDirectoryRepository,
  resolveRepository,
  resolveTree,
  snapshotTree,
  type RepositoryPaths,
} from "./git.js";
import { LocalFilesChangedError, runInteractiveMergeReview } from "./merge-review.js";
import { isPathEqualOrInside, packageRoot } from "./paths.js";
import { executingPiVersion } from "./pi-version.js";
import { buildProfile } from "./profile.js";
import {
  isSshHostUnreachableError,
  isSshKeyLockedError,
} from "./remote.js";
import {
  assertRemoteWorkspaceAvailable,
  attachRemoteRun,
  cleanupRemoteWorkspace,
  downloadPreparedResult,
  forceStopRemoteRun,
  invalidatePreparedResult,
  launchRemoteRun,
  observeRemoteWorkspace,
  prepareRemoteContinuation,
  provisionInitialRemoteWorkspace,
  refreshRemoteHerdr,
  requestGracefulStop,
  resolveNewRemoteWorkspace,
  settleUnstartedReservation,
  type RemoteLifecycleState,
  type RemoteWorkspaceObservation,
  type RemoteWorkspaceStatus,
} from "./remote-workspace.js";
import { addRemote, listRemotes, removeRemote, validateSshTarget } from "./remotes.js";
import {
  createControlSession,
  exportActiveBranch,
  hashFileSha256,
  prepareReturnedSession,
  readSessionBoundaryHeader,
} from "./session.js";
import {
  loadTask,
  removeTaskFiles,
  saveTask,
  taskDirectory,
  tryWithRepositoryOperationLock,
  withRepositoryOperationLock,
  type ApplyingTaskState,
  type ApplyPlan,
  type CleanupPendingTaskState,
  type RemoteTaskState,
  type ReservedTaskState,
  type ReturnedAuthentication,
  type ReturningTaskState,
  type TaskState,
} from "./state.js";
import { showDiff } from "./diff-viewer.js";

const controlStatusKey = "remote-handoff-control";
const gracefulStopTimeoutMs = 10_000;

declare global {
  var __piRemoteHandoffProcessInstanceToken: string | undefined;
}

const processInstanceToken = globalThis.__piRemoteHandoffProcessInstanceToken ??= randomUUID();

interface AttachmentReservation {
  task: RemoteTaskState;
  lease: FileLockLease;
  markerContents: string;
}

type ReachableTask = {
  task: TaskState;
  observation?: RemoteWorkspaceObservation;
};

type ObservedTask =
  | { kind: "reachable"; value: ReachableTask }
  | { kind: "unreachable"; task: TaskState; error: Error };

type MenuAction =
  | "start"
  | "remotes"
  | "attach"
  | "status"
  | "stop"
  | "continue"
  | "view-diff"
  | "apply"
  | "discard"
  | "retry-cleanup"
  | "retry-connection"
  | "abandon";

interface MenuItem {
  action: MenuAction;
  label: string;
}

function currentLocation(task: TaskState, ctx: ExtensionContext): "control" | "original" | "unrelated" {
  const currentFile = ctx.sessionManager.getSessionFile();
  if (currentFile && resolve(currentFile) === task.controlSessionFile) return "control";
  if (
    ctx.sessionManager.getSessionId() === task.originalSessionId
    || (currentFile && resolve(currentFile) === task.originalSessionFile)
  ) {
    return "original";
  }
  return "unrelated";
}

function attachmentMarker(task: TaskState): string {
  return join(task.localDir, "attachment-active");
}

function attachmentLeasePath(commonGitDir: string): string {
  return `${taskDirectory(commonGitDir)}.attachment`;
}

async function attachmentLeaseIsHeld(task: TaskState): Promise<boolean> {
  return fileLockIsHeld(attachmentLeasePath(task.commonGitDir));
}

async function currentProcessOwnsAttachment(task: TaskState): Promise<boolean> {
  try {
    const markerContents = await readFile(attachmentMarker(task), "utf8");
    return markerContents.startsWith(`${processInstanceToken}:`) && await attachmentLeaseIsHeld(task);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function reserveAttachment(task: RemoteTaskState): Promise<AttachmentReservation> {
  let lease: FileLockLease;
  try {
    lease = await acquireFileLock(attachmentLeasePath(task.commonGitDir), false);
  } catch (error) {
    if (isFileLockUnavailable(error)) {
      throw new Error("The remote terminal is already attached by another local controller.");
    }
    throw error;
  }

  const markerContents = `${processInstanceToken}:${randomUUID()}\n`;
  try {
    await writeFile(attachmentMarker(task), markerContents, { mode: 0o600 });
  } catch (error) {
    await lease.release();
    throw error;
  }
  return { task, lease, markerContents };
}

async function releaseAttachment(reservation: AttachmentReservation): Promise<void> {
  let markerError: Error | undefined;
  try {
    const marker = attachmentMarker(reservation.task);
    if (await readFile(marker, "utf8") !== reservation.markerContents) {
      throw new Error("Attachment marker ownership changed while its lease was held.");
    }
    await rm(marker);
  } catch (error) {
    markerError = asError(error);
  }

  try {
    await reservation.lease.release();
  } catch (error) {
    const leaseError = asError(error);
    if (markerError) {
      throw new AggregateError([markerError, leaseError], "Attachment marker cleanup and lease release failed.");
    }
    throw leaseError;
  }
  if (markerError) throw markerError;
}

function conversationIsBlocked(task: TaskState): boolean {
  return task.phase !== "cleanup-pending";
}

function remoteOwnsConversation(task: TaskState): boolean {
  return task.phase === "reserved" || task.phase === "remote";
}

function remoteContext(
  task: TaskState,
  status: RemoteWorkspaceStatus | undefined,
): { task: RemoteTaskState; status: RemoteWorkspaceStatus } {
  if (task.phase !== "remote" || !status) throw new Error(`Unexpected Remote Handoff phase: ${task.phase}.`);
  return { task, status };
}

async function resolveRepositoryContext(cwd: string): Promise<RepositoryPaths> {
  const agentDir = resolve(getAgentDir());
  const directory = await resolveDirectoryRepository(cwd, agentDir);
  const directoryTask = await loadTask(directory.commonGitDir);
  if (directoryTask) {
    if (
      directoryTask.repositoryKind !== "directory"
      || directoryTask.repoRoot !== directory.repoRoot
      || directoryTask.commonGitDir !== directory.commonGitDir
      || directoryTask.privateGitDir !== directory.privateGitDir
    ) {
      throw new Error("The non-Git Remote Handoff namespace belongs to a different directory.");
    }
    return directoryTask;
  }
  return resolveRepository(cwd, agentDir);
}

async function taskForContext(ctx: ExtensionContext): Promise<TaskState | undefined> {
  const repository = await resolveRepositoryContext(ctx.cwd);
  return loadTask(repository.commonGitDir);
}

function errorDetail(error: string | undefined): string {
  if (!error) return "";
  return ` Error: ${error}${error.endsWith(".") ? "" : "."}`;
}

function statusLabel(status: RemoteWorkspaceStatus): string {
  switch (status.kind) {
    case "active":
      return `Remote Pi is ${status.state}.`;
    case "stopped":
      return `Remote Pi stopped without a prepared result.${errorDetail(status.error)}`;
    case "prepared":
      return `A result is prepared.${errorDetail(status.error)}`;
    case "incomplete":
      return `The remote workspace is incomplete.${errorDetail(status.error)}`;
  }
}

function activeStatusLabel(state: RemoteLifecycleState, host: string): string {
  switch (state) {
    case "preparing":
      return `Remote Pi is starting on ${host}.`;
    case "running":
      return `Remote Pi is working on ${host}.`;
    case "idle":
      return `Remote turn finished on ${host}. Run /remote-handoff to attach or stop.`;
    case "stopping":
    case "preparing-result":
      return `Remote Pi is preparing a result on ${host}.`;
    case "prepared":
      return `Remote result ready from ${host}. Run /remote-handoff to review.`;
    case "failed":
      return `Remote Pi failed on ${host}. Run /remote-handoff to inspect.`;
  }
}

function controlStatusLabel(task: TaskState, status?: RemoteWorkspaceStatus): string {
  if (status) {
    switch (status.kind) {
      case "active":
        return activeStatusLabel(status.state, task.host);
      case "prepared":
        return `Remote result ready from ${task.host}. Run /remote-handoff to review.`;
      case "stopped":
        return `Remote Pi stopped on ${task.host} without a result. Run /remote-handoff to continue or discard.`;
      case "incomplete":
        return `Remote workspace on ${task.host} needs attention. Run /remote-handoff to inspect.`;
    }
  }

  switch (task.phase) {
    case "reserved":
      return `Remote Pi is starting on ${task.host}. Run /remote-handoff to check status.`;
    case "remote":
      return `Checking Remote Pi on ${task.host}...`;
    case "applying":
      return "Remote result apply needs recovery. Run /remote-handoff to continue.";
    case "returning":
      return "Remote Handoff ownership return needs recovery. Run /remote-handoff to continue.";
    case "cleanup-pending":
      return `Remote cleanup pending on ${task.host}. Run /remote-handoff to retry.`;
  }
}

function setControlStatus(
  ctx: ExtensionContext,
  task: TaskState,
  status?: RemoteWorkspaceStatus,
): void {
  ctx.ui.setStatus(controlStatusKey, controlStatusLabel(task, status));
}

function remoteTask(task: ReservedTaskState, launchId = task.launchId): RemoteTaskState {
  const { reservationKind: _reservationKind, ...metadata } = task;
  return { ...metadata, phase: "remote", launchId };
}

async function reconcileRemoteTask(
  task: ReservedTaskState | RemoteTaskState,
  knownObservation?: RemoteWorkspaceObservation,
): Promise<{ task: ReservedTaskState | RemoteTaskState; observation: RemoteWorkspaceObservation }> {
  const observation = knownObservation ?? await observeRemoteWorkspace(task);
  if (observation.reconciliation.kind === "conflicting") {
    if (
      task.phase === "reserved"
      && task.reservationKind === "continue"
      && !observation.reconciliation.processRunning
    ) {
      return { task, observation };
    }
    throw new Error(
      `Remote workspace belongs to launch ${observation.reconciliation.recordedLaunchId}, not ${task.launchId}.`,
    );
  }
  const launched = observation.status.kind === "active"
    || observation.status.kind === "prepared"
    || (observation.status.kind === "stopped" && observation.reconciliation.kind === "matching-stopped");
  if (task.phase === "reserved" && launched) {
    const remote = remoteTask(task);
    await saveTask(remote);
    return { task: remote, observation };
  }
  return { task, observation };
}

async function observeTask(task: TaskState): Promise<ObservedTask> {
  if (
    task.phase === "applying"
    || task.phase === "returning"
    || task.phase === "cleanup-pending"
  ) {
    return { kind: "reachable", value: { task } };
  }

  try {
    return { kind: "reachable", value: await reconcileRemoteTask(task) };
  } catch (error) {
    if (!isSshHostUnreachableError(error)) throw error;
    return { kind: "unreachable", task, error };
  }
}

async function withProgress<T>(
  ctx: ExtensionCommandContext,
  initialMessage: string,
  operation: (onProgress: (message: string) => void) => Promise<T>,
): Promise<T> {
  let message = initialMessage;
  let started = Date.now();
  ctx.ui.setStatus("remote-handoff", message);
  const timer = setInterval(() => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    ctx.ui.setStatus("remote-handoff", `${message} (${seconds}s)`);
  }, 1000);
  timer.unref();
  try {
    return await operation((nextMessage) => {
      message = nextMessage;
      started = Date.now();
      ctx.ui.setStatus("remote-handoff", message);
    });
  } finally {
    clearInterval(timer);
  }
}

async function allSettled<T extends readonly unknown[] | []>(
  values: T,
): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  await Promise.allSettled(values);
  return Promise.all(values);
}

async function removeLocalHandoff(task: TaskState): Promise<void> {
  await removeRepositoryData(task, [task.handoffRef, task.resultRef]);
  await removeTaskFiles(task);
}

type ReservationSettlement = "not-applicable" | "reconciled" | "released" | "preserved";

const reservationNotices = {
  released: "Remote Pi never launched. The local conversation reservation was released.",
  preserved: "The new remote run never launched. The stopped handoff was preserved.",
};

async function settleReservation(
  task: ReservedTaskState,
  reconciliation: RemoteWorkspaceObservation["reconciliation"],
): Promise<ReservationSettlement> {
  if (task.reservationKind === "continue" && reconciliation.kind === "conflicting" && !reconciliation.processRunning) {
    await settleUnstartedReservation(task, false);
    const settled = await observeRemoteWorkspace(task);
    if (settled.reconciliation.kind === "conflicting" && !settled.reconciliation.processRunning) {
      await saveTask(remoteTask(task, settled.reconciliation.recordedLaunchId));
      return "preserved";
    }
  } else if (reconciliation.kind === "not-launched" || reconciliation.kind === "matching-unacknowledged") {
    if (task.reservationKind === "start" && await settleUnstartedReservation(task, true)) {
      await removeLocalHandoff(task);
      return "released";
    }
    if (task.reservationKind === "continue" && await settleUnstartedReservation(task, false)) {
      await saveTask(remoteTask(task));
      return "preserved";
    }
  } else {
    return "not-applicable";
  }
  await reconcileRemoteTask(task);
  return "reconciled";
}

function remoteMenu(host: string, status: RemoteWorkspaceStatus): { title: string; items: MenuItem[] } {
  switch (status.kind) {
    case "active":
      return {
        title: `Remote Pi is active on ${host}`,
        items: [
          { action: "attach", label: "attach: open the remote Pi terminal" },
          { action: "status", label: "status: show remote run status" },
          { action: "stop", label: "stop and prepare result" },
        ],
      };
    case "stopped":
      return {
        title: `Remote Pi stopped on ${host} without a result`,
        items: [
          { action: "continue", label: "continue remotely" },
          { action: "status", label: "status: show workspace status" },
          { action: "discard", label: "discard: end this handoff" },
        ],
      };
    case "prepared":
      return {
        title: `Result prepared on ${host}`,
        items: [
          { action: "view-diff", label: "view diff" },
          { action: "continue", label: "continue remotely" },
          { action: "apply", label: "apply" },
          { action: "discard", label: "discard: end this handoff" },
        ],
      };
    case "incomplete":
      return {
        title: `Remote workspace on ${host} needs attention`,
        items: [
          { action: "status", label: "status: show workspace status" },
          { action: "discard", label: "discard: end this handoff" },
        ],
      };
  }
}

function menuForTask(
  task: TaskState,
  status: RemoteWorkspaceStatus | undefined,
  attachmentInUse: boolean,
): { title: string; items: MenuItem[] } {
  const restrictWhileAttached = (
    menu: { title: string; items: MenuItem[] },
  ): { title: string; items: MenuItem[] } => {
    if (!attachmentInUse) return menu;
    return {
      title: `${menu.title}. Another local controller is attached`,
      items: [{ action: "status", label: "status: show current handoff state" }],
    };
  };

  switch (task.phase) {
    case "reserved":
      return restrictWhileAttached({
        title: `Remote startup is being reconciled on ${task.host}`,
        items: [
          { action: "status", label: "status: check startup" },
        ],
      });
    case "remote":
      if (!status) throw new Error("A remote handoff has no observed status.");
      return restrictWhileAttached(remoteMenu(task.host, status));
    case "cleanup-pending":
      return restrictWhileAttached({
        title: `Result applied, cleanup pending on ${task.host}`,
        items: [
          { action: "retry-cleanup", label: "retry cleanup" },
          { action: "status", label: "status: show cleanup state" },
        ],
      });
    case "applying":
      return restrictWhileAttached({
        title: "Returning the prepared result locally",
        items: [{ action: "apply", label: "continue apply recovery" }],
      });
    case "returning":
      return restrictWhileAttached({
        title: "Returning the original conversation locally",
        items: [{ action: "discard", label: "continue ownership return" }],
      });
  }
}

function unreachableMenu(task: TaskState, attachmentInUse = false): { title: string; items: MenuItem[] } {
  return {
    title: attachmentInUse
      ? `Cannot reach ${task.host}. Another local controller is attached`
      : `Cannot reach ${task.host}`,
    items: attachmentInUse
      ? [{ action: "retry-connection", label: "retry connection" }]
      : [
        { action: "retry-connection", label: "retry connection" },
        { action: "abandon", label: "abandon unreachable handoff" },
      ],
  };
}

async function selectMenu(
  ctx: ExtensionCommandContext,
  title: string,
  items: MenuItem[],
): Promise<MenuAction | undefined> {
  const byLabel = new Map(items.map((item): [string, MenuAction] => [item.label, item.action]));
  const selected = await ctx.ui.select(title, [...byLabel.keys()]);
  return selected ? byLabel.get(selected) : undefined;
}

async function selectHost(ctx: ExtensionCommandContext, agentDir: string): Promise<string | undefined> {
  const remotes = await listRemotes(agentDir);
  if (remotes.length === 1) return remotes[0];
  if (remotes.length > 1) return ctx.ui.select("SSH host", remotes);
  return ctx.ui.input("SSH host", "user@server");
}

async function manageRemotes(ctx: ExtensionCommandContext): Promise<void> {
  const agentDir = resolve(getAgentDir());
  const selected = await ctx.ui.select("Saved SSH remotes", ["Add", "Remove", "List"]);
  if (!selected) return;

  if (selected === "List") {
    const remotes = await listRemotes(agentDir);
    ctx.ui.notify(remotes.length > 0 ? remotes.join("\n") : "No saved SSH remotes.", "info");
    return;
  }

  if (selected === "Add") {
    const target = await ctx.ui.input("SSH host", "user@server");
    if (!target) return;
    await addRemote(agentDir, target);
    ctx.ui.notify(`Saved SSH remote: ${target}`, "info");
    return;
  }

  const remotes = await listRemotes(agentDir);
  if (remotes.length === 0) {
    ctx.ui.notify("No saved SSH remotes.", "info");
    return;
  }
  const target = await ctx.ui.select("Remove SSH remote", remotes);
  if (!target) return;
  await removeRemote(agentDir, target);
  ctx.ui.notify(`Removed SSH remote: ${target}`, "info");
}

async function attachWithControlConversation(
  ctx: ExtensionCommandContext,
  reservation: AttachmentReservation,
  watch: (task: RemoteTaskState, ctx: ExtensionContext) => void,
): Promise<void> {
  const { task } = reservation;
  const attach = async (controlContext: ExtensionCommandContext) => {
    let attachmentError: Error | undefined;
    try {
      const code = await attachRemoteRun(controlContext, task);
      const observation = await observeRemoteWorkspace(task);
      if (observation.reconciliation.kind !== "matching-live") {
        controlContext.ui.notify("Remote Pi exited. Checking for a prepared result...", "info");
      } else if (code === 0) {
        controlContext.ui.notify("Detached from remote Pi. Remote Pi keeps running.", "info");
      } else {
        throw new Error(`The remote terminal attachment ended with exit status ${code}.`);
      }
    } catch (error) {
      attachmentError = asError(error);
    }

    let cleanupError: Error | undefined;
    try {
      await releaseAttachment(reservation);
    } catch (error) {
      cleanupError = asError(error);
    }

    if (attachmentError) controlContext.ui.notify(attachmentError.message, "error");
    if (cleanupError) {
      controlContext.ui.notify(`Local attachment cleanup failed: ${cleanupError.message}`, "error");
    }
  };

  if (currentLocation(task, ctx) === "control") {
    await attach(ctx);
    watch(task, ctx);
    return;
  }

  let replacementContext: ExtensionCommandContext | undefined;
  let result: { cancelled: boolean } | undefined;
  try {
    result = await ctx.switchSession(task.controlSessionFile, {
      withSession: async (controlContext) => {
        replacementContext = controlContext;
        await attach(controlContext);
      },
    });
  } catch (error) {
    if (replacementContext) {
      replacementContext.ui.notify(errorMessage(error), "error");
      return;
    }
    let cleanupError: Error | undefined;
    try {
      await releaseAttachment(reservation);
    } catch (cleanupFailure) {
      cleanupError = asError(cleanupFailure);
    }
    if (cleanupError) {
      throw new Error(`${errorMessage(error)} Local attachment cleanup also failed: ${cleanupError.message}`, { cause: error });
    }
    throw error;
  }
  if (replacementContext) return;

  let cleanupError: Error | undefined;
  try {
    await releaseAttachment(reservation);
  } catch (error) {
    cleanupError = asError(error);
  }
  if (result?.cancelled) {
    ctx.ui.notify("The control-conversation switch was canceled. The handoff remains active.", "warning");
  }
  if (cleanupError) ctx.ui.notify(`Local attachment cleanup failed: ${cleanupError.message}`, "error");
}

async function startHandoff(
  ctx: ExtensionCommandContext,
  repository: RepositoryPaths,
): Promise<RemoteTaskState | undefined> {
  ctx.ui.setStatus("remote-handoff", "Waiting for local Pi to become idle...");
  await ctx.waitForIdle();
  if (repository.repositoryKind === "git") {
    await assertRepositoryHasCommits(repository);
    await rejectUnsupportedRepository(repository);
  }

  const localAgentDir = resolve(getAgentDir());
  const host = await selectHost(ctx, localAgentDir);
  if (!host) {
    ctx.ui.setStatus("remote-handoff", undefined);
    return;
  }
  validateSshTarget(host);

  ctx.ui.setStatus("remote-handoff", `Checking remote host ${host}...`);
  const workspace = await resolveNewRemoteWorkspace({
    host,
    repoRoot: repository.repoRoot,
    commonGitDir: repository.commonGitDir,
  });
  await addRemote(localAgentDir, host);
  assertRemoteWorkspaceAvailable(workspace);

  const id = randomUUID();
  const launchId = randomUUID();
  const localDir = taskDirectory(repository.commonGitDir);

  const originalSessionFile = ctx.sessionManager.getSessionFile();
  if (!originalSessionFile || !isAbsolute(originalSessionFile)) {
    throw new Error("The active Pi conversation must be persisted at an absolute path.");
  }
  if (isPathEqualOrInside(localDir, originalSessionFile)) {
    throw new Error("The active Pi conversation must be outside the Remote Handoff directory.");
  }

  const handoffRef = `refs/pi-remote-handoff/${id}/handoff`;
  const resultRef = `refs/pi-remote-handoff/${id}/result`;
  const portableSession = join(localDir, "session.jsonl");
  const handoffBundle = join(localDir, "handoff.bundle");
  const controlSessionFile = join(localDir, "control", "session.jsonl");
  let task: ReservedTaskState | undefined;

  try {
    await initializeRepository(repository, localAgentDir);
    if (repository.repositoryKind === "directory") {
      await rejectUnsupportedRepository(repository);
    }
    await rm(localDir, { recursive: true, force: true });
    await mkdir(localDir, { recursive: true, mode: 0o700 });
    ctx.ui.setStatus("remote-handoff", "Snapshotting conversation, files, and Pi profile...");
    const [exported, handoffCommit, profile] = await allSettled([
      exportActiveBranch(
        ctx.sessionManager,
        portableSession,
        workspace.conversationCwd,
        join(localDir, "original-session.jsonl"),
      ),
      createSnapshot(repository, localDir, handoffRef, "pi-remote-handoff handoff").then(async (commit) => {
        await createBundle(repository, handoffBundle, handoffRef);
        return commit;
      }),
      buildProfile({
        agentDir: localAgentDir,
        homeDir: homedir(),
        remoteProfileHome: workspace.profileHome,
        excludedPackagePath: packageRoot,
      }),
      captureAuthenticationSnapshot(localAgentDir, localDir),
      createControlSession(controlSessionFile, repository.repoRoot),
    ]);
    const piVersion = executingPiVersion();
    const repositoryMetadata = repository.repositoryKind === "directory"
      ? {
          repositoryKind: repository.repositoryKind,
          repoRoot: repository.repoRoot,
          commonGitDir: repository.commonGitDir,
          privateGitDir: repository.privateGitDir,
        }
      : {
          repositoryKind: repository.repositoryKind,
          repoRoot: repository.repoRoot,
          commonGitDir: repository.commonGitDir,
        };

    const reservedTask: ReservedTaskState = {
      version: 8,
      ...repositoryMetadata,
      phase: "reserved",
      reservationKind: "start",
      launchId,
      id,
      host,
      localDir,
      remoteDir: workspace.remoteDir,
      remoteAgentDir: workspace.remoteAgentDir,
      herdrSession: `pi-handoff-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`,
      remoteHerdrCommand: workspace.remoteHerdrCommand,
      handoffCommit,
      handoffRef,
      resultRef,
      originalSessionFile: exported.sourcePath,
      originalSessionId: exported.sessionId,
      originalSessionCwd: exported.sourceCwd,
      originalSessionExisted: exported.sourceExisted,
      originalSessionSnapshotFile: exported.originalSnapshotPath,
      originalSessionSha256: exported.originalSha256,
      controlSessionFile,
      authentication: { kind: "pending", localAgentDir },
    };
    task = reservedTask;
    await saveTask(reservedTask);

    await withProgress(
      ctx,
      "Uploading handoff...",
      (onProgress) => provisionInitialRemoteWorkspace({
        task: reservedTask,
        artifacts: {
          handoffBundle,
          portableSession,
        },
        profile,
        piVersion,
        onProgress,
      }),
    );

    ctx.ui.setStatus("remote-handoff", "Launching remote Pi...");
    const launched = await launchRemoteRun({
      task: reservedTask,
      piVersion,
      trustMode: ctx.isProjectTrusted() ? "--approve" : "--no-approve",
    });
    const reconciled = await reconcileRemoteTask(reservedTask, launched);
    ctx.ui.setStatus("remote-handoff", undefined);
    const { status } = reconciled.observation;
    if (reconciled.task.phase === "remote" && status.kind === "active") return reconciled.task;
    ctx.ui.notify(statusLabel(status), status.kind === "prepared" ? "info" : "error");
  } catch (error) {
    if (!task) {
      await removeRepositoryData(repository, [handoffRef]);
      await rm(localDir, { recursive: true, force: true });
      throw error;
    }
    if (isSshHostUnreachableError(error) || isSshKeyLockedError(error)) {
      throw error;
    }

    try {
      const observation = await observeRemoteWorkspace(task);
      if (await settleReservation(task, observation.reconciliation) === "not-applicable") {
        await reconcileRemoteTask(task);
      }
    } catch (reconcileError) {
      if (isSshHostUnreachableError(reconcileError)) throw error;
    }
    throw error;
  }
}

async function continueRemote(
  ctx: ExtensionCommandContext,
  task: RemoteTaskState,
  status: RemoteWorkspaceStatus,
): Promise<RemoteTaskState | undefined> {
  if (status.kind === "prepared") {
    const confirmed = await ctx.ui.confirm(
      "Continue remote work?",
      "This deletes the prepared result. You will need to stop the new remote run before you can review or apply it.",
    );
    if (!confirmed) return;
  }

  await ctx.waitForIdle();
  if (status.kind === "prepared") {
    ctx.ui.setStatus("remote-handoff", "Invalidating the prepared result...");
    await invalidatePreparedResult(task);
  }

  ctx.ui.setStatus("remote-handoff", "Checking remote runtimes...");
  const piVersion = executingPiVersion();
  const current = await refreshRemoteHerdr(task);
  await saveTask(current);

  await prepareRemoteContinuation({
    task: current,
    piVersion,
    onProgress: (message) => ctx.ui.setStatus("remote-handoff", message),
  });

  const reserved: ReservedTaskState = {
    ...current,
    phase: "reserved",
    reservationKind: "continue",
    launchId: randomUUID(),
  };
  await saveTask(reserved);
  const launched = await launchRemoteRun({
    task: reserved,
    piVersion,
    trustMode: ctx.isProjectTrusted() ? "--approve" : "--no-approve",
  });
  const reconciled = await reconcileRemoteTask(reserved, launched);
  ctx.ui.setStatus("remote-handoff", undefined);
  const reconciledStatus = reconciled.observation.status;
  if (reconciled.task.phase === "remote" && reconciledStatus.kind === "active") return reconciled.task;
  ctx.ui.notify(statusLabel(reconciledStatus), "warning");
}

async function stopAndPrepare(ctx: ExtensionCommandContext, task: RemoteTaskState): Promise<void> {
  ctx.ui.setStatus("remote-handoff", "Stopping remote Pi and preparing its result...");
  const observation = await requestGracefulStop(task, gracefulStopTimeoutMs);
  ctx.ui.setStatus("remote-handoff", undefined);
  if (observation.status.kind === "prepared") {
    ctx.ui.notify(`Result prepared.${errorDetail(observation.status.error)}`, "info");
    return;
  }
  if (observation.status.kind !== "active") {
    ctx.ui.notify(statusLabel(observation.status), "warning");
    return;
  }

  const force = await ctx.ui.confirm(
    "Remote Pi did not stop",
    "Force stop the dedicated remote Herdr session? This can leave no prepared result.",
  );
  if (!force) return;
  const forced = await forceStopRemoteRun(task);
  if (forced.status.kind === "prepared") ctx.ui.notify("Result prepared.", "info");
  else ctx.ui.notify("Remote Pi was force stopped without a prepared result.", "warning");
}

async function importPreparedResult(task: RemoteTaskState): Promise<{
  resultCommit: string;
  remoteSession: string;
}> {
  const downloaded = await downloadPreparedResult(task);
  const resultCommit = await importResult(task, downloaded.bundle, task.resultRef);
  return { resultCommit, remoteSession: downloaded.session };
}

function currentTree(task: TaskState, includedPaths: readonly string[] = []): Promise<string> {
  return snapshotTree(task, task.localDir, task.handoffCommit, includedPaths);
}

async function writePatch(task: TaskState, patch: string): Promise<{ path: string; sha256: string }> {
  const path = join(task.localDir, `apply-${randomUUID()}.patch`);
  await writeFile(path, patch, { flag: "wx", mode: 0o600 });
  return { path, sha256: createHash("sha256").update(patch).digest("hex") };
}

async function removeApplyCandidate(plan: ApplyPlan): Promise<void> {
  await Promise.all([
    rm(plan.patchFile, { force: true }),
    rm(plan.returnedSessionFile, { force: true }),
  ]);
}

function prepareLocalReturnedSession(
  task: RemoteTaskState,
  source: string,
): Promise<{ path: string; sha256: string }> {
  return prepareReturnedSession(
    source,
    join(task.localDir, `returned-session-${randomUUID()}.jsonl`),
    task.originalSessionCwd,
    task.originalSessionId,
  );
}

async function existingFileSha256(path: string): Promise<string | undefined> {
  try {
    return await hashFileSha256(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

interface BuiltApplyPlan {
  plan: ApplyPlan;
  refs: string[];
}

async function buildApplyPlan(
  ctx: ExtensionCommandContext,
  task: RemoteTaskState,
  resultCommit: string,
  remoteSession: string,
): Promise<BuiltApplyPlan | undefined> {
  const paths = await analyzeApplyPaths(task, task.handoffCommit, resultCommit);
  const beforeTree = await currentTree(task, paths.includedPaths);
  const handoffTree = await resolveTree(task, task.handoffCommit);

  if (beforeTree === handoffTree && paths.collisionPaths.length === 0) {
    const patch = await createBinaryPatch(task, task.handoffCommit, resultCommit);
    await checkApplyPatch(task, patch);
    const patchFile = await writePatch(task, patch);
    try {
      const returned = await prepareLocalReturnedSession(task, remoteSession);
      return {
        plan: {
          resultCommit,
          beforeTree,
          afterTree: await resolveTree(task, resultCommit),
          includedPaths: paths.includedPaths,
          patchFile: patchFile.path,
          patchSha256: patchFile.sha256,
          returnedSessionFile: returned.path,
          returnedSessionSha256: returned.sha256,
        },
        refs: [],
      };
    } catch (error) {
      await rm(patchFile.path, { force: true });
      throw error;
    }
  }

  const review = await runInteractiveMergeReview({
    ctx,
    repository: task,
    localDir: task.localDir,
    handoffCommit: task.handoffCommit,
    resultCommit,
    returnedSessionPath: remoteSession,
    expectedSessionId: task.originalSessionId,
    includedPaths: paths.includedPaths,
  });
  if (review.kind === "left") return undefined;
  try {
    const returned = await prepareLocalReturnedSession(task, review.reviewSession.path);
    return {
      plan: {
        ...review.applyPlan,
        returnedSessionFile: returned.path,
        returnedSessionSha256: returned.sha256,
      },
      refs: review.refs,
    };
  } catch (error) {
    await rm(review.applyPlan.patchFile, { force: true });
    for (const ref of review.refs) await deleteRef(task, ref);
    throw error;
  } finally {
    await rm(review.reviewSession.path, { force: true });
  }
}

async function installReturnedConversation(task: ApplyingTaskState): Promise<void> {
  const plan = task.applyPlan;
  if (await hashFileSha256(plan.returnedSessionFile) !== plan.returnedSessionSha256) {
    throw new Error("The returned conversation candidate changed after apply was prepared.");
  }
  const currentHash = await existingFileSha256(task.originalSessionFile);
  if (currentHash === plan.returnedSessionSha256) return;
  if (
    task.originalSessionExisted
      ? currentHash !== task.originalSessionSha256
      : currentHash !== undefined && currentHash !== task.originalSessionSha256
  ) {
    throw new Error("The original conversation changed while the handoff owned it.");
  }
  await atomicWrite(task.originalSessionFile, await readFile(plan.returnedSessionFile));
}

async function applyFiles(task: ApplyingTaskState): Promise<CleanupPendingTaskState> {
  const plan = task.applyPlan;
  if (await hashFileSha256(plan.patchFile) !== plan.patchSha256) {
    throw new Error("The prepared apply patch changed before it was applied.");
  }
  const before = await currentTree(task, plan.includedPaths);
  if (before === plan.beforeTree) {
    const patch = await readFile(plan.patchFile, "utf8");
    await checkApplyPatch(task, patch);
    await applyDelta(task, patch);
  } else if (before !== plan.afterTree) {
    throw new Error("Local files changed after final apply confirmation. The prepared apply cannot continue safely.");
  }

  const after = await currentTree(task, plan.includedPaths);
  if (after !== plan.afterTree) {
    throw new Error("Applying the prepared result did not produce the reviewed file tree.");
  }
  const cleanup: CleanupPendingTaskState = {
    ...task,
    phase: "cleanup-pending",
    authentication: { kind: "returned" },
  };
  await saveTask(cleanup);
  return cleanup;
}

async function retryCleanup(ctx: ExtensionCommandContext, task: CleanupPendingTaskState): Promise<void> {
  ctx.ui.setStatus("remote-handoff", "Removing remote handoff workspace...");
  await cleanupRemoteWorkspace(task);
  await removeLocalHandoff(task);
  ctx.ui.setStatus("remote-handoff", undefined);
  ctx.ui.notify("Prepared result applied and handoff workspace removed.", "info");
}

async function finishApplying(
  ctx: ExtensionCommandContext,
  task: ApplyingTaskState,
): Promise<void> {
  await installReturnedConversation(task);

  const finish = async (localContext: ExtensionCommandContext) => {
    let cleanup: CleanupPendingTaskState;
    try {
      localContext.ui.setStatus("remote-handoff", "Applying reviewed files...");
      cleanup = await applyFiles(task);
    } catch (error) {
      localContext.ui.setStatus("remote-handoff", undefined);
      localContext.ui.notify(errorMessage(error), "error");
      return;
    }
    try {
      await retryCleanup(localContext, cleanup);
    } catch (error) {
      localContext.ui.setStatus("remote-handoff", undefined);
      localContext.ui.notify(
        `The result was applied, but cleanup failed: ${errorMessage(error)}`,
        "warning",
      );
    }
  };

  const switched = await ctx.switchSession(task.originalSessionFile, { withSession: finish });
  if (switched.cancelled) {
    ctx.ui.notify("The conversation switch was canceled. Apply remains recoverable.", "warning");
  }
}

async function returnAuthentication(
  ctx: ExtensionCommandContext,
  task: RemoteTaskState,
): Promise<ReturnedAuthentication> {
  await returnRemoteAuthentication({
    task,
    activeAgentDir: getAgentDir(),
    selectConflict: async (provider) => {
      const local = "Keep local authentication";
      const remote = "Use returned authentication";
      const selected = await ctx.ui.select(provider, [local, remote]);
      if (selected === local) return "local";
      if (selected === remote) return "remote";
      return undefined;
    },
  });
  return { kind: "returned" };
}

async function applyPreparedResult(
  ctx: ExtensionCommandContext,
  task: RemoteTaskState,
): Promise<void> {
  await ctx.waitForIdle();
  ctx.ui.setStatus("remote-handoff", "Downloading prepared result...");
  const imported = await importPreparedResult(task);

  while (true) {
    ctx.ui.setStatus("remote-handoff", "Preparing apply review...");
    let built: BuiltApplyPlan | undefined;
    try {
      built = await buildApplyPlan(ctx, task, imported.resultCommit, imported.remoteSession);
    } catch (error) {
      if (error instanceof LocalFilesChangedError) {
        ctx.ui.notify("Local files changed during merge review. Restarting against the latest files.", "warning");
        continue;
      }
      throw error;
    }
    ctx.ui.setStatus("remote-handoff", undefined);
    if (!built) return;
    const { plan } = built;

    let confirmed: boolean;
    try {
      await showDiff(ctx, task, plan.beforeTree, plan.afterTree, "Changes apply will make", "No file changes.");
      confirmed = await ctx.ui.confirm(
        "Apply prepared result?",
        "Return the reviewed conversation and apply these file changes without staging them?",
      );
    } finally {
      for (const ref of built.refs) await deleteRef(task, ref);
    }
    if (!confirmed) {
      await removeApplyCandidate(plan);
      return;
    }

    if (await currentTree(task, plan.includedPaths) !== plan.beforeTree) {
      await removeApplyCandidate(plan);
      ctx.ui.notify("Local files changed before apply. Restarting review against the latest files.", "warning");
      continue;
    }

    ctx.ui.setStatus("remote-handoff", "Returning remote authentication...");
    const authentication = await returnAuthentication(ctx, task);
    if (await currentTree(task, plan.includedPaths) !== plan.beforeTree) {
      await removeApplyCandidate(plan);
      ctx.ui.setStatus("remote-handoff", undefined);
      ctx.ui.notify("Local files changed while authentication was returning. Restarting review.", "warning");
      continue;
    }
    const applying: ApplyingTaskState = {
      ...task,
      phase: "applying",
      authentication,
      applyPlan: plan,
    };
    await saveTask(applying);
    ctx.ui.setStatus("remote-handoff", undefined);
    await finishApplying(ctx, applying);
    return;
  }
}

async function returnOriginalConversation(
  ctx: ExtensionCommandContext,
  task: ReturningTaskState,
): Promise<void> {
  const finish = async (localContext: ExtensionCommandContext) => {
    await removeLocalHandoff(task);
    localContext.ui.setStatus("remote-handoff", undefined);
    localContext.ui.notify(
      task.returnReason === "discard"
        ? "Handoff discarded and original conversation returned."
        : "Unreachable handoff abandoned locally. Remote data was not removed.",
      task.returnReason === "discard" ? "info" : "warning",
    );
  };

  if (currentLocation(task, ctx) === "original") {
    await finish(ctx);
    return;
  }
  await materializeOriginalConversation(task);
  const switched = await ctx.switchSession(task.originalSessionFile, { withSession: finish });
  if (switched.cancelled) {
    ctx.ui.notify("The original-conversation switch was canceled. Ownership return remains recoverable.", "warning");
  }
}

async function assertOriginalConversationUnchanged(task: TaskState): Promise<void> {
  const currentHash = await existingFileSha256(task.originalSessionFile);
  const unchanged = task.originalSessionExisted
    ? currentHash === task.originalSessionSha256
    : currentHash === undefined || currentHash === task.originalSessionSha256;
  if (!unchanged) {
    throw new Error("The original conversation changed while the handoff owned it.");
  }
}

async function materializeOriginalConversation(task: TaskState): Promise<void> {
  if (task.originalSessionExisted || await existingFileSha256(task.originalSessionFile) !== undefined) return;
  if (await hashFileSha256(task.originalSessionSnapshotFile) !== task.originalSessionSha256) {
    throw new Error("The original conversation snapshot changed while the handoff owned it.");
  }
  await atomicWrite(task.originalSessionFile, await readFile(task.originalSessionSnapshotFile));
}

async function discardHandoff(
  ctx: ExtensionCommandContext,
  task: RemoteTaskState,
  status: RemoteWorkspaceStatus,
): Promise<void> {
  const confirmed = await ctx.ui.confirm(
    "Discard this handoff?",
    status.kind === "prepared"
      ? "Delete the prepared files and remote conversation without applying them?"
      : "Delete the remote workspace and return the unchanged original conversation?",
  );
  if (!confirmed) return;
  await assertOriginalConversationUnchanged(task);

  ctx.ui.setStatus("remote-handoff", "Returning remote authentication...");
  const authentication = await returnAuthentication(ctx, task);
  const returning: ReturningTaskState = {
    ...task,
    phase: "returning",
    returnReason: "discard",
    authentication,
  };
  await saveTask(returning);
  ctx.ui.setStatus("remote-handoff", "Removing remote handoff workspace...");
  await cleanupRemoteWorkspace(returning);
  await returnOriginalConversation(ctx, returning);
}

async function recoverReturning(ctx: ExtensionCommandContext, task: ReturningTaskState): Promise<void> {
  await assertOriginalConversationUnchanged(task);
  if (task.returnReason === "discard") {
    ctx.ui.setStatus("remote-handoff", "Finishing remote workspace removal...");
    await cleanupRemoteWorkspace(task);
  }
  await returnOriginalConversation(ctx, task);
}

async function abandonHandoff(ctx: ExtensionCommandContext, task: TaskState): Promise<void> {
  if (task.phase === "cleanup-pending") {
    throw new Error("Conversation ownership is already local. Retry cleanup instead.");
  }
  const confirmed = await ctx.ui.confirm(
    "Abandon unreachable handoff?",
    "Use this only if the host will never return. Remote files, conversation changes, and refreshed credentials cannot be recovered or deleted.",
  );
  if (!confirmed) return;
  await assertOriginalConversationUnchanged(task);
  if (task.phase === "applying") {
    throw new Error("Apply has already started locally and cannot be abandoned as an unreachable handoff.");
  }

  const returning: ReturningTaskState = {
    ...task,
    phase: "returning",
    returnReason: "abandon",
    authentication: task.authentication,
  };
  await saveTask(returning);
  await returnOriginalConversation(ctx, returning);
}

function registerRemoteHandoffCommand(
  pi: ExtensionAPI,
  handler: (ctx: ExtensionCommandContext) => Promise<void>,
): void {
  pi.registerCommand("remote-handoff", {
    description: "Open the Remote Handoff lifecycle menu",
    handler: async (args, ctx) => {
      try {
        const task = await taskForContext(ctx);
        if (
          task
          && currentLocation(task, ctx) === "control"
          && await currentProcessOwnsAttachment(task)
        ) return;
        if (ctx.mode !== "tui") throw new Error("Remote Handoff requires Pi's interactive TUI.");
        if (args.trim()) throw new Error("Run /remote-handoff without arguments.");
      } catch (error) {
        ctx.ui.setStatus("remote-handoff", undefined);
        ctx.ui.notify(errorMessage(error), "error");
        return;
      }
      await handler(ctx);
    },
  });
}

export default function registerRemoteHandoff(pi: ExtensionAPI) {
  if (process.env.PI_REMOTE_HANDOFF_CONTROL || process.env.PI_REMOTE_HANDOFF_REVIEW) return;

  let sessionClosed = false;
  const watchers = new Map<string, NodeJS.Timeout>();
  const stopWatcher = (commonGitDir: string) => {
    const timer = watchers.get(commonGitDir);
    if (timer) clearInterval(timer);
    watchers.delete(commonGitDir);
  };
  const watch = (task: RemoteTaskState, ctx: ExtensionContext) => {
    stopWatcher(task.commonGitDir);
    setControlStatus(ctx, task);
    let polling = false;
    let unreachable = false;
    const poll = async () => {
      if (sessionClosed || polling) return;
      polling = true;
      try {
        await tryWithRepositoryOperationLock(task.commonGitDir, async () => {
          if (sessionClosed) return;
          const current = await loadTask(task.commonGitDir);
          if (sessionClosed) return;
          if (!current || current.phase !== "remote") {
            if (current) setControlStatus(ctx, current);
            stopWatcher(task.commonGitDir);
            return;
          }
          const { status } = (await reconcileRemoteTask(current)).observation;
          if (sessionClosed) return;
          const connectionWasUnreachable = unreachable;
          unreachable = false;
          setControlStatus(ctx, current, status);
          if (status.kind === "prepared") {
            stopWatcher(task.commonGitDir);
            ctx.ui.notify(
              `Remote result prepared.${errorDetail(status.error)} Open /remote-handoff to review it.`,
              status.error ? "warning" : "info",
            );
          } else if (status.kind === "stopped") {
            stopWatcher(task.commonGitDir);
            ctx.ui.notify("Remote Pi stopped without a prepared result. Open /remote-handoff to continue or discard.", "error");
          } else if (connectionWasUnreachable) {
            ctx.ui.notify(`Connection to ${task.host} restored.`, "info");
          }
        });
      } catch (error) {
        if (sessionClosed) return;
        if (isSshHostUnreachableError(error)) {
          ctx.ui.setStatus(
            controlStatusKey,
            `Cannot reach ${task.host}. Remote Handoff is retrying.`,
          );
          if (!unreachable) {
            unreachable = true;
            ctx.ui.notify(`Cannot reach ${task.host}. Remote Handoff will keep retrying.`, "error");
          }
        } else {
          stopWatcher(task.commonGitDir);
          ctx.ui.setStatus(
            controlStatusKey,
            `Remote status unavailable on ${task.host}. Run /remote-handoff to inspect.`,
          );
          ctx.ui.notify(errorMessage(error), "error");
        }
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void poll(), 3_000);
    timer.unref();
    watchers.set(task.commonGitDir, timer);
    void poll();
  };

  const watchAfterAttachment = (task: RemoteTaskState, ctx: ExtensionContext) => {
    stopWatcher(task.commonGitDir);
    const wait = async () => {
      if (sessionClosed) return;
      if (await currentProcessOwnsAttachment(task)) return;
      if (sessionClosed) return;
      stopWatcher(task.commonGitDir);
      watch(task, ctx);
    };
    const timer = setInterval(() => void wait(), 500);
    timer.unref();
    watchers.set(task.commonGitDir, timer);
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      ctx.ui.setStatus(controlStatusKey, undefined);
      const task = await taskForContext(ctx);
      if (!task || !conversationIsBlocked(task)) return;
      const location = currentLocation(task, ctx);
      if (location === "original" && remoteOwnsConversation(task) && task.phase !== "reserved") {
        ctx.ui.notify(
          "This conversation belongs to Remote Handoff. Local Pi will close. Reopen the repository and use /remote-handoff.",
          "error",
        );
        ctx.shutdown();
        return;
      }
      if (location === "original") {
        ctx.ui.notify(
          task.phase === "reserved"
            ? "This conversation is reserved while remote startup is reconciled. Use /remote-handoff."
            : "Remote Handoff is finishing the local ownership return. Use /remote-handoff to recover it.",
          "warning",
        );
      }
      if (location === "control") {
        setControlStatus(ctx, task);
        if (task.phase === "remote") {
          if (await currentProcessOwnsAttachment(task)) {
            watchAfterAttachment(task, ctx);
          } else {
            watch(task, ctx);
          }
        }
      }
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
    }
  });

  pi.on("input", async (_event, ctx) => {
    try {
      const task = await taskForContext(ctx);
      if (!task || !conversationIsBlocked(task)) {
        return { action: "continue" };
      }
      const location = currentLocation(task, ctx);
      if (location === "unrelated") return { action: "continue" };
      ctx.ui.notify(
        location === "control"
          ? "This is the Remote Handoff control conversation. Run /remote-handoff to manage it."
          : task.phase === "reserved"
            ? "This conversation is reserved while remote startup is reconciled. Run /remote-handoff to manage it."
            : "This conversation belongs to Remote Handoff. Run /remote-handoff to recover it.",
        "warning",
      );
      return { action: "handled" };
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
      return { action: "handled" };
    }
  });

  pi.on("user_bash", async (_event, ctx) => {
    try {
      const task = await taskForContext(ctx);
      if (
        !task
        || currentLocation(task, ctx) !== "control"
        || !(await currentProcessOwnsAttachment(task))
      ) return;
      return {
        result: {
          output: "",
          exitCode: 0,
          cancelled: false,
          truncated: false,
        },
      };
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
      return {
        result: {
          output: "",
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }
  });

  pi.on("session_before_switch", async (event, ctx) => {
    try {
      const currentTask = await taskForContext(ctx);
      if (
        currentTask
        && currentLocation(currentTask, ctx) === "control"
        && await currentProcessOwnsAttachment(currentTask)
      ) {
        ctx.ui.notify("Conversation switching is blocked while the remote terminal is attached.", "warning");
        return { cancel: true };
      }
      if (event.reason !== "resume" || !event.targetSessionFile) return;
      const header = await readSessionBoundaryHeader(resolve(event.targetSessionFile));
      const repository = await resolveRepositoryContext(header.cwd);
      const task = await loadTask(repository.commonGitDir);
      if (!task || !remoteOwnsConversation(task) || header.id !== task.originalSessionId) return;
      ctx.ui.notify("The target conversation belongs to an active Remote Handoff session.", "warning");
      return { cancel: true };
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return;
      ctx.ui.notify(errorMessage(error), "error");
      return { cancel: true };
    }
  });

  const blockOriginalConversationMutation = async (ctx: ExtensionContext, action: string) => {
    try {
      const task = await taskForContext(ctx);
      if (!task || !conversationIsBlocked(task)) return;
      const location = currentLocation(task, ctx);
      const attachedControl = location === "control" && await currentProcessOwnsAttachment(task);
      if (location !== "original" && !attachedControl) return;
      ctx.ui.notify(`${action} is blocked while this conversation belongs to Remote Handoff.`, "warning");
      return { cancel: true };
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
      return { cancel: true };
    }
  };

  pi.on("session_before_fork", async (_event, ctx) => blockOriginalConversationMutation(ctx, "Forking"));
  pi.on("session_before_tree", async (_event, ctx) => blockOriginalConversationMutation(ctx, "Tree navigation"));
  pi.on("session_before_compact", async (_event, ctx) => blockOriginalConversationMutation(ctx, "Compaction"));

  pi.on("session_shutdown", (_event, ctx) => {
    sessionClosed = true;
    for (const timer of watchers.values()) clearInterval(timer);
    watchers.clear();
    ctx.ui.setStatus(controlStatusKey, undefined);
  });

  registerRemoteHandoffCommand(pi, async (ctx) => {
    const repository = await resolveRepositoryContext(ctx.cwd);
    let attachment: AttachmentReservation | undefined;

    ctx.ui.setStatus("remote-handoff", "Waiting for Remote Handoff access...");
    const lifecycle = withRepositoryOperationLock(repository.commonGitDir, async () => {
      while (true) {
        ctx.ui.setStatus("remote-handoff", "Checking Remote Handoff...");
        let task = await loadTask(repository.commonGitDir);
        if (!task) {
          ctx.ui.setStatus("remote-handoff", undefined);
          const action = await selectMenu(ctx, "Remote Handoff action", [
            { action: "start", label: "start: hand off this conversation" },
            { action: "remotes", label: "remotes: manage saved SSH hosts" },
          ]);
          if (action === "start") {
            const active = await startHandoff(ctx, repository);
            if (active) attachment = await reserveAttachment(active);
            return;
          }
          if (action === "remotes") {
            await manageRemotes(ctx);
            continue;
          }
          return;
        }

        const attachmentInUse = await attachmentLeaseIsHeld(task);
        if (attachmentInUse && (task.phase === "applying" || task.phase === "returning")) {
          ctx.ui.setStatus("remote-handoff", undefined);
          ctx.ui.notify(
            "Another local controller is finishing a remote terminal attachment. Retry after it detaches.",
            "warning",
          );
          return;
        }

        if (task.phase === "applying") {
          ctx.ui.setStatus("remote-handoff", undefined);
          await finishApplying(ctx, task);
          return;
        }
        if (task.phase === "returning") {
          ctx.ui.setStatus("remote-handoff", undefined);
          try {
            await recoverReturning(ctx, task);
            return;
          } catch (error) {
            if (!isSshHostUnreachableError(error)) throw error;
            const menu = unreachableMenu(task);
            const action = await selectMenu(ctx, menu.title, menu.items);
            if (action === "retry-connection") continue;
            if (action === "abandon") {
              await abandonHandoff(ctx, task);
            }
            return;
          }
        }

        const observed = await observeTask(task);
        if (observed.kind === "unreachable") {
          ctx.ui.setStatus("remote-handoff", undefined);
          const menu = unreachableMenu(task, attachmentInUse);
          const action = await selectMenu(ctx, menu.title, menu.items);
          if (action === "retry-connection") continue;
          if (action === "abandon") {
            await abandonHandoff(ctx, task);
            return;
          }
          return;
        }
        task = observed.value.task;

        if (task.phase === "reserved" && observed.value.observation) {
          const settlement = await settleReservation(task, observed.value.observation.reconciliation);
          if (settlement !== "not-applicable") {
            if (settlement !== "reconciled") {
              ctx.ui.setStatus("remote-handoff", undefined);
              ctx.ui.notify(reservationNotices[settlement], "warning");
            }
            continue;
          }
        }

        const status = observed.value.observation?.status;
        const menu = menuForTask(task, status, attachmentInUse);
        ctx.ui.setStatus("remote-handoff", undefined);
        const action = await selectMenu(ctx, menu.title, menu.items);
        if (!action) return;

        switch (action) {
          case "attach":
            attachment = await reserveAttachment(remoteContext(task, status).task);
            return;
          case "status":
            if (task.phase === "cleanup-pending") {
              ctx.ui.notify("The result is applied locally. Remote cleanup is still pending.", "warning");
            } else if (status) {
              ctx.ui.notify(statusLabel(status), "info");
            } else {
              ctx.ui.notify(`Remote Handoff phase: ${task.phase}.`, "info");
            }
            continue;
          case "stop":
            await stopAndPrepare(ctx, remoteContext(task, status).task);
            continue;
          case "continue": {
            const remote = remoteContext(task, status);
            const active = await continueRemote(ctx, remote.task, remote.status);
            if (active) attachment = await reserveAttachment(active);
            return;
          }
          case "view-diff": {
            const remote = remoteContext(task, status).task;
            ctx.ui.setStatus("remote-handoff", "Downloading prepared result...");
            const imported = await importPreparedResult(remote);
            ctx.ui.setStatus("remote-handoff", undefined);
            await showDiff(ctx, remote, remote.handoffCommit, imported.resultCommit, "Remote changes", "No changes.");
            continue;
          }
          case "apply":
            await applyPreparedResult(ctx, remoteContext(task, status).task);
            return;
          case "discard": {
            const remote = remoteContext(task, status);
            await discardHandoff(ctx, remote.task, remote.status);
            return;
          }
          case "retry-cleanup":
            if (task.phase !== "cleanup-pending") throw new Error("Cleanup is not pending.");
            await retryCleanup(ctx, task);
            return;
          case "start":
          case "remotes":
          case "retry-connection":
          case "abandon":
            throw new Error(`Unexpected Remote Handoff action: ${action}`);
        }
      }
    });
    try {
      await lifecycle;
    } catch (error) {
      if (!attachment) throw error;
      let cleanupError: Error | undefined;
      try {
        await releaseAttachment(attachment);
      } catch (cleanupFailure) {
        cleanupError = asError(cleanupFailure);
      }
      ctx.ui.setStatus("remote-handoff", undefined);
      ctx.ui.notify(errorMessage(error), "error");
      if (cleanupError) ctx.ui.notify(`Local attachment cleanup failed: ${cleanupError.message}`, "error");
      return;
    }
    if (attachment) await attachWithControlConversation(ctx, attachment, watch);
  });
}
