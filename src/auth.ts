import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withFileLock } from "./file-lock.js";
import { scpFrom, shellQuote, ssh } from "./remote.js";
import type { PendingAuthenticationTaskState } from "./state.js";

type Credential = Record<string, unknown> & (
  | { type: "api_key"; key?: string; env?: Record<string, string> }
  | { type: "oauth"; access: string; refresh: string; expires: number }
);
type Authentication = Map<string, Credential>;
type ProviderValue = Credential | typeof absent;

const absent = Symbol("absent");

export type AuthenticationConflictChoice = "local" | "remote";

export interface ReturnAuthenticationOptions {
  task: PendingAuthenticationTaskState;
  activeAgentDir: string;
  selectConflict: (provider: string) => Promise<AuthenticationConflictChoice | undefined>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCredential(value: unknown): value is Credential {
  if (!isObject(value)) return false;
  switch (value.type) {
    case "api_key": {
      if (Object.hasOwn(value, "key") && typeof value.key !== "string") return false;
      if (!Object.hasOwn(value, "env")) return true;
      const env = value.env;
      return env !== null &&
        typeof env === "object" &&
        !Array.isArray(env) &&
        Object.values(env).every((entry) => typeof entry === "string");
    }
    case "oauth":
      return typeof value.access === "string" &&
        typeof value.refresh === "string" &&
        typeof value.expires === "number" &&
        Number.isFinite(value.expires);
    default:
      return false;
  }
}

function parseAuthentication(contents: string, source: string): Authentication {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error(`${source} contains invalid JSON.`);
  }
  if (!isObject(value)) throw new Error(`${source} must contain a provider-keyed JSON object.`);

  const authentication = new Map<string, Credential>();
  for (const [provider, credential] of Object.entries(value)) {
    if (!isCredential(credential)) {
      throw new Error(`${source} contains an invalid credential for provider ${JSON.stringify(provider)}.`);
    }
    authentication.set(provider, credential);
  }
  return authentication;
}

function encodeJson(value: string | number | boolean | null): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Authentication contains a value that JSON cannot encode.");
  return encoded;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return encodeJson(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${encodeJson(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  throw new Error("Authentication contains a value that JSON cannot encode.");
}

function providerValue(authentication: Authentication, provider: string): ProviderValue {
  return authentication.get(provider) ?? absent;
}

function equalProviderValues(left: ProviderValue, right: ProviderValue): boolean {
  if (left === absent || right === absent) return left === right;
  return canonicalJson(left) === canonicalJson(right);
}

function equalAuthentication(left: Authentication, right: Authentication): boolean {
  const providers = new Set([...left.keys(), ...right.keys()]);
  for (const provider of providers) {
    if (!equalProviderValues(providerValue(left, provider), providerValue(right, provider))) return false;
  }
  return true;
}

function mergeAuthentication(
  base: Authentication,
  local: Authentication,
  remote: Authentication,
  choices: ReadonlyMap<string, AuthenticationConflictChoice>,
): { authentication: Authentication; conflicts: string[] } {
  const authentication = new Map<string, Credential>();
  const conflicts: string[] = [];
  const providers = new Set([...local.keys(), ...remote.keys(), ...base.keys()]);

  for (const provider of providers) {
    const baseValue = providerValue(base, provider);
    const localValue = providerValue(local, provider);
    const remoteValue = providerValue(remote, provider);
    let merged: ProviderValue;

    if (equalProviderValues(localValue, remoteValue)) {
      merged = localValue;
    } else if (equalProviderValues(localValue, baseValue)) {
      merged = remoteValue;
    } else if (equalProviderValues(remoteValue, baseValue)) {
      merged = localValue;
    } else {
      const choice = choices.get(provider);
      if (!choice) {
        conflicts.push(provider);
        continue;
      }
      merged = choice === "local" ? localValue : remoteValue;
    }

    if (merged !== absent) authentication.set(provider, merged);
  }

  return { authentication, conflicts };
}

function serializeAuthentication(authentication: Authentication): string {
  return `${JSON.stringify(Object.fromEntries(authentication), null, 2)}\n`;
}

async function atomicWrite(path: string, contents: string | Buffer): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function captureAuthenticationSnapshot(agentDir: string, localDir: string): Promise<string> {
  const authPath = join(resolve(agentDir), "auth.json");
  const baselinePath = join(localDir, "auth-base.json");
  await mkdir(localDir, { recursive: true });
  await withFileLock(authPath, true, async (checkLock) => {
    const contents = await readFile(authPath);
    parseAuthentication(contents.toString("utf8"), "Local Pi authentication");
    checkLock();
    await atomicWrite(baselinePath, contents);
  });
  return baselinePath;
}

async function downloadRemoteAuthentication(task: PendingAuthenticationTaskState): Promise<Authentication> {
  const profile = `${task.remoteDir}/profile`;
  const remoteAuthPath = `${task.remoteAgentDir}/auth.json`;
  const status = (await ssh(
    task.host,
    [
      `if ! test -e ${shellQuote(profile)}; then`,
      "  printf 'absent'",
      `elif test -f ${shellQuote(remoteAuthPath)} && ! test -L ${shellQuote(remoteAuthPath)}; then`,
      "  printf 'present'",
      `elif test -L ${shellQuote(remoteAuthPath)}; then`,
      "  printf 'invalid'",
      "else",
      "  printf 'missing'",
      "fi",
    ].join("\n"),
  )).stdout;

  if (status === "absent") throw new Error("The private remote Pi profile is missing, so its authentication cannot be returned.");
  if (status === "missing") throw new Error("The private remote Pi profile exists but its authentication file is missing.");
  if (status === "invalid") throw new Error("The private remote Pi authentication file is invalid.");
  if (status !== "present") throw new Error("The remote workspace returned an invalid authentication status.");

  const download = join(task.localDir, `returned-auth-${randomUUID()}.json`);
  try {
    await scpFrom(task.host, remoteAuthPath, download);
    return parseAuthentication(await readFile(download, "utf8"), "Returned remote Pi authentication");
  } finally {
    await rm(download, { force: true });
  }
}

export async function returnRemoteAuthentication(options: ReturnAuthenticationOptions): Promise<void> {
  const localAgentDir = resolve(options.task.authentication.localAgentDir);
  if (resolve(options.activeAgentDir) !== localAgentDir) {
    throw new Error(`This workspace belongs to a different local Pi agent directory: ${localAgentDir}`);
  }

  const remote = await downloadRemoteAuthentication(options.task);

  const baseline = parseAuthentication(
    await readFile(join(options.task.localDir, "auth-base.json"), "utf8"),
    "Remote Handoff authentication baseline",
  );
  const localAuthPath = join(localAgentDir, "auth.json");

  while (true) {
    const pending = await withFileLock(localAuthPath, true, async (checkLock) => {
      const local = parseAuthentication(await readFile(localAuthPath, "utf8"), "Local Pi authentication");
      const merged = mergeAuthentication(baseline, local, remote, new Map());
      if (merged.conflicts.length === 0) {
        checkLock();
        await atomicWrite(localAuthPath, serializeAuthentication(merged.authentication));
        return undefined;
      }
      return { local, conflicts: merged.conflicts };
    });
    if (!pending) return;

    const choices = new Map<string, AuthenticationConflictChoice>();
    for (const provider of pending.conflicts) {
      const choice = await options.selectConflict(provider);
      if (!choice) throw new Error("Authentication conflict resolution was canceled.");
      choices.set(provider, choice);
    }

    const saved = await withFileLock(localAuthPath, true, async (checkLock) => {
      const local = parseAuthentication(await readFile(localAuthPath, "utf8"), "Local Pi authentication");
      if (!equalAuthentication(local, pending.local)) return false;
      const merged = mergeAuthentication(baseline, local, remote, choices);
      if (merged.conflicts.length > 0) {
        throw new Error(`Authentication conflicts remain for providers: ${merged.conflicts.join(", ")}.`);
      }
      checkLock();
      await atomicWrite(localAuthPath, serializeAuthentication(merged.authentication));
      return true;
    });
    if (saved) return;
  }
}
