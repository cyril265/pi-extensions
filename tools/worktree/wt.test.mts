import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const wtPath = join(import.meta.dirname, "wt.mts");

test("wt new clones matching frontend dependencies with relative links intact", () => {
  const fixture = createRepositoryFixture();
  const target = join(fixture.root, "feature-worktree");

  try {
    const result = runWt(fixture.repo, ["new", "feature", "--no-fetch", "--path", "../feature-worktree"]);
    const targetPackage = join(target, "frontend/node_modules/example/package.txt");
    const targetLink = join(target, "frontend/node_modules/.bin/example");

    assert.match(result.stdout, /Cloned .*frontend\/node_modules/);
    assert.equal(readFileSync(targetPackage, "utf8"), "source dependency\n");
    assert.equal(readlinkSync(targetLink), "../example/package.txt");

    writeFileSync(targetPackage, "target dependency\n");
    assert.equal(readFileSync(fixture.sourcePackage, "utf8"), "source dependency\n");

    writeFileSync(fixture.sourcePackage, "changed source dependency\n");
    assert.equal(readFileSync(targetPackage, "utf8"), "target dependency\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("wt clone clones matching frontend dependencies", () => {
  const fixture = createRepositoryFixture();
  const target = join(fixture.root, "remote-worktree");

  try {
    git(fixture.repo, ["update-ref", "refs/remotes/origin/remote-feature", "main"]);

    const result = runWt(fixture.repo, ["clone", "remote-feature", "--no-fetch", "--path", target]);

    assert.match(result.stdout, /Cloned .*frontend\/node_modules/);
    assert.equal(readFileSync(join(target, "frontend/node_modules/example/package.txt"), "utf8"), "source dependency\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("wt leaves dependencies uninstalled when no worktree has the target lockfile", () => {
  const fixture = createRepositoryFixture();
  const target = join(fixture.root, "different-worktree");

  try {
    writeFileSync(join(fixture.repo, "frontend/package-lock.json"), '{"lockfileVersion":3,"packages":{"different":{}}}\n');
    git(fixture.repo, ["add", "frontend/package-lock.json"]);
    git(fixture.repo, ["commit", "-m", "different dependencies"]);
    git(fixture.repo, ["branch", "different-base"]);
    git(fixture.repo, ["reset", "--hard", "HEAD~1"]);

    const result = runWt(fixture.repo, ["new", "different", "--base", "different-base", "--no-fetch", "--path", target]);

    assert.equal(existsSync(join(target, "frontend/node_modules")), false);
    assert.match(result.stdout, /No matching frontend dependencies were cloned/);
    assert.match(result.stdout, /npm install/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createRepositoryFixture() {
  const root = mkdtempSync(join(tmpdir(), "wt-cow-test-"));
  const repo = join(root, "repo");
  const frontend = join(repo, "frontend");
  const nodeModules = join(frontend, "node_modules");
  const sourcePackage = join(nodeModules, "example/package.txt");

  mkdirSync(join(nodeModules, ".bin"), { recursive: true });
  mkdirSync(join(nodeModules, "example"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  writeFileSync(join(frontend, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
  writeFileSync(join(nodeModules, ".package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
  writeFileSync(sourcePackage, "source dependency\n");
  symlinkSync("../example/package.txt", join(nodeModules, ".bin/example"));

  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "wt-test@example.com"]);
  git(repo, ["config", "user.name", "wt test"]);
  git(repo, ["add", ".gitignore", "frontend/package-lock.json"]);
  git(repo, ["commit", "-m", "initial"]);

  return { root, repo, sourcePackage };
}

function runWt(cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, [wtPath, ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
