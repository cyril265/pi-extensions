import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";

const remotesFileName = "pi-remote-handoff-remotes.json";

export function validateSshTarget(target: string): string {
  const parts = target.split("@");
  if (
    !target
    || target.startsWith("-")
    || !/^[A-Za-z0-9_.@-]+$/.test(target)
    || parts.length > 2
    || parts.some((part) => part.length === 0)
  ) {
    throw new Error(`Invalid SSH target: ${JSON.stringify(target)}`);
  }
  return target;
}

function remotesPath(agentDir: string): string {
  return join(resolve(agentDir), remotesFileName);
}

function parseRemotes(contents: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("Saved SSH remotes contain invalid JSON.");
  }
  if (!Array.isArray(value)) throw new Error("Saved SSH remotes must be a JSON array.");

  const remotes: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") throw new Error("Every saved SSH remote must be a string.");
    validateSshTarget(entry);
    if (seen.has(entry)) throw new Error(`Saved SSH remotes contain a duplicate target: ${JSON.stringify(entry)}.`);
    seen.add(entry);
    remotes.push(entry);
  }
  return remotes;
}

async function readRemotes(path: string): Promise<string[]> {
  try {
    return parseRemotes(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function atomicWrite(path: string, remotes: string[]): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(remotes, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function mutateRemotes(agentDir: string, mutation: (remotes: string[]) => string[]): Promise<string[]> {
  const path = remotesPath(agentDir);
  await mkdir(dirname(path), { recursive: true });
  const release = await lockfile.lock(path, {
    realpath: false,
    stale: 30_000,
    retries: {
      retries: 10,
      factor: 2,
      minTimeout: 100,
      maxTimeout: 10_000,
      randomize: true,
    },
  });
  try {
    const remotes = mutation(await readRemotes(path));
    await atomicWrite(path, remotes);
    return remotes;
  } finally {
    await release();
  }
}

export function listRemotes(agentDir: string): Promise<string[]> {
  return readRemotes(remotesPath(agentDir));
}

export async function addRemote(agentDir: string, target: string): Promise<string[]> {
  const validTarget = validateSshTarget(target);
  return mutateRemotes(agentDir, (remotes) => remotes.includes(validTarget) ? remotes : [...remotes, validTarget]);
}

export async function removeRemote(agentDir: string, target: string): Promise<string[]> {
  const validTarget = validateSshTarget(target);
  return mutateRemotes(agentDir, (remotes) => remotes.filter((remote) => remote !== validTarget));
}
