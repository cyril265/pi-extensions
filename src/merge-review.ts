import {
  getAgentDir,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkApplyPatch,
  createBinaryPatch,
  createSnapshot,
  resolveTree,
} from "./git.js";
import {
  createReviewSession,
  hashFileSha256,
  type PreparedSessionFile,
} from "./session.js";
import type { ApplyPlan } from "./state.js";

const companionPath = fileURLToPath(new URL("./merge-review-companion.ts", import.meta.url));
const reviewOutcomeMarkerName = "outcome";
const reviewPrompt = `Review the merge Git has prepared in this temporary worktree.

Inspect Git's merge and resolve clear textual conflicts. Inspect files Git merged cleanly too, because the combined code can have semantic conflicts even when Git reports none. In this worktree, the current or ours side is the developer's local version. The incoming or theirs side is the remote prepared result.

When intent is ambiguous, ask the developer before changing the merge. For binary conflicts and path collisions, do not choose a side yourself. Ask whether to keep the local or remote version.

Work only in this temporary worktree. Leave the real repository, its index, and its worktree untouched. Do not commit.

When the merge is ready, run /remote-handoff and choose "Complete merge review". Choose "Leave merge review" to exit without consuming the prepared result.`;

export type MergeReviewApplyPlanInput = Omit<
  ApplyPlan,
  "returnedSessionFile" | "returnedSessionSha256"
>;

export type InteractiveMergeReviewResult =
  | { kind: "left" }
  | {
    kind: "completed";
    applyPlan: MergeReviewApplyPlanInput;
    reviewSession: PreparedSessionFile;
  };

export interface InteractiveMergeReviewOptions {
  ctx: ExtensionCommandContext;
  repoRoot: string;
  localDir: string;
  handoffCommit: string;
  resultCommit: string;
  returnedSessionPath: string;
  expectedSessionId: string;
  includedPaths: readonly string[];
}

interface GitOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  preserveOutput?: boolean;
}

interface MergeReview {
  repoRoot: string;
  localDir: string;
  worktreePath: string;
  temporaryRoot: string;
  handoffCommit: string;
  resultCommit: string;
  localSnapshotCommit: string;
  localSnapshotRef: string;
  mergedRef: string;
  includedPaths: string[];
}

interface FinalizedMergeReview {
  resultCommit: string;
  beforeTree: string;
  afterTree: string;
  localSnapshotRef: string;
  mergedRef: string;
  patchFile: string;
  patchSha256: string;
}

type ReviewOutcome = "complete" | "leave";

interface ReviewPiExit {
  started: boolean;
  error?: Error;
}

function git(args: string[], options: GitOptions): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        encoding: "utf8",
        maxBuffer: 128 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args[0] ?? ""} failed: ${stderr || stdout}`.trim()));
          return;
        }
        resolvePromise(options.preserveOutput ? stdout : stdout.trimEnd());
      },
    );
    child.stdin?.end(options.input);
  });
}

async function deleteReviewRef(repoRoot: string, ref: string): Promise<void> {
  await git(["update-ref", "-d", ref], { cwd: repoRoot });
}

async function listUnmergedPaths(worktreePath: string): Promise<string[]> {
  const output = await git(["diff", "--name-only", "--diff-filter=U", "-z"], {
    cwd: worktreePath,
    preserveOutput: true,
  });
  return output.split("\0").filter(Boolean);
}

async function removeReviewWorktree(review: MergeReview): Promise<void> {
  await git(["worktree", "remove", "--force", review.worktreePath], { cwd: review.repoRoot });
  await rm(review.temporaryRoot, { recursive: true, force: true });
}

async function startMergeReview(options: {
  repoRoot: string;
  localDir: string;
  handoffCommit: string;
  resultCommit: string;
  includedPaths: readonly string[];
}): Promise<MergeReview> {
  try {
    await git(["merge-base", "--is-ancestor", options.handoffCommit, options.resultCommit], {
      cwd: options.repoRoot,
    });
  } catch {
    throw new Error("Prepared result does not descend from the Remote Handoff.");
  }

  const reviewId = randomUUID();
  const localSnapshotRef = `refs/pi-remote-handoff/review-${reviewId}/local`;
  const mergedRef = `refs/pi-remote-handoff/review-${reviewId}/merged`;
  const localSnapshotCommit = await createSnapshot(
    options.repoRoot,
    options.localDir,
    localSnapshotRef,
    "pi-remote-handoff merge review local snapshot",
    options.handoffCommit,
    options.includedPaths,
  );
  let temporaryRoot: string;
  try {
    temporaryRoot = await mkdtemp(join(tmpdir(), "pi-remote-handoff-review-"));
  } catch (error) {
    await deleteReviewRef(options.repoRoot, localSnapshotRef);
    throw error;
  }
  const worktreePath = join(temporaryRoot, "worktree");
  const review: MergeReview = {
    repoRoot: options.repoRoot,
    localDir: options.localDir,
    worktreePath,
    temporaryRoot,
    handoffCommit: options.handoffCommit,
    resultCommit: options.resultCommit,
    localSnapshotCommit,
    localSnapshotRef,
    mergedRef,
    includedPaths: [...options.includedPaths],
  };

  try {
    await git(["worktree", "add", "--detach", worktreePath, localSnapshotCommit], { cwd: options.repoRoot });
    try {
      await git(["merge", "--no-commit", "--no-ff", options.resultCommit], {
        cwd: worktreePath,
        env: { GIT_MERGE_AUTOEDIT: "no" },
      });
    } catch (error) {
      const unmergedPaths = await listUnmergedPaths(worktreePath);
      if (unmergedPaths.length === 0) throw error;
    }
    return review;
  } catch (error) {
    try {
      await removeReviewWorktree(review);
    } catch {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
    await deleteReviewRef(options.repoRoot, localSnapshotRef);
    throw error;
  }
}

async function commitMergedReview(review: MergeReview): Promise<string> {
  const unmergedPaths = await listUnmergedPaths(review.worktreePath);
  if (unmergedPaths.length > 0) {
    throw new Error(`Merge review still has unresolved paths: ${unmergedPaths.join(", ")}.`);
  }
  await git(["add", "-A", "--", "."], { cwd: review.worktreePath });
  if (/^160000 /m.test(await git(["ls-files", "--stage"], { cwd: review.worktreePath }))) {
    throw new Error("Git submodules and embedded repositories are not supported by pi-remote-handoff.");
  }
  const tree = await git(["write-tree"], { cwd: review.worktreePath });
  const commit = await git(
    ["commit-tree", tree, "-p", review.localSnapshotCommit, "-p", review.resultCommit],
    {
      cwd: review.worktreePath,
      input: "pi-remote-handoff merged result\n",
    },
  );
  await git(["update-ref", review.mergedRef, commit], { cwd: review.repoRoot });
  return commit;
}

async function treesEqual(repoRoot: string, left: string, right: string): Promise<boolean> {
  const [leftTree, rightTree] = await Promise.all([
    resolveTree(repoRoot, left),
    resolveTree(repoRoot, right),
  ]);
  return leftTree === rightTree;
}

async function finalizeMergeReview(review: MergeReview): Promise<FinalizedMergeReview> {
  const mergedCommit = await commitMergedReview(review);
  const [beforeTree, afterTree] = await Promise.all([
    resolveTree(review.repoRoot, review.localSnapshotCommit),
    resolveTree(review.repoRoot, mergedCommit),
  ]);
  const patch = await createBinaryPatch(review.repoRoot, review.localSnapshotCommit, mergedCommit);
  const patchFile = join(review.localDir, `apply-${randomUUID()}.patch`);
  await writeFile(patchFile, patch, { flag: "wx", mode: 0o600 });
  const patchSha256 = createHash("sha256").update(patch).digest("hex");

  try {
    await removeReviewWorktree(review);
    const checkRef = `refs/pi-remote-handoff/review-check-${randomUUID()}`;
    try {
      const current = await createSnapshot(
        review.repoRoot,
        review.localDir,
        checkRef,
        "pi-remote-handoff merge review file check",
        review.handoffCommit,
        review.includedPaths,
      );
      if (!(await treesEqual(review.repoRoot, current, review.localSnapshotCommit))) {
        throw new Error("Local files changed during merge review. Start the review again with the current files.");
      }
    } finally {
      await deleteReviewRef(review.repoRoot, checkRef);
    }
    await checkApplyPatch(review.repoRoot, patch);
    return {
      resultCommit: review.resultCommit,
      beforeTree,
      afterTree,
      localSnapshotRef: review.localSnapshotRef,
      mergedRef: review.mergedRef,
      patchFile,
      patchSha256,
    };
  } catch (error) {
    await rm(patchFile, { force: true });
    await deleteReviewRef(review.repoRoot, review.localSnapshotRef);
    await deleteReviewRef(review.repoRoot, review.mergedRef);
    throw error;
  }
}

async function discardMergeReview(review: MergeReview): Promise<void> {
  try {
    await removeReviewWorktree(review);
  } finally {
    await deleteReviewRef(review.repoRoot, review.localSnapshotRef);
    await deleteReviewRef(review.repoRoot, review.mergedRef);
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function executingPiCommand(): string {
  const command = process.argv[1];
  if (!command) throw new Error("Cannot identify the executing Pi command.");
  return command;
}

function spawnReviewPi(options: {
  command: string;
  cwd: string;
  sessionFile: string;
  controlDirectory: string;
  prompt: string | undefined;
  trustMode: "--approve" | "--no-approve";
  agentDir: string;
}): Promise<ReviewPiExit> {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name === "PI_SIMPLE_SUBAGENT" || name.startsWith("PI_SIMPLE_SUBAGENT_")) {
      delete environment[name];
    }
  }

  return new Promise((resolvePromise) => {
    const args = [
      options.trustMode,
      "--session",
      options.sessionFile,
      "--extension",
      companionPath,
    ];
    if (options.prompt !== undefined) args.push("--", options.prompt);

    const child = spawn(
      options.command,
      args,
      {
        cwd: options.cwd,
        env: {
          ...environment,
          PI_REMOTE_HANDOFF_REVIEW: "1",
          PI_REMOTE_HANDOFF_REVIEW_CONTROL: options.controlDirectory,
          PI_CODING_AGENT_DIR: options.agentDir,
        },
        stdio: "inherit",
      },
    );
    let started = false;
    child.once("spawn", () => {
      started = true;
    });
    child.once("error", (error) => resolvePromise({ started, error }));
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise({ started });
        return;
      }
      if (signal) {
        resolvePromise({ started, error: new Error(`Merge review Pi was terminated by ${signal}.`) });
        return;
      }
      resolvePromise({ started, error: new Error(`Merge review Pi exited with status ${code}.`) });
    });
  });
}

async function attachReviewTerminal(
  ctx: ExtensionCommandContext,
  options: Parameters<typeof spawnReviewPi>[0],
): Promise<ReviewPiExit> {
  if (ctx.mode !== "tui") throw new Error("Merge review requires Pi's interactive TUI.");

  return ctx.ui.custom<ReviewPiExit>((tui, _theme, _keybindings, done) => {
    tui.stop();
    process.stdout.write("\u001b[2J\u001b[H");

    void (async () => {
      let result: ReviewPiExit;
      try {
        result = await spawnReviewPi(options);
      } catch (error) {
        result = {
          started: false,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      } finally {
        tui.start();
        tui.requestRender(true);
      }
      done(result);
    })();
    return { render: () => [], invalidate: () => {} };
  });
}

async function readReviewOutcome(controlDirectory: string): Promise<ReviewOutcome | undefined> {
  const marker = join(controlDirectory, reviewOutcomeMarkerName);
  try {
    const stats = await lstat(marker);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("The merge review outcome marker is invalid.");
    }
    const contents = await readFile(marker, "utf8");
    if (contents === "complete\n") return "complete";
    if (contents === "leave\n") return "leave";
    throw new Error("The merge review outcome marker has invalid contents.");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function deleteFinalizedRefs(repoRoot: string, review: FinalizedMergeReview): Promise<void> {
  await Promise.all([
    deleteReviewRef(repoRoot, review.localSnapshotRef),
    deleteReviewRef(repoRoot, review.mergedRef),
  ]);
}

async function cleanupIncompleteReview(options: {
  repoRoot: string;
  review: MergeReview | undefined;
  finalized: FinalizedMergeReview | undefined;
  reviewSession: PreparedSessionFile | undefined;
}): Promise<void> {
  const operations: Promise<unknown>[] = [];

  if (options.finalized) {
    operations.push(
      rm(options.finalized.patchFile, { force: true }),
      deleteFinalizedRefs(options.repoRoot, options.finalized),
    );
  } else if (options.review) {
    operations.push(discardMergeReview(options.review));
  }

  if (options.reviewSession) {
    operations.push(rm(options.reviewSession.path, { force: true }));
  }

  const results = await Promise.allSettled(operations);
  const errors: unknown[] = [];
  for (const result of results) {
    if (result.status === "rejected") errors.push(result.reason);
  }
  if (errors.length > 0) throw new AggregateError(errors, "Could not clean up the merge review.");
}

export async function runInteractiveMergeReview(
  options: InteractiveMergeReviewOptions,
): Promise<InteractiveMergeReviewResult> {
  const agentDir = getAgentDir();
  if (!isAbsolute(agentDir)) throw new Error("The current Pi profile path is not absolute.");

  let review: MergeReview | undefined;
  let reviewSession: PreparedSessionFile | undefined;
  let finalized: FinalizedMergeReview | undefined;
  let keepCompletedResult = false;
  let failure: unknown;

  try {
    review = await startMergeReview({
      repoRoot: options.repoRoot,
      localDir: options.localDir,
      handoffCommit: options.handoffCommit,
      resultCommit: options.resultCommit,
      includedPaths: options.includedPaths,
    });
    const controlDirectory = join(review.temporaryRoot, "control");
    await mkdir(controlDirectory, { mode: 0o700 });
    reviewSession = await createReviewSession(
      options.returnedSessionPath,
      options.localDir,
      review.worktreePath,
      options.expectedSessionId,
    );

    let prompt: string | undefined = reviewPrompt;
    while (true) {
      const exit = await attachReviewTerminal(options.ctx, {
        command: executingPiCommand(),
        cwd: review.worktreePath,
        sessionFile: reviewSession.path,
        controlDirectory,
        prompt,
        trustMode: options.ctx.isProjectTrusted() ? "--approve" : "--no-approve",
        agentDir,
      });
      if (exit.started) prompt = undefined;

      const outcome = await readReviewOutcome(controlDirectory);
      if (outcome === "complete") break;
      if (outcome === "leave") return { kind: "left" };

      const detail = exit.error
        ? `Merge review stopped: ${exit.error.message}\n\n`
        : "Pi exited without choosing Complete or Leave. ";
      const discard = await options.ctx.ui.confirm(
        "Leave merge review?",
        `${detail}Discard the work done in this merge review? Choose No to reopen it.`,
      );
      if (discard) return { kind: "left" };
    }

    finalized = await finalizeMergeReview(review);
    await deleteFinalizedRefs(review.repoRoot, finalized);
    const completedSession = {
      path: reviewSession.path,
      sha256: await hashFileSha256(reviewSession.path),
    };
    keepCompletedResult = true;
    return {
      kind: "completed",
      applyPlan: {
        resultCommit: finalized.resultCommit,
        beforeTree: finalized.beforeTree,
        afterTree: finalized.afterTree,
        includedPaths: [...options.includedPaths],
        patchFile: finalized.patchFile,
        patchSha256: finalized.patchSha256,
      },
      reviewSession: completedSession,
    };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (!keepCompletedResult) {
      try {
        await cleanupIncompleteReview({
          repoRoot: options.repoRoot,
          review,
          finalized,
          reviewSession,
        });
      } catch (cleanupError) {
        if (failure !== undefined) {
          throw new AggregateError([failure, cleanupError], "Merge review and its cleanup failed.");
        }
        throw cleanupError;
      }
    }
  }
}
