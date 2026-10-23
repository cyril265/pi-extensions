import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hasErrorCode } from "./errors.js";
import { isRecord } from "./json.js";
import { isPathEqualOrInside } from "./paths.js";
import type { TransferObject } from "./transfer.js";

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
  remoteProfileHome: string;
  excludedPackagePath?: string;
}

export interface PortableProfile {
  manifest: Buffer;
  objects: Map<string, TransferObject>;
}

type ProfileEntry =
  | { path: string; type: "directory" }
  | { path: string; type: "file"; mode: number; size: number; hash: string };

interface PendingProfileFile {
  path: string;
  source: string;
  mode: number;
}

const hashConcurrency = 8;

interface IgnoreContext {
  root: string;
  included: Set<string>;
  directories: Set<string>;
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

function fileMode(mode: number): number {
  return process.platform === "win32" ? 0o600 : mode & 0o700;
}

function hashFile(path: string): Promise<{ hash: string; size: number }> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    let size = 0;
    createReadStream(path, { highWaterMark: 1024 * 1024 })
      .on("data", (chunk) => {
        const bytes = chunk as Buffer;
        size += bytes.length;
        hash.update(bytes);
      })
      .on("error", reject)
      .on("end", () => resolvePromise({ hash: hash.digest("hex"), size }));
  });
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
}

function gitIgnoreContext(directory: string): Promise<IgnoreContext | null> {
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: directory, env: gitEnvironment(), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolvePromise(null);
          return;
        }
        const included = new Set<string>();
        const directories = new Set<string>();
        for (const listed of stdout.split("\0")) {
          if (!listed) continue;
          const path = (listed.endsWith("/") ? listed.slice(0, -1) : listed).normalize("NFC");
          included.add(path);
          for (let parent = posix.dirname(path); parent !== "."; parent = posix.dirname(parent)) {
            if (directories.has(parent)) break;
            directories.add(parent);
          }
        }
        resolvePromise({ root: directory, included, directories });
      },
    );
  });
}

class ProfileTree {
  private readonly entries = new Map<string, ProfileEntry>();
  private readonly objects = new Map<string, TransferObject>();
  private readonly pending = new Map<string, PendingProfileFile>();
  private readonly ignoreContexts = new Map<string, Promise<IgnoreContext | null>>();

  hasDirectory(path: string): boolean {
    return this.entries.get(path)?.type === "directory";
  }

  private ignoreContext(directory: string): Promise<IgnoreContext | null> {
    let context = this.ignoreContexts.get(directory);
    if (!context) {
      context = gitIgnoreContext(directory);
      this.ignoreContexts.set(directory, context);
    }
    return context;
  }

  addDirectory(path: string): void {
    for (let current = path; current !== "." && current !== ""; current = posix.dirname(current)) {
      if (this.entries.get(current)?.type === "directory") return;
      this.entries.set(current, { path: current, type: "directory" });
    }
  }

  addContent(path: string, content: Buffer, mode: number): void {
    this.addDirectory(posix.dirname(path));
    this.pending.delete(path);
    const hash = createHash("sha256").update(content).digest("hex");
    this.entries.set(path, { path, type: "file", mode, size: content.length, hash });
    this.objects.set(hash, { hash, size: content.length, source: { content } });
  }

  async addTree(source: string, destination: string, excludedPaths: ReadonlySet<string> = new Set()): Promise<void> {
    const root = resolve(source);
    const visit = async (
      candidate: string,
      target: string,
      location: string,
      isSymbolicLink: boolean,
      context: IgnoreContext | null,
      ancestors: ReadonlySet<string>,
    ): Promise<void> => {
      const isRoot = candidate === root;
      if (!isRoot && ignoredDirectoryNames.has(basename(candidate))) return;
      if (excludedPaths.size > 0) {
        if (excludedPaths.has(resolve(candidate))) return;
        try {
          if (excludedPaths.has(await realpath(candidate))) return;
        } catch (error) {
          if (hasErrorCode(error, "ENOENT")) return;
        }
      }
      let stats;
      try {
        stats = await stat(candidate);
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return;
        throw error;
      }
      let listed = false;
      if (!isRoot && context) {
        const path = relative(context.root, location).split(sep).join("/").normalize("NFC");
        listed = context.included.has(path);
        if (!listed && (isSymbolicLink || !stats.isDirectory() || !context.directories.has(path))) return;
      }
      if (stats.isDirectory()) {
        const identity = `${stats.dev}:${stats.ino}`;
        if (stats.ino !== 0 && ancestors.has(identity)) {
          throw new Error(`Portable Pi profile source contains a directory cycle: ${candidate}`);
        }
        const opensContext = isRoot || isSymbolicLink || listed;
        const real = opensContext ? await realpath(candidate) : location;
        const childContext = opensContext ? await this.ignoreContext(real) : context;
        this.addDirectory(target);
        const nested = new Set(ancestors).add(identity);
        const children = await readdir(candidate, { withFileTypes: true });
        await Promise.all(children.map((child) => visit(
          join(candidate, child.name),
          posix.join(target, child.name),
          join(real, child.name),
          child.isSymbolicLink(),
          childContext,
          nested,
        )));
        return;
      }
      if (stats.isFile()) {
        this.addDirectory(posix.dirname(target));
        this.pending.set(target, { path: target, source: candidate, mode: fileMode(stats.mode) });
        return;
      }
      throw new Error(`Unsupported portable Pi profile entry: ${candidate}`);
    };
    await visit(root, destination, root, false, null, new Set());
  }

  async build(): Promise<PortableProfile> {
    const pending = [...this.pending.values()];
    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        const file = pending[next++]!;
        const { hash, size } = await hashFile(file.source);
        this.entries.set(file.path, { path: file.path, type: "file", mode: file.mode, size, hash });
        if (!this.objects.has(hash)) this.objects.set(hash, { hash, size, source: { path: file.source } });
      }
    };
    await Promise.all(Array.from({ length: Math.min(hashConcurrency, pending.length) }, worker));
    const entries = [...this.entries.values()].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    return {
      manifest: Buffer.from(`${JSON.stringify({ version: 1, entries })}\n`),
      objects: this.objects,
    };
  }
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

export async function buildProfile(options: BuildProfileOptions): Promise<PortableProfile> {
  const agentDir = resolve(options.agentDir);
  const homeDir = resolve(options.homeDir);
  const stageHome = "home";
  const stageAgent = posix.join(stageHome, ".pi", "agent");
  const tree = new ProfileTree();
  tree.addDirectory(stageAgent);

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
    const name = portableName(index, portable.root, packageNames);
    const relativeDestination = posix.join(".pi", "agent", "local-packages", name);
    await tree.addTree(portable.root, posix.join(stageHome, relativeDestination), localSecrets);
    rewrittenPackages.push(withSource(entry, posix.join("local-packages", name, portable.suffix)));
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
        rewrittenEntries.push(relative(agentDir, absolute).split(sep).join("/"));
        continue;
      }

      const portable = await portableSource(absolute, sourceStat.isDirectory());
      if (isPathEqualOrInside(portable.root, agentDir)) {
        throw new Error(`Configured Pi ${resourceType} path contains the agent directory: ${portable.root}`);
      }

      const name = portableName(index, portable.root, resourceNames);
      const relativeDestination = posix.join(".pi", "agent", "local-resources", resourceType, name);
      await tree.addTree(portable.root, posix.join(stageHome, relativeDestination));
      rewrittenEntries.push(posix.join("local-resources", resourceType, name, portable.suffix));
      if (portable.installDependencies) packageDirectories.push(relativeDestination);
    }
    if (await hasPackageManifest(conventionalRoot)) {
      packageDirectories.push(posix.join(".pi", "agent", resourceType));
    }
    for (const packageDirectory of await packageManifestChildren(conventionalRoot)) {
      packageDirectories.push(posix.join(".pi", "agent", resourceType, basename(packageDirectory)));
    }
    settings[resourceType] = rewrittenEntries;
  }

  const sharedSkills = join(homeDir, ".agents", "skills");
  try {
    await lstat(sharedSkills);
    await tree.addTree(sharedSkills, posix.join(stageHome, ".agents", "skills"));
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
    await tree.addTree(source, posix.join(stageAgent, name));
  }

  const rewrittenSettings = rewriteHome(settings, homeDir, options.remoteProfileHome);
  tree.addContent(
    posix.join(stageAgent, "settings.json"),
    Buffer.from(`${JSON.stringify(rewrittenSettings, null, 2)}\n`),
    0o600,
  );
  const portablePackageDirectories = [...new Set(packageDirectories)].filter((directory) =>
    tree.hasDirectory(posix.join(stageHome, directory)),
  );
  tree.addContent(
    "profile.json",
    Buffer.from(`${JSON.stringify({ version: 1, packageDirectories: portablePackageDirectories }, null, 2)}\n`),
    0o600,
  );
  return tree.build();
}
