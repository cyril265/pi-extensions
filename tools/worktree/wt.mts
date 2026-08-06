#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

type CommandHandler = (args: string[]) => void;

type WorktreeInfo = {
  path: string;
  branch: string | null;
  head: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
};

type Options = {
  positionals: string[];
  flags: Map<string, string | boolean>;
};

type ParseOptionsConfig = {
  valueFlags?: readonly string[];
};

type CommandOptionsConfig = {
  command: string;
  valueFlags?: readonly string[];
  booleanFlags?: readonly string[];
  maxPositionals?: number;
  allowExtraPositionals?: boolean;
  strictOptions?: boolean;
};

type BranchContext = {
  options: Options;
  branch: string;
  repoRoot: string;
  worktree: WorktreeInfo | null;
};

const color = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

const commands = new Map<string, CommandHandler>([
  ["help", helpCommand],
  ["new", newCommand],
  ["clone", cloneCommand],
  ["list", listCommand],
  ["ls", listCommand],
  ["path", pathCommand],
  ["remove", removeCommand],
  ["rm", removeCommand],
  ["agent", agentCommand],
]);

main();

function main() {
  const [, , maybeCommand, ...rest] = process.argv;

  if (!maybeCommand || maybeCommand === "help" || maybeCommand === "--help" || maybeCommand === "-h") {
    helpCommand(rest);
    return;
  }

  const handler = commands.get(maybeCommand);

  if (!handler) {
    fail(`Unknown command ${inline(maybeCommand)}. Run ${inline("wt help")}.`);
  }

  handler(rest);
}

function helpCommand(_args: string[]) {
  print([
    `${color.bold}${color.cyan}wt${color.reset} ${color.dim}— tiny git worktree CLI for branch-per-task flow${color.reset}`,
    "",
    `${color.bold}Usage${color.reset}`,
    `  wt new <branch> [--base main] [--path /custom/path] [--no-fetch]`,
    `  wt clone <branch> [--path /custom/path] [--no-fetch]`,
    `  wt list`,
    `  wt path <branch>`,
    `  wt agent <branch> [command [args...]]`,
    `  wt agent <branch> --cmd 'npm test && npm run lint'`,
    `  wt remove <branch> [--delete-branch] [--force]`,
    `  wt help`,
    "",
    `${color.bold}Examples${color.reset}`,
    `  wt new feat-auth-refresh`,
    `  wt clone fix/login-redirect`,
    `  wt clone origin/fix/login-redirect`,
    `  wt new experiment --base origin/main`,
    `  wt list`,
    `  wt agent feat-auth-refresh npm test`,
    `  wt remove feat-auth-refresh --delete-branch`,
    "",
    `${color.bold}Behavior${color.reset}`,
    `  - Creates worktrees next to the current repo as ${inline("repo_branch-name")}`,
    `  - Uses the current git repo/worktree as the source repo`,
    `  - Keeps branch names intact and only slugs the directory name`,
    `  - Creates new branches from ${inline("main")} by default, or ${inline("--base <ref>")}`,
    `  - Refuses ${inline("wt new foo")} when local or remote branch ${inline("foo")} already exists`,
    `  - Clones remote branches with ${inline("wt clone foo")} from ${inline("origin/foo")}, or restores an identical local branch with no worktree`,
    `  - Also accepts ${inline("wt clone origin/foo")} and creates local branch ${inline("foo")}`,
    `  - Copies Rider project settings from ${inline(".idea")} and child project ${inline(".idea")} folders into new worktrees`,
    `  - Configures branch pushes to target ${inline("origin/<branch>")} without pushing`,
    `  - Prefills ${inline("cd <path>")} in interactive terminals after ${inline("wt new")} and ${inline("wt clone")}`,
  ]);
}

function newCommand(args: string[]) {
  const context = resolveBranchContext(args, { command: "new", valueFlags: ["base", "path"], booleanFlags: ["no-fetch"] });
  const { options, branch, repoRoot, worktree } = context;
  const base = readStringFlag(options, "base") ?? "main";
  const shouldFetch = !options.flags.has("no-fetch");
  const customPath = readStringFlag(options, "path");
  const worktreePath = customPath ?? defaultWorktreePath(repoRoot, branch);

  rejectRemoteBranchInputForNew(branch);

  if (worktree) {
    fail(`Branch ${inline(branch)} already has worktree ${inline(worktree.path)}.`);
  }

  if (localBranchExists(repoRoot, branch)) {
    fail(`${inline("wt new")} only creates new branches, and local branch ${inline(branch)} already exists.`);
  }

  if (shouldFetch) {
    info(`Fetching ${inline("origin")}...`);
    runGit(repoRoot, ["fetch", "origin"]);
  }

  const remoteBranch = remoteBranchRef(branch);
  if (remoteBranchExists(repoRoot, branch)) {
    fail(`Remote branch ${inline(remoteBranch)} already exists. Use ${inline(`wt clone ${branch}`)} to clone it, or choose a new branch name.`);
  }

  info(`Creating ${inline(branch)} from ${inline(base)}...`);
  runGit(repoRoot, ["worktree", "add", "--no-track", "-b", branch, worktreePath, base]);

  configureBranchRemote(repoRoot, branch);
  copyRiderSettings(repoRoot, worktreePath);

  print([
    `${color.green}Created${color.reset} ${inline(branch)}`,
    `  Path:   ${worktreePath}`,
    `  Agent:  cd ${shellEscape(worktreePath)} && pi`,
  ]);

  prefillTerminalInput(`cd ${shellEscape(worktreePath)}`);
}

function cloneCommand(args: string[]) {
  const context = resolveRemoteBranchContext(args, { command: "clone", valueFlags: ["path"], booleanFlags: ["no-fetch"] });
  const { options, branch, repoRoot, worktree } = context;
  const shouldFetch = !options.flags.has("no-fetch");
  const customPath = readStringFlag(options, "path");
  const worktreePath = customPath ?? defaultWorktreePath(repoRoot, branch);
  const remoteBranch = remoteBranchRef(branch);

  if (worktree) {
    fail(`Branch ${inline(branch)} already has worktree ${inline(worktree.path)}.`);
  }

  if (shouldFetch) {
    info(`Fetching ${inline("origin")}...`);
    runGit(repoRoot, ["fetch", "origin"]);
  }

  if (!remoteBranchExists(repoRoot, branch)) {
    fail(`Remote branch ${inline(remoteBranch)} was not found.`);
  }

  const restoringExistingBranch = localBranchExists(repoRoot, branch);

  if (restoringExistingBranch && !refsPointToSameCommit(repoRoot, branch, remoteBranch)) {
    fail(`Local branch ${inline(branch)} differs from ${inline(remoteBranch)} and has no worktree. Resolve the branch difference before cloning it.`);
  }

  if (restoringExistingBranch) {
    info(`Restoring worktree for existing local branch ${inline(branch)}...`);
    runGit(repoRoot, ["worktree", "add", worktreePath, branch]);
  } else {
    info(`Cloning ${inline(remoteBranch)} into local branch ${inline(branch)}...`);
    runGit(repoRoot, ["worktree", "add", "--no-track", "-b", branch, worktreePath, remoteBranch]);
  }

  configureBranchRemote(repoRoot, branch);
  copyRiderSettings(repoRoot, worktreePath);

  print([
    restoringExistingBranch
      ? `${color.green}Restored${color.reset} ${inline(branch)}`
      : `${color.green}Cloned${color.reset} ${inline(remoteBranch)} as ${inline(branch)}`,
    `  Path:   ${worktreePath}`,
    `  Agent:  cd ${shellEscape(worktreePath)} && pi`,
  ]);

  prefillTerminalInput(`cd ${shellEscape(worktreePath)}`);
}

function listCommand(args: string[]) {
  validateCommandOptions(parseOptions(args), { command: "list", maxPositionals: 0 });

  const repoRoot = getRepoRoot();
  const current = currentBranch(repoRoot);
  const worktrees = getWorktrees(repoRoot);

  if (worktrees.length === 0) {
    info("No worktrees found.");
    return;
  }

  const rows = worktrees.map((worktree) => {
    const status = worktree.detached
      ? "detached"
      : worktree.branch === current
        ? "current"
        : "ready";

    return {
      branch: worktree.branch ?? "(detached)",
      status,
      path: worktree.path,
      flags: [
        worktree.bare ? "bare" : null,
        worktree.locked ? "locked" : null,
        worktree.prunable ? "prunable" : null,
      ].filter(Boolean).join(", "),
    };
  });
  const sortedRows = [...rows].sort((left, right) => {
    const order = statusOrder(left.status) - statusOrder(right.status);
    if (order !== 0) {
      return order;
    }

    const branchOrder = left.branch.localeCompare(right.branch);
    if (branchOrder !== 0) {
      return branchOrder;
    }

    return left.path.localeCompare(right.path);
  });

  const branchWidth = Math.max(...sortedRows.map((row) => row.branch.length), "branch".length);
  const statusWidth = Math.max(...sortedRows.map((row) => row.status.length), "status".length);

  print([
     `${pad("branch", branchWidth)}  ${pad("status", statusWidth)}  path`,
     `${pad("-".repeat(branchWidth), branchWidth)}  ${pad("-".repeat(statusWidth), statusWidth)}  ${"-".repeat(4)}`,
    ...sortedRows.map((row) => `${pad(row.branch, branchWidth)}  ${paintStatus(row.status, statusWidth)}  ${row.path}${row.flags ? ` ${color.dim}(${row.flags})${color.reset}` : ""}`),
  ]);
}

function pathCommand(args: string[]) {
  const worktree = requireWorktree(resolveBranchContext(args, { command: "path" }));

  console.log(worktree.path);
}

function removeCommand(args: string[]) {
  const context = resolveBranchContext(args, { command: "remove", booleanFlags: ["delete-branch", "force"] });
  const { options, branch, repoRoot } = context;
  const worktree = requireWorktree(context);

  const removeArgs = ["worktree", "remove"];
  if (options.flags.has("force")) {
    removeArgs.push("--force");
  }
  removeArgs.push(worktree.path);

  info(`Removing worktree ${inline(worktree.path)}...`);
  runGit(repoRoot, removeArgs);

  if (options.flags.has("delete-branch")) {
    info(`Deleting branch ${inline(branch)}...`);
    runGit(repoRoot, ["branch", options.flags.has("force") ? "-D" : "-d", branch]);
  }

  print([`${color.green}Removed${color.reset} ${inline(branch)}`]);
}

function agentCommand(args: string[]) {
  const context = resolveBranchContext(args, { command: "agent", valueFlags: ["cmd"], allowExtraPositionals: true, strictOptions: false });
  const worktree = requireWorktree(context);
  const directCommand = context.options.positionals.slice(1);
  const shellCommand = readStringFlag(context.options, "cmd");

  if (shellCommand && directCommand.length > 0) {
    fail(`Use either ${inline("--cmd")} or a direct command after the branch, not both.`);
  }

  const command = directCommand.length > 0 ? directCommand : null;
  const exitCode = command
    ? runCommand(worktree.path, command)
    : runWorktreeShellCommand(worktree.path, shellCommand ?? "pi");

  process.exit(exitCode);
}

function parseOptions(args: string[], config: ParseOptionsConfig = {}): Options {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  const valueFlags = new Set(config.valueFlags ?? []);
  let collectPositionalsOnly = false;

  for (let index = 0; index < args.length; index++) {
    const token = args[index];

    if (collectPositionalsOnly) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      collectPositionalsOnly = true;
      continue;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const trimmed = token.slice(2);
    if (!trimmed) {
      continue;
    }

    const [name, inlineValue] = trimmed.split("=", 2);
    if (inlineValue !== undefined) {
      if (valueFlags.has(name) && inlineValue === "") {
        fail(`Missing value for ${inline(`--${name}`)}.`);
      }

      flags.set(name, inlineValue);
      continue;
    }

    if (valueFlags.has(name)) {
      const next = args[index + 1];
      if (!next || next === "--" || next.startsWith("--")) {
        fail(`Missing value for ${inline(`--${name}`)}.`);
      }

      flags.set(name, next);
      index++;
      continue;
    }

    flags.set(name, true);
  }

  return { positionals, flags };
}

function validateCommandOptions(options: Options, config: CommandOptionsConfig) {
  if (config.strictOptions === false) {
    return;
  }

  const valueFlags = new Set(config.valueFlags ?? []);
  const booleanFlags = new Set(config.booleanFlags ?? []);

  for (const [name, value] of options.flags) {
    if (!valueFlags.has(name) && !booleanFlags.has(name)) {
      fail(`Unknown option ${inline(`--${name}`)} for ${inline(`wt ${config.command}`)}.`);
    }

    if (booleanFlags.has(name) && typeof value === "string") {
      fail(`Option ${inline(`--${name}`)} for ${inline(`wt ${config.command}`)} does not take a value.`);
    }
  }

  const maxPositionals = config.allowExtraPositionals ? Number.POSITIVE_INFINITY : config.maxPositionals ?? 1;

  if (options.positionals.length > maxPositionals) {
    fail(`Unexpected argument ${inline(options.positionals[maxPositionals])} for ${inline(`wt ${config.command}`)}.`);
  }
}

function readStringFlag(options: Options, name: string) {
  const value = options.flags.get(name);
  return typeof value === "string" ? value : null;
}

function getRepoRoot() {
  return runGitText(process.cwd(), ["rev-parse", "--show-toplevel"]);
}

function currentBranch(repoRoot: string) {
  return runGitText(repoRoot, ["branch", "--show-current"]);
}

function localBranchExists(repoRoot: string, branch: string) {
  return gitSucceeds(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
}

function remoteBranchExists(repoRoot: string, branch: string) {
  return gitSucceeds(repoRoot, ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteBranchRef(branch)}`]);
}

function refsPointToSameCommit(repoRoot: string, left: string, right: string) {
  return runGitText(repoRoot, ["rev-parse", "--verify", left]) === runGitText(repoRoot, ["rev-parse", "--verify", right]);
}

function remoteBranchRef(branch: string) {
  return `origin/${branch}`;
}

function configureBranchRemote(repoRoot: string, branch: string) {
  runGit(repoRoot, ["config", `branch.${branch}.remote`, "origin"]);
  runGit(repoRoot, ["config", `branch.${branch}.merge`, `refs/heads/${branch}`]);

  if (!remoteBranchExists(repoRoot, branch)) {
    runGit(repoRoot, ["update-ref", `refs/remotes/origin/${branch}`, branch]);
  }
}

function getWorktrees(repoRoot: string): WorktreeInfo[] {
  const output = runGitText(repoRoot, ["worktree", "list", "--porcelain"]);
  const lines = output.split("\n");
  const worktrees: WorktreeInfo[] = [];
  let current: WorktreeInfo | null = null;

  for (const line of lines) {
    if (!line) {
      if (current) {
        worktrees.push(current);
        current = null;
      }
      continue;
    }

    if (line.startsWith("worktree ")) {
      current = {
        path: line.slice("worktree ".length),
        branch: null,
        head: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("branch ")) {
      current.branch = line.slice("branch refs/heads/".length);
      continue;
    }

    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
      continue;
    }

    if (line === "bare") {
      current.bare = true;
      continue;
    }

    if (line === "detached") {
      current.detached = true;
      continue;
    }

    if (line.startsWith("locked")) {
      current.locked = true;
      continue;
    }

    if (line.startsWith("prunable")) {
      current.prunable = true;
    }
  }

  if (current) {
    worktrees.push(current);
  }

  return worktrees;
}

function findWorktreeByBranch(repoRoot: string, branch: string) {
  return getWorktrees(repoRoot).find((worktree) => worktree.branch === branch) ?? null;
}

function resolveBranchContext(args: string[], config: CommandOptionsConfig): BranchContext {
  const options = parseOptions(args, { valueFlags: config.valueFlags });
  validateCommandOptions(options, config);

  const branch = options.positionals[0];

  if (!branch) {
    fail(`Missing branch name. Example: ${inline(`wt ${config.command} feat-something`)}`);
  }

  const repoRoot = getRepoRoot();
  return {
    options,
    branch,
    repoRoot,
    worktree: findWorktreeByBranch(repoRoot, branch),
  };
}

function resolveRemoteBranchContext(args: string[], config: CommandOptionsConfig): BranchContext {
  const options = parseOptions(args, { valueFlags: config.valueFlags });
  validateCommandOptions(options, config);

  const branchInput = options.positionals[0];

  if (!branchInput) {
    fail(`Missing branch name. Example: ${inline(`wt ${config.command} feat-something`)}`);
  }

  const branch = localBranchName(branchInput);

  if (!branch) {
    fail(`Missing branch name after ${inline("origin/")}. Example: ${inline(`wt ${config.command} origin/feat-something`)}`);
  }

  const repoRoot = getRepoRoot();
  return {
    options,
    branch,
    repoRoot,
    worktree: findWorktreeByBranch(repoRoot, branch),
  };
}

function localBranchName(branch: string) {
  return isOriginBranchInput(branch) ? branch.slice("origin/".length) : branch;
}

function isOriginBranchInput(branch: string) {
  return branch.startsWith("origin/");
}

function rejectRemoteBranchInputForNew(branch: string) {
  if (branch === "origin/") {
    fail(`Missing branch name after ${inline("origin/")}. Use ${inline("wt clone origin/<branch>")} to clone a remote branch.`);
  }

  if (isOriginBranchInput(branch)) {
    fail(`${inline("wt new")} expects a new local branch name. Use ${inline(`wt clone ${branch}`)} to clone the remote branch.`);
  }
}

function requireWorktree(context: BranchContext) {
  if (!context.worktree) {
    fail(`No worktree found for ${inline(context.branch)}.`);
  }

  return context.worktree;
}

function copyRiderSettings(sourceRoot: string, targetRoot: string) {
  let copied = copyRiderSettingsFromIdeaPath(join(sourceRoot, ".idea"), join(targetRoot, ".idea"));

  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sourceIdeaPath = join(sourceRoot, entry.name, ".idea");
    if (!existsSync(sourceIdeaPath)) {
      continue;
    }

    copied += copyRiderSettingsFromIdeaPath(sourceIdeaPath, join(targetRoot, entry.name, ".idea"));
  }

  if (copied > 0) {
    info(`Copied ${copied} Rider setting file${copied === 1 ? "" : "s"}.`);
  }
}

function copyRiderSettingsFromIdeaPath(sourceIdeaPath: string, targetIdeaPath: string) {
  if (!existsSync(sourceIdeaPath)) {
    return 0;
  }

  return copyRiderSettingsDirectory(sourceIdeaPath, sourceIdeaPath, targetIdeaPath, targetIdeaPath);
}

function copyRiderSettingsDirectory(rootPath: string, sourcePath: string, targetPath: string, targetIdeaPath: string): number {
  let copied = 0;

  for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
    const sourceEntryPath = join(sourcePath, entry.name);
    const relativeEntryPath = relative(rootPath, sourceEntryPath);

    if (shouldSkipRiderSetting(relativeEntryPath)) {
      continue;
    }

    const targetEntryPath = join(targetPath, relativeEntryPath);

    if (entry.isDirectory()) {
      copied += copyRiderSettingsDirectory(rootPath, sourceEntryPath, targetPath, targetIdeaPath);
      continue;
    }

    if (!entry.isFile() || !shouldCopyRiderSetting(relativeEntryPath)) {
      continue;
    }

    mkdirSync(dirname(targetEntryPath), { recursive: true });
    copyRiderSettingFile(sourceEntryPath, targetEntryPath, relativeEntryPath, targetIdeaPath);
    copied++;
  }

  return copied;
}

function copyRiderSettingFile(sourcePath: string, targetPath: string, relativePath: string, targetIdeaPath: string) {
  const name = basename(relativePath);

  if (name === "vcs.xml") {
    writeFileSync(targetPath, sanitizeVcsMappings(readFileSync(sourcePath, "utf8")));
    return;
  }

  if (name === "indexLayout.xml") {
    writeFileSync(targetPath, sanitizeIndexLayout(readFileSync(sourcePath, "utf8"), targetIdeaPath));
    return;
  }

  copyFileSync(sourcePath, targetPath);
}

function sanitizeVcsMappings(content: string) {
  return content
    .split("\n")
    .filter((line) => !line.includes("$PROJECT_DIR$/../.."))
    .join("\n");
}

function sanitizeIndexLayout(content: string, targetIdeaPath: string) {
  const targetRootName = basename(targetRootFromIdeaPath(targetIdeaPath));
  const attachedFolders = [
    "    <attachedFolders>",
    `      <Path>../../${targetRootName}</Path>`,
    "    </attachedFolders>",
  ].join("\n");

  return content.replace(/    <attachedFolders>[\s\S]*?    <\/attachedFolders>/, attachedFolders);
}

function targetRootFromIdeaPath(targetIdeaPath: string) {
  const projectDir = dirname(targetIdeaPath);

  if (basename(projectDir) === "backend") {
    return dirname(projectDir);
  }

  return projectDir;
}

function shouldCopyRiderSetting(relativePath: string) {
  const name = basename(relativePath);

  return name === ".gitignore"
    || name === ".name"
    || name.endsWith(".xml")
    || name.endsWith(".DotSettings");
}

function shouldSkipRiderSetting(relativePath: string) {
  const parts = relativePath.split(/[\\/]/);
  const name = parts.at(-1) ?? "";

  return parts.includes("shelf")
    || parts.includes("scratches")
    || parts.includes("httpRequests")
    || name === "workspace.xml"
    || name === "tasks.xml"
    || name === "workspaceModel.xml";
}

function defaultWorktreePath(repoRoot: string, branch: string) {
  const repoName = basename(repoRoot) || "repo";
  const parentDir = dirname(repoRoot);
  const slug = branch
    .trim()
    .replace(/^\.+/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return join(parentDir, `${repoName}_${slug || "worktree"}`);
}

function spawnGit(cwd: string, args: string[], output: "inherit" | "pipe") {
  return spawnSync("git", args, { cwd, stdio: ["ignore", output, output] });
}

function runGit(cwd: string, args: string[]) {
  const result = spawnGit(cwd, args, "inherit");

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runGitText(cwd: string, args: string[]) {
  const result = spawnGit(cwd, args, "pipe");

  if (result.status !== 0) {
    const stderr = result.stderr.toString().trim();
    fail(stderr || `git ${args.join(" ")} failed`);
  }

  return result.stdout.toString().trim();
}

function gitSucceeds(cwd: string, args: string[]) {
  return spawnGit(cwd, args, "pipe").status === 0;
}

function pad(value: string, width: number) {
  return value.padEnd(width, " ");
}

function paintStatus(status: string, width: number) {
  const text = pad(status, width);

  if (status === "current") {
    return `${color.green}${text}${color.reset}`;
  }

  if (status === "detached") {
    return `${color.yellow}${text}${color.reset}`;
  }

  return `${color.blue}${text}${color.reset}`;
}

function statusOrder(status: string) {
  if (status === "current") {
    return 0;
  }

  if (status === "ready") {
    return 1;
  }

  return 2;
}

function inline(value: string) {
  return `${color.bold}${value}${color.reset}`;
}

function info(message: string) {
  console.log(`${color.cyan}›${color.reset} ${message}`);
}

function print(lines: string[]) {
  console.log(lines.join("\n"));
}

function fail(message: string): never {
  console.error(`${color.red}error${color.reset}: ${message}`);
  process.exit(1);
}

function shellEscape(value: string) {
  if (!value.includes("'")) {
    return `'${value}'`;
  }

  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function runCommand(cwd: string, cmd: string[]) {
  info(`Running ${inline(cmd.join(" "))} in ${inline(cwd)}...`);
  return runInheritedProcess(cwd, cmd);
}

function runWorktreeShellCommand(cwd: string, command: string) {
  info(`Running ${inline(command)} in ${inline(cwd)}...`);
  return runInheritedProcess(cwd, ["bash", "-lc", command]);
}

function runInheritedProcess(cwd: string, cmd: string[]) {
  return spawnSync(cmd[0], cmd.slice(1), { cwd, stdio: "inherit" }).status ?? 1;
}

function prefillTerminalInput(command: string) {
  if (!process.stdout.isTTY) {
    return;
  }

  // 0x80017472 is TIOCSTI on macOS: push one byte into the controlling terminal's input queue.
  const injectIntoTty = [
    `open(my $tty, "+<", "/dev/tty") or die "wt: cannot open /dev/tty: $!\\n";`,
    `for my $byte (split //, $ARGV[0]) {`,
    `  ioctl($tty, 0x80017472, $byte) or die "wt: cannot prefill terminal input: $!\\n";`,
    `}`,
  ].join("\n");

  spawnSync("perl", ["-e", injectIntoTty, command], { stdio: ["ignore", "ignore", "inherit"] });
}
