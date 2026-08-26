import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

interface GitOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  preserveOutput?: boolean;
}

export interface RepositoryPaths {
  repoRoot: string;
  commonGitDir: string;
}

export interface MergeReview {
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

export interface FinalizedMergeReview {
  localSnapshotCommit: string;
  resultCommit: string;
  mergedCommit: string;
  beforeTree: string;
  afterTree: string;
  localSnapshotRef: string;
  mergedRef: string;
  patchFile: string;
  patchSha256: string;
}

export function git(args: string[], options: GitOptions): Promise<string> {
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

function resolveGitPath(repoRoot: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(repoRoot, value);
}

async function resolveCommit(repoRoot: string, revision: string): Promise<string> {
  return git(["rev-parse", "--verify", `${revision}^{commit}`], { cwd: repoRoot });
}

export async function resolveRepository(cwd: string): Promise<RepositoryPaths> {
  const repoRoot = await git(["rev-parse", "--show-toplevel"], { cwd });
  const rawCommonGitDir = await git(["rev-parse", "--git-common-dir"], { cwd: repoRoot });
  try {
    await resolveCommit(repoRoot, "HEAD");
  } catch {
    throw new Error("The Git repository has no commits. Create its initial commit before starting a Remote Handoff.");
  }
  return {
    repoRoot,
    commonGitDir: resolveGitPath(repoRoot, rawCommonGitDir),
  };
}

export async function rejectUnsupportedRepository(repoRoot: string): Promise<void> {
  const gitlinks = await git(["ls-files", "--stage"], { cwd: repoRoot });
  const submoduleConfig = await git(
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", ".gitmodules"],
    { cwd: repoRoot },
  );
  if (submoduleConfig || /^160000 /m.test(gitlinks)) {
    throw new Error("Git submodules are not supported by pi-remote-handoff.");
  }

  const paths = await git(
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repoRoot, preserveOutput: true },
  );
  if (!paths) return;
  const attributes = await git(
    ["check-attr", "-z", "--stdin", "filter"],
    { cwd: repoRoot, input: paths, preserveOutput: true },
  );
  const fields = attributes.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 3 !== 0) {
    throw new Error("Git returned malformed content-filter attributes.");
  }
  for (let index = 0; index < fields.length; index += 3) {
    const path = fields[index];
    const value = fields[index + 2];
    if (path && value !== "unspecified" && value !== "unset") {
      throw new Error(`Git content filters are not supported by pi-remote-handoff: ${path}`);
    }
  }

  const attributeFiles = await git(
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", ".gitattributes", "**/.gitattributes"],
    { cwd: repoRoot },
  );
  for (const path of attributeFiles.split("\n").filter(Boolean)) {
    const contents = await readFile(join(repoRoot, path), "utf8");
    if (/(?:^|\s)[!-]?filter(?:=|\s|$)/m.test(contents)) {
      throw new Error(`Git content filters are not supported by pi-remote-handoff: ${path}`);
    }
  }
}

export async function createSnapshot(
  repoRoot: string,
  localDir: string,
  ref: string,
  message: string,
  parentCommit?: string,
  includedPaths: readonly string[] = [],
): Promise<string> {
  await mkdir(localDir, { recursive: true, mode: 0o700 });
  const index = join(localDir, `index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    const parent = await resolveCommit(repoRoot, parentCommit ?? "HEAD");
    await git(["read-tree", parent], { cwd: repoRoot, env });
    await git(["add", "-A", "--", "."], { cwd: repoRoot, env });
    for (const path of includedPaths) {
      try {
        await lstat(join(repoRoot, path));
        await git(["add", "-f", "--", path], { cwd: repoRoot, env });
      } catch (error) {
        if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
          continue;
        }
        throw error;
      }
    }
    if (/^160000 /m.test(await git(["ls-files", "--stage"], { cwd: repoRoot, env }))) {
      throw new Error("Git submodules and embedded repositories are not supported by pi-remote-handoff.");
    }
    const tree = await git(["write-tree"], { cwd: repoRoot, env });
    const commit = await git(["commit-tree", tree, "-p", parent], {
      cwd: repoRoot,
      env,
      input: `${message}\n`,
    });
    await git(["update-ref", ref, commit], { cwd: repoRoot });
    return commit;
  } finally {
    await rm(index, { force: true });
    await rm(`${index}.lock`, { force: true });
  }
}

export async function resolveTree(repoRoot: string, revision: string): Promise<string> {
  return git(["rev-parse", "--verify", `${revision}^{tree}`], { cwd: repoRoot });
}

export async function treesEqual(repoRoot: string, left: string, right: string): Promise<boolean> {
  const [leftTree, rightTree] = await Promise.all([
    resolveTree(repoRoot, left),
    resolveTree(repoRoot, right),
  ]);
  return leftTree === rightTree;
}

export async function createBundle(repoRoot: string, bundlePath: string, ref: string): Promise<void> {
  await git(["bundle", "create", bundlePath, ref], { cwd: repoRoot });
}

export async function importResult(repoRoot: string, bundlePath: string, ref: string): Promise<string> {
  await git(["fetch", "--force", bundlePath, `${ref}:${ref}`], { cwd: repoRoot });
  return resolveCommit(repoRoot, ref);
}

export async function diff(repoRoot: string, from: string, to: string): Promise<string> {
  return await git(["--no-pager", "diff", "--stat", from, to], { cwd: repoRoot }) +
    "\n\n" +
    await git(["--no-pager", "diff", "--binary", from, to], { cwd: repoRoot });
}

export async function createBinaryPatch(repoRoot: string, from: string, to: string): Promise<string> {
  return git(["diff", "--binary", from, to], { cwd: repoRoot, preserveOutput: true });
}

export async function checkApplyPatch(repoRoot: string, patch: string): Promise<void> {
  await git(["apply", "--check", "--binary", "--whitespace=nowarn", "--allow-empty", "-"], {
    cwd: repoRoot,
    input: patch,
  });
}

export async function applyDelta(repoRoot: string, checkedPatch: string): Promise<void> {
  await git(["apply", "--binary", "--whitespace=nowarn", "--allow-empty", "-"], {
    cwd: repoRoot,
    input: checkedPatch,
  });
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

export async function startMergeReview(options: {
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
    await deleteRef(options.repoRoot, localSnapshotRef);
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
    await deleteRef(options.repoRoot, localSnapshotRef);
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

export async function finalizeMergeReview(review: MergeReview): Promise<FinalizedMergeReview> {
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
      await deleteRef(review.repoRoot, checkRef);
    }
    await checkApplyPatch(review.repoRoot, patch);
    return {
      localSnapshotCommit: review.localSnapshotCommit,
      resultCommit: review.resultCommit,
      mergedCommit,
      beforeTree,
      afterTree,
      localSnapshotRef: review.localSnapshotRef,
      mergedRef: review.mergedRef,
      patchFile,
      patchSha256,
    };
  } catch (error) {
    await rm(patchFile, { force: true });
    await deleteRef(review.repoRoot, review.localSnapshotRef);
    await deleteRef(review.repoRoot, review.mergedRef);
    throw error;
  }
}

export interface ApplyPathAnalysis {
  includedPaths: string[];
  collisionPaths: string[];
}

export async function analyzeApplyPaths(
  repoRoot: string,
  handoffCommit: string,
  resultCommit: string,
): Promise<ApplyPathAnalysis> {
  const added = await git(
    ["diff", "--name-only", "--diff-filter=A", "-z", handoffCommit, resultCommit],
    { cwd: repoRoot, preserveOutput: true },
  );
  const addedPaths = added.split("\0").filter(Boolean);
  const includedPaths = new Set(addedPaths);
  const collisions = new Set<string>();
  const isTracked = async (path: string): Promise<boolean> => {
    const tracked = await git(["ls-files", "-z", "--", path], {
      cwd: repoRoot,
      preserveOutput: true,
    });
    return tracked.split("\0").includes(path);
  };

  for (const addedPath of addedPaths) {
    let candidate = addedPath;
    while (candidate !== "." && candidate !== "") {
      try {
        const stats = await lstat(join(repoRoot, candidate));
        if (candidate === addedPath && stats.isDirectory()) {
          collisions.add(candidate);
          includedPaths.add(candidate);
        } else if (!stats.isDirectory() && !(await isTracked(candidate))) {
          collisions.add(candidate);
          includedPaths.add(candidate);
        }
        break;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
          throw error;
        }
        candidate = dirname(candidate);
      }
    }
  }
  return {
    includedPaths: [...includedPaths],
    collisionPaths: [...collisions],
  };
}

export async function discardMergeReview(review: MergeReview): Promise<void> {
  try {
    await removeReviewWorktree(review);
  } finally {
    await deleteRef(review.repoRoot, review.localSnapshotRef);
    await deleteRef(review.repoRoot, review.mergedRef);
  }
}

export async function deleteRef(repoRoot: string, ref: string): Promise<void> {
  await git(["update-ref", "-d", ref], { cwd: repoRoot });
}
