#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
REAL_AGENT_DIR=${PI_REMOTE_HANDOFF_E2E_SOURCE_AGENT_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}
AUTHORITATIVE_TASK=${PI_REMOTE_HANDOFF_E2E_PROTECTED_TASK:-}
UI_TIMEOUT=${PI_REMOTE_HANDOFF_E2E_UI_TIMEOUT_SECONDS:-180}
START_TIMEOUT=${PI_REMOTE_HANDOFF_E2E_START_TIMEOUT_SECONDS:-900}
REMOTE_IDLE_TIMEOUT=${PI_REMOTE_HANDOFF_E2E_REMOTE_IDLE_TIMEOUT_SECONDS:-600}
MODEL_TIMEOUT=${PI_REMOTE_HANDOFF_E2E_MODEL_TIMEOUT_SECONDS:-900}
PACE=${PI_REMOTE_HANDOFF_E2E_KEY_PACE_SECONDS:-0.20}
RUN_ID="$(date +%Y%m%d%H%M%S)-$$-$RANDOM"
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/pi-remote-handoff-e2e.XXXXXX")
ROOT=$(cd "$ROOT" && pwd -P)
DIAGNOSTIC=${PI_REMOTE_HANDOFF_E2E_DIAGNOSTIC:-${TMPDIR:-/tmp}/pi-remote-handoff-e2e-${RUN_ID}.log}
CONTROLLERS="$ROOT/controllers"
FIXTURES="$ROOT/fixtures"
REMOTE_RESOURCES="$ROOT/remote-resources"
CLIENT_PIDS="$ROOT/client-pids"
REVIEW_DIRS_BEFORE="$ROOT/review-dirs-before"
RUN_LOCK="${TMPDIR:-/tmp}/pi-remote-handoff-e2e.lock"
RUN_LOCK_OWNED=0
mkdir -p "$ROOT"
: > "$CONTROLLERS"
: > "$FIXTURES"
: > "$REMOTE_RESOURCES"
: > "$CLIENT_PIDS"
find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'pi-remote-handoff-review-*' -print 2>/dev/null | sort > "$REVIEW_DIRS_BEFORE"

CURRENT_STEP=initialization
FAILED=1
HOST=
AUTH_BEFORE_HASH=
AUTH_BEFORE_MTIME=
AUTH_BEFORE_PHASE=

local_herdr() {
  local -a command=(env)
  local variable
  for variable in "${!PI_SIMPLE_SUBAGENT@}"; do
    command+=(-u "$variable")
  done
  "${command[@]}" \
    -u HERDR_ENV \
    -u HERDR_TAB_ID \
    -u HERDR_SOCKET_PATH \
    -u HERDR_BIN_PATH \
    -u HERDR_WORKSPACE_ID \
    -u HERDR_PANE_ID \
    -u HERDR_SESSION \
    herdr "$@"
}

redact() {
  if [[ -n ${HOST:-} ]]; then
    sed "s#$(printf '%s' "$HOST" | sed 's/[][\\.^$*+?{}|()#]/\\&/g')#<redacted-host>#g"
  else
    cat
  fi
}

record_diagnostic() {
  {
    printf 'step: %s\n' "$CURRENT_STEP"
    printf 'lines: %s\n' "${FAIL_STACK:-unknown}"
    printf 'run: %s\n' "$RUN_ID"
    while IFS=$'\t' read -r name pane; do
      [[ -n "$name" && -n "$pane" ]] || continue
      printf '\ncontroller: %s\n' "$name"
      local_herdr --session "$name" pane read "$pane" --source recent-unwrapped --lines 300 2>&1 || true
    done < "$CONTROLLERS"
  } | redact > "$DIAGNOSTIC" 2>/dev/null || true
  chmod 600 "$DIAGNOSTIC" 2>/dev/null || true
}

safe_local_session_cleanup() {
  local name=$1
  [[ "$name" == pi-rh-e2e-* && "$name" != default ]] || return 0
  local_herdr session stop "$name" --json >/dev/null 2>&1 || true
  local_herdr session delete "$name" --json >/dev/null 2>&1 || true
}

safe_remote_cleanup() {
  [[ -n ${HOST:-} ]] || return 0
  local remote_dir herdr_command herdr_session
  while IFS=$'\t' read -r remote_dir herdr_command herdr_session; do
    [[ "$remote_dir" == */.pi-remote-handoff/workspaces/* ]] || continue
    [[ "$herdr_command" == /* ]] || continue
    [[ "$herdr_session" == pi-handoff-* && "$herdr_session" != default ]] || continue
    ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" bash -s -- "$remote_dir" "$herdr_command" "$herdr_session" >/dev/null 2>&1 <<'REMOTE_CLEANUP' || true
set -u
remote_dir=$1
herdr_command=$2
herdr_session=$3
if "$herdr_command" --session "$herdr_session" status server --json 2>/dev/null | jq -e '.running == true' >/dev/null 2>&1; then
  "$herdr_command" session stop "$herdr_session" --json >/dev/null 2>&1 || true
fi
"$herdr_command" session delete "$herdr_session" --json >/dev/null 2>&1 || true
rm -rf -- "$remote_dir"
REMOTE_CLEANUP
  done < "$REMOTE_RESOURCES"
}

record_fixture_remote_resources() {
  local project task record
  while IFS= read -r project; do
    [[ -e "$project" ]] || continue
    task=$(task_file "$project")
    [[ -f "$task" ]] || continue
    record=$(jq -r '[.remoteDir,.remoteHerdrCommand,.herdrSession] | @tsv' "$task" 2>/dev/null) || continue
    grep -Fqx "$record" "$REMOTE_RESOURCES" 2>/dev/null || printf '%s\n' "$record" >> "$REMOTE_RESOURCES"
  done < "$FIXTURES"
}

safe_fixture_cleanup() {
  local repo git_dir path ref
  while IFS= read -r repo; do
    [[ -d "$repo/.git" ]] || continue
    git_dir=$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
    [[ -n "$git_dir" ]] || continue
    while IFS= read -r path; do
      [[ "$path" == "${TMPDIR:-/tmp}"/pi-remote-handoff-review-*/worktree ]] || continue
      git -C "$repo" worktree remove --force "$path" >/dev/null 2>&1 || true
      rm -rf -- "$(dirname "$path")"
    done < <(git -C "$repo" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
    while IFS= read -r ref; do
      [[ "$ref" == refs/pi-remote-handoff/* ]] || continue
      git -C "$repo" update-ref -d "$ref" >/dev/null 2>&1 || true
    done < <(git -C "$repo" for-each-ref --format='%(refname)' refs/pi-remote-handoff/ 2>/dev/null)
    rm -rf -- "$git_dir/pi-remote-handoff" "$git_dir/pi-remote-handoff.operation"
  done < "$FIXTURES"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ $FAILED -ne 0 || $status -ne 0 ]]; then record_diagnostic; fi
  while IFS=$'\t' read -r name _pane; do
    [[ -n "$name" ]] && safe_local_session_cleanup "$name"
  done < "$CONTROLLERS"
  record_fixture_remote_resources
  safe_remote_cleanup
  safe_fixture_cleanup
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && wait "$pid" 2>/dev/null || true
  done < "$CLIENT_PIDS"
  if [[ $RUN_LOCK_OWNED -eq 1 && -f "$RUN_LOCK/pid" && $(cat "$RUN_LOCK/pid" 2>/dev/null || true) == $$ ]]; then
    rm -rf -- "$RUN_LOCK"
  fi
  rm -rf -- "$ROOT"
  if [[ $FAILED -eq 0 && $status -eq 0 ]]; then rm -f -- "$DIAGNOSTIC"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  FAIL_STACK=${BASH_LINENO[*]:-unknown}
  printf 'FAIL  %s\n' "$CURRENT_STEP" >&2
  return 1
}

pass() {
  printf 'PASS  %s\n' "$CURRENT_STEP"
}

step() {
  CURRENT_STEP=$1
}

require_commands() {
  local command
  for command in bash node jq git ssh scp pi herdr npm tar shasum stat; do
    command -v "$command" >/dev/null || fail
  done
}

check_ssh() {
  local error_file="$ROOT/ssh-check"
  if ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" true >/dev/null 2>"$error_file"; then
    rm -f "$error_file"
    return
  fi
  local identities
  identities=$(ssh-add -l 2>&1 || true)
  if { cat "$error_file"; printf '%s\n' "$identities"; } | grep -Eqi 'no identities|sign_and_send_pubkey: signing failed|incorrect passphrase|agent refused operation'; then
    printf 'Your SSH key is locked\n'
    exit 1
  fi
  fail
}

assert_authoritative_unchanged() {
  [[ -n "$AUTHORITATIVE_TASK" ]] || return 0
  [[ -f "$AUTHORITATIVE_TASK" ]] || fail
  local hash mtime phase
  hash=$(shasum -a 256 "$AUTHORITATIVE_TASK" | cut -d' ' -f1)
  mtime=$(stat -f '%m' "$AUTHORITATIVE_TASK")
  phase=$(jq -r '.phase' "$AUTHORITATIVE_TASK")
  [[ "$hash" == "$AUTH_BEFORE_HASH" && "$mtime" == "$AUTH_BEFORE_MTIME" && "$phase" == "$AUTH_BEFORE_PHASE" ]] || fail
}

make_profile() {
  local profile=$1
  mkdir -m 700 -p "$profile"
  cp "$REAL_AGENT_DIR/auth.json" "$profile/auth.json"
  chmod 600 "$profile/auth.json"
  jq '{
    defaultProvider,
    defaultModel,
    defaultThinkingLevel,
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: []
  }' "$REAL_AGENT_DIR/settings.json" > "$profile/settings.json"
  chmod 600 "$profile/settings.json"
  local model_file
  for model_file in models.json models-store.json; do
    [[ -f "$REAL_AGENT_DIR/$model_file" ]] && cp "$REAL_AGENT_DIR/$model_file" "$profile/$model_file"
  done
  cp "$REAL_AGENT_DIR/pi-remote-handoff-remotes.json" "$profile/pi-remote-handoff-remotes.json"
  chmod 600 "$profile/pi-remote-handoff-remotes.json"
  [[ $(jq 'length' "$profile/pi-remote-handoff-remotes.json") -eq 1 ]] || fail
  [[ $(find "$profile" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ') -eq 0 ]] || fail
  [[ $(jq '[.packages,.extensions,.skills,.prompts,.themes] | all(length == 0)' "$profile/settings.json") == true ]] || fail
}

make_repo() {
  local label=$1
  local base="$ROOT/$label"
  local repo="$base/repo"
  mkdir -p "$repo" "$base/home"
  git -C "$repo" init -q
  git -C "$repo" config user.name pi-remote-handoff-e2e
  git -C "$repo" config user.email pi-remote-handoff-e2e@invalid
  printf 'base\n' > "$repo/base.txt"
  git -C "$repo" add base.txt
  git -C "$repo" commit -qm base
  printf '%s\n' "$repo" >> "$FIXTURES"
  make_profile "$base/profile"
  printf '%s\n' "$base"
}

make_directory() {
  local label=$1
  local base="$ROOT/$label"
  local dir="$base/project"
  mkdir -p "$dir" "$base/home"
  ! git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 || fail
  printf 'base\n' > "$dir/base.txt"
  printf 'ignored.txt\n' > "$dir/.gitignore"
  printf 'ignored\n' > "$dir/ignored.txt"
  printf '%s\n' "$dir" >> "$FIXTURES"
  make_profile "$base/profile"
  printf '%s\n' "$base"
}

directory_namespace() {
  local dir=$1 hash
  hash=$(printf '%s' "$(cd "$dir" && pwd -P)" | shasum -a 256 | cut -d' ' -f1)
  printf '%s/profile/remote-handoff/directories/%s\n' "$(dirname "$dir")" "$hash"
}

task_file() {
  local repo=$1
  local namespace
  if [[ -d "$repo/.git" ]]; then
    namespace=$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)
  else
    namespace=$(directory_namespace "$repo")
  fi
  printf '%s/pi-remote-handoff/task.json\n' "$namespace"
}

record_task_resources() {
  local repo=$1 task
  task=$(task_file "$repo")
  [[ -f "$task" ]] || fail
  local record
  record=$(jq -r '[.remoteDir,.remoteHerdrCommand,.herdrSession] | @tsv' "$task")
  grep -Fqx "$record" "$REMOTE_RESOURCES" 2>/dev/null || printf '%s\n' "$record" >> "$REMOTE_RESOURCES"
}

start_controller() {
  local base=$1 repo=$2 original=$3
  local name="pi-rh-e2e-${RUN_ID}-$RANDOM"
  local client="$base/herdr-client-$name.log"
  (
    unset HERDR_ENV HERDR_TAB_ID HERDR_SOCKET_PATH HERDR_BIN_PATH HERDR_WORKSPACE_ID HERDR_PANE_ID HERDR_SESSION
    local variable
    for variable in "${!PI_SIMPLE_SUBAGENT@}"; do unset "$variable"; done
    exec script -q "$client" bash -c 'stty rows 50 cols 160; exec herdr session attach "$1"' _ "$name"
  ) >/dev/null 2>&1 &
  local client_pid=$!
  printf '%s\n' "$client_pid" >> "$CLIENT_PIDS"
  printf '%s\n' "$client_pid" > "$base/herdr-client.pid"

  local panes pane previous= stable=0 deadline=$((SECONDS + UI_TIMEOUT))
  while (( SECONDS < deadline )); do
    if panes=$(local_herdr --session "$name" pane list 2>/dev/null); then
      pane=$(jq -r '.result.panes | if length == 1 then .[0].pane_id else empty end' <<<"$panes")
      if [[ -n "$pane" && "$pane" == "$previous" ]]; then
        stable=$((stable + 1))
        (( stable >= 3 )) && break
      else
        previous=$pane
        stable=0
      fi
    fi
    sleep 0.25
  done
  [[ -n ${pane:-} && $stable -ge 3 ]] || fail

  local command
  printf -v command 'cd %q && exec env HOME=%q PI_CODING_AGENT_DIR=%q pi --approve --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --session %q --extension %q' \
    "$repo" "$base/home" "$base/profile" "$original" "$PROJECT_ROOT/src/index.ts"
  local_herdr --session "$name" pane run "$pane" "$command" >/dev/null
  wait_agent_idle "$name" "$pane" "$UI_TIMEOUT"
  printf '%s\t%s\n' "$name" "$pane" >> "$CONTROLLERS"
  printf '%s\t%s\n' "$name" "$pane"
}

wait_agent_idle() {
  local name=$1 pane=$2 timeout=$3
  local deadline=$((SECONDS + timeout)) agents
  while (( SECONDS < deadline )); do
    agents=$(local_herdr --session "$name" agent list 2>/dev/null || true)
    if jq -e --arg pane "$pane" '.result.agents[]? | select(.pane_id == $pane and (.agent_status == "idle" or .agent_status == "done"))' >/dev/null 2>&1 <<<"$agents"; then
      return
    fi
    sleep 0.5
  done
  fail
}

pane_visible() {
  local_herdr --session "$1" pane read "$2" --source visible --lines 80 2>/dev/null
}

pane_recent() {
  local_herdr --session "$1" pane read "$2" --source recent-unwrapped --lines 500 2>/dev/null
}

wait_visible() {
  local name=$1 pane=$2 text=$3 timeout=${4:-$UI_TIMEOUT}
  local deadline=$((SECONDS + timeout)) output
  while (( SECONDS < deadline )); do
    output=$(pane_visible "$name" "$pane" || true)
    [[ "$output" == *"$text"* ]] && return
    sleep 0.4
  done
  fail
}

wait_visible_regex() {
  local name=$1 pane=$2 regex=$3 timeout=${4:-$UI_TIMEOUT}
  local deadline=$((SECONDS + timeout)) output
  while (( SECONDS < deadline )); do
    output=$(pane_visible "$name" "$pane" || true)
    grep -Eq "$regex" <<<"$output" && return
    sleep 0.4
  done
  fail
}

assert_ui_message() {
  local output=$1 expected=$2
  output=$(tr -d '[:space:]' <<<"$output")
  expected=$(tr -d '[:space:]' <<<"$expected")
  [[ "$output" == *"$expected"* ]] || fail
}

wait_for_conflict_question() {
  local name=$1 pane=$2 deadline=$((SECONDS + MODEL_TIMEOUT)) output agents
  while (( SECONDS < deadline )); do
    output=$(pane_visible "$name" "$pane" || true)
    agents=$(local_herdr --session "$name" agent list 2>/dev/null || true)
    if grep -F 'shared.txt' <<<"$output" >/dev/null \
      && grep -F '?' <<<"$output" >/dev/null \
      && grep -Eqi 'local|remote|content|version' <<<"$output" \
      && jq -e --arg pane "$pane" '.result.agents[]? | select(.pane_id == $pane and (.agent_status == "idle" or .agent_status == "done"))' >/dev/null 2>&1 <<<"$agents"; then
      CONFLICT_QUESTION=$output
      return
    fi
    sleep 1
  done
  fail
}

wait_review_resolution() {
  local repo=$1 deadline=$((SECONDS + MODEL_TIMEOUT)) worktree
  while (( SECONDS < deadline )); do
    worktree=$(git -C "$repo" worktree list --porcelain | sed -n 's/^worktree //p' | grep 'pi-remote-handoff-review-' | head -1 || true)
    if [[ -n "$worktree" && -f "$worktree/shared.txt" ]] \
      && [[ $(cat "$worktree/shared.txt") == combined ]] \
      && git -C "$worktree" diff --cached --name-only | grep -Fx shared.txt >/dev/null; then
      return
    fi
    sleep 1
  done
  fail
}

complete_merge_review() {
  local name=$1 pane=$2 repo=$3
  local deadline=$((SECONDS + MODEL_TIMEOUT)) output agents worktree idle_polls=0 command_sent=0
  while (( SECONDS < deadline )); do
    output=$(pane_visible "$name" "$pane" || true)
    if grep -Eq '^[[:space:]]*Changes apply will make[[:space:]]*$' <<<"$output"; then return; fi
    if grep -Eq '^[[:space:]]*(→[[:space:]]+)?Complete merge review[[:space:]]*$' <<<"$output"; then
      send_key "$name" "$pane" enter
      command_sent=1
      idle_polls=0
      sleep 1
      continue
    fi

    worktree=$(git -C "$repo" worktree list --porcelain | sed -n 's/^worktree //p' | grep 'pi-remote-handoff-review-' | head -1 || true)
    if [[ -z "$worktree" ]]; then
      wait_visible "$name" "$pane" 'Changes apply will make' "$START_TIMEOUT"
      return
    fi
    if [[ $command_sent -eq 1 ]]; then
      idle_polls=0
      sleep 1
      continue
    fi

    agents=$(local_herdr --session "$name" agent list 2>/dev/null || true)
    if jq -e --arg pane "$pane" '.result.agents[]? | select(.pane_id == $pane and (.agent_status == "idle" or .agent_status == "done"))' >/dev/null 2>&1 <<<"$agents"; then
      idle_polls=$((idle_polls + 1))
      if (( idle_polls >= 10 )); then
        send_text_enter "$name" "$pane" /remote-handoff
        command_sent=1
      fi
    else
      idle_polls=0
    fi
    sleep 1
  done
  fail
}

send_text_enter() {
  local name=$1 pane=$2 text=$3
  local_herdr --session "$name" pane send-text "$pane" "$text" >/dev/null
  sleep "$PACE"
  local_herdr --session "$name" pane send-text "$pane" $'\r' >/dev/null
  sleep "$PACE"
}

send_key() {
  local_herdr --session "$1" pane send-keys "$2" "$3" >/dev/null
  sleep "$PACE"
}

close_text_viewer() {
  sleep 2
  local_herdr --session "$1" pane send-text "$2" q >/dev/null
  sleep "$PACE"
}

choose_down() {
  local name=$1 pane=$2 count=$3 i
  for ((i=0; i<count; i++)); do send_key "$name" "$pane" down; done
  send_key "$name" "$pane" enter
}

confirm_yes() {
  local name=$1 pane=$2 expected=$3
  wait_visible "$name" "$pane" "$expected"
  send_key "$name" "$pane" enter
}

wait_task_phase() {
  local repo=$1 expected=$2 timeout=$3
  local task deadline=$((SECONDS + timeout)) phase
  task=$(task_file "$repo")
  while (( SECONDS < deadline )); do
    if [[ -f "$task" ]]; then
      phase=$(jq -r '.phase // empty' "$task" 2>/dev/null || true)
      [[ "$phase" == "$expected" ]] && return
    fi
    sleep 0.5
  done
  fail
}

wait_remote_state() {
  local repo=$1 expected=$2 timeout=$3
  local task remote_dir state deadline=$((SECONDS + timeout)) error_file="$ROOT/remote-state-error"
  task=$(task_file "$repo")
  remote_dir=$(jq -r '.remoteDir' "$task")
  while (( SECONDS < deadline )); do
    state=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "cat $(printf %q "$remote_dir/control/state")" 2>"$error_file" || true)
    if grep -Eqi 'no identities|sign_and_send_pubkey: signing failed|incorrect passphrase|agent refused operation' "$error_file"; then
      printf 'Your SSH key is locked\n'
      exit 1
    fi
    [[ "$state" == "$expected" ]] && return
    sleep 1
  done
  fail
}

wait_remote_file_content() {
  local remote_file=$1 expected=$2 timeout=${3:-$UI_TIMEOUT}
  local deadline=$((SECONDS + timeout)) value error_file="$ROOT/remote-file-error"
  while (( SECONDS < deadline )); do
    value=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "cat $(printf %q "$remote_file")" 2>"$error_file" || true)
    if grep -Eqi 'no identities|sign_and_send_pubkey: signing failed|incorrect passphrase|agent refused operation' "$error_file"; then
      printf 'Your SSH key is locked\n'
      exit 1
    fi
    [[ "$value" == "$expected" ]] && return
    sleep 0.5
  done
  fail
}

wait_local_controller_ready() {
  local name=$1 pane=$2 repo=$3
  wait_agent_idle "$name" "$pane" "$UI_TIMEOUT"
  wait_visible "$name" "$pane" "$(cd "$repo" && pwd -P)" "$UI_TIMEOUT"
  send_key "$name" "$pane" ctrl+c
  sleep 2
}

open_prepared_menu() {
  local name=$1 pane=$2 deadline=$((SECONDS + UI_TIMEOUT)) output
  PREPARED_AUTO_VIEW=0
  send_text_enter "$name" "$pane" /remote-handoff
  while (( SECONDS < deadline )); do
    output=$(pane_visible "$name" "$pane" || true)
    if [[ "$output" == *'view diff'* ]]; then return; fi
    if [[ "$output" == *'Remote changes'* ]]; then
      PREPARED_AUTO_VIEW=1
      close_text_viewer "$name" "$pane"
      wait_visible "$name" "$pane" 'view diff'
      return
    fi
    sleep 0.4
  done
  fail
}

assert_no_driver_errors() {
  local name=$1 pane=$2 output
  output=$(pane_recent "$name" "$pane" || true)
  ! grep -Eqi 'stale.{0,20}context|operation.{0,10}lock|ELOCKED' <<<"$output" || fail
}

assert_remote_absent() {
  local remote_dir=$1 herdr_command=$2 herdr_session=$3
  local result
  result=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" bash -s -- "$remote_dir" "$herdr_command" "$herdr_session" <<'REMOTE_ASSERT'
set -eu
remote_dir=$1
herdr_command=$2
herdr_session=$3
workspace=present
session=present
test ! -e "$remote_dir" && workspace=absent
if ! "$herdr_command" session list 2>/dev/null | awk -v name="$herdr_session" '$1 == name { found=1 } END { exit found ? 0 : 1 }'; then
  session=absent
fi
printf '%s %s\n' "$workspace" "$session"
REMOTE_ASSERT
)
  [[ "$result" == "absent absent" ]] || fail
}

assert_clean_handoff() {
  local repo=$1 remote_dir=$2 herdr_command=$3 herdr_session=$4
  local git_dir
  git_dir=$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)
  [[ ! -e "$git_dir/pi-remote-handoff/task.json" ]] || fail
  [[ ! -e "$git_dir/pi-remote-handoff" ]] || fail
  [[ -z $(git -C "$repo" for-each-ref --format='%(refname)' refs/pi-remote-handoff/) ]] || fail
  [[ $(git -C "$repo" worktree list --porcelain | grep -c '^worktree ' || true) -eq 1 ]] || fail
  assert_remote_absent "$remote_dir" "$herdr_command" "$herdr_session"
}

assert_clean_directory_handoff() {
  local dir=$1 remote_dir=$2 herdr_command=$3 herdr_session=$4
  local namespace
  namespace=$(directory_namespace "$dir")
  [[ ! -e "$namespace/pi-remote-handoff/task.json" ]] || fail
  [[ ! -e "$namespace/pi-remote-handoff" ]] || fail
  [[ ! -e "$namespace/repository.git" ]] || fail
  [[ ! -e "$dir/.git" ]] || fail
  assert_remote_absent "$remote_dir" "$herdr_command" "$herdr_session"
}

stop_controller() {
  local name=$1 base=$2 pid deadline
  safe_local_session_cleanup "$name"
  pid=$(cat "$base/herdr-client.pid")
  deadline=$((SECONDS + 10))
  while (( SECONDS < deadline )) && kill -0 "$pid" 2>/dev/null; do sleep 0.25; done
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 0.25
  fi
}

remove_scenario_fixture() {
  local base=$1
  [[ "$base" == "$ROOT"/* ]] || fail
  rm -rf -- "$base"
  [[ ! -e "$base" ]] || fail
}

scenario_direct_apply() {
  step 'direct apply: setup'
  local base repo original controller name pane task remote_dir remote_herdr remote_session control
  base=$(make_repo direct)
  repo="$base/repo"
  original="$base/original.jsonl"
  [[ ! -e "$original" ]] || fail
  controller=$(start_controller "$base" "$repo" "$original")
  name=${controller%%$'\t'*}; pane=${controller#*$'\t'}
  [[ ! -e "$original" ]] || fail
  pass

  step 'direct apply: start and attach'
  send_text_enter "$name" "$pane" /remote-handoff
  wait_visible "$name" "$pane" 'start: hand off this conversation'
  send_key "$name" "$pane" enter
  wait_task_phase "$repo" active "$START_TIMEOUT"
  record_task_resources "$repo"
  task=$(task_file "$repo")
  remote_dir=$(jq -r '.remoteDir' "$task")
  remote_herdr=$(jq -r '.remoteHerdrCommand' "$task")
  remote_session=$(jq -r '.herdrSession' "$task")
  control=$(jq -r '.controlSessionFile' "$task")
  [[ $(jq -r '.originalSessionExisted' "$task") == false ]] || fail
  [[ ! -e "$original" ]] || fail
  [[ -f "$(dirname "$task")/attachment-active" ]] || fail
  wait_remote_state "$repo" idle "$REMOTE_IDLE_TIMEOUT"
  pass

  step 'direct apply: remote Bash isolation'
  local before_control
  before_control=$(grep -c 'BashExecution' "$control" 2>/dev/null || true)
  send_text_enter "$name" "$pane" "!bash -c \"printf 'remote-only\\n' > remote.txt\""
  wait_remote_file_content "$remote_dir/repository/remote.txt" remote-only
  wait_remote_state "$repo" idle "$UI_TIMEOUT"
  [[ ! -e "$repo/remote.txt" ]] || fail
  [[ $(grep -c 'BashExecution' "$control" 2>/dev/null || true) -eq $before_control ]] || fail
  pass

  step 'direct apply: stop through remote companion'
  send_text_enter "$name" "$pane" /remote-handoff
  wait_visible "$name" "$pane" 'Stop and prepare result'
  choose_down "$name" "$pane" 1
  confirm_yes "$name" "$pane" 'Abort the active turn, stop Pi, and prepare the result?'
  wait_remote_state "$repo" prepared "$START_TIMEOUT"
  wait_task_phase "$repo" prepared "$UI_TIMEOUT"
  [[ ! -e "$(dirname "$task")/attachment-active" ]] || fail
  wait_local_controller_ready "$name" "$pane" "$repo"
  pass

  step 'direct apply: view diff without applying'
  open_prepared_menu "$name" "$pane"
  if [[ $PREPARED_AUTO_VIEW -eq 0 ]]; then
    send_key "$name" "$pane" enter
    wait_visible "$name" "$pane" 'Remote changes'
    wait_visible "$name" "$pane" 'remote.txt'
    close_text_viewer "$name" "$pane"
    wait_visible "$name" "$pane" 'view diff'
  else
    pane_recent "$name" "$pane" | grep -F 'remote.txt' >/dev/null || fail
  fi
  [[ ! -e "$repo/remote.txt" ]] || fail
  pass

  step 'direct apply: apply and clean up'
  local review_before returned_header
  review_before=$(find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'pi-remote-handoff-review-*' -print | sort)
  choose_down "$name" "$pane" 2
  wait_visible "$name" "$pane" 'Changes apply will make' "$START_TIMEOUT"
  close_text_viewer "$name" "$pane"
  confirm_yes "$name" "$pane" 'Return the reviewed conversation and apply these file changes without staging them?'
  local deadline=$((SECONDS + START_TIMEOUT))
  while (( SECONDS < deadline )) && [[ -e "$task" ]]; do sleep 0.5; done
  [[ ! -e "$task" ]] || fail
  [[ $(cat "$repo/remote.txt") == remote-only ]] || fail
  [[ -z $(git -C "$repo" diff --cached --name-only) ]] || fail
  git -C "$repo" status --porcelain=v1 | grep -Fx '?? remote.txt' >/dev/null || fail
  [[ -f "$original" ]] || fail
  returned_header=$(sed -n '1p' "$original")
  [[ $(jq -r '.cwd' <<<"$returned_header") == "$(cd "$repo" && pwd -P)" ]] || fail
  grep -F 'remote.txt' "$original" >/dev/null || fail
  [[ "$review_before" == "$(find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'pi-remote-handoff-review-*' -print | sort)" ]] || fail
  assert_clean_handoff "$repo" "$remote_dir" "$remote_herdr" "$remote_session"
  assert_no_driver_errors "$name" "$pane"
  stop_controller "$name" "$base"
  remove_scenario_fixture "$base"
  pass
}

scenario_directory_apply() {
  step 'directory apply: setup'
  local base dir original controller name pane namespace task remote_dir remote_herdr remote_session
  base=$(make_directory directory)
  dir="$base/project"
  original="$base/original.jsonl"
  namespace=$(directory_namespace "$dir")
  [[ ! -e "$dir/.git" ]] || fail
  [[ ! -e "$namespace" ]] || fail
  controller=$(start_controller "$base" "$dir" "$original")
  name=${controller%%$'\t'*}; pane=${controller#*$'\t'}
  pass

  step 'directory apply: start with private Git database'
  send_text_enter "$name" "$pane" /remote-handoff
  wait_visible "$name" "$pane" 'start: hand off this conversation'
  send_key "$name" "$pane" enter
  wait_task_phase "$dir" active "$START_TIMEOUT"
  record_task_resources "$dir"
  task=$(task_file "$dir")
  remote_dir=$(jq -r '.remoteDir' "$task")
  remote_herdr=$(jq -r '.remoteHerdrCommand' "$task")
  remote_session=$(jq -r '.herdrSession' "$task")
  [[ "$task" == "$namespace/pi-remote-handoff/task.json" ]] || fail
  [[ $(jq -r '.repositoryKind' "$task") == directory ]] || fail
  [[ $(jq -r '.repoRoot' "$task") == "$(cd "$dir" && pwd -P)" ]] || fail
  [[ $(jq -r '.commonGitDir' "$task") == "$namespace" ]] || fail
  [[ $(jq -r '.privateGitDir' "$task") == "$namespace/repository.git" ]] || fail
  [[ -d "$namespace/repository.git" ]] || fail
  [[ ! -e "$dir/.git" ]] || fail
  wait_remote_state "$dir" idle "$REMOTE_IDLE_TIMEOUT"
  wait_remote_file_content "$remote_dir/repository/base.txt" base
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "test ! -e $(printf %q "$remote_dir/repository/ignored.txt")" || fail
  pass

  step 'directory apply: remote edit'
  send_text_enter "$name" "$pane" "!bash -c \"printf 'remote-only\\n' > remote.txt\""
  wait_remote_file_content "$remote_dir/repository/remote.txt" remote-only
  wait_remote_state "$dir" idle "$UI_TIMEOUT"
  [[ ! -e "$dir/remote.txt" ]] || fail
  [[ ! -e "$dir/.git" ]] || fail
  pass

  step 'directory apply: stop through remote companion'
  send_text_enter "$name" "$pane" /remote-handoff
  wait_visible "$name" "$pane" 'Stop and prepare result'
  choose_down "$name" "$pane" 1
  confirm_yes "$name" "$pane" 'Abort the active turn, stop Pi, and prepare the result?'
  wait_remote_state "$dir" prepared "$START_TIMEOUT"
  wait_task_phase "$dir" prepared "$UI_TIMEOUT"
  wait_local_controller_ready "$name" "$pane" "$dir"
  pass

  step 'directory apply: apply and clean up'
  local apply_view
  open_prepared_menu "$name" "$pane"
  choose_down "$name" "$pane" 2
  wait_visible "$name" "$pane" 'Changes apply will make' "$START_TIMEOUT"
  apply_view=$(pane_visible "$name" "$pane")
  grep -F 'remote.txt' <<<"$apply_view" >/dev/null || fail
  ! grep -F 'ignored.txt' <<<"$apply_view" >/dev/null || fail
  close_text_viewer "$name" "$pane"
  confirm_yes "$name" "$pane" 'Return the reviewed conversation and apply these file changes without staging them?'
  local deadline=$((SECONDS + START_TIMEOUT))
  while (( SECONDS < deadline )) && [[ -e "$task" ]]; do sleep 0.5; done
  [[ ! -e "$task" ]] || fail
  [[ $(cat "$dir/remote.txt") == remote-only ]] || fail
  [[ $(cat "$dir/base.txt") == base ]] || fail
  [[ $(cat "$dir/ignored.txt") == ignored ]] || fail
  [[ -f "$original" ]] || fail
  [[ $(jq -r '.cwd' <<<"$(sed -n '1p' "$original")") == "$(cd "$dir" && pwd -P)" ]] || fail
  grep -F 'remote.txt' "$original" >/dev/null || fail
  assert_clean_directory_handoff "$dir" "$remote_dir" "$remote_herdr" "$remote_session"
  assert_no_driver_errors "$name" "$pane"
  stop_controller "$name" "$base"
  remove_scenario_fixture "$base"
  pass
}

scenario_merge_review() {
  step 'merge review: setup and diverge'
  local base repo original controller name pane task remote_dir remote_herdr remote_session
  base=$(make_repo merge)
  repo="$base/repo"; original="$base/original.jsonl"
  printf 'base\n' > "$repo/shared.txt"
  printf 'staged-base\n' > "$repo/staged.txt"
  printf 'local-base\n' > "$repo/local.txt"
  git -C "$repo" add shared.txt staged.txt local.txt
  git -C "$repo" commit -qm fixtures
  controller=$(start_controller "$base" "$repo" "$original")
  name=${controller%%$'\t'*}; pane=${controller#*$'\t'}
  send_text_enter "$name" "$pane" /remote-handoff
  wait_visible "$name" "$pane" 'start: hand off this conversation'
  send_key "$name" "$pane" enter
  wait_task_phase "$repo" active "$START_TIMEOUT"
  record_task_resources "$repo"
  task=$(task_file "$repo")
  remote_dir=$(jq -r '.remoteDir' "$task")
  remote_herdr=$(jq -r '.remoteHerdrCommand' "$task")
  remote_session=$(jq -r '.herdrSession' "$task")
  wait_remote_state "$repo" idle "$REMOTE_IDLE_TIMEOUT"
  send_text_enter "$name" "$pane" "!bash -c \"printf 'remote\\n' > shared.txt\""
  wait_remote_file_content "$remote_dir/repository/shared.txt" remote
  wait_remote_state "$repo" idle "$UI_TIMEOUT"
  printf 'local\n' > "$repo/shared.txt"
  printf 'staged-change\n' > "$repo/staged.txt"
  git -C "$repo" add staged.txt
  printf 'local-change\n' > "$repo/local.txt"
  local cached_before="$base/cached-before.patch" cached_hash
  git -C "$repo" diff --cached --binary > "$cached_before"
  cached_hash=$(shasum -a 256 "$cached_before" | cut -d' ' -f1)
  pass

  step 'merge review: prepare result'
  send_text_enter "$name" "$pane" /remote-handoff
  wait_visible "$name" "$pane" 'Stop and prepare result'
  choose_down "$name" "$pane" 1
  confirm_yes "$name" "$pane" 'Abort the active turn, stop Pi, and prepare the result?'
  wait_remote_state "$repo" prepared "$START_TIMEOUT"
  wait_task_phase "$repo" prepared "$UI_TIMEOUT"
  wait_local_controller_ready "$name" "$pane" "$repo"
  pass

  step 'merge review: real Pi resolves ambiguous conflict'
  open_prepared_menu "$name" "$pane"
  choose_down "$name" "$pane" 2
  wait_for_conflict_question "$name" "$pane"
  grep -F 'shared.txt' <<<"$CONFLICT_QUESTION" >/dev/null || fail
  grep -F '?' <<<"$CONFLICT_QUESTION" >/dev/null || fail
  send_text_enter "$name" "$pane" 'Use custom content: combined'
  wait_review_resolution "$repo"
  complete_merge_review "$name" "$pane" "$repo"
  local apply_view
  apply_view=$(pane_visible "$name" "$pane")
  grep -F 'combined' <<<"$apply_view" >/dev/null || fail
  close_text_viewer "$name" "$pane"
  confirm_yes "$name" "$pane" 'Return the reviewed conversation and apply these file changes without staging them?'
  local deadline=$((SECONDS + START_TIMEOUT))
  while (( SECONDS < deadline )) && [[ -e "$task" ]]; do sleep 0.5; done
  [[ ! -e "$task" ]] || fail
  pass

  step 'merge review: preserve local Git state and clean up'
  local cached_after="$base/cached-after.patch"
  git -C "$repo" diff --cached --binary > "$cached_after"
  [[ $(shasum -a 256 "$cached_after" | cut -d' ' -f1) == "$cached_hash" ]] || fail
  cmp -s "$cached_before" "$cached_after" || fail
  [[ $(cat "$repo/shared.txt") == combined ]] || fail
  git -C "$repo" diff --name-only | grep -Fx shared.txt >/dev/null || fail
  [[ $(cat "$repo/local.txt") == local-change ]] || fail
  git -C "$repo" diff --name-only | grep -Fx local.txt >/dev/null || fail
  [[ $(cat "$repo/staged.txt") == staged-change ]] || fail
  [[ $(git -C "$repo" diff --cached --name-only) == staged.txt ]] || fail
  [[ -f "$original" ]] || fail
  [[ $(jq -r '.cwd' <<<"$(sed -n '1p' "$original")") == "$(cd "$repo" && pwd -P)" ]] || fail
  grep -F 'Use custom content: combined' "$original" >/dev/null || fail
  [[ $(git -C "$repo" worktree list --porcelain | grep -c '^worktree ') -eq 1 ]] || fail
  [[ -z $(git -C "$repo" for-each-ref --format='%(refname)' 'refs/pi-remote-handoff/review-*') ]] || fail
  assert_clean_handoff "$repo" "$remote_dir" "$remote_herdr" "$remote_session"
  assert_no_driver_errors "$name" "$pane"
  stop_controller "$name" "$base"
  remove_scenario_fixture "$base"
  pass
}

scenario_restart_discard() {
  step 'controller restart: start active handoff'
  local base repo original controller name pane task remote_dir remote_herdr remote_session
  base=$(make_repo restart)
  repo="$base/repo"; original="$base/original.jsonl"
  controller=$(start_controller "$base" "$repo" "$original")
  name=${controller%%$'\t'*}; pane=${controller#*$'\t'}
  send_text_enter "$name" "$pane" /remote-handoff
  wait_visible "$name" "$pane" 'start: hand off this conversation'
  send_key "$name" "$pane" enter
  wait_task_phase "$repo" active "$START_TIMEOUT"
  record_task_resources "$repo"
  task=$(task_file "$repo")
  remote_dir=$(jq -r '.remoteDir' "$task")
  remote_herdr=$(jq -r '.remoteHerdrCommand' "$task")
  remote_session=$(jq -r '.herdrSession' "$task")
  wait_remote_state "$repo" idle "$REMOTE_IDLE_TIMEOUT"
  stop_controller "$name" "$base"
  wait_remote_state "$repo" idle "$UI_TIMEOUT"
  pass

  step 'controller restart: reconcile and discard'
  local recovery="$base/recovery.jsonl"
  controller=$(start_controller "$base" "$repo" "$recovery")
  name=${controller%%$'\t'*}; pane=${controller#*$'\t'}
  send_text_enter "$name" "$pane" /remote-handoff
  wait_visible "$name" "$pane" 'Remote Pi is active'
  choose_down "$name" "$pane" 2
  wait_remote_state "$repo" prepared "$START_TIMEOUT"
  wait_task_phase "$repo" prepared "$UI_TIMEOUT"
  wait_visible "$name" "$pane" 'view diff'
  choose_down "$name" "$pane" 3
  confirm_yes "$name" "$pane" 'Delete the prepared files and remote conversation without applying them?'
  local deadline=$((SECONDS + START_TIMEOUT))
  while (( SECONDS < deadline )) && [[ -e "$task" ]]; do sleep 0.5; done
  [[ ! -e "$task" && -f "$original" ]] || fail
  [[ $(jq -r '.cwd' <<<"$(sed -n '1p' "$original")") == "$(cd "$repo" && pwd -P)" ]] || fail
  assert_clean_handoff "$repo" "$remote_dir" "$remote_herdr" "$remote_session"
  assert_no_driver_errors "$name" "$pane"
  stop_controller "$name" "$base"
  remove_scenario_fixture "$base"
  pass
}

if [[ $# -ne 0 ]]; then
  printf 'Usage: E2E_SCENARIO=[all|direct|directory|merge|restart] npm run verify:e2e\n' >&2
  exit 2
fi
REQUESTED_SCENARIO=${E2E_SCENARIO:-all}
case "$REQUESTED_SCENARIO" in
  all | direct | directory | merge | restart) ;;
  *)
    printf 'Usage: E2E_SCENARIO=[all|direct|directory|merge|restart] npm run verify:e2e\n' >&2
    exit 2
    ;;
esac

if ! mkdir -m 700 "$RUN_LOCK" 2>/dev/null; then
  lock_pid=$(cat "$RUN_LOCK/pid" 2>/dev/null || true)
  if [[ "$lock_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$lock_pid" 2>/dev/null; then
    step 'exclusive E2E run'
    fail
  fi
  rm -rf -- "$RUN_LOCK"
  mkdir -m 700 "$RUN_LOCK"
fi
printf '%s\n' $$ > "$RUN_LOCK/pid"
RUN_LOCK_OWNED=1

step 'preflight safety'
require_commands
if [[ -n "$AUTHORITATIVE_TASK" ]]; then
  [[ -f "$AUTHORITATIVE_TASK" ]] || fail
  AUTH_BEFORE_HASH=$(shasum -a 256 "$AUTHORITATIVE_TASK" | cut -d' ' -f1)
  AUTH_BEFORE_MTIME=$(stat -f '%m' "$AUTHORITATIVE_TASK")
  AUTH_BEFORE_PHASE=$(jq -r '.phase' "$AUTHORITATIVE_TASK")
fi
[[ -f "$REAL_AGENT_DIR/auth.json" && -f "$REAL_AGENT_DIR/settings.json" && -f "$REAL_AGENT_DIR/pi-remote-handoff-remotes.json" ]] || fail
[[ $(jq 'length' "$REAL_AGENT_DIR/pi-remote-handoff-remotes.json") -eq 1 ]] || fail
HOST=$(jq -r '.[0]' "$REAL_AGENT_DIR/pi-remote-handoff-remotes.json")
[[ -n "$HOST" && "$HOST" != null ]] || fail
check_ssh
pass

scenario_count=0
if [[ "$REQUESTED_SCENARIO" == all || "$REQUESTED_SCENARIO" == direct ]]; then
  scenario_direct_apply
  scenario_count=$((scenario_count + 1))
fi
if [[ "$REQUESTED_SCENARIO" == all || "$REQUESTED_SCENARIO" == directory ]]; then
  scenario_directory_apply
  scenario_count=$((scenario_count + 1))
fi
if [[ "$REQUESTED_SCENARIO" == all || "$REQUESTED_SCENARIO" == merge ]]; then
  scenario_merge_review
  scenario_count=$((scenario_count + 1))
fi
if [[ "$REQUESTED_SCENARIO" == all || "$REQUESTED_SCENARIO" == restart ]]; then
  scenario_restart_discard
  scenario_count=$((scenario_count + 1))
fi

step 'final cleanup verification'
assert_authoritative_unchanged
local_review_dirs=$(find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'pi-remote-handoff-review-*' -print 2>/dev/null | sort)
[[ "$local_review_dirs" == "$(cat "$REVIEW_DIRS_BEFORE")" ]] || fail
while IFS=$'\t' read -r name _pane; do
  [[ -z "$name" ]] && continue
  ! local_herdr session list | awk -v name="$name" '$1 == name { found=1 } END { exit !found }' || fail
done < "$CONTROLLERS"
while IFS= read -r pid; do
  [[ -z "$pid" ]] && continue
  ! kill -0 "$pid" 2>/dev/null || fail
done < "$CLIENT_PIDS"
while IFS= read -r repo; do
  [[ -z "$repo" ]] && continue
  [[ ! -e "$(dirname "$repo")" ]] || fail
done < "$FIXTURES"
while IFS=$'\t' read -r remote_dir herdr_command herdr_session; do
  [[ -z "$remote_dir" ]] && continue
  assert_remote_absent "$remote_dir" "$herdr_command" "$herdr_session"
done < "$REMOTE_RESOURCES"
pass

FAILED=0
printf 'PASS  %s scenario(s)\n' "$scenario_count"
