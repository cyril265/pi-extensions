import { execFile } from "node:child_process";
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasErrorCode } from "./errors.js";
import { isRecord } from "./json.js";
import { isPathEqualOrInside } from "./paths.js";

const portableNames = [
  "APPEND_SYSTEM.md",
  "APPEND_SYSTEM.openai-codex.md",
  "SYSTEM.md",
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
  "keybindings.json",
  "models.json",
  "multi-pass.json",
  "pi-cbm-settings.json",
  "pi-sub-bar-settings.json",
  "pi-sub-core-settings.json",
  "pi-vcc-config.json",
  "presets.json",
  "simple-subagent.json",
  "web-providers.json",
  "prompts",
  "themes",
  "agents",
  "skills",
  "extensions",
] as const;

const resourceTypes = ["extensions", "skills", "prompts", "themes"] as const;
const ignoredDirectoryNames = new Set(["node_modules", ".git"]);

type PackageSetting = string | { source: string; [key: string]: unknown };
type ResourceType = (typeof resourceTypes)[number];

interface ProfileSettings {
  packages?: PackageSetting[];
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
  [key: string]: unknown;
}

function parseSettings(contents: string): ProfileSettings {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("Pi settings contain invalid JSON.");
  }
  if (!isRecord(value)) throw new Error("Pi settings must contain a JSON object.");

  let packages: PackageSetting[] | undefined;
  if (value.packages !== undefined) {
    if (!Array.isArray(value.packages)) throw new Error("Pi settings packages must be an array.");
    packages = value.packages.map((entry) => {
      if (typeof entry === "string") return entry;
      if (!isRecord(entry) || typeof entry.source !== "string" || entry.source.length === 0) {
        throw new Error("Each Pi settings package must be a source string or an object with a source string.");
      }
      return { ...entry, source: entry.source };
    });
    if (packages.some((entry) => typeof entry === "string" && entry.length === 0)) {
      throw new Error("Pi settings package sources cannot be empty.");
    }
  }

  const resources = new Map<ResourceType, string[]>();
  for (const type of resourceTypes) {
    const entries = value[type];
    if (entries === undefined) continue;
    if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === "string")) {
      throw new Error(`Pi settings ${type} must be an array of strings.`);
    }
    resources.set(type, entries);
  }

  return {
    ...value,
    ...(packages ? { packages } : {}),
    ...Object.fromEntries(resources),
  };
}

export interface BuildProfileOptions {
  agentDir: string;
  homeDir: string;
  localDir: string;
  remoteProfileHome: string;
  excludedPackagePath?: string;
}

function sourceOf(setting: PackageSetting): string {
  return typeof setting === "string" ? setting : setting.source;
}

function withSource(setting: PackageSetting, source: string): PackageSetting {
  return typeof setting === "string" ? source : { ...setting, source };
}

function isRemotePackageSource(source: string): boolean {
  return /^(?:npm:|git:|github:|https?:|ssh:|git@)/.test(source);
}

function rewriteHomeString(value: string, localHome: string, remoteHome: string): string {
  const prefix = /^[!+-]/.test(value) ? value[0]! : "";
  const path = prefix ? value.slice(1) : value;
  if (path === "~") return `${prefix}${remoteHome}`;
  if (path.startsWith("~/")) return `${prefix}${remoteHome}/${path.slice(2)}`;
  if (path === localHome) return `${prefix}${remoteHome}`;
  if (path.startsWith(`${localHome}/`)) return `${prefix}${remoteHome}${path.slice(localHome.length)}`;
  return value;
}

function rewriteHome(value: unknown, localHome: string, remoteHome: string): unknown {
  if (typeof value === "string") return rewriteHomeString(value, localHome, remoteHome);
  if (Array.isArray(value)) return value.map((child) => rewriteHome(child, localHome, remoteHome));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, rewriteHome(child, localHome, remoteHome)]),
    );
  }
  return value;
}

function resolveLocalSource(source: string, baseDir: string, homeDir: string): string {
  if (source.startsWith("file://")) return fileURLToPath(source);
  if (source === "~") return homeDir;
  if (source.startsWith("~/")) return resolve(homeDir, source.slice(2));
  return resolve(baseDir, source);
}

function portableName(index: number, source: string, usedNames: Set<string>): string {
  const name = basename(source).replaceAll(/[^A-Za-z0-9._-]/g, "-") || "resource";
  if (!usedNames.has(name)) {
    usedNames.add(name);
    return name;
  }
  const uniqueName = `${index.toString().padStart(3, "0")}-${name}`;
  usedNames.add(uniqueName);
  return uniqueName;
}

async function copyTree(source: string, destination: string, excludedPaths: ReadonlySet<string> = new Set()): Promise<void> {
  const root = resolve(source);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: async (candidate) => {
      if (candidate !== root && ignoredDirectoryNames.has(basename(candidate))) return false;
      if (excludedPaths.has(resolve(candidate))) return false;
      try {
        return !excludedPaths.has(await realpath(candidate));
      } catch {
        return true;
      }
    },
  });
}

async function hasPackageManifest(directory: string): Promise<boolean> {
  try {
    return (await stat(join(directory, "package.json"))).isFile();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function packageManifestChildren(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
  const children: string[] = [];
  for (const entry of entries) {
    if (ignoredDirectoryNames.has(entry.name)) continue;
    const child = join(directory, entry.name);
    let childStat;
    try {
      childStat = await stat(child);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) continue;
      throw error;
    }
    if (!childStat.isDirectory()) continue;
    if (await hasPackageManifest(child)) children.push(child);
  }
  return children;
}

async function portableSource(absolute: string, isDirectory: boolean) {
  if (isDirectory) return { root: absolute, suffix: "", installDependencies: true };
  const parent = dirname(absolute);
  if (await hasPackageManifest(parent)) {
    return { root: parent, suffix: basename(absolute), installDependencies: true };
  }
  return { root: absolute, suffix: "", installDependencies: false };
}

function createArchive(sourceDirectory: string, archivePath: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "tar",
      ["-czf", archivePath, "-C", sourceDirectory, "."],
      { encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`tar failed (${error.code ?? "unknown"}): ${stderr || stdout}`.trim()));
          return;
        }
        resolvePromise();
      },
    );
  });
}

async function samePath(left: string, right: string | undefined): Promise<boolean> {
  if (!right) return false;
  try {
    return (await realpath(left)) === (await realpath(right));
  } catch {
    return resolve(left) === resolve(right);
  }
}

function isPattern(entry: string): boolean {
  return /^[!+-]/.test(entry) || entry.includes("*") || entry.includes("?");
}

export async function buildProfile(options: BuildProfileOptions): Promise<string> {
  const agentDir = resolve(options.agentDir);
  const homeDir = resolve(options.homeDir);
  const stage = join(options.localDir, "profile-stage");
  const archivePath = join(options.localDir, "profile.tar.gz");
  const stageHome = join(stage, "home");
  const stageAgent = join(stageHome, ".pi", "agent");

  await rm(stage, { recursive: true, force: true });
  await rm(archivePath, { force: true });
  await mkdir(stageAgent, { recursive: true });

  const settings = parseSettings(await readFile(join(agentDir, "settings.json"), "utf8"));
  const localAuth = join(agentDir, "auth.json");
  const localSecrets = new Set([localAuth]);
  try {
    localSecrets.add(await realpath(localAuth));
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  const packageDirectories: string[] = [];
  const rewrittenPackages: PackageSetting[] = [];
  const packageNames = new Set<string>();

  for (const [index, entry] of (settings.packages ?? []).entries()) {
    const source = sourceOf(entry);
    if (isRemotePackageSource(source)) {
      rewrittenPackages.push(entry);
      continue;
    }

    const absolute = resolveLocalSource(source, agentDir, homeDir);
    let sourceStat;
    try {
      sourceStat = await stat(absolute);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        rewrittenPackages.push(entry);
        continue;
      }
      throw error;
    }
    if (await samePath(absolute, options.excludedPackagePath)) continue;

    const portable = await portableSource(absolute, sourceStat.isDirectory());
    const relativeDestination = join(".pi", "agent", "local-packages", portableName(index, portable.root, packageNames));
    await copyTree(portable.root, join(stageHome, relativeDestination), localSecrets);
    const remoteSource = relative(stageAgent, join(stageHome, relativeDestination, portable.suffix));
    rewrittenPackages.push(withSource(entry, remoteSource));
    if (portable.installDependencies) packageDirectories.push(relativeDestination);
  }
  settings.packages = rewrittenPackages;

  for (const resourceType of resourceTypes) {
    const conventionalRoot = join(agentDir, resourceType);
    const rewrittenEntries: string[] = [];
    const resourceNames = new Set<string>();
    for (const [index, entry] of (settings[resourceType] ?? []).entries()) {
      if (isPattern(entry)) {
        rewrittenEntries.push(entry);
        continue;
      }

      const absolute = resolveLocalSource(entry, agentDir, homeDir);
      let sourceStat;
      try {
        sourceStat = await stat(absolute);
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) {
          rewrittenEntries.push(entry);
          continue;
        }
        throw error;
      }
      if (isPathEqualOrInside(conventionalRoot, absolute)) {
        rewrittenEntries.push(relative(agentDir, absolute));
        continue;
      }

      const portable = await portableSource(absolute, sourceStat.isDirectory());
      if (isPathEqualOrInside(portable.root, agentDir)) {
        throw new Error(`Configured Pi ${resourceType} path contains the agent directory: ${portable.root}`);
      }

      const relativeDestination = join(
        ".pi",
        "agent",
        "local-resources",
        resourceType,
        portableName(index, portable.root, resourceNames),
      );
      await copyTree(portable.root, join(stageHome, relativeDestination));
      rewrittenEntries.push(relative(stageAgent, join(stageHome, relativeDestination, portable.suffix)));
      if (portable.installDependencies) packageDirectories.push(relativeDestination);
    }
    if (await hasPackageManifest(conventionalRoot)) {
      packageDirectories.push(join(".pi", "agent", resourceType));
    }
    for (const packageDirectory of await packageManifestChildren(conventionalRoot)) {
      packageDirectories.push(join(".pi", "agent", resourceType, basename(packageDirectory)));
    }
    settings[resourceType] = rewrittenEntries;
  }

  const sharedSkills = join(homeDir, ".agents", "skills");
  try {
    await lstat(sharedSkills);
    await copyTree(sharedSkills, join(stageHome, ".agents", "skills"));
    settings.skills = [...(settings.skills ?? []), `${options.remoteProfileHome}/.agents/skills`];
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }

  const additionalSystemPrompts = (await readdir(agentDir)).filter((name) =>
    /^(?:APPEND_SYSTEM|SYSTEM)(?:\..+)?\.md$/.test(name),
  );
  for (const name of new Set([...portableNames, ...additionalSystemPrompts])) {
    const source = join(agentDir, name);
    try {
      await lstat(source);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) continue;
      throw error;
    }
    await copyTree(source, join(stageAgent, name));
  }

  const rewrittenSettings = rewriteHome(settings, homeDir, options.remoteProfileHome);
  await writeFile(join(stageAgent, "settings.json"), `${JSON.stringify(rewrittenSettings, null, 2)}\n`, {
    mode: 0o600,
  });
  await writeFile(
    join(stage, "profile.json"),
    `${JSON.stringify({ version: 1, packageDirectories: [...new Set(packageDirectories)] }, null, 2)}\n`,
  );
  await createArchive(stage, archivePath);
  await chmod(archivePath, 0o600);
  await rm(stage, { recursive: true, force: true });
  return archivePath;
}
