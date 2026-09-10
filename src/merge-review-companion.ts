import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { atomicWrite } from "./atomic-write.js";

function unmergedPaths(cwd: string): Promise<string[]> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      { cwd, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Could not inspect the merge: ${stderr || stdout}`.trim()));
          return;
        }
        resolvePromise(stdout.split("\0").filter(Boolean));
      },
    );
  });
}

type ReviewOutcome = "complete" | "leave";

function writeReviewOutcome(controlDirectory: string, outcome: ReviewOutcome): Promise<void> {
  return atomicWrite(join(controlDirectory, "outcome"), `${outcome}\n`);
}

export default function registerMergeReviewCompanion(pi: ExtensionAPI) {
  if (process.env.PI_REMOTE_HANDOFF_REVIEW !== "1") {
    throw new Error("The merge review companion can run only during a Remote Handoff merge review.");
  }
  const controlDirectory = process.env.PI_REMOTE_HANDOFF_REVIEW_CONTROL;
  if (!controlDirectory || !isAbsolute(controlDirectory)) {
    throw new Error("PI_REMOTE_HANDOFF_REVIEW_CONTROL must be an absolute path.");
  }

  pi.registerCommand("remote-handoff", {
    description: "Manage this Remote Handoff merge review",
    handler: async (args, ctx) => {
      if (args.trim()) throw new Error("Run /remote-handoff without arguments.");
      const complete = "Complete merge review";
      const leave = "Leave merge review";
      const status = "Status";
      const selected = await ctx.ui.select("Remote Handoff merge review", [complete, leave, status]);
      if (!selected) return;

      if (selected === leave) {
        const confirmed = await ctx.ui.confirm(
          "Leave merge review?",
          "Discard the work done in this merge review? The prepared remote result will remain available.",
        );
        if (!confirmed) return;
        await writeReviewOutcome(controlDirectory, "leave");
        ctx.shutdown();
        return;
      }

      const unresolved = await unmergedPaths(ctx.cwd);
      if (selected === status) {
        ctx.ui.notify(
          unresolved.length === 0
            ? "Git has no unmerged paths. Inspect clean merges before completing the review."
            : `Git still has unmerged paths:\n${unresolved.join("\n")}`,
          unresolved.length === 0 ? "info" : "warning",
        );
        return;
      }
      if (unresolved.length > 0) {
        ctx.ui.notify(`Resolve these unmerged paths before completing:\n${unresolved.join("\n")}`, "warning");
        return;
      }

      await writeReviewOutcome(controlDirectory, "complete");
      ctx.shutdown();
    },
  });

  pi.on("session_before_switch", (event, ctx) => {
    const command = event.reason === "new" ? "/new" : "/resume";
    ctx.ui.notify(`${command} is blocked during merge review.`, "warning");
    return { cancel: true };
  });
  pi.on("session_before_fork", (event, ctx) => {
    const command = event.position === "at" ? "/clone" : "/fork";
    ctx.ui.notify(`${command} is blocked during merge review.`, "warning");
    return { cancel: true };
  });
}
