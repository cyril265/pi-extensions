#!/usr/bin/env bash
set -uo pipefail
umask 077

if [[ ${PI_REMOTE_HANDOFF_LOGIN_SHELL-} != 1 ]]; then
  if [[ ${SHELL-} != /* || ! -x $SHELL ]]; then
    printf 'Remote login shell is missing or invalid: %s\n' "${SHELL-}" >&2
    exit 2
  fi
  exec env PI_REMOTE_HANDOFF_LOGIN_SHELL=1 "$SHELL" -lc 'exec "$@"' remote-handoff-login "$0" "$@"
fi

control=$1
repository=$2
session=$3
companion=$4
result_ref=$5
trust_mode=${6-}
pi_command=${7-}
agent_dir=${8-}
pi_version=${9-}
herdr_command=${10-}
herdr_session=${11-}
herdr_pane_file=${12-}
herdr_version=${13-}
launch_id=${14-}

if [[ "$control" != /* || ! -d "$control" ]]; then
  printf 'Invalid or missing runner control directory: %s\n' "$control" >&2
  exit 2
fi
write_state() {
  state_temporary="$control/state.tmp.$$"
  printf '%s\n' "$1" > "$state_temporary"
  mv -f "$state_temporary" "$control/state"
}

fail() {
  error_temporary="$control/error.tmp.$$"
  printf '%s\n' "$1" > "$error_temporary"
  mv -f "$error_temporary" "$control/error"
  write_state failed
  exit 1
}

if [[ ! "$launch_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  fail "Invalid or missing launch ID"
fi
recorded_launch_id=$(cat "$control/launch-id") || fail "Could not read the recorded launch ID"
if [[ "$recorded_launch_id" != "$launch_id" ]]; then
  fail "Runner launch ID does not match the recorded launch ID"
fi
printf '{"launchId":"%s","pid":%s}\n' "$launch_id" "$$" > "$control/runner.tmp.$$" || fail "Could not record remote Pi runner ownership"
mv -f "$control/runner.tmp.$$" "$control/runner" || fail "Could not publish remote Pi runner ownership"

if [[ "$session" != "$control/session.jsonl" || ! -f "$session" || -L "$session" ]]; then
  fail "Invalid or missing canonical remote Pi session: $session"
fi

case "$trust_mode" in
  --approve | --no-approve) ;;
  *) fail "Invalid or missing runner trust mode: $trust_mode" ;;
esac

if [[ "$pi_command" != /* || ! -x "$pi_command" ]]; then
  fail "Invalid or missing Pi executable: $pi_command"
fi
if [[ -z "$pi_version" || "$($pi_command --version 2>/dev/null)" != "$pi_version" ]]; then
  fail "Shared Pi runtime does not match expected version: $pi_version"
fi
if [[ "$agent_dir" != /* || ! -d "$agent_dir" ]]; then
  fail "Invalid or missing Pi agent directory: $agent_dir"
fi
if [[ ! -f "$agent_dir/auth.json" || -L "$agent_dir/auth.json" ]]; then
  fail "Private workspace Pi authentication is missing"
fi
if [[ "$herdr_command" != /* || ! -x "$herdr_command" ]]; then
  fail "Invalid or missing Herdr executable: $herdr_command"
fi
if [[ -z "$herdr_version" || "$("$herdr_command" --version)" != "herdr $herdr_version" ]]; then
  fail "Herdr runtime does not match expected version: $herdr_version"
fi
if [[ -z "$herdr_session" || "${HERDR_SESSION-}" != "$herdr_session" ]]; then
  fail "Runner does not belong to the recorded Herdr session: $herdr_session"
fi
if [[ "${HERDR_ENV-}" != 1 || -z "${HERDR_PANE_ID-}" ]]; then
  fail "Runner is not owned by a Herdr pane"
fi
if [[ "$herdr_pane_file" != /* || ! -f "$herdr_pane_file" || -L "$herdr_pane_file" ]]; then
  fail "Invalid or missing Herdr pane metadata: $herdr_pane_file"
fi
herdr_pane=$(cat "$herdr_pane_file") || fail "Could not read Herdr pane metadata"
if [[ "$herdr_pane" != "$HERDR_PANE_ID" ]]; then
  fail "Runner Herdr pane does not match recorded pane: $herdr_pane"
fi

trap 'fail "Remote Pi runner received SIGHUP"' HUP
trap 'fail "Remote Pi runner received SIGINT"' INT
trap 'fail "Remote Pi runner received SIGTERM"' TERM

cd "$repository" || fail "Cannot enter remote repository"
write_state preparing
rm -f "$control/active-session"

set +e
pi_args=("$trust_mode" --session "$session" --extension "$companion")
PI_REMOTE_HANDOFF_CONTROL="$control" PI_CODING_AGENT_DIR="$agent_dir" "$pi_command" "${pi_args[@]}"
pi_status=$?
set -e
pi_log_temporary="$control/pi.log.tmp"
rm -f "$pi_log_temporary"
"$herdr_command" --session "$herdr_session" pane read "$herdr_pane" \
  --source recent-unwrapped --lines 200 > "$pi_log_temporary" || fail "Could not capture recent Herdr pane output"
chmod 600 "$pi_log_temporary" || fail "Could not secure captured Herdr pane output"
mv -f "$pi_log_temporary" "$control/pi.log" || fail "Could not publish captured Herdr pane output"

write_state preparing-result
active_session_file="$control/active-session"
if [[ ! -f "$active_session_file" ]]; then
  if [[ $pi_status -ne 0 ]]; then
    startup_error=$(grep -m1 '^Error:' "$control/pi.log" 2>/dev/null || true)
    fail "${startup_error:-Pi exited with status $pi_status before session startup}"
  fi
  fail "Active Pi session metadata is missing"
fi
active_session=$(cat "$active_session_file") || fail "Could not read active Pi session metadata"
if [[ "$active_session" != /* ]]; then
  fail "Active Pi session path is not absolute"
fi
if [[ ! -f "$active_session" ]]; then
  fail "Active Pi session path does not identify a regular file"
fi
if [[ "$active_session" != "$session" ]]; then
  fail "Exclusive remote Pi replaced the handed-off session"
fi

if ! git add -A; then
  fail "Could not stage the remote result for bundling"
fi
if ! git -c user.name=pi-remote-handoff -c user.email=pi-remote-handoff@invalid commit --allow-empty -m "pi-remote-handoff result" >/dev/null; then
  fail "Could not create the remote result commit"
fi
result_commit=$(git rev-parse HEAD) || fail "Could not resolve the remote result commit"
git update-ref "$result_ref" "$result_commit" || fail "Could not create the remote result ref"
result_directory_temporary="$control/result.tmp.$$"
rm -rf "$result_directory_temporary"
mkdir -m 700 "$result_directory_temporary" || fail "Could not create the result publication directory"
git bundle create "$result_directory_temporary/result.bundle" "$result_ref" || fail "Could not create the remote result bundle"
printf '%s\n' "$launch_id" > "$result_directory_temporary/result-launch-id" || fail "Could not record result launch ownership"

if [[ $pi_status -ne 0 && ! -e "$control/stop-request" ]]; then
  error_temporary="$control/error.tmp.$$"
  printf 'Pi exited with status %s\n' "$pi_status" > "$error_temporary"
  mv -f "$error_temporary" "$control/error"
fi

exec 9>"$control/launch.lock"
flock -x 9 || fail "Could not lock remote result publication"
recorded_launch_id=$(cat "$control/launch-id") || fail "Could not re-read the recorded launch ID"
if [[ "$recorded_launch_id" != "$launch_id" ]]; then
  fail "Cannot publish a result for a replaced launch ID"
fi
if [[ -e "$control/result" ]]; then
  fail "A prepared result already exists"
fi
mv "$result_directory_temporary" "$control/result" || fail "Could not publish the remote result"
write_state prepared
flock -u 9
