import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { repositoryEnvironment, repositoryGit, type RepositoryPaths } from "./git.js";
import { runInTerminal } from "./terminal.js";

export async function showDiff(
  ctx: ExtensionCommandContext,
  repository: RepositoryPaths,
  from: string,
  to: string,
  title: string,
  emptyMessage: string,
): Promise<void> {
  if (!(await repositoryGit(repository, ["diff", "--name-only", from, to]))) {
    ctx.ui.notify(emptyMessage, "info");
    return;
  }
  const exit = await runInTerminal(ctx, "git", ["--paginate", "diff", "--stat", "--binary", from, to], {
    cwd: repository.repoRoot,
    env: repositoryEnvironment(repository, { ...process.env, GIT_PAGER: "less", LESS: `-R -Ps${title}` }),
  });
  if (exit.error) throw exit.error;
  if (exit.code !== 0) throw new Error(`git diff exited with status ${exit.code}.`);
}
