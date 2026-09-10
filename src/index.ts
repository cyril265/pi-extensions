import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureAuthenticationSnapshot, returnRemoteAuthentication } from "./auth.js";
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
  diff,
  analyzeApplyPaths,
  assertRepositoryHasCommits,
  importResult,
  initializeRepository,
  rejectUnsupportedRepository,
  removeRepositoryData,
  resolveDirectoryRepository,
  resolveRepository,
  resolveTree,
  type RepositoryPaths,
} from "./git.js";
import { LocalFilesChangedError, runInteractiveMergeReview } from "./merge-review.js";
import { getExecutingPiVersion } from "./pi-version.js";
import { buildProfile } from "./profile.js";
import {
  isSshHostUnreachableError,
  isSshKeyLockedError,
  localHerdrInstallation,
  type TerminalAttachmentEnd,
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
  refreshStoppedRemoteWorkspace,
  requestGracefulStop,
  resolveNewRemoteWorkspace,
  settleUnstartedReservation,
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
  isPathEqualOrInside,
  loadTask,
  removeTaskFiles,
  saveTask,
  taskDirectory,
  tryWithRepositoryOperationLock,
  withRepositoryOperationLock,
  type ActiveTaskState,
  type ApplyingTaskState,
  type ApplyPlan,
  type CleanupPendingTaskState,
  type PendingAuthentication,
  type PreparedTaskState,
  type RemoteOwnedTaskState,
  type ReservedTaskState,
  type ReturnedAuthentication,
  type ReturningTaskState,
  type StoppedTaskState,
  type TaskState,
} from "./state.js";
import { showReadOnlyText } from "./text-viewer.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const controlStatusKey = "remote-handoff-control";
const gracefulStopTimeoutMs = 10_000;

declare global {
  var __piRemoteHandoffProcessInstanceToken: string | undefined;
}

const processInstanceToken = globalThis.__piRemoteHandoffProcessInstanceToken ??= randomUUID();

interface AttachmentReservation {
  task: ActiveTaskState;
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
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function reserveAttachment(task: ActiveTaskState): Promise<AttachmentReservation> {
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
    markerError = error instanceof Error ? error : new Error(String(error));
  }

  try {
    await reservation.lease.release();
  } catch (error) {
    const leaseError = error instanceof Error ? error : new Error(String(error));
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
  return task.phase === "reserved"
    || task.phase === "active"
    || task.phase === "stopped"
    || task.phase === "prepared";
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

function activeStatusLabel(
  state: Extract<RemoteWorkspaceStatus, { kind: "active" }>["state"],
  host: string,
): string {
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
    case "active":
      return `Checking Remote Pi on ${task.host}...`;
    case "stopped":
      return `Remote Pi stopped on ${task.host} without a result. Run /remote-handoff to continue or discard.`;
    case "prepared":
      return `Remote result ready from ${task.host}. Run /remote-handoff to review.`;
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

function remoteOwnedWithPhase(
  task: ReservedTaskState | RemoteOwnedTaskState,
  phase: RemoteOwnedTaskState["phase"],
): RemoteOwnedTaskState {
  return { ...task, phase };
}

async function reconcileRemoteTask(
  task: ReservedTaskState | RemoteOwnedTaskState,
): Promise<ReachableTask> {
  const observation = await observeRemoteWorkspace(task);
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
  let next: TaskState = task;

  switch (observation.status.kind) {
    case "active":
      next = remoteOwnedWithPhase(task, "active");
      break;
    case "prepared":
      next = remoteOwnedWithPhase(task, "prepared");
      break;
    case "stopped":
      if (
        task.phase !== "reserved"
        || observation.reconciliation.kind === "matching-stopped"
      ) {
        next = remoteOwnedWithPhase(task, "stopped");
      }
      break;
    case "incomplete":
      break;
  }

  if (next.phase !== task.phase) await saveTask(next);
  return { task: next, observation };
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

async function removeLocalHandoff(task: TaskState): Promise<void> {
  await removeRepositoryData(task, [task.handoffRef, task.resultRef]);
  await removeTaskFiles(task);
}

async function removePrelaunchReservation(task: ReservedTaskState): Promise<boolean> {
  if (!(await settleUnstartedReservation(task, true))) return false;
  await removeLocalHandoff(task);
  return true;
}

function menuForTask(task: TaskState, attachmentInUse: boolean): { title: string; items: MenuItem[] } {
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
    case "active":
      return restrictWhileAttached({
        title: `Remote Pi is active on ${task.host}`,
        items: [
          { action: "attach", label: "attach: open the remote Pi terminal" },
          { action: "status", label: "status: show remote run status" },
          { action: "stop", label: "stop and prepare result" },
        ],
      });
    case "stopped":
      return restrictWhileAttached({
        title: `Remote Pi stopped on ${task.host} without a result`,
        items: [
          { action: "continue", label: "continue remotely" },
          { action: "status", label: "status: show workspace status" },
          { action: "discard", label: "discard: end this handoff" },
        ],
      });
    case "prepared":
      return restrictWhileAttached({
        title: `Result prepared on ${task.host}`,
        items: [
          { action: "view-diff", label: "view diff" },
          { action: "continue", label: "continue remotely" },
          { action: "apply", label: "apply" },
          { action: "discard", label: "discard: end this handoff" },
        ],
      });
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

async function attachRemoteTerminal(
  ctx: ExtensionCommandContext,
  task: ActiveTaskState,
): Promise<TerminalAttachmentEnd> {
  const outcome = await ctx.ui.custom<TerminalAttachmentEnd | Error>(
    (tui, _theme, _keybindings, done) => {
      let inputTaken = false;
      const releaseInput = () => {
        if (!inputTaken) return;
        inputTaken = false;
        tui.start();
        tui.requestRender(true);
      };

      void (async () => {
        let result: TerminalAttachmentEnd | Error;
        try {
          result = await attachRemoteRun(task, {
            takeInput: () => {
              tui.stop();
              process.stdout.write("\u001b[2J\u001b[H");
              inputTaken = true;
            },
            releaseInput,
          });
        } catch (error) {
          result = error instanceof Error ? error : new Error(String(error));
        } finally {
          releaseInput();
        }
        done(result);
      })();

      return { render: () => [], invalidate: () => {} };
    },
  );

  if (outcome instanceof Error) throw outcome;
  return outcome;
}

async function attachWithControlConversation(
  ctx: ExtensionCommandContext,
  reservation: AttachmentReservation,
  watch: (task: ActiveTaskState, ctx: ExtensionContext) => void,
): Promise<void> {
  const { task } = reservation;
  const attach = async (controlContext: ExtensionCommandContext) => {
    let attachmentError: Error | undefined;
    try {
      const terminalEnd = await attachRemoteTerminal(controlContext, task);
      controlContext.ui.notify(
        terminalEnd === "detached"
          ? "Detached from remote Pi. Remote Pi keeps running."
          : "Remote Pi exited. Checking for a prepared result...",
        "info",
      );
    } catch (error) {
      attachmentError = error instanceof Error ? error : new Error(String(error));
    }

    let cleanupError: Error | undefined;
    try {
      await releaseAttachment(reservation);
    } catch (error) {
      cleanupError = error instanceof Error ? error : new Error(String(error));
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
      replacementContext.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return;
    }
    let cleanupError: Error | undefined;
    try {
      await releaseAttachment(reservation);
    } catch (cleanupFailure) {
      cleanupError = cleanupFailure instanceof Error ? cleanupFailure : new Error(String(cleanupFailure));
    }
    if (cleanupError) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} Local attachment cleanup also failed: ${cleanupError.message}`, { cause: error });
    }
    throw error;
  }
  if (replacementContext) return;

  let cleanupError: Error | undefined;
  try {
    await releaseAttachment(reservation);
  } catch (error) {
    cleanupError = error instanceof Error ? error : new Error(String(error));
  }
  if (result?.cancelled) {
    ctx.ui.notify("The control-conversation switch was canceled. The handoff remains active.", "warning");
  }
  if (cleanupError) ctx.ui.notify(`Local attachment cleanup failed: ${cleanupError.message}`, "error");
}

async function startHandoff(
  ctx: ExtensionCommandContext,
  repository: RepositoryPaths,
): Promise<ActiveTaskState | undefined> {
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

  ctx.ui.setStatus("remote-handoff", "Checking local Herdr...");
  const herdr = await localHerdrInstallation();
  ctx.ui.setStatus("remote-handoff", `Checking remote host ${host}...`);
  const workspace = await resolveNewRemoteWorkspace({
    host,
    repoRoot: repository.repoRoot,
    commonGitDir: repository.commonGitDir,
    herdr,
  });
  await addRemote(localAgentDir, host);
  await assertRemoteWorkspaceAvailable(workspace);

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
    ctx.ui.setStatus("remote-handoff", "Exporting active conversation...");
    const exported = await exportActiveBranch(
      ctx.sessionManager,
      portableSession,
      workspace.conversationCwd,
      join(localDir, "original-session.jsonl"),
    );
    ctx.ui.setStatus("remote-handoff", "Snapshotting local files...");
    const handoffCommit = await createSnapshot(
      repository,
      localDir,
      handoffRef,
      "pi-remote-handoff handoff",
    );
    await rm(handoffBundle, { force: true });
    await createBundle(repository, handoffBundle, handoffRef);
    ctx.ui.setStatus("remote-handoff", "Building portable Pi profile...");
    const profileArchive = await buildProfile({
      agentDir: localAgentDir,
      homeDir: homedir(),
      localDir,
      remoteProfileHome: workspace.profileHome,
      excludedPackagePath: packageRoot,
    });
    const authenticationBaseline = await captureAuthenticationSnapshot(localAgentDir, localDir);
    await createControlSession(controlSessionFile, repository.repoRoot);
    const piVersion = await getExecutingPiVersion();
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
      version: 7,
      ...repositoryMetadata,
      phase: "reserved",
      reservationKind: "start",
      launchId,
      id,
      host,
      localDir,
      remoteDir: workspace.remoteDir,
      remoteAgentDir: workspace.remoteAgentDir,
      remotePiCommand: workspace.remotePiCommand,
      herdrSession: `pi-handoff-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`,
      remoteHerdrCommand: workspace.remoteHerdrCommand,
      herdrVersion: herdr.version,
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
      "Creating private remote workspace...",
      (onProgress) => provisionInitialRemoteWorkspace({
        task: reservedTask,
        artifacts: {
          handoffBundle,
          portableSession,
          profileArchive,
          authenticationBaseline,
        },
        piVersion,
        onProgress,
      }),
    );

    ctx.ui.setStatus("remote-handoff", "Launching remote Pi...");
    await launchRemoteRun({
      task: reservedTask,
      piVersion,
      trustMode: ctx.isProjectTrusted() ? "--approve" : "--no-approve",
    });
    const reconciled = await reconcileRemoteTask(reservedTask);
    const current = reconciled.task;
    ctx.ui.setStatus("remote-handoff", undefined);

    if (current.phase === "active") {
      return current;
    }
    if (reconciled.observation) {
      ctx.ui.notify(
        statusLabel(reconciled.observation.status),
        reconciled.observation.status.kind === "prepared" ? "info" : "error",
      );
    }
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
      if (
        observation.reconciliation.kind === "not-launched"
        || observation.reconciliation.kind === "matching-unacknowledged"
      ) {
        if (!(await removePrelaunchReservation(task))) await reconcileRemoteTask(task);
      } else {
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
  task: StoppedTaskState | PreparedTaskState,
): Promise<ActiveTaskState | undefined> {
  if (task.phase === "prepared") {
    const confirmed = await ctx.ui.confirm(
      "Continue remote work?",
      "This deletes the prepared result. You will need to stop the new remote run before you can review or apply it.",
    );
    if (!confirmed) return;
  }

  await ctx.waitForIdle();
  let stopped: StoppedTaskState;
  if (task.phase === "prepared") {
    ctx.ui.setStatus("remote-handoff", "Invalidating the prepared result...");
    await invalidatePreparedResult(task);
    stopped = { ...task, phase: "stopped" };
    await saveTask(stopped);
  } else {
    stopped = task;
  }

  ctx.ui.setStatus("remote-handoff", "Checking local and remote runtimes...");
  const herdr = await localHerdrInstallation();
  const piVersion = await getExecutingPiVersion();
  const currentStopped = await refreshStoppedRemoteWorkspace(stopped, herdr);
  await saveTask(currentStopped);

  await prepareRemoteContinuation({
    task: currentStopped,
    piVersion,
    onProgress: (message) => ctx.ui.setStatus("remote-handoff", message),
  });

  const reserved: ReservedTaskState = {
    ...currentStopped,
    phase: "reserved",
    reservationKind: "continue",
    launchId: randomUUID(),
  };
  await saveTask(reserved);
  await launchRemoteRun({
    task: reserved,
    piVersion,
    trustMode: ctx.isProjectTrusted() ? "--approve" : "--no-approve",
  });
  const reconciled = await reconcileRemoteTask(reserved);
  ctx.ui.setStatus("remote-handoff", undefined);
  if (reconciled.task.phase === "active") {
    return reconciled.task;
  }
  if (reconciled.observation) {
    ctx.ui.notify(statusLabel(reconciled.observation.status), "warning");
  }
}

async function stopAndPrepare(ctx: ExtensionCommandContext, task: ActiveTaskState): Promise<void> {
  ctx.ui.setStatus("remote-handoff", "Stopping remote Pi and preparing its result...");
  const observation = await requestGracefulStop(task, gracefulStopTimeoutMs);
  if (observation.status.kind === "prepared") {
    const prepared = remoteOwnedWithPhase(task, "prepared");
    await saveTask(prepared);
    ctx.ui.setStatus("remote-handoff", undefined);
    ctx.ui.notify(`Result prepared.${errorDetail(observation.status.error)}`, "info");
    return;
  }
  if (observation.status.kind !== "active") {
    const stopped = remoteOwnedWithPhase(task, "stopped");
    await saveTask(stopped);
    ctx.ui.setStatus("remote-handoff", undefined);
    ctx.ui.notify(statusLabel(observation.status), "warning");
    return;
  }

  ctx.ui.setStatus("remote-handoff", undefined);
  const force = await ctx.ui.confirm(
    "Remote Pi did not stop",
    "Force stop the dedicated remote Herdr session? This can leave no prepared result.",
  );
  if (!force) return;
  const forced = await forceStopRemoteRun(task);
  const phase = forced.status.kind === "prepared" ? "prepared" : "stopped";
  await saveTask(remoteOwnedWithPhase(task, phase));
  ctx.ui.notify(
    phase === "prepared" ? "Result prepared." : "Remote Pi was force stopped without a prepared result.",
    phase === "prepared" ? "info" : "warning",
  );
}

async function importPreparedResult(task: PreparedTaskState): Promise<{
  resultCommit: string;
  remoteSession: string;
}> {
  const downloaded = await downloadPreparedResult(task);
  const resultCommit = await importResult(task, downloaded.bundle, task.resultRef);
  return { resultCommit, remoteSession: downloaded.session };
}

async function currentTree(task: TaskState, includedPaths: readonly string[] = []): Promise<string> {
  const ref = `refs/pi-remote-handoff/${task.id}/current-${randomUUID()}`;
  try {
    const commit = await createSnapshot(
      task,
      task.localDir,
      ref,
      "pi-remote-handoff current files",
      task.handoffCommit,
      includedPaths,
    );
    return resolveTree(task, commit);
  } finally {
    await deleteRef(task, ref);
  }
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

async function prepareLocalReturnedSession(
  task: PreparedTaskState,
  source: string,
): Promise<{ path: string; sha256: string }> {
  const returned = await prepareReturnedSession(
    source,
    task.originalSessionFile,
    task.originalSessionCwd,
    task.originalSessionId,
  );
  const path = join(task.localDir, `returned-session-${randomUUID()}.jsonl`);
  try {
    await copyFile(returned.path, path);
    await chmod(path, 0o600);
    return { path, sha256: await hashFileSha256(path) };
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  } finally {
    await rm(returned.path, { force: true });
  }
}

async function existingFileSha256(path: string): Promise<string | undefined> {
  try {
    return await hashFileSha256(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function buildApplyPlan(
  ctx: ExtensionCommandContext,
  task: PreparedTaskState,
  resultCommit: string,
  remoteSession: string,
): Promise<ApplyPlan | undefined> {
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
        resultCommit,
        beforeTree,
        afterTree: await resolveTree(task, resultCommit),
        includedPaths: paths.includedPaths,
        patchFile: patchFile.path,
        patchSha256: patchFile.sha256,
        returnedSessionFile: returned.path,
        returnedSessionSha256: returned.sha256,
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
      ...review.applyPlan,
      returnedSessionFile: returned.path,
      returnedSessionSha256: returned.sha256,
    };
  } catch (error) {
    await rm(review.applyPlan.patchFile, { force: true });
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

  const temporary = join(dirname(task.originalSessionFile), `.${randomUUID()}.pi-remote-handoff-install.tmp`);
  try {
    await copyFile(plan.returnedSessionFile, temporary);
    await chmod(temporary, 0o600);
    await rename(temporary, task.originalSessionFile);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
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
      localContext.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return;
    }
    try {
      await retryCleanup(localContext, cleanup);
    } catch (error) {
      localContext.ui.setStatus("remote-handoff", undefined);
      localContext.ui.notify(
        `The result was applied, but cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
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
  task: StoppedTaskState | PreparedTaskState,
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
  task: PreparedTaskState,
): Promise<void> {
  await ctx.waitForIdle();
  ctx.ui.setStatus("remote-handoff", "Downloading prepared result...");
  const imported = await importPreparedResult(task);

  while (true) {
    ctx.ui.setStatus("remote-handoff", "Preparing apply review...");
    let plan: ApplyPlan | undefined;
    try {
      plan = await buildApplyPlan(ctx, task, imported.resultCommit, imported.remoteSession);
    } catch (error) {
      if (error instanceof LocalFilesChangedError) {
        ctx.ui.notify("Local files changed during merge review. Restarting against the latest files.", "warning");
        continue;
      }
      throw error;
    }
    ctx.ui.setStatus("remote-handoff", undefined);
    if (!plan) return;

    const patch = await readFile(plan.patchFile, "utf8");
    await showReadOnlyText(ctx, "Changes apply will make", patch.trim() || "No file changes.");
    const confirmed = await ctx.ui.confirm(
      "Apply prepared result?",
      "Return the reviewed conversation and apply these file changes without staging them?",
    );
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
  const temporary = join(dirname(task.originalSessionFile), `.${randomUUID()}.pi-remote-handoff-original.tmp`);
  try {
    await copyFile(task.originalSessionSnapshotFile, temporary);
    await chmod(temporary, 0o600);
    await rename(temporary, task.originalSessionFile);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function discardHandoff(
  ctx: ExtensionCommandContext,
  task: StoppedTaskState | PreparedTaskState,
): Promise<void> {
  const confirmed = await ctx.ui.confirm(
    "Discard this handoff?",
    task.phase === "prepared"
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
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
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
  const watch = (task: ActiveTaskState, ctx: ExtensionContext) => {
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
          if (!current || current.phase !== "active") {
            if (current) setControlStatus(ctx, current);
            stopWatcher(task.commonGitDir);
            return;
          }
          const reconciled = await reconcileRemoteTask(current);
          if (sessionClosed) return;
          const connectionWasUnreachable = unreachable;
          unreachable = false;
          if (reconciled.observation) {
            setControlStatus(ctx, reconciled.task, reconciled.observation.status);
          } else {
            setControlStatus(ctx, reconciled.task);
          }
          if (reconciled.task.phase === "prepared") {
            stopWatcher(task.commonGitDir);
            const status = reconciled.observation?.status;
            ctx.ui.notify(
              `Remote result prepared.${status?.kind === "prepared" ? errorDetail(status.error) : ""} Open /remote-handoff to review it.`,
              status?.kind === "prepared" && status.error ? "warning" : "info",
            );
          } else if (reconciled.task.phase === "stopped") {
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
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
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

  const watchAfterAttachment = (task: ActiveTaskState, ctx: ExtensionContext) => {
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
        if (task.phase === "active") {
          if (await currentProcessOwnsAttachment(task)) {
            watchAfterAttachment(task, ctx);
          } else {
            watch(task, ctx);
          }
        }
      }
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
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
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
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
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
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
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
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
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
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

        if (task.phase === "reserved") {
          const reconciliation = observed.value.observation?.reconciliation;
          if (
            task.reservationKind === "continue"
            && reconciliation?.kind === "conflicting"
            && !reconciliation.processRunning
          ) {
            await settleUnstartedReservation(task, false);
            const settled = await observeRemoteWorkspace(task);
            if (
              settled.reconciliation.kind === "conflicting"
              && !settled.reconciliation.processRunning
            ) {
              const stopped: StoppedTaskState = {
                ...task,
                phase: "stopped",
                launchId: settled.reconciliation.recordedLaunchId,
              };
              await saveTask(stopped);
              ctx.ui.setStatus("remote-handoff", undefined);
              ctx.ui.notify("The new remote run never launched. The stopped handoff was preserved.", "warning");
            } else {
              await reconcileRemoteTask(task);
            }
            continue;
          }
          if (reconciliation?.kind === "not-launched" || reconciliation?.kind === "matching-unacknowledged") {
            if (task.reservationKind === "start") {
              if (await removePrelaunchReservation(task)) {
                ctx.ui.setStatus("remote-handoff", undefined);
                ctx.ui.notify("Remote Pi never launched. The local conversation reservation was released.", "warning");
              } else {
                await reconcileRemoteTask(task);
              }
            } else {
              if (await settleUnstartedReservation(task, false)) {
                const stopped: StoppedTaskState = { ...task, phase: "stopped" };
                await saveTask(stopped);
                ctx.ui.setStatus("remote-handoff", undefined);
                ctx.ui.notify("The new remote run never launched. The stopped handoff was preserved.", "warning");
              } else {
                await reconcileRemoteTask(task);
              }
            }
            continue;
          }
        }

        const menu = menuForTask(task, attachmentInUse);
        ctx.ui.setStatus("remote-handoff", undefined);
        const action = await selectMenu(ctx, menu.title, menu.items);
        if (!action) return;

        switch (action) {
          case "attach":
            if (task.phase !== "active") throw new Error("Remote Pi is not active.");
            attachment = await reserveAttachment(task);
            return;
          case "status":
            if (task.phase === "cleanup-pending") {
              ctx.ui.notify("The result is applied locally. Remote cleanup is still pending.", "warning");
            } else if (observed.value.observation) {
              ctx.ui.notify(statusLabel(observed.value.observation.status), "info");
            } else {
              ctx.ui.notify(`Remote Handoff phase: ${task.phase}.`, "info");
            }
            continue;
          case "stop":
            if (task.phase !== "active") throw new Error("Remote Pi is not active.");
            await stopAndPrepare(ctx, task);
            continue;
          case "continue":
            if (task.phase !== "stopped" && task.phase !== "prepared") {
              throw new Error("This handoff cannot continue remotely in its current phase.");
            }
            {
              const active = await continueRemote(ctx, task);
              if (active) attachment = await reserveAttachment(active);
            }
            return;
          case "view-diff": {
            if (task.phase !== "prepared") throw new Error("No prepared result is available.");
            ctx.ui.setStatus("remote-handoff", "Downloading prepared result...");
            const imported = await importPreparedResult(task);
            const output = (await diff(task, task.handoffCommit, imported.resultCommit)).trim();
            ctx.ui.setStatus("remote-handoff", undefined);
            await showReadOnlyText(ctx, "Remote changes", output || "No changes.");
            continue;
          }
          case "apply":
            if (task.phase !== "prepared") throw new Error("No prepared result is available.");
            await applyPreparedResult(ctx, task);
            return;
          case "discard":
            if (task.phase !== "stopped" && task.phase !== "prepared") {
              throw new Error("This handoff cannot be discarded in its current phase.");
            }
            await discardHandoff(ctx, task);
            return;
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
        cleanupError = cleanupFailure instanceof Error ? cleanupFailure : new Error(String(cleanupFailure));
      }
      ctx.ui.setStatus("remote-handoff", undefined);
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      if (cleanupError) ctx.ui.notify(`Local attachment cleanup failed: ${cleanupError.message}`, "error");
      return;
    }
    if (attachment) await attachWithControlConversation(ctx, attachment, watch);
  });
}
