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
trust_mode=$6
pi_command=$7
agent_dir=$8
herdr_command=$9
herdr_session=${10}
launch_id=${11}
handoff_ref=${12}

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

recorded_launch_id=$(cat "$control/launch-id") || fail "Could not read the recorded launch ID"
if [[ "$recorded_launch_id" != "$launch_id" ]]; then
  fail "Runner launch ID does not match the recorded launch ID"
fi
printf '{"launchId":"%s","pid":%s}\n' "$launch_id" "$$" > "$control/runner.tmp.$$" || fail "Could not record remote Pi runner ownership"
mv -f "$control/runner.tmp.$$" "$control/runner" || fail "Could not publish remote Pi runner ownership"

if [[ ! -f "$session" || -L "$session" ]]; then
  fail "Invalid or missing canonical remote Pi session: $session"
fi
if [[ ! -f "$agent_dir/auth.json" || -L "$agent_dir/auth.json" ]]; then
  fail "Private workspace Pi authentication is missing"
fi

trap 'fail "Remote Pi runner received SIGHUP"' HUP
trap 'fail "Remote Pi runner received SIGINT"' INT
trap 'fail "Remote Pi runner received SIGTERM"' TERM

cd "$repository" || fail "Cannot enter remote repository"
write_state preparing
rm -f "$control/active-session"

pi_args=("$trust_mode" --session "$session" --extension "$companion")
PI_REMOTE_HANDOFF_CONTROL="$control" PI_CODING_AGENT_DIR="$agent_dir" "$pi_command" "${pi_args[@]}"
pi_status=$?
pi_log_temporary="$control/pi.log.tmp"
rm -f "$pi_log_temporary"
"$herdr_command" --session "$herdr_session" pane read "$HERDR_PANE_ID" \
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
bundle_revisions=("$result_ref")
if git rev-parse -q --verify "$handoff_ref^{commit}" >/dev/null; then
  bundle_revisions+=("^$handoff_ref")
fi
git bundle create "$result_directory_temporary/result.bundle" "${bundle_revisions[@]}" || fail "Could not create the remote result bundle"
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
