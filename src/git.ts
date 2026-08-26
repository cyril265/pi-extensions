import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
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

export async function deleteRef(repoRoot: string, ref: string): Promise<void> {
  await git(["update-ref", "-d", ref], { cwd: repoRoot });
}
