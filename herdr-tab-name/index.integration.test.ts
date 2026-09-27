import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const extensionPath = path.join(import.meta.dirname, "index.ts");
const agentDir =
  process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const herdrAvailable = !!process.env.HERDR_SOCKET_PATH;
const piCommand = process.platform === "win32" ? "pi.cmd" : "pi";
const herdrCommand = process.platform === "win32" ? "herdr.exe" : "herdr";

function herdr(args: string[]): unknown {
  return JSON.parse(execFileSync(herdrCommand, args, { encoding: "utf8" }));
}

function tabLabel(tabId: string): string {
  return (herdr(["tab", "get", tabId]) as { result: { tab: { label: string } } })
    .result.tab.label;
}

async function usageLines(file: string): Promise<number> {
  if (!existsSync(file)) return 0;
  return (await readFile(file, "utf8")).split("\n").filter(Boolean).length;
}

function waitFor<T>(
  lines: T[],
  predicate: (line: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const found = lines.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error("timed out waiting for pi output"));
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

test(
  "survives a new session while automatic naming is in flight",
  { skip: !herdrAvailable && "requires a running herdr server", timeout: 120_000 },
  async () => {
    const created = herdr(["tab", "create"]) as {
      result: { tab: { tab_id: string } };
    };
    const tabId = created.result.tab.tab_id;
    const initialLabel = tabLabel(tabId);
    const cwd = await mkdtemp(path.join(os.tmpdir(), "herdr-tab-name-"));
    const usageFile = path.join(agentDir, "tmp", "herdr-tab-name", "usage.jsonl");
    const usageBefore = await usageLines(usageFile);
    const stateFile = path.join(
      agentDir,
      "tmp",
      "herdr-tab-name",
      `${tabId.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`,
    );

    const child = spawn(
      piCommand,
      [
        "--mode",
        "rpc",
        "--no-session",
        "-ne",
        "-ns",
        "-nc",
        "--model",
        "openai-codex/gpt-5.6-luna:minimal",
        "-e",
        extensionPath,
      ],
      {
        cwd,
        env: { ...process.env, HERDR_ENV: "1", HERDR_TAB_ID: tabId },
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      },
    );
    const events: Array<Record<string, unknown>> = [];
    let stderr = "";
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        events.push(JSON.parse(line));
      } catch {}
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );
    let exitCode: number | null | undefined;
    exited.then((code) => (exitCode = code));
    const send = (command: Record<string, unknown>) =>
      child.stdin.write(JSON.stringify(command) + "\n");

    try {
      send({
        id: "prompt",
        type: "prompt",
        message: "Fix the login redirect loop in the OAuth callback handler",
      });
      await waitFor(events, (event) => event.type === "agent_start", 30_000);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      send({ id: "new", type: "new_session" });
      await waitFor(events, (event) => event.id === "new", 30_000);

      const deadline = Date.now() + 60_000;
      while (
        exitCode === undefined &&
        Date.now() < deadline &&
        (await usageLines(usageFile)) === usageBefore
      ) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.ok(
        exitCode !== undefined || (await usageLines(usageFile)) > usageBefore,
        "naming model call never finished",
      );
      await new Promise((resolve) => setTimeout(resolve, 2_000));

      assert.equal(exitCode, undefined, `pi exited early: ${stderr}`);
      assert.doesNotMatch(stderr, /uncaughtException|stale/);
      assert.equal(tabLabel(tabId), initialLabel);
    } finally {
      child.kill();
      await exited;
      execFileSync(herdrCommand, ["tab", "close", tabId]);
      await rm(stateFile, { force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
