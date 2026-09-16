#!/usr/bin/env bash
# tests/fm-control-recovery.test.sh - regression coverage for missing-endpoint recovery.
#
# Hermetic verification of the guarded recovery operation for an existing task
# whose recorded endpoint is missing:
#   1. Successful recovery via `fm-control.sh <task-id> recover` preserves
#      uncommitted files and task identity while creating a replacement worker.
#   2. Successful recovery via `fm-control.sh <task-id> relaunch --recover-missing-endpoint`.
#   3. Live endpoint ownership refusal: refuses when the recorded endpoint is alive.
#   4. Live process ownership refusal: refuses when an independent process has cwd in the worktree.
#   5. Ambiguous ownership refusal: refuses when the process scan fails (lsof error).
#   6. Shared ownership refusal: refuses when another task's metadata records the same worktree.
#   7. Worktree disappearance: refuses when the recorded worktree is missing.
#   8. Concurrent ownership change: refuses when metadata changes concurrently.
#   9. Ordinary relaunch invariant: refuses without --recover-missing-endpoint when endpoint is missing.
#  10. Endpoint still exists: refuses recover when recorded endpoint is dead (directs to ordinary relaunch).
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=bin/fm-control-lib.sh
. "$ROOT/bin/fm-control-lib.sh"
# shellcheck source=bin/fm-process-lib.sh
. "$ROOT/bin/fm-process-lib.sh"

CONTROL="$ROOT/bin/fm-control.sh"
SPAWN="$ROOT/bin/fm-spawn.sh"
TMP_ROOT=$(fm_test_tmproot fm-control-recovery)
mkdir -p "$TMP_ROOT"
TMP_ROOT=$(cd "$TMP_ROOT" && pwd)
TASK_TMPS=()

recovery_cleanup() {
  local d
  for d in "${TASK_TMPS[@]:-}"; do
    [ -n "$d" ] && rm -rf "$d"
  done
  rm -rf "$TMP_ROOT"
}
trap recovery_cleanup EXIT

make_tmux_stub() {  # <dir>
  local fb="$1/fakebin"
  mkdir -p "$fb"
  cat > "$fb/tmux" <<'SH'
#!/usr/bin/env bash
set -u
D=$FM_FAKE_DIR
case "${1:-}" in
  send-keys)
    shift
    literal=0
    while [ $# -gt 0 ]; do
      case "$1" in
        -t) shift 2 ;;
        -l) literal=1; shift ;;
        *) break ;;
      esac
    done
    payload=${1:-}
    if [ "$literal" = 1 ]; then
      printf '%s\n' "$payload" >> "$D/literal"
      case "$payload" in
        /exit|/quit)
          printf 'zsh' > "$D/command"
          ;;
        *'encode launch-brief'*)
          cat "$D/becomes" > "$D/command"
          ;;
      esac
    else
      printf '%s\n' "$payload" >> "$D/keys"
      case "$payload" in
        *'cd '*)
          target_path=${payload#*cd }
          target_path=${target_path#\'}
          target_path=${target_path%\'}
          printf '%s' "$target_path" > "$D/cwd"
          ;;
      esac
    fi
    exit 0 ;;
  new-window)
    shift
    name="fm-new"
    while [ $# -gt 0 ]; do
      case "$1" in
        -n) name=$2; shift 2 ;;
        *) shift ;;
      esac
    done
    printf '%s\n' "$name" >> "$D/windows"
    printf '@1\n'
    exit 0 ;;
  set-window-option)
    exit 0 ;;
  display-message)
    for a in "$@"; do
      case "$a" in
        *cursor_y*) printf '1\n'; exit 0 ;;
        *pane_current_command*) cat "$D/command"; printf '\n'; exit 0 ;;
        *pane_current_path*) cat "$D/cwd"; printf '\n'; exit 0 ;;
      esac
    done
    printf 'fakepane\n'; exit 0 ;;
  capture-pane) printf '╭────╮\n│    │\n╰────╯\n'; exit 0 ;;
  list-windows) [ -f "$D/windows" ] && cat "$D/windows"; exit 0 ;;
esac
exit 0
SH
  chmod +x "$fb/tmux"

  cat > "$fb/lsof" <<'SH'
#!/usr/bin/env bash
set -u
D=$FM_FAKE_DIR
if [ -f "$D/lsof_fail" ]; then
  echo "lsof: error reading process table" >&2
  exit 1
fi
if [ -f "$D/lsof_output" ]; then
  cat "$D/lsof_output"
  exit 0
fi
exit 0
SH
  chmod +x "$fb/lsof"

  cat > "$fb/sleep" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  chmod +x "$fb/sleep"
}

new_case() {
  local id=${2:-t1} dir="$TMP_ROOT/$1-$RANDOM"
  mkdir -p "$dir/home/state" "$dir/home/data" "$dir/fake"
  : > "$dir/fake/literal"
  : > "$dir/fake/keys"
  printf 'claude' > "$dir/fake/command"
  printf 'claude' > "$dir/fake/becomes"
  : > "$dir/fake/windows"
  make_tmux_stub "$dir"
  printf '%s\n' "$dir"
}

add_ship_task_missing_endpoint() {
  local dir=$1 id=$2 harness=${3:-claude}
  local home="$dir/home" proj="$dir/proj" wt="$dir/wt"
  fm_git_worktree "$proj" "$wt" "task-$id"
  mkdir -p "$home/data/$id"
  cat > "$home/data/$id/brief.md" <<EOF
# Task
## Captain's intent
Exercise missing-endpoint recovery for $id.

## Firstmate spec
Recover the task worker in the preserved worktree.
EOF
  {
    echo "window=fmses:fm-$id"
    echo "endpoint_task_id=$id"
    echo "worktree=$wt"
    echo "project=$proj"
    echo "harness=$harness"
    echo "kind=ship"
    echo "mode=no-mistakes"
    echo "yolo=off"
    echo "tasktmp=/tmp/fm-$id"
    echo "model=default"
    echo "effort=default"
    echo "spawn_gen=s_initial"
  } > "$home/state/$id.meta"
  # Uncommitted changes to be preserved
  echo "uncommitted file 1" > "$wt/file1.txt"
  echo "uncommitted file 2" > "$wt/file2.txt"
  # Missing endpoint: fm-$id is NOT in $dir/fake/windows
  : > "$dir/fake/windows"
  printf '%s' "$proj" > "$dir/fake/cwd"
  TASK_TMPS+=("/tmp/fm-$id")
}

run_control() {
  local dir=$1; shift
  mkdir -p "$dir/user-home"
  env PATH="$dir/fakebin:$PATH" FM_HOME="$dir/home" FM_FAKE_DIR="$dir/fake" \
    HOME="$dir/user-home" CLAUDE_CONFIG_DIR='' \
    FM_SPAWN_NO_GUARD=1 GROK_HOME="$dir/grokhome" \
    FM_CONTROL_POLL=0.01 FM_CONTROL_EXIT_WAIT=0.05 FM_CONTROL_LAUNCH_WAIT=0.05 \
    "$CONTROL" "$@" 2>&1
}

meta_field() {
  grep "^$3=" "$1/home/state/$2.meta" | tail -1 | cut -d= -f2-
}

# --- Test 1: Successful missing-endpoint recovery via 'recover' verb ---------
test_successful_recovery_verb() {
  local dir out rc wt
  dir=$(new_case recover-verb)
  add_ship_task_missing_endpoint "$dir" t1 claude
  wt="$dir/wt"

  out=$(run_control "$dir" t1 recover --note "recovering dead worker process"); rc=$?
  expect_code 0 "$rc" "recovery via recover verb should succeed"
  assert_contains "$out" "recovered t1 harness=claude" "output should announce recovery"

  [ -f "$wt/file1.txt" ] || fail "uncommitted file1.txt should be preserved"
  [ -f "$wt/file2.txt" ] || fail "uncommitted file2.txt should be preserved"
  [ "$(cat "$wt/file1.txt")" = "uncommitted file 1" ] || fail "file1 contents should be preserved"

  local new_win new_gen
  new_win=$(meta_field "$dir" t1 window)
  new_gen=$(meta_field "$dir" t1 spawn_gen)
  assert_contains "$new_win" "fm-t1" "metadata window should be published with replacement endpoint"
  [ "$new_gen" != "s_initial" ] || fail "metadata spawn_gen should be freshly generated"

  assert_contains "$(cat "$dir/home/data/t1/brief.md")" "recovering dead worker process" \
    "brief should carry the progress note"
  pass "missing-endpoint recovery: successful recovery via recover verb preserves work and publishes replacement"
}

# --- Test 2: Successful missing-endpoint recovery via 'relaunch --recover-missing-endpoint'
test_successful_recovery_relaunch_flag() {
  local dir out rc wt
  dir=$(new_case recover-flag)
  add_ship_task_missing_endpoint "$dir" t1 claude
  wt="$dir/wt"

  out=$(run_control "$dir" t1 relaunch --recover-missing-endpoint --note "recovering via flag"); rc=$?
  expect_code 0 "$rc" "recovery via relaunch flag should succeed"
  assert_contains "$out" "recovered t1 harness=claude" "output should announce recovery"
  [ -f "$wt/file1.txt" ] || fail "uncommitted file1.txt should be preserved"
  pass "missing-endpoint recovery: successful recovery via relaunch --recover-missing-endpoint"
}

# --- Test 3: Live endpoint ownership refusal --------------------------------
test_live_endpoint_refusal() {
  local dir out rc
  dir=$(new_case live-endpoint)
  add_ship_task_missing_endpoint "$dir" t1 claude
  # Endpoint is actually alive in fake tmux
  printf '%s\n' "fm-t1" > "$dir/fake/windows"
  printf 'claude' > "$dir/fake/command"
  printf '%s' "$dir/wt" > "$dir/fake/cwd"

  out=$(run_control "$dir" t1 recover --note "should be refused"); rc=$?
  expect_code 1 "$rc" "recovering a live endpoint must be refused"
  assert_contains "$out" "refusing missing-endpoint recovery because a live agent still owns the recorded endpoint" \
    "refusal should report live endpoint ownership"
  [ "$(meta_field "$dir" t1 spawn_gen)" = "s_initial" ] || fail "metadata must not be altered on refusal"
  pass "missing-endpoint recovery: live endpoint ownership is refused"
}

# --- Test 4: Live process in worktree refusal -------------------------------
test_live_process_in_worktree_refusal() {
  local dir out rc
  dir=$(new_case live-proc)
  add_ship_task_missing_endpoint "$dir" t1 claude
  # Simulate an independent process holding cwd in the worktree
  printf 'p8888\nfcwd\nn%s\n' "$dir/wt" > "$dir/fake/lsof_output"

  out=$(run_control "$dir" t1 recover --note "should be refused"); rc=$?
  expect_code 1 "$rc" "recovery with live process in worktree must be refused"
  assert_contains "$out" "live process(es) (8888) still have current working directory" \
    "refusal should name the live process in worktree"
  [ "$(meta_field "$dir" t1 spawn_gen)" = "s_initial" ] || fail "metadata must not be altered on refusal"
  pass "missing-endpoint recovery: live process in worktree is independently refused"
}

# --- Test 5: Ambiguous ownership refusal (lsof failure) ---------------------
test_ambiguous_ownership_lsof_failure_refusal() {
  local dir out rc
  dir=$(new_case ambig-lsof)
  add_ship_task_missing_endpoint "$dir" t1 claude
  # Simulate lsof probe error
  : > "$dir/fake/lsof_fail"

  out=$(run_control "$dir" t1 recover --note "should be refused"); rc=$?
  expect_code 1 "$rc" "recovery with ambiguous process state must be refused"
  assert_contains "$out" "cannot verify absence of live processes under" \
    "refusal should report inability to verify process state"
  [ "$(meta_field "$dir" t1 spawn_gen)" = "s_initial" ] || fail "metadata must not be altered on refusal"
  pass "missing-endpoint recovery: ambiguous process ownership is refused"
}

# --- Test 6: Shared worktree ownership refusal ------------------------------
test_shared_worktree_refusal() {
  local dir out rc
  dir=$(new_case shared-wt)
  add_ship_task_missing_endpoint "$dir" t1 claude
  # Create a second task pointing to the same worktree
  cat > "$dir/home/state/t2.meta" <<EOF
window=fmses:fm-t2
endpoint_task_id=t2
worktree=$dir/wt
project=$dir/proj
harness=claude
kind=ship
mode=no-mistakes
EOF

  out=$(run_control "$dir" t1 recover --note "should be refused"); rc=$?
  expect_code 1 "$rc" "recovery with shared worktree must be refused"
  assert_contains "$out" "refusing shared worktree recovery" \
    "refusal should report shared worktree ownership"
  pass "missing-endpoint recovery: shared worktree ownership across tasks is refused"
}

# --- Test 7: Worktree disappearance refusal ---------------------------------
test_worktree_disappearance_refusal() {
  local dir out rc
  dir=$(new_case wt-gone)
  add_ship_task_missing_endpoint "$dir" t1 claude
  # Remove the worktree directory
  rm -rf "$dir/wt"

  out=$(run_control "$dir" t1 recover --note "should be refused"); rc=$?
  expect_code 1 "$rc" "recovery with missing worktree must be refused"
  assert_contains "$out" "recorded worktree" \
    "refusal should report that the recorded worktree is missing"
  assert_contains "$out" "is missing" \
    "refusal should report that the recorded worktree is missing"
  pass "missing-endpoint recovery: missing worktree is refused before touching state"
}

# --- Test 8: Concurrent ownership change refusal ----------------------------
test_concurrent_ownership_change_refusal() {
  local dir out rc
  dir=$(new_case conc-change)
  add_ship_task_missing_endpoint "$dir" t1 claude

  # Fake git stub that alters metadata during HEAD check
  cat > "$dir/fakebin/git" <<SH
#!/usr/bin/env bash
if [ "\${1:-}" = "-C" ]; then
  # Intercept checkpoint check to tamper with metadata concurrently
  echo "spawn_gen=concurrent_change_gen" >> "$dir/home/state/t1.meta"
fi
exec /usr/bin/git "\$@"
SH
  chmod +x "$dir/fakebin/git"

  out=$(run_control "$dir" t1 recover --note "should be refused"); rc=$?
  expect_code 1 "$rc" "recovery with concurrent metadata change must be refused"
  assert_contains "$out" "metadata changed concurrently during recovery" \
    "refusal should detect concurrent metadata change"
  pass "missing-endpoint recovery: concurrent ownership change during recovery is refused"
}

# --- Test 9: Ordinary relaunch refuses missing endpoint ---------------------
test_ordinary_relaunch_refuses_missing_endpoint() {
  local dir out rc
  dir=$(new_case ord-relaunch)
  add_ship_task_missing_endpoint "$dir" t1 claude

  out=$(run_control "$dir" t1 relaunch --note "trying ordinary relaunch"); rc=$?
  expect_code 1 "$rc" "ordinary relaunch must refuse a missing endpoint"
  assert_contains "$out" "recorded endpoint is gone, so there is no agent to stop" \
    "ordinary relaunch refusal must preserve positive agent-free endpoint requirement"
  pass "missing-endpoint recovery: ordinary relaunch continues to refuse missing endpoint"
}

# --- Test 10: Recover refuses when endpoint still exists (dead) -------------
test_recover_refuses_when_endpoint_still_exists() {
  local dir out rc
  dir=$(new_case ep-exists)
  add_ship_task_missing_endpoint "$dir" t1 claude
  # Endpoint exists in dead state (in windows list, command is zsh)
  printf '%s\n' "fm-t1" > "$dir/fake/windows"
  printf 'zsh' > "$dir/fake/command"
  printf '%s' "$dir/wt" > "$dir/fake/cwd"

  out=$(run_control "$dir" t1 recover --note "trying recover on dead endpoint"); rc=$?
  expect_code 1 "$rc" "recover must refuse when recorded endpoint still exists"
  assert_contains "$out" "recorded endpoint still exists (state: dead); use ordinary relaunch instead of missing-endpoint recovery" \
    "refusal should direct operator to ordinary relaunch when endpoint exists"
  pass "missing-endpoint recovery: recover refuses when endpoint still exists in dead state"
}

test_successful_recovery_verb
test_successful_recovery_relaunch_flag
test_live_endpoint_refusal
test_live_process_in_worktree_refusal
test_ambiguous_ownership_lsof_failure_refusal
test_shared_worktree_refusal
test_worktree_disappearance_refusal
test_concurrent_ownership_change_refusal
test_ordinary_relaunch_refuses_missing_endpoint
test_recover_refuses_when_endpoint_still_exists
