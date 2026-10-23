#!/usr/bin/env bash
set -euo pipefail
umask 077

control=$1
profile=$2
root=$3
pi_version=$4

agent_dir="$profile/home/.pi/agent"
initial_auth="$control/initial-auth.json"
manifest="$control/profile-manifest.json"
objects="$root/profile-objects"
runtime="$root/runtime/$pi_version"
dependency_cache="$root/package-dependencies"
runtime_candidate="$runtime.tmp.$$"
profile_candidate="$profile.tmp.$$"
runtime_job=

progress() {
  printf 'PI_REMOTE_HANDOFF_PROGRESS\t%s\n' "$1"
}

valid_authentication() {
  node "$control/validate-authentication.cjs" "$1"
}

cleanup() {
  if [[ -n $runtime_job ]]; then
    wait "$runtime_job" || true
  fi
  rm -rf -- "$runtime_candidate" "$profile_candidate"
  rm -f -- "$initial_auth"
}
trap cleanup EXIT

prepare_runtime() {
  progress "Waiting for shared Pi runtime lock"
  exec 9>"$runtime.lock"
  flock -x 9
  if [[ "$("$runtime/node_modules/.bin/pi" --version 2>/dev/null || true)" == "$pi_version" ]]; then
    progress "Reusing shared Pi $pi_version"
    return 0
  fi
  progress "Installing shared Pi $pi_version"
  rm -rf -- "$runtime" "$runtime_candidate"
  mkdir -m 700 "$runtime_candidate"
  npm install \
    --prefix "$runtime_candidate" \
    --ignore-scripts \
    --no-audit \
    --no-fund \
    --legacy-peer-deps \
    "@earendil-works/pi-coding-agent@$pi_version" >/dev/null
  if [[ "$("$runtime_candidate/node_modules/.bin/pi" --version)" != "$pi_version" ]]; then
    printf 'Shared Pi version verification failed.\n' >&2
    exit 1
  fi
  chmod -R go-rwx "$runtime_candidate"
  mv "$runtime_candidate" "$runtime"
  progress "Shared Pi $pi_version ready"
}

prepare_profile() {
  if node "$control/validate-profile.cjs" "$profile"; then
    if ! valid_authentication "$agent_dir/auth.json"; then
      progress "Restoring workspace authentication"
      if ! valid_authentication "$initial_auth"; then
        printf 'Initial workspace authentication is missing or invalid.\n' >&2
        exit 1
      fi
      cp "$initial_auth" "$agent_dir/auth.json"
      chmod 600 "$agent_dir/auth.json"
    fi
    return 0
  fi

  local authentication
  if valid_authentication "$agent_dir/auth.json"; then
    authentication="$agent_dir/auth.json"
  elif valid_authentication "$initial_auth"; then
    authentication="$initial_auth"
  else
    printf 'Workspace authentication is missing or invalid.\n' >&2
    exit 1
  fi
  if [[ ! -f "$manifest" ]]; then
    printf 'The uploaded profile manifest is missing.\n' >&2
    exit 1
  fi

  rm -rf -- "$profile_candidate"
  node "$control/profile.cjs" "$manifest" "$objects" "$profile_candidate" "$dependency_cache"
  local candidate_agent_dir="$profile_candidate/home/.pi/agent"
  mkdir -p "$candidate_agent_dir"
  cp "$authentication" "$candidate_agent_dir/auth.json"
  chmod 600 "$candidate_agent_dir/auth.json"
  rm -rf -- "$profile"
  mv "$profile_candidate" "$profile"
}

mkdir -p "$root/runtime" "$dependency_cache" "$objects"
prepare_runtime &
runtime_job=$!
prepare_profile
progress "Workspace profile ready"
wait "$runtime_job"
runtime_job=
