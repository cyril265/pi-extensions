import {
  getAgentDir,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deleteRef,
  discardMergeReview,
  finalizeMergeReview,
  startMergeReview,
  type FinalizedMergeReview,
  type MergeReview,
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

type ReviewOutcome = "complete" | "leave";

interface ReviewPiExit {
  started: boolean;
  error?: Error;
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
    deleteRef(repoRoot, review.localSnapshotRef),
    deleteRef(repoRoot, review.mergedRef),
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
