import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

interface GitOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  preserveOutput?: boolean;
}

interface ExistingRepositoryPaths {
  repositoryKind: "git";
  repoRoot: string;
  commonGitDir: string;
}

interface DirectoryRepositoryPaths {
  repositoryKind: "directory";
  repoRoot: string;
  commonGitDir: string;
  privateGitDir: string;
}

export type RepositoryPaths = ExistingRepositoryPaths | DirectoryRepositoryPaths;

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

function repositoryEnvironment(repository: RepositoryPaths, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined {
  if (repository.repositoryKind === "git") return env;
  return {
    ...env,
    GIT_DIR: repository.privateGitDir,
    GIT_WORK_TREE: repository.repoRoot,
  };
}

export function repositoryGit(
  repository: RepositoryPaths,
  args: string[],
  options: Omit<GitOptions, "cwd"> = {},
): Promise<string> {
  const env = repositoryEnvironment(repository, options.env);
  return git(args, {
    ...options,
    cwd: repository.repoRoot,
    ...(env ? { env } : {}),
  });
}

async function resolveCommit(repository: RepositoryPaths, revision: string): Promise<string> {
  return repositoryGit(repository, ["rev-parse", "--verify", `${revision}^{commit}`]);
}

async function resolveThroughExistingAncestor(path: string): Promise<string> {
  let existing = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(existing), ...missing);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const parent = dirname(existing);
    if (parent === existing) throw new Error(`Cannot resolve path: ${path}`);
    missing.unshift(basename(existing));
    existing = parent;
  }
}

export async function resolveDirectoryRepositoryForLookup(
  cwd: string,
  agentDir: string,
): Promise<DirectoryRepositoryPaths> {
  const repoRoot = await realpath(resolve(cwd));
  const hash = createHash("sha256").update(repoRoot).digest("hex");
  const commonGitDir = await resolveThroughExistingAncestor(
    resolve(await realpath(resolve(agentDir)), "remote-handoff", "directories", hash),
  );
  return {
    repositoryKind: "directory",
    repoRoot,
    commonGitDir,
    privateGitDir: join(commonGitDir, "repository.git"),
  };
}

export async function resolveDirectoryRepository(cwd: string, agentDir: string): Promise<DirectoryRepositoryPaths> {
  const repository = await resolveDirectoryRepositoryForLookup(cwd, agentDir);
  const canonicalAgentDir = await realpath(resolve(agentDir));
  if (
    !isPathEqualOrInside(canonicalAgentDir, repository.commonGitDir)
    || isPathEqualOrInside(repository.repoRoot, repository.commonGitDir)
  ) {
    throw new Error("Remote Handoff storage must stay inside the Pi agent directory and outside the handed-off directory.");
  }
  return repository;
}

async function hasGitMarker(cwd: string): Promise<boolean> {
  let directory = cwd;
  while (true) {
    try {
      await lstat(join(directory, ".git"));
      return true;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

export async function resolveRepository(cwd: string, agentDir: string): Promise<RepositoryPaths> {
  const canonicalCwd = await realpath(resolve(cwd));
  if (!(await hasGitMarker(canonicalCwd))) {
    return resolveDirectoryRepository(canonicalCwd, agentDir);
  }
  const repoRoot = await git(["rev-parse", "--show-toplevel"], { cwd });
  const rawCommonGitDir = await git(["rev-parse", "--git-common-dir"], { cwd: repoRoot });
  const repository: ExistingRepositoryPaths = {
    repositoryKind: "git",
    repoRoot,
    commonGitDir: resolveGitPath(repoRoot, rawCommonGitDir),
  };
  try {
    await resolveCommit(repository, "HEAD");
  } catch {
    throw new Error("The Git repository has no commits. Create its initial commit before starting a Remote Handoff.");
  }
  return repository;
}

function isPathEqualOrInside(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export async function initializeRepository(repository: RepositoryPaths): Promise<void> {
  if (repository.repositoryKind === "git") return;
  const resolvedCommonGitDir = await resolveThroughExistingAncestor(repository.commonGitDir);
  if (
    resolvedCommonGitDir !== repository.commonGitDir
    || isPathEqualOrInside(repository.repoRoot, resolvedCommonGitDir)
  ) {
    throw new Error("Remote Handoff storage must stay inside the Pi agent directory and outside the handed-off directory.");
  }

  await rm(repository.privateGitDir, { recursive: true, force: true });
  await mkdir(repository.commonGitDir, { recursive: true, mode: 0o700 });
  try {
    await git(["init", "--bare", "--quiet", repository.privateGitDir], { cwd: repository.repoRoot });
    await repositoryGit(repository, ["config", "core.bare", "false"]);
    await repositoryGit(repository, ["config", "core.worktree", repository.repoRoot]);
    await repositoryGit(repository, ["config", "user.name", "pi-remote-handoff"]);
    await repositoryGit(repository, ["config", "user.email", "pi-remote-handoff@invalid"]);
    const tree = await repositoryGit(repository, ["mktree"], { input: "" });
    const commit = await repositoryGit(repository, ["commit-tree", tree], {
      input: "pi-remote-handoff directory base\n",
    });
    await repositoryGit(repository, ["symbolic-ref", "HEAD", "refs/pi-remote-handoff/base"]);
    await repositoryGit(repository, ["update-ref", "HEAD", commit]);
  } catch (error) {
    await rm(repository.privateGitDir, { recursive: true, force: true });
    throw error;
  }
}

export async function removeRepositoryData(
  repository: RepositoryPaths,
  refs: readonly string[],
): Promise<void> {
  if (repository.repositoryKind === "directory") {
    await rm(repository.privateGitDir, { recursive: true, force: true });
    return;
  }
  for (const ref of refs) await deleteRef(repository, ref);
}

export async function rejectUnsupportedRepository(repository: RepositoryPaths): Promise<void> {
  const gitlinks = await repositoryGit(repository, ["ls-files", "--stage"]);
  const submoduleConfig = await repositoryGit(
    repository,
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", ".gitmodules"],
  );
  if (submoduleConfig || /^160000 /m.test(gitlinks)) {
    throw new Error("Git submodules are not supported by pi-remote-handoff.");
  }

  const paths = await repositoryGit(
    repository,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { preserveOutput: true },
  );
  if (!paths) return;
  const attributes = await repositoryGit(
    repository,
    ["check-attr", "-z", "--stdin", "filter"],
    { input: paths, preserveOutput: true },
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

  const attributeFiles = await repositoryGit(
    repository,
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", ".gitattributes", "**/.gitattributes"],
  );
  for (const path of attributeFiles.split("\n").filter(Boolean)) {
    const contents = await readFile(join(repository.repoRoot, path), "utf8");
    if (/(?:^|\s)[!-]?filter(?:=|\s|$)/m.test(contents)) {
      throw new Error(`Git content filters are not supported by pi-remote-handoff: ${path}`);
    }
  }
}

export async function createSnapshot(
  repository: RepositoryPaths,
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
    const parent = await resolveCommit(repository, parentCommit ?? "HEAD");
    await repositoryGit(repository, ["read-tree", parent], { env });
    const addPaths = repository.repositoryKind === "directory"
      ? [".", ":(top,exclude).git"]
      : ["."];
    await repositoryGit(repository, ["add", "-A", "--", ...addPaths], { env });
    for (const path of includedPaths) {
      try {
        await lstat(join(repository.repoRoot, path));
        await repositoryGit(repository, ["add", "-f", "--", path], { env });
      } catch (error) {
        if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
          continue;
        }
        throw error;
      }
    }
    if (/^160000 /m.test(await repositoryGit(repository, ["ls-files", "--stage"], { env }))) {
      throw new Error("Git submodules and embedded repositories are not supported by pi-remote-handoff.");
    }
    const tree = await repositoryGit(repository, ["write-tree"], { env });
    const commit = await repositoryGit(repository, ["commit-tree", tree, "-p", parent], {
      env,
      input: `${message}\n`,
    });
    await repositoryGit(repository, ["update-ref", ref, commit]);
    return commit;
  } finally {
    await rm(index, { force: true });
    await rm(`${index}.lock`, { force: true });
  }
}

export async function resolveTree(repository: RepositoryPaths, revision: string): Promise<string> {
  return repositoryGit(repository, ["rev-parse", "--verify", `${revision}^{tree}`]);
}

export async function createBundle(repository: RepositoryPaths, bundlePath: string, ref: string): Promise<void> {
  await repositoryGit(repository, ["bundle", "create", bundlePath, ref]);
}

export async function importResult(repository: RepositoryPaths, bundlePath: string, ref: string): Promise<string> {
  await repositoryGit(repository, ["fetch", "--force", bundlePath, `${ref}:${ref}`]);
  return resolveCommit(repository, ref);
}

export async function diff(repository: RepositoryPaths, from: string, to: string): Promise<string> {
  return await repositoryGit(repository, ["--no-pager", "diff", "--stat", from, to])
    + "\n\n"
    + await repositoryGit(repository, ["--no-pager", "diff", "--binary", from, to]);
}

export async function createBinaryPatch(repository: RepositoryPaths, from: string, to: string): Promise<string> {
  return repositoryGit(repository, ["diff", "--binary", from, to], { preserveOutput: true });
}

export async function checkApplyPatch(repository: RepositoryPaths, patch: string): Promise<void> {
  await repositoryGit(repository, ["apply", "--check", "--binary", "--whitespace=nowarn", "--allow-empty", "-"], {
    input: patch,
  });
}

export async function applyDelta(repository: RepositoryPaths, checkedPatch: string): Promise<void> {
  await repositoryGit(repository, ["apply", "--binary", "--whitespace=nowarn", "--allow-empty", "-"], {
    input: checkedPatch,
  });
}

export interface ApplyPathAnalysis {
  includedPaths: string[];
  collisionPaths: string[];
}

export async function analyzeApplyPaths(
  repository: RepositoryPaths,
  handoffCommit: string,
  resultCommit: string,
): Promise<ApplyPathAnalysis> {
  const added = await repositoryGit(
    repository,
    ["diff", "--name-only", "--diff-filter=A", "-z", handoffCommit, resultCommit],
    { preserveOutput: true },
  );
  const addedPaths = added.split("\0").filter(Boolean);
  const includedPaths = new Set(addedPaths);
  const collisions = new Set<string>();
  const isTracked = async (path: string): Promise<boolean> => {
    const tracked = await repositoryGit(repository, ["ls-files", "-z", "--", path], {
      preserveOutput: true,
    });
    return tracked.split("\0").includes(path);
  };

  for (const addedPath of addedPaths) {
    let candidate = addedPath;
    while (candidate !== "." && candidate !== "") {
      try {
        const stats = await lstat(join(repository.repoRoot, candidate));
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

export async function deleteRef(repository: RepositoryPaths, ref: string): Promise<void> {
  await repositoryGit(repository, ["update-ref", "-d", ref]);
}
