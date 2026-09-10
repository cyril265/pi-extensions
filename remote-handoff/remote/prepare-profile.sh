#!/usr/bin/env bash
set -euo pipefail
umask 077

archive=$1
profile=$2
runtime=$3
pi_version=$4
mode=${5-both}
authentication_mode=${6-}

progress() {
  printf 'PI_REMOTE_HANDOFF_PROGRESS\t%s\n' "$1"
}

case "$mode" in
  profile | runtime | both) ;;
  *)
    printf 'Invalid preparation mode: %s\n' "$mode" >&2
    exit 1
    ;;
esac

case "$authentication_mode" in
  initial | preserve) ;;
  *)
    printf 'Invalid authentication mode: %s\n' "$authentication_mode" >&2
    exit 1
    ;;
esac

runtime_parent=$(dirname "$runtime")
mkdir -p "$runtime_parent"
chmod 700 "$runtime_parent"

if [[ "$mode" != runtime ]]; then
  agent_dir="$profile/home/.pi/agent"
  initial_auth="$(dirname "$archive")/initial-auth.json"
  validate_authentication="$(dirname "$archive")/validate-authentication.cjs"
  profile_candidate="${profile}.tmp.$$"
  profile_backup="${profile}.previous.$$"
  dependency_cache="$runtime_parent/package-dependencies"
  mkdir -p "$dependency_cache"
  chmod 700 "$dependency_cache"

  if [[ "$authentication_mode" == initial ]]; then
    if ! node "$validate_authentication" "$initial_auth"; then
      printf 'Initial workspace authentication is missing or invalid.\n' >&2
      exit 1
    fi
  else
    if ! node "$validate_authentication" "$agent_dir/auth.json"; then
      printf 'Existing private workspace authentication is missing or invalid.\n' >&2
      exit 1
    fi
  fi

  progress "Extracting workspace profile"
  cleanup_profile_candidate() {
    rm -rf -- "$profile_candidate"
  }
  trap cleanup_profile_candidate EXIT
  rm -rf -- "$profile_candidate"
  if [[ -e "$profile_backup" || -L "$profile_backup" ]]; then
    printf 'Private profile backup already exists: %s\n' "$profile_backup" >&2
    exit 1
  fi
  mkdir -m 700 "$profile_candidate"
  tar -xzf "$archive" -C "$profile_candidate"
  candidate_agent_dir="$profile_candidate/home/.pi/agent"
  mkdir -p "$candidate_agent_dir"
  if [[ "$authentication_mode" == initial ]]; then
    cp "$initial_auth" "$candidate_agent_dir/auth.json"
    rm -f -- "$initial_auth"
  else
    cp "$agent_dir/auth.json" "$candidate_agent_dir/auth.json"
  fi
  chmod -R go-rwx "$profile_candidate"
  chmod 700 "$profile_candidate" "$profile_candidate/home" "$profile_candidate/home/.pi" "$candidate_agent_dir"
  chmod 600 "$candidate_agent_dir/auth.json" "$candidate_agent_dir/settings.json"

  progress "Scanning portable package dependencies"
  node - "$profile_candidate" "$dependency_cache" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const progress = (message) => fs.writeSync(1, `PI_REMOTE_HANDOFF_PROGRESS\t${message}\n`);

const profile = process.argv[2];
const cache = process.argv[3];
const manifest = JSON.parse(fs.readFileSync(path.join(profile, "profile.json"), "utf8"));
if (manifest.version !== 1 || !Array.isArray(manifest.packageDirectories)) {
  throw new Error("Invalid portable Pi profile manifest");
}

const packageInputs = [];
const installs = [];
for (const relative of manifest.packageDirectories) {
  if (typeof relative !== "string" || path.isAbsolute(relative) || relative.split(path.sep).includes("..")) {
    throw new Error(`Invalid portable package path: ${JSON.stringify(relative)}`);
  }
  const directory = path.join(profile, "home", relative);
  const packageJson = path.join(directory, "package.json");
  if (!fs.existsSync(packageJson)) continue;
  packageInputs.push({ relative, directory });
  const packageData = JSON.parse(fs.readFileSync(packageJson, "utf8"));
  if (
    Object.keys(packageData.dependencies || {}).length === 0 &&
    Object.keys(packageData.optionalDependencies || {}).length === 0
  ) {
    continue;
  }

  const label = typeof packageData.name === "string" && packageData.name ? packageData.name : relative;
  installs.push({ relative, label, directory, packageJson, packageData });
}

if (installs.length === 0) {
  progress("No portable package dependencies to install");
}

const dependencyFiles = crypto.createHash("sha256");
const hashEntry = (root, relative = "") => {
  const absolute = path.join(root, relative);
  const stat = fs.lstatSync(absolute);
  const name = relative.split(path.sep).join("/");
  if (stat.isDirectory()) {
    dependencyFiles.update(JSON.stringify(["directory", name, stat.mode & 0o777]));
    for (const child of fs.readdirSync(absolute).sort()) {
      hashEntry(root, path.join(relative, child));
    }
    return;
  }
  if (stat.isFile()) {
    dependencyFiles.update(JSON.stringify(["file", name, stat.mode & 0o777, stat.size]));
    dependencyFiles.update(fs.readFileSync(absolute));
    return;
  }
  if (stat.isSymbolicLink()) {
    dependencyFiles.update(JSON.stringify(["symlink", name, fs.readlinkSync(absolute)]));
    return;
  }
  throw new Error(`Unsupported portable package entry: ${absolute}`);
};

for (const { relative, directory } of packageInputs) {
  dependencyFiles.update(JSON.stringify(["package", relative]));
  hashEntry(directory);
}

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
const dependencyInput = dependencyFiles.digest("hex");
const cacheScript = String.raw`
set -euo pipefail
candidate="$CACHE_ENTRY.tmp.$$"
cleanup() {
  rm -rf -- "$candidate"
  rm -f -- "$CACHE_RESULT"
}
trap cleanup EXIT

if [[ -e "$CACHE_RESULT" || -L "$CACHE_RESULT" ]]; then
  printf 'Dependency cache result path already exists: %s\n' "$CACHE_RESULT" >&2
  exit 1
fi
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
  cp -a -- "$CACHE_ENTRY/node_modules" "$PACKAGE_DIRECTORY/node_modules"
  printf 'reused\n' >"$CACHE_RESULT"
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
  cp -a -- "$PACKAGE_DIRECTORY/node_modules" "$candidate/node_modules"
  printf '%s\n' "$CACHE_KEY" >"$candidate/complete"
  chmod -R go-rwx "$candidate"
  mv "$candidate" "$CACHE_ENTRY"
  printf 'installed\n' >"$CACHE_RESULT"
fi
trap - EXIT
`;

for (const [index, { relative, label, directory, packageJson, packageData }] of installs.entries()) {
  const key = crypto
    .createHash("sha256")
    .update(JSON.stringify({ version: 1, relative, dependencyInput, runtime }))
    .digest("hex");
  const cacheEntry = path.join(cache, key);
  const cacheResult = path.join(cache, `${key}.result.${process.pid}`);
  const lock = path.join(cache, `${key}.lock`);
  progress(`Preparing package ${index + 1}/${installs.length}: ${label}`);
  const original = fs.readFileSync(packageJson);
  const installManifest = { ...packageData };
  delete installManifest.scripts;
  fs.writeFileSync(packageJson, `${JSON.stringify(installManifest, null, 2)}\n`);
  let result;
  try {
    result = spawnSync("flock", ["-x", lock, "bash", "-c", cacheScript], {
      cwd: directory,
      env: {
        ...process.env,
        CACHE_ENTRY: cacheEntry,
        CACHE_KEY: key,
        CACHE_RESULT: cacheResult,
        PACKAGE_DIRECTORY: directory,
      },
      stdio: "inherit",
    });
  } finally {
    fs.writeFileSync(packageJson, original);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Dependency preparation failed for ${relative}`);
  const cacheResultValue = fs.readFileSync(cacheResult, "utf8").trim();
  fs.unlinkSync(cacheResult);
  if (cacheResultValue === "reused") {
    progress(`Reused package ${index + 1}/${installs.length}: ${label}`);
  } else if (cacheResultValue === "installed") {
    progress(`Installed package ${index + 1}/${installs.length}: ${label}`);
  } else {
    throw new Error(`Invalid dependency cache result for ${relative}`);
  }
}
NODE

  progress "Securing workspace profile"
  chmod -R go-rwx "$profile_candidate"

  had_profile=false
  if [[ -e "$profile" || -L "$profile" ]]; then
    mv "$profile" "$profile_backup"
    had_profile=true
  fi
  if ! mv "$profile_candidate" "$profile"; then
    if [[ "$had_profile" == true ]] && ! mv "$profile_backup" "$profile"; then
      printf 'Could not restore the previous private profile. It remains at %s\n' "$profile_backup" >&2
    fi
    exit 1
  fi
  rm -rf -- "$profile_backup"
  trap - EXIT
  progress "Workspace profile ready"
fi

if [[ "$mode" != profile ]]; then
  progress "Waiting for shared Pi runtime lock"
  exec 9>"${runtime}.lock"
  flock -x 9
  progress "Checking shared Pi version"
  pi_command="$runtime/node_modules/.bin/pi"
  installed_version=$("$pi_command" --version 2>/dev/null || true)
  if [[ "$installed_version" != "$pi_version" ]]; then
    progress "Installing shared Pi $pi_version"
    candidate="${runtime}.tmp.$$"
    previous="${runtime}.previous.$$"
    cleanup_runtime() {
      rm -rf -- "$candidate"
      if [[ -e "$previous" && ! -e "$runtime" ]]; then
        mv "$previous" "$runtime"
      else
        rm -rf -- "$previous"
      fi
    }
    trap cleanup_runtime EXIT
    rm -rf -- "$candidate" "$previous"
    mkdir -m 700 "$candidate"
    npm install \
      --prefix "$candidate" \
      --ignore-scripts \
      --no-audit \
      --no-fund \
      --legacy-peer-deps \
      "@earendil-works/pi-coding-agent@$pi_version" >/dev/null

    candidate_pi="$candidate/node_modules/.bin/pi"
    [[ -x "$candidate_pi" ]] || {
      printf 'Shared Pi executable is missing: %s\n' "$candidate_pi" >&2
      exit 1
    }
    [[ "$("$candidate_pi" --version)" == "$pi_version" ]] || {
      printf 'Shared Pi version verification failed.\n' >&2
      exit 1
    }
    chmod -R go-rwx "$candidate"
    if [[ -e "$runtime" ]]; then
      mv "$runtime" "$previous"
    fi
    if ! mv "$candidate" "$runtime"; then
      if [[ -e "$previous" ]]; then
        mv "$previous" "$runtime"
      fi
      exit 1
    fi
    rm -rf -- "$previous"
    trap - EXIT
  else
    progress "Reusing shared Pi $pi_version"
  fi
  chmod 700 "$runtime"
  progress "Shared Pi $pi_version ready"
  printf '%s\n' "$pi_command"
fi
