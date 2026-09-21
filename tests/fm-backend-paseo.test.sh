#!/usr/bin/env bash
# tests/fm-backend-paseo.test.sh - fake-Paseo-CLI unit tests for the Paseo
# session-provider adapter primitives in bin/backends/paseo.sh.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TMP_ROOT=$(fm_test_tmproot fm-backend-paseo-tests)

# make_paseo_fakebin: a small fake CLI that logs every invocation and returns
# ordered responses from <dir>/responses/<n>.out. Commands that are silent in
# the real adapter do not consume the response queue, which keeps lifecycle
# tests readable while still exercising the exact public CLI calls.
make_paseo_fakebin() {  # <dir> -> echoes fakebin dir
  local fb="$1/fakebin"
  mkdir -p "$fb"
  cat > "$fb/paseo" <<'SH'
#!/usr/bin/env bash
set -u
LOG="${FM_PASEO_LOG:?}"
RESP="${FM_PASEO_RESPONSES:?}"
{
  printf 'paseo'
  for a in "$@"; do printf '\x1f%s' "$a"; done
  printf '\n'
} >> "$LOG"

if [ "${1:-}" = --version ]; then
  printf '%s\n' "${FM_PASEO_FAKE_VERSION:-paseo 0.1.0}"
  exit "${FM_PASEO_VERSION_EXIT:-0}"
fi
if [ "${1:-}" = status ] && [ "${2:-}" = --json ]; then
  [ "${FM_PASEO_STATUS_EXIT:-0}" -eq 0 ] || exit "$FM_PASEO_STATUS_EXIT"
  if [ -n "${FM_PASEO_STATUS_JSON:-}" ]; then
    printf '%s\n' "$FM_PASEO_STATUS_JSON"
  else
    printf '%s\n' '{"localDaemon":"running"}'
  fi
  exit 0
fi
case "${1:-} ${2:-}" in
  "agent open"|"stop "*|"archive "*|"workspace archive"|"terminal kill")
    exit "${FM_PASEO_LIFECYCLE_EXIT:-0}"
    ;;
esac

COUNT_FILE="$RESP/.count"
next=$(( $(cat "$COUNT_FILE" 2>/dev/null || printf '0') + 1 ))
echo "$next" > "$COUNT_FILE"
if [ -f "$RESP/$next.exit" ]; then
  exit "$(cat "$RESP/$next.exit")"
fi
[ -f "$RESP/$next.out" ] && cat "$RESP/$next.out"
exit 0
SH
  chmod +x "$fb/paseo"
  printf '%s\n' "$fb"
}

paseo_case() {  # <name> -> sets CASE_DIR, LOG, RESP, FB
  CASE_DIR="$TMP_ROOT/$1"
  mkdir -p "$CASE_DIR/responses"
  LOG="$CASE_DIR/log"
  RESP="$CASE_DIR/responses"
  : > "$LOG"
  FB=$(make_paseo_fakebin "$CASE_DIR")
}

paseo_env() {
  PATH="$FB:$PATH" FM_PASEO_LOG="$LOG" FM_PASEO_RESPONSES="$RESP"
  export PATH FM_PASEO_LOG FM_PASEO_RESPONSES
}

test_paseo_tools_and_version_check() {
  local out status no_paseo
  paseo_case tools
  paseo_env
  FM_PASEO_FAKE_VERSION='paseo 1.2.3' \
    bash -c '. "$0/bin/backends/paseo.sh"; fm_backend_paseo_tool_check; fm_backend_paseo_version_check' "$ROOT"
  status=$?
  expect_code 0 "$status" "Paseo tool and version checks should accept an executable CLI"
  assert_contains "$(cat "$LOG")" $'paseo\x1f--version' \
    "version check did not invoke paseo --version"

  no_paseo=$(fm_test_base_path_sans "$PATH" paseo)
  out=$(PATH="$no_paseo" bash -c '. "$0/bin/backends/paseo.sh"; fm_backend_paseo_tool_check' "$ROOT" 2>&1)
  status=$?
  [ "$status" -ne 0 ] || fail "tool check should reject a missing Paseo CLI"
  assert_contains "$out" "'paseo' CLI is not installed" \
    "missing Paseo CLI error should name the executable"
  pass "Paseo tool and version checks validate the CLI and report absence"
}

test_paseo_daemon_check_accepts_local_daemon() {
  paseo_case daemon-local
  paseo_env
  FM_PASEO_STATUS_JSON='{"localDaemon":"running"}' \
    bash -c '. "$0/bin/backends/paseo.sh"; fm_backend_paseo_daemon_check' "$ROOT"
  expect_code 0 $? "daemon check should accept a running local daemon"
  pass "fm_backend_paseo_daemon_check: accepts localDaemon=running"
}

test_paseo_daemon_check_accepts_connected_daemon() {
  paseo_case daemon-connected
  paseo_env
  FM_PASEO_STATUS_JSON='{"connectedDaemon":"reachable"}' \
    bash -c '. "$0/bin/backends/paseo.sh"; fm_backend_paseo_daemon_check' "$ROOT"
  expect_code 0 $? "daemon check should accept a reachable connected daemon"
  pass "fm_backend_paseo_daemon_check: accepts connectedDaemon=reachable"
}

test_paseo_daemon_check_rejects_unavailable_daemon() {
  local out status
  paseo_case daemon-down
  paseo_env
  out=$(FM_PASEO_STATUS_JSON='{"localDaemon":"stopped","connectedDaemon":"unreachable"}' \
    bash -c '. "$0/bin/backends/paseo.sh"; fm_backend_paseo_daemon_check' "$ROOT" 2>&1)
  status=$?
  [ "$status" -ne 0 ] || fail "daemon check should reject unavailable daemons"
  assert_contains "$out" "Paseo daemon is not running" \
    "daemon check should explain an unavailable daemon"
  pass "fm_backend_paseo_daemon_check: rejects unavailable daemons"
}

test_paseo_agent_belongs_to_task_accepts_matching_label() {
  local worktree
  paseo_case belongs-label
  paseo_env
  worktree="$CASE_DIR/worktree"; mkdir -p "$worktree"
  printf '{"labels":["firstmate_task=task-label"],"cwd":"%s","workspaceId":"ws-label"}\n' "$worktree" > "$RESP/1.out"
  bash -c '. "$0/bin/backends/paseo.sh"; fm_backend_paseo_agent_belongs_to_task agent-label task-label "$1" ws-label' "$ROOT" "$worktree"
  expect_code 0 $? "matching firstmate task label should prove ownership"
  pass "fm_backend_paseo_agent_belongs_to_task: accepts matching label"
}

test_paseo_agent_belongs_to_task_accepts_matching_title() {
  local worktree
  paseo_case belongs-title
  paseo_env
  worktree="$CASE_DIR/worktree"; mkdir -p "$worktree"
  printf '{"title":"fm-task-title","cwd":"%s","workspaceId":"ws-title"}\n' "$worktree" > "$RESP/1.out"
  bash -c '. "$0/bin/backends/paseo.sh"; fm_backend_paseo_agent_belongs_to_task agent-title task-title "$1" ws-title' "$ROOT" "$worktree"
  expect_code 0 $? "matching task title should prove ownership"
  pass "fm_backend_paseo_agent_belongs_to_task: accepts matching title"
}

test_paseo_agent_belongs_to_task_accepts_normalized_matching_cwd() {
  local worktree
  paseo_case belongs-cwd
  paseo_env
  worktree="$CASE_DIR/worktree"; mkdir -p "$worktree"
  printf '{"name":"fm-task-cwd","cwd":"%s/.","workspaceId":"ws-cwd"}\n' "$worktree" > "$RESP/1.out"
  bash -c '. "$0/bin/backends/paseo.sh"; fm_backend_paseo_agent_belongs_to_task agent-cwd task-cwd "$1" ws-cwd' "$ROOT" "$worktree"
  expect_code 0 $? "normalized matching cwd should prove the agent is in the task worktree"
  pass "fm_backend_paseo_agent_belongs_to_task: accepts normalized matching cwd"
}

test_paseo_agent_belongs_to_task_rejects_mismatch() {
  local worktree other out status
  paseo_case belongs-mismatch
  paseo_env
  worktree="$CASE_DIR/worktree"; other="$CASE_DIR/other"; mkdir -p "$worktree" "$other"
  printf '{"labels":["firstmate_task=task-mismatch"],"cwd":"%s","workspaceId":"ws-mismatch"}\n' "$other" > "$RESP/1.out"
  set +e
  bash -c '. "$0/bin/backends/paseo.sh"; fm_backend_paseo_agent_belongs_to_task agent-mismatch task-mismatch "$1" ws-mismatch' "$ROOT" "$worktree"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail "ownership check should reject an agent in a different cwd"
  out=$(cat "$LOG")
  assert_contains "$out" $'paseo\x1finspect\x1fagent-mismatch' \
    "ownership mismatch should inspect the candidate agent"
  pass "fm_backend_paseo_agent_belongs_to_task: rejects cwd mismatch"
}

test_paseo_kill_stops_archives_and_verifies_agent() {
  paseo_case kill
  paseo_env
  printf '{"Status":"running"}\n' > "$RESP/1.out"
  printf '{"Status":"closed","Archived":true}\n' > "$RESP/2.out"
  bash -c '. "$0/bin/backends/paseo.sh"; fm_backend_paseo_kill agent-kill' "$ROOT"
  expect_code 0 $? "kill should stop, archive, and verify a running agent"
  local log_text
  log_text=$(cat "$LOG")
  assert_contains "$log_text" $'paseo\x1finspect\x1fagent-kill\x1f--json' \
    "kill should inspect the agent"
  assert_contains "$log_text" $'paseo\x1fstop\x1fagent-kill' \
    "kill should stop a running agent"
  assert_contains "$log_text" $'paseo\x1farchive\x1fagent-kill' \
    "kill should archive the stopped agent"
  pass "fm_backend_paseo_kill: stops, archives, and verifies a running agent"
}

test_paseo_kill_accepts_already_archived_agent_without_lifecycle_calls() {
  paseo_case kill-archived
  paseo_env
  printf '{"Status":"closed","Archived":true}\n' > "$RESP/1.out"
  bash -c '. "$0/bin/backends/paseo.sh"; fm_backend_paseo_kill agent-archived' "$ROOT"
  expect_code 0 $? "kill should accept an already archived agent"
  assert_not_contains "$(cat "$LOG")" $'paseo\x1fstop\x1f' \
    "already archived agent should not be stopped"
  assert_not_contains "$(cat "$LOG")" $'paseo\x1farchive\x1f' \
    "already archived agent should not be archived again"
  pass "fm_backend_paseo_kill: handles an already archived agent"
}

test_paseo_remove_worktree_archives_and_verifies_workspace() {
  paseo_case remove-worktree
  paseo_env
  printf '[{"workspaceId":"ws-remove","cwd":"%s","status":"archived"}]\n' "$CASE_DIR/worktree" > "$RESP/1.out"
  bash -c '. "$0/bin/backends/paseo.sh"; fm_backend_paseo_remove_worktree ws-remove' "$ROOT"
  expect_code 0 $? "remove_worktree should archive and verify the workspace"
  local log_text
  log_text=$(cat "$LOG")
  assert_contains "$log_text" $'paseo\x1fworkspace\x1farchive\x1fws-remove\x1f--json' \
    "remove_worktree should archive the workspace"
  assert_contains "$log_text" $'paseo\x1fworkspace\x1fls\x1f--json' \
    "remove_worktree should list workspaces for verification"
  pass "fm_backend_paseo_remove_worktree: archives and verifies the workspace"
}

test_paseo_agent_state_treats_archived_idle_as_dead() {
  local out
  paseo_case agent-state-archived-idle
  paseo_env
  printf '{"Status":"idle","Archived":true}\n' > "$RESP/1.out"
  printf '{"Status":"idle","Archived":true}\n' > "$RESP/2.out"
  out=$(bash -c '. "$0/bin/backends/paseo.sh"; fm_backend_paseo_agent_state agent-archived-idle' "$ROOT")
  [ "$out" = dead ] || fail "archived idle agent should be dead, got '$out'"
  pass "fm_backend_paseo_agent_state: archived idle agents are dead"
}

assert_paseo_busy_state() {  # <name> <json> <expected>
  local name=$1 json=$2 expected=$3 out
  paseo_case "busy-state-$name"
  paseo_env
  printf '%s\n' "$json" > "$RESP/1.out"
  out=$(bash -c '. "$0/bin/backends/paseo.sh"; fm_backend_paseo_busy_state agent-busy-state' "$ROOT")
  [ "$out" = "$expected" ] || fail "Paseo $name state should be $expected, got '$out'"
}

test_paseo_busy_state_maps_native_status() {
  assert_paseo_busy_state running '{"Status":"running","Archived":false}' busy
  assert_paseo_busy_state idle '{"Status":"idle","Archived":false}' idle
  assert_paseo_busy_state archived '{"Status":"idle","archived":true}' dead
  pass "fm_backend_paseo_busy_state: maps running, idle, and archived agents"
}

test_paseo_spawn_agent_extracts_id_and_opens_agent() {
  local cwd brief out
  paseo_case spawn
  paseo_env
  cwd="$CASE_DIR/worktree"; brief="$CASE_DIR/brief.md"; mkdir -p "$cwd"
  printf 'Task: spawn fixture\n' > "$brief"
  printf '{"agentId":"agent-spawned"}\n' > "$RESP/1.out"
  out=$(PASEO_AGENT_ID=parent-123 bash -c \
    '. "$0/bin/backends/paseo.sh"; fm_backend_paseo_spawn_agent task-spawn "Spawn title" "$1" "$2" test/model high ship ws-spawn' \
    "$ROOT" "$cwd" "$brief")
  [ "$out" = agent-spawned ] || fail "spawn should print the extracted agent ID, got '$out'"
  local log_text
  log_text=$(cat "$LOG")
  assert_contains "$log_text" $'paseo\x1fagent\x1frun\x1f--json\x1f--provider\x1fpi\x1f--model\x1ftest/model\x1f--thinking\x1fhigh' \
    "spawn should invoke paseo agent run with the requested model and effort"
  assert_contains "$log_text" $'paseo\x1fagent\x1frun\x1f--json\x1f--provider\x1fpi\x1f--model\x1ftest/model\x1f--thinking\x1fhigh\x1f--cwd' \
    "spawn should pass the task cwd"
  assert_contains "$log_text" $'--workspace\x1fws-spawn\x1f--title\x1fSpawn title' \
    "spawn should pass the workspace and title"
  assert_contains "$log_text" $'--label\x1fpaseo.parent-agent-id=parent-123\x1f--label\x1ffirstmate_task=task-spawn\x1f--label\x1ffirstmate_kind=ship' \
    "spawn should pass parent, task, and kind labels"
  assert_contains "$log_text" $'paseo\x1fagent\x1fopen\x1fagent-spawned' \
    "spawn should open the created native agent"
  pass "fm_backend_paseo_spawn_agent: extracts the agent ID and opens it"
}

test_paseo_spawn_agent_rejects_invalid_json() {
  local cwd brief out status
  paseo_case spawn-invalid-json
  paseo_env
  cwd="$CASE_DIR/worktree"; brief="$CASE_DIR/brief.md"; mkdir -p "$cwd"
  printf 'Task: invalid response fixture\n' > "$brief"
  printf 'not json\n' > "$RESP/1.out"
  set +e
  out=$(bash -c \
    '. "$0/bin/backends/paseo.sh"; fm_backend_paseo_spawn_agent task-invalid "Invalid title" "$1" "$2" model medium scout ws-invalid' \
    "$ROOT" "$cwd" "$brief" 2>&1)
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail "spawn should reject invalid agent-run JSON"
  assert_contains "$out" "returned invalid JSON without an agent ID" \
    "invalid spawn response should explain the missing agent ID"
  assert_not_contains "$(cat "$LOG")" $'paseo\x1fagent\x1fopen' \
    "spawn should not open an agent when the run response is invalid"
  pass "fm_backend_paseo_spawn_agent: rejects invalid JSON without opening an agent"
}

test_paseo_tools_and_version_check
test_paseo_daemon_check_accepts_local_daemon
test_paseo_daemon_check_accepts_connected_daemon
test_paseo_daemon_check_rejects_unavailable_daemon
test_paseo_agent_belongs_to_task_accepts_matching_label
test_paseo_agent_belongs_to_task_accepts_matching_title
test_paseo_agent_belongs_to_task_accepts_normalized_matching_cwd
test_paseo_agent_belongs_to_task_rejects_mismatch
test_paseo_kill_stops_archives_and_verifies_agent
test_paseo_kill_accepts_already_archived_agent_without_lifecycle_calls
test_paseo_remove_worktree_archives_and_verifies_workspace
test_paseo_agent_state_treats_archived_idle_as_dead
test_paseo_busy_state_maps_native_status
test_paseo_spawn_agent_extracts_id_and_opens_agent
test_paseo_spawn_agent_rejects_invalid_json
