import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "./json.js";
import { scpTo, shellQuote, ssh, type HerdrInstallation } from "./remote.js";

const requiredRemoteCommands = ["bash", "git", "node", "npm", "tar", "flock", "ssh"];
const stableManifestUrl = "https://herdr.dev/latest.json";
const previewManifestUrl = "https://herdr.dev/preview.json";

interface RemotePlatform {
  home: string;
  assetKey: string;
}

interface HerdrAsset {
  url: string;
  sha256: string;
}

export interface RemoteHerdrRuntime {
  home: string;
  command: string;
}

function record(value: unknown, source: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${source} has an invalid shape.`);
  return value;
}

function nonEmptyString(value: unknown, source: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${source} is missing.`);
  return value;
}

function checksum(value: unknown, source: string): string {
  const digest = nonEmptyString(value, source);
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`${source} is invalid.`);
  return digest;
}

function assetFromRelease(release: unknown, assetKey: string, source: string): HerdrAsset {
  const value = record(release, source);
  const assets = record(value.assets, `${source} assets`);
  const asset = assets[assetKey];
  if (typeof asset === "string") {
    const checksums = record(value.sha256, `${source} checksums`);
    return {
      url: asset,
      sha256: checksum(checksums[assetKey], `${source} ${assetKey} checksum`),
    };
  }
  const assetValue = record(asset, `${source} ${assetKey} asset`);
  return {
    url: nonEmptyString(assetValue.url, `${source} ${assetKey} URL`),
    sha256: checksum(assetValue.sha256, `${source} ${assetKey} checksum`),
  };
}

async function fetchManifest(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Herdr manifest request failed (${response.status}): ${url}`);
  return record(await response.json(), "Herdr release manifest");
}

async function resolveHerdrAsset(version: string, assetKey: string): Promise<HerdrAsset> {
  const preview = version.match(/^\d+\.\d+\.\d+-preview\.(.+)$/);
  if (preview?.[1]) {
    const manifest = await fetchManifest(previewManifestUrl);
    const builds = record(manifest.builds, "Herdr preview builds");
    return assetFromRelease(
      builds[preview[1]],
      assetKey,
      `Herdr preview build ${preview[1]}`,
    );
  }

  const manifest = await fetchManifest(stableManifestUrl);
  if (manifest.version === version || manifest.version === `v${version}`) {
    return assetFromRelease(manifest, assetKey, `Herdr release ${version}`);
  }
  const releases = record(manifest.releases, "Herdr releases");
  return assetFromRelease(releases[version], assetKey, `Herdr release ${version}`);
}

async function inspectRemotePlatform(host: string): Promise<RemotePlatform> {
  const result = await ssh(
    host,
    [
      "set -eu",
      `for command in ${requiredRemoteCommands.join(" ")}; do`,
      "  if ! command -v \"$command\" >/dev/null; then",
      "    printf 'Missing remote command: %s\\n' \"$command\" >&2",
      "    exit 1",
      "  fi",
      "done",
      "node_version=$(node -p 'process.versions.node')",
      "node -e 'const [major, minor] = process.versions.node.split(\".\").map(Number); if (major < 22 || (major === 22 && minor < 19)) process.exit(1)' || {",
      "  printf 'Remote Node.js 22.19.0 or newer is required; found %s.\\n' \"$node_version\" >&2",
      "  exit 1",
      "}",
      "printf '%s\\n%s\\n%s\\n' \"$HOME\" \"$(uname -s)\" \"$(uname -m)\"",
    ].join("\n"),
  );
  const [home, os, architecture, ...extra] = result.stdout.trimEnd().split("\n");
  if (extra.length !== 0 || !home?.startsWith("/") || !os || !architecture) {
    throw new Error(`The remote host returned invalid platform metadata: ${JSON.stringify(result.stdout)}`);
  }
  const platformOs = os === "Linux" ? "linux" : os === "Darwin" ? "macos" : undefined;
  const platformArchitecture = architecture === "x86_64" || architecture === "amd64"
    ? "x86_64"
    : architecture === "aarch64" || architecture === "arm64"
      ? "aarch64"
      : undefined;
  if (!platformOs || !platformArchitecture) {
    throw new Error(`The remote platform is unsupported: ${os} ${architecture}`);
  }
  return { home, assetKey: `${platformOs}-${platformArchitecture}` };
}

async function matchingRemoteHerdr(
  host: string,
  platform: RemotePlatform,
  installation: HerdrInstallation,
): Promise<string | undefined> {
  const managed = `${platform.home}/.pi-remote-handoff/herdr/${installation.version}/herdr`;
  const result = await ssh(
    host,
    [
      "path_herdr=$(command -v herdr || true)",
      `for candidate in \"$path_herdr\" \"$HOME/.local/bin/herdr\" ${shellQuote(managed)}; do`,
      "  case \"$candidate\" in /*) ;; *) continue ;; esac",
      `  if test -x \"$candidate\" && test \"$(\"$candidate\" --version 2>/dev/null)\" = ${shellQuote(installation.output)}; then`,
      "    printf '%s\\n' \"$candidate\"",
      "    exit 0",
      "  fi",
      "done",
    ].join("\n"),
  );
  const command = result.stdout.trim();
  if (!command) return undefined;
  if (!command.startsWith("/") || command.includes("\n")) {
    throw new Error(`The remote host returned an invalid Herdr path: ${JSON.stringify(result.stdout)}`);
  }
  return command;
}

async function downloadHerdr(asset: HerdrAsset): Promise<{ directory: string; path: string }> {
  const url = new URL(asset.url);
  if (url.protocol !== "https:") throw new Error(`Herdr asset URL is not HTTPS: ${asset.url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Herdr download failed (${response.status}): ${asset.url}`);
  const contents = Buffer.from(await response.arrayBuffer());
  const actualChecksum = createHash("sha256").update(contents).digest("hex");
  if (actualChecksum !== asset.sha256) throw new Error("Downloaded Herdr checksum does not match its release manifest.");

  const directory = await mkdtemp(join(tmpdir(), "pi-remote-handoff-herdr-"));
  const path = join(directory, "herdr");
  try {
    await writeFile(path, contents, { mode: 0o700 });
    return { directory, path };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function installRemoteHerdr(
  host: string,
  platform: RemotePlatform,
  installation: HerdrInstallation,
): Promise<string> {
  const destination = `${platform.home}/.pi-remote-handoff/herdr/${installation.version}/herdr`;
  const temporary = `${destination}.tmp.${randomUUID()}`;
  const asset = await resolveHerdrAsset(installation.version, platform.assetKey);
  const download = await downloadHerdr(asset);
  try {
    await ssh(host, `umask 077 && mkdir -p ${shellQuote(destination.slice(0, destination.lastIndexOf("/")))}`);
    await scpTo(host, download.path, temporary);
    await ssh(
      host,
      [
        `chmod 755 ${shellQuote(temporary)}`,
        `test "$(${shellQuote(temporary)} --version 2>/dev/null)" = ${shellQuote(installation.output)}`,
        `mv -f ${shellQuote(temporary)} ${shellQuote(destination)}`,
      ].join(" && "),
    );
  } catch (error) {
    try {
      await ssh(host, `rm -f -- ${shellQuote(temporary)}`);
    } catch {
      // Keep the installation failure as the useful error.
    }
    throw error;
  } finally {
    await rm(download.directory, { recursive: true, force: true });
  }
  return destination;
}

export async function ensureRemoteHerdr(
  host: string,
  installation: HerdrInstallation,
): Promise<RemoteHerdrRuntime> {
  const platform = await inspectRemotePlatform(host);
  const existing = await matchingRemoteHerdr(host, platform, installation);
  if (existing) return { home: platform.home, command: existing };

  await installRemoteHerdr(host, platform, installation);
  const installed = await matchingRemoteHerdr(host, platform, installation);
  if (!installed) throw new Error(`Remote Herdr installation does not match ${installation.output}.`);
  return { home: platform.home, command: installed };
}
