const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const [manifestPath, objects, profile, cache] = process.argv.slice(2);
const progress = (message) => fs.writeSync(1, `PI_REMOTE_HANDOFF_PROGRESS\t${message}\n`);
const hashPattern = /^[0-9a-f]{64}$/;
const copyConcurrency = 8;
const dependencyConcurrency = Math.max(1, Math.min(4, os.availableParallelism()));
const localSpecification = /^(?:file:|link:|\.{1,2}(?:[\\/]|$)|[\\/]|~[\\/]|[A-Za-z]:[\\/])/;
const dependencyFields = ["dependencies", "optionalDependencies", "devDependencies", "peerDependencies"];

const safeRelative = (relative) => {
  if (
    typeof relative !== "string"
    || relative === ""
    || relative.startsWith("/")
    || relative.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Invalid portable profile path: ${JSON.stringify(relative)}`);
  }
  return relative;
};

async function materialize() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error("Invalid portable Pi profile manifest");
  }
  const files = [];
  const entries = new Map();
  fs.mkdirSync(profile, { mode: 0o700 });
  for (const entry of manifest.entries) {
    const target = path.join(profile, ...safeRelative(entry.path).split("/"));
    if (entry.type === "directory") {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      continue;
    }
    if (entry.type !== "file" || !hashPattern.test(entry.hash) || !Number.isInteger(entry.mode)) {
      throw new Error(`Invalid portable profile entry: ${JSON.stringify(entry.path)}`);
    }
    const object = path.join(objects, entry.hash);
    if (!fs.existsSync(object)) throw new Error(`Portable profile object is missing for ${entry.path}`);
    files.push({ target, object, mode: entry.mode & 0o700 });
    entries.set(entry.path, entry);
  }
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      fs.mkdirSync(path.dirname(file.target), { recursive: true, mode: 0o700 });
      await fs.promises.copyFile(file.object, file.target, fs.constants.COPYFILE_FICLONE);
      if (file.mode !== 0o600) await fs.promises.chmod(file.target, file.mode);
    }
  };
  await Promise.all(Array.from({ length: Math.min(copyConcurrency, files.length) }, worker));
  return entries;
}

const usesLocalPackages = (packageData) => packageData.workspaces !== undefined
  || dependencyFields.some((field) => Object.values(packageData[field] || {}).some(
    (specification) => typeof specification === "string" && localSpecification.test(specification.trim()),
  ))
  || /"(?:file|link):/.test(JSON.stringify(packageData.overrides || {}));

async function prepareDependencies(entries) {
  const profileManifest = JSON.parse(fs.readFileSync(path.join(profile, "profile.json"), "utf8"));
  if (profileManifest.version !== 1 || !Array.isArray(profileManifest.packageDirectories)) {
    throw new Error("Invalid portable Pi profile manifest");
  }

  const packageInputs = [];
  const installs = [];
  for (const relative of profileManifest.packageDirectories) {
    safeRelative(relative);
    const directory = path.join(profile, "home", ...relative.split("/"));
    const packageJson = path.join(directory, "package.json");
    if (!fs.existsSync(packageJson)) continue;
    packageInputs.push(relative);
    const packageData = JSON.parse(fs.readFileSync(packageJson, "utf8"));
    if (
      Object.keys(packageData.dependencies || {}).length === 0
      && Object.keys(packageData.optionalDependencies || {}).length === 0
    ) {
      continue;
    }
    const label = typeof packageData.name === "string" && packageData.name ? packageData.name : relative;
    installs.push({ relative, label, directory, packageJson, packageData });
  }

  if (installs.length === 0) {
    progress("No portable package dependencies to install");
    return;
  }

  const entryHash = (relative) => entries.get(`home/${relative}`)?.hash ?? null;
  const allPackageInputs = crypto.createHash("sha256");
  for (const relative of packageInputs) {
    const prefix = `home/${relative}/`;
    allPackageInputs.update(JSON.stringify(["package", relative]));
    for (const [entryPath, entry] of entries) {
      if (entryPath.startsWith(prefix)) {
        allPackageInputs.update(JSON.stringify([entryPath.slice(prefix.length), entry.mode, entry.size, entry.hash]));
      }
    }
  }
  const allPackageInputsHash = allPackageInputs.digest("hex");

  const npmVersionResult = spawnSync("npm", ["--version"], { encoding: "utf8" });
  if (npmVersionResult.error) throw npmVersionResult.error;
  if (npmVersionResult.status !== 0) throw new Error("Could not read the remote npm version");
  const reportHeader = process.report.getReport().header;
  const runtime = {
    node: process.version,
    versions: process.versions,
    platform: process.platform,
    arch: process.arch,
    os: {
      type: os.type(),
      release: os.release(),
      version: os.version(),
      glibcRuntime: reportHeader.glibcVersionRuntime,
      glibcCompiler: reportHeader.glibcVersionCompiler,
    },
    npm: npmVersionResult.stdout.trim(),
  };

  const cacheScript = String.raw`
set -euo pipefail
candidate="$CACHE_ENTRY.tmp.$$"
trap 'rm -rf -- "$candidate"' EXIT

link_tree() {
  cp -al -- "$1" "$2" 2>/dev/null || {
    rm -rf -- "$2"
    cp -a -- "$1" "$2"
  }
}

if [[ -e "$PACKAGE_DIRECTORY/node_modules" || -L "$PACKAGE_DIRECTORY/node_modules" ]]; then
  printf 'Portable package already has node_modules: %s\n' "$PACKAGE_DIRECTORY" >&2
  exit 1
fi

if [[ -e "$CACHE_ENTRY" || -L "$CACHE_ENTRY" ]]; then
  if [[ ! -d "$CACHE_ENTRY" || -L "$CACHE_ENTRY" || ! -d "$CACHE_ENTRY/node_modules" || -L "$CACHE_ENTRY/node_modules" || ! -f "$CACHE_ENTRY/complete" || -L "$CACHE_ENTRY/complete" ]]; then
    printf 'Dependency cache entry is invalid: %s\n' "$CACHE_ENTRY" >&2
    exit 1
  fi
  if [[ "$(cat "$CACHE_ENTRY/complete")" != "$CACHE_KEY" ]]; then
    printf 'Dependency cache key verification failed: %s\n' "$CACHE_ENTRY" >&2
    exit 1
  fi
  link_tree "$CACHE_ENTRY/node_modules" "$PACKAGE_DIRECTORY/node_modules"
  printf 'PI_REMOTE_HANDOFF_PROGRESS\tReused %s\n' "$PROGRESS_LABEL"
else
  if [[ -e "$candidate" || -L "$candidate" ]]; then
    printf 'Dependency cache candidate already exists: %s\n' "$candidate" >&2
    exit 1
  fi
  npm install --omit=dev --no-audit --no-fund
  if [[ ! -d "$PACKAGE_DIRECTORY/node_modules" || -L "$PACKAGE_DIRECTORY/node_modules" ]]; then
    printf 'npm install did not create node_modules: %s\n' "$PACKAGE_DIRECTORY" >&2
    exit 1
  fi
  mkdir -m 700 "$candidate"
  link_tree "$PACKAGE_DIRECTORY/node_modules" "$candidate/node_modules"
  printf '%s\n' "$CACHE_KEY" >"$candidate/complete"
  chmod -R go-rwx "$candidate"
  mv "$candidate" "$CACHE_ENTRY"
  printf 'PI_REMOTE_HANDOFF_PROGRESS\tInstalled %s\n' "$PROGRESS_LABEL"
fi
trap - EXIT
`;

  const prepare = async (index) => {
    const { relative, label, directory, packageJson, packageData } = installs[index];
    const installManifest = { ...packageData };
    delete installManifest.scripts;
    const inputs = usesLocalPackages(packageData)
      ? { relative, packages: allPackageInputsHash }
      : {
          manifest: installManifest,
          packageLock: entryHash(`${relative}/package-lock.json`),
          shrinkwrap: entryHash(`${relative}/npm-shrinkwrap.json`),
          npmrc: entryHash(`${relative}/.npmrc`),
        };
    const key = crypto
      .createHash("sha256")
      .update(JSON.stringify({ version: 2, inputs, runtime }))
      .digest("hex");
    const cacheEntry = path.join(cache, key);
    const lock = path.join(cache, `${key}.lock`);
    const progressLabel = `package ${index + 1}/${installs.length}: ${label}`;
    progress(`Preparing ${progressLabel}`);
    const original = fs.readFileSync(packageJson);
    fs.writeFileSync(packageJson, `${JSON.stringify(installManifest, null, 2)}\n`);
    try {
      const status = await new Promise((resolve, reject) => {
        const child = spawn("flock", ["-x", lock, "bash", "-c", cacheScript], {
          cwd: directory,
          env: {
            ...process.env,
            CACHE_ENTRY: cacheEntry,
            CACHE_KEY: key,
            PACKAGE_DIRECTORY: directory,
            PROGRESS_LABEL: progressLabel,
          },
          stdio: ["ignore", "inherit", "inherit"],
        });
        child.on("error", reject);
        child.on("close", resolve);
      });
      if (status !== 0) throw new Error(`Dependency preparation failed for ${relative}`);
    } finally {
      fs.writeFileSync(packageJson, original);
    }
  };

  let next = 0;
  let failure;
  const worker = async () => {
    while (next < installs.length && failure === undefined) {
      const index = next++;
      try {
        await prepare(index);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(dependencyConcurrency, installs.length) }, worker));
  if (failure !== undefined) throw failure;
}

(async () => {
  progress("Materializing workspace profile");
  const entries = await materialize();
  progress("Scanning portable package dependencies");
  await prepareDependencies(entries);
})().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
