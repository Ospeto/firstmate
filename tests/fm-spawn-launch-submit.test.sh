#!/usr/bin/env bash
# tests/fm-spawn-launch-submit.test.sh - regression tests for initial launch
# command submission and confirmation across backends.
#
# Covers:
#   1. Instant successful submission (atomic text + Enter).
#   2. Typed-but-unsubmitted command with swallowed/delayed Enter (recovers via resend Enter).
#   3. Failed confirmation path when command remains unsubmitted at prompt after retries.
#   4. End-to-end executable spawn (fm-spawn.sh) failure when launch cannot be submitted.
#   5. Long/wrapped launch command submission.
#   6. Submitted command with output/echo before active prompt line.
#   7. Capture failure handling (cap_rc != 0).
#   8. Projected Herdr launch abort cleanup.
#   9. Real Herdr lab session launch execution.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
fm_git_identity fmtest fmtest@example.invalid

# shellcheck source=/dev/null
. "$ROOT/bin/fm-backend.sh"

TMP_ROOT=$(fm_test_tmproot fm-spawn-launch-submit)

make_fake_tmux() {
  local case_dir=$1
  local fakebin="$case_dir/fakebin"
  local state_file="$case_dir/tmux-state"
  local log_file="$case_dir/tmux.log"
  mkdir -p "$fakebin"
  : > "$log_file"

  cat > "$fakebin/tmux" <<SH
#!/usr/bin/env bash
set -u
log="$log_file"
state="$state_file"
printf '%s\n' "\$*" >> "\$log"

case "\$*" in
  *"#{pane_current_path}"*) printf '%s\n' "${FM_FAKE_PANE_PATH:-$case_dir/wt}"; exit 0 ;;
esac

case "\${1:-}" in
  display-message) printf 'firstmate\n'; exit 0 ;;
  list-windows) exit 0 ;;
  has-session|new-session|new-window|kill-window) exit 0 ;;
  capture-pane)
    if [ -f "\$state.fail_capture_always" ]; then
      exit 1
    fi
    if [ -f "\$state.fail_capture" ]; then
      fail_cnt=\$(cat "\$state.fail_capture")
      if [ "\$fail_cnt" -gt 0 ]; then
        echo \$((fail_cnt - 1)) > "\$state.fail_capture"
        exit 1
      fi
    fi
    if [ -f "\$state" ]; then
      cat "\$state"
    else
      printf 'bash-5.2$ \n'
    fi
    exit 0
    ;;
  send-keys)
    mode=\$(cat "\$state.mode" 2>/dev/null || echo "normal")
    sent_text=""
    for a in "\$@"; do
      case "\$a" in
        send-keys|-t|firstmate:*|Enter) ;;
        *) sent_text="\$a" ;;
      esac
    done

    if [ -n "\$sent_text" ]; then
      case "\$sent_text" in
        export*)
          printf 'bash-5.2$ \n' > "\$state"
          ;;
        *)
          case "\$mode" in
            swallowed_once)
              printf 'bash-5.2$ %s\n' "\$sent_text" > "\$state"
              printf 'recovered\n' > "\$state.mode"
              ;;
            swallowed_wrapped_once)
              printf 'bash-5.2$ %.20s\n%.20s\n%.20s\n%.20s\n%s\n' \
                "\$sent_text" "\${sent_text:20:20}" "\${sent_text:40:20}" \
                "\${sent_text:60:20}" "\${sent_text:80}" > "\$state"
              printf 'recovered\n' > "\$state.mode"
              ;;
            swallowed_always)
              printf 'bash-5.2$ %s\n' "\$sent_text" > "\$state"
              ;;
            *)
              printf 'Pi v0.1.0\n│ > \n' > "\$state"
              ;;
          esac
          ;;
      esac
    else
      # Bare Enter key resend
      if [ "\$mode" = "recovered" ]; then
        printf 'Pi v0.1.0\n│ > \n' > "\$state"
      fi
    fi
    exit 0
    ;;
esac
exit 0
SH
  chmod +x "$fakebin/tmux"
  fm_fake_exit0 "$fakebin" treehouse pi-signed
  printf '%s' "$fakebin"
}

# --- Test 1: Instant successful submission ---
test_instant_success() {
  local case_dir="$TMP_ROOT/test1"
  mkdir -p "$case_dir"
  local fakebin
  fakebin=$(make_fake_tmux "$case_dir")
  PATH="$fakebin:$PATH" export PATH

  printf 'Pi v0.1.0\n│ > \n' > "$case_dir/tmux-state"
  printf 'normal\n' > "$case_dir/tmux-state.mode"

  local rc=0
  FM_LAUNCH_SUBMIT_RETRIES=3 FM_LAUNCH_SUBMIT_SLEEP=0.01 \
    fm_backend_launch_submit "tmux" "firstmate:0" "pi --mode crew -e /tmp/turnend" 3 0.01 "w1" || rc=$?

  [ "$rc" -eq 0 ] || { echo "test 1 failed: expected rc=0, got $rc" >&2; exit 1; }
  echo "ok 1 - instant successful launch submission"
}

# --- Test 2: Typed-but-unsubmitted command (swallowed Enter) recovers on retry ---
test_swallowed_enter_recovery() {
  local case_dir="$TMP_ROOT/test2"
  mkdir -p "$case_dir"
  local fakebin
  fakebin=$(make_fake_tmux "$case_dir")
  PATH="$fakebin:$PATH" export PATH

  # Start mode as swallowed_once
  printf 'swallowed_once\n' > "$case_dir/tmux-state.mode"

  local rc=0
  FM_LAUNCH_SUBMIT_RETRIES=5 FM_LAUNCH_SUBMIT_SLEEP=0.01 \
    fm_backend_launch_submit "tmux" "firstmate:0" "pi --mode crew -e /tmp/turnend" 5 0.01 "w1" || rc=$?

  [ "$rc" -eq 0 ] || { echo "test 2 failed: expected rc=0, got $rc" >&2; exit 1; }

  # Verify send-keys Enter was resent in log
  grep -Fq 'send-keys -t firstmate:0 Enter' "$case_dir/tmux.log" || {
    echo "test 2 failed: expected resend of Enter key in log" >&2
    exit 1
  }

  echo "ok 2 - swallowed Enter recovery submits unsubmitted command"
}

# --- Test 3: Failed confirmation path when command remains unsubmitted ---
test_failed_confirmation() {
  local case_dir="$TMP_ROOT/test3"
  mkdir -p "$case_dir"
  local fakebin
  fakebin=$(make_fake_tmux "$case_dir")
  PATH="$fakebin:$PATH" export PATH

  printf 'swallowed_always\n' > "$case_dir/tmux-state.mode"

  local rc=0 err_out
  err_out=$(FM_LAUNCH_SUBMIT_RETRIES=2 FM_LAUNCH_SUBMIT_SLEEP=0.01 \
    fm_backend_launch_submit "tmux" "firstmate:0" "pi --mode crew -e /tmp/turnend" 2 0.01 "w1" 2>&1) || rc=$?

  [ "$rc" -ne 0 ] || { echo "test 3 failed: expected non-zero rc for unsubmitted command" >&2; exit 1; }
  case "$err_out" in
    *"failed to submit after"*|"sitting at shell prompt"*) : ;;
    *) echo "test 3 failed: unexpected error output: $err_out" >&2; exit 1 ;;
  esac

  echo "ok 3 - failed confirmation path reports failure"
}

# --- Test 4: End-to-end executable spawn failure on unsubmitted launch ---
test_spawn_executable_failure() {
  local case_dir="$TMP_ROOT/test4"
  local home="$case_dir/home"
  local proj="$case_dir/project"
  local wt="$case_dir/wt"
  mkdir -p "$case_dir" "$home/data" "$home/projects" "$home/state" "$home/config"
  printf 'pi\n' > "$home/config/crew-harness"
  fm_git_worktree "$proj" "$wt" "wt-test4"
  touch "$home/state/.last-watcher-beat"
  mkdir -p "$home/data/t4"
  printf 'brief for t4\n' > "$home/data/t4/brief.md"

  local fakebin
  fakebin=$(make_fake_tmux "$case_dir")
  printf 'swallowed_always\n' > "$case_dir/tmux-state.mode"

  local rc=0 err_out
  PATH="$fakebin:$PATH" export PATH
  FM_FAKE_PANE_PATH="$wt"
  err_out=$(HERDR_ENV="" FM_HOME="$home" FM_LAUNCH_SUBMIT_RETRIES=2 FM_LAUNCH_SUBMIT_SLEEP=0.01 \
    "$ROOT/bin/fm-spawn.sh" --backend tmux --harness pi t4="$proj" 2>&1) || rc=$?

  [ "$rc" -ne 0 ] || { echo "test 4 failed: expected fm-spawn.sh to fail when launch submit fails" >&2; exit 1; }
  case "$err_out" in
    *"launch command failed to submit"*|*"failed to submit after"*) : ;;
    *) echo "test 4 failed: unexpected spawn error output: $err_out" >&2; exit 1 ;;
  esac

  echo "ok 4 - executable fm-spawn.sh fails cleanly on unsubmitted launch"
}

# --- Test 5: Long/wrapped launch command submission ---
test_long_wrapped_launch_command() {
  local case_dir="$TMP_ROOT/test5_long"
  mkdir -p "$case_dir"
  local fakebin
  fakebin=$(make_fake_tmux "$case_dir")
  PATH="$fakebin:$PATH" export PATH

  local long_cmd="pi --mode crew --very-long-option-1=value1 --very-long-option-2=value2 --very-long-option-3=value3 -e /tmp/turnend"

  # Start mode as swallowed_wrapped_once to verify sig matching and recovery on long command
  printf 'swallowed_wrapped_once\n' > "$case_dir/tmux-state.mode"

  local rc=0
  FM_LAUNCH_SUBMIT_RETRIES=5 FM_LAUNCH_SUBMIT_SLEEP=0.01 \
    fm_backend_launch_submit "tmux" "firstmate:0" "$long_cmd" 5 0.01 "w1" || rc=$?

  [ "$rc" -eq 0 ] || { echo "test 5 failed: expected rc=0, got $rc" >&2; exit 1; }
  grep -Fq 'send-keys -t firstmate:0 Enter' "$case_dir/tmux.log" || {
    echo "test 5 failed: expected resend of Enter key in log" >&2
    exit 1
  }
  echo "ok 5 - long/wrapped launch command submission succeeds"
}

# --- Test 6: Submitted command with output / echo before active prompt ---
test_submitted_command_with_output_echo() {
  local case_dir="$TMP_ROOT/test6_echo"
  mkdir -p "$case_dir"
  local fakebin
  fakebin=$(make_fake_tmux "$case_dir")
  PATH="$fakebin:$PATH" export PATH

  local cmd="pi --mode crew -e /tmp/turnend"
  # Pane capture contains echoed command on line 2, but active prompt on last line
  cat > "$case_dir/tmux-state" <<EOF
bash-5.2$ pi --mode crew -e /tmp/turnend
pi --mode crew -e /tmp/turnend
Pi v0.1.0
│ >
EOF
  printf 'normal\n' > "$case_dir/tmux-state.mode"

  local rc=0
  FM_LAUNCH_SUBMIT_RETRIES=3 FM_LAUNCH_SUBMIT_SLEEP=0.01 \
    fm_backend_launch_submit "tmux" "firstmate:0" "$cmd" 3 0.01 "w1" || rc=$?

  [ "$rc" -eq 0 ] || { echo "test 6 failed: expected rc=0, got $rc" >&2; exit 1; }
  echo "ok 6 - submitted command with output/echo confirmed via active prompt line"
}

# --- Test 7: Capture failure handling (cap_rc != 0) ---
test_capture_failure_handling() {
  local case_dir="$TMP_ROOT/test7_cap_fail"
  mkdir -p "$case_dir"
  local fakebin
  fakebin=$(make_fake_tmux "$case_dir")
  PATH="$fakebin:$PATH" export PATH

  printf 'Pi v0.1.0\n│ > \n' > "$case_dir/tmux-state"
  printf 'normal\n' > "$case_dir/tmux-state.mode"

  # 1. Temporary capture failure (fail 2 times, then succeed)
  echo 2 > "$case_dir/tmux-state.fail_capture"
  local rc=0
  FM_LAUNCH_SUBMIT_RETRIES=5 FM_LAUNCH_SUBMIT_SLEEP=0.01 \
    fm_backend_launch_submit "tmux" "firstmate:0" "pi --mode crew -e /tmp/turnend" 5 0.01 "w1" || rc=$?

  [ "$rc" -eq 0 ] || { echo "test 7 failed: expected rc=0 on recovery, got $rc" >&2; exit 1; }

  # 2. Permanent capture failure returns non-zero without script failure
  echo 1 > "$case_dir/tmux-state.fail_capture_always"
  rc=0
  FM_LAUNCH_SUBMIT_RETRIES=2 FM_LAUNCH_SUBMIT_SLEEP=0.01 \
    fm_backend_launch_submit "tmux" "firstmate:0" "pi --mode crew -e /tmp/turnend" 2 0.01 "w1" >/dev/null 2>&1 || rc=$?

  [ "$rc" -ne 0 ] || { echo "test 7 failed: expected non-zero rc on permanent capture failure" >&2; exit 1; }
  echo "ok 7 - capture failure handling (cap_rc != 0) handled safely"
}

# --- Test 8: Projected Herdr launch abort cleanup ---
test_projected_herdr_launch_abort_cleanup() {
  local case_dir="$TMP_ROOT/test8_herdr_abort"
  local fakebin="$case_dir/fakebin"
  local herdr_cleanup_log="$case_dir/herdr_cleanup.log"
  mkdir -p "$case_dir" "$fakebin"
  : > "$herdr_cleanup_log"

  cat > "$fakebin/herdr" <<SH
#!/usr/bin/env bash
set -u
printf '%s\n' "\$*" >> "$herdr_cleanup_log"
case "\${1:-}" in
  workspace)
    if [ "\${2:-}" = "list" ]; then
      printf '{"result":{"workspaces":[{"workspace_id":"ws-active","focused":true,"active_tab_id":"tab-active"}]}}\n'
      exit 0
    fi
    ;;
  tab)
    if [ "\${2:-}" = "list" ]; then
      printf '{"result":{"tabs":[{"tab_id":"tab-active","focused":true}]}}\n'
      exit 0
    fi
    ;;
  pane)
    case "\${2:-}" in
      get)
        pane_arg="\${3:-}"
        printf '{"result":{"pane":{"pane_id":"%s","tab_id":"tab-target","workspace_id":"ws-target"}}}\n' "\$pane_arg"
        exit 0
        ;;
      close)
        exit 0
        ;;
    esac
    ;;
esac
exit 0
SH
  chmod +x "$fakebin/herdr"
  fm_fake_exit0 "$fakebin" treehouse pi-signed

  local old_path=$PATH
  PATH="$fakebin:$PATH" export PATH

  fm_backend_source herdr
  fm_backend_herdr_projection_cleanup_exact "fm-lab-abort-test" "pane-abort-1" "pane-seeded-1"

  PATH=$old_path export PATH

  grep -Fq 'pane close' "$herdr_cleanup_log" || {
    echo "test 8 failed: expected herdr pane close during projected Herdr launch abort cleanup" >&2
    exit 1
  }

  echo "ok 8 - projected Herdr launch abort cleanup verified"
}

# --- Test 9: Real Herdr lab session launch submission & recovery ---
test_herdr_lab_submit() {
  if ! command -v herdr >/dev/null 2>&1 || [ ! -x "$ROOT/bin/fm-herdr-lab.sh" ]; then
    echo "ok 9 - real Herdr lab test skipped (herdr not available)"
    return 0
  fi

  local lab_helper="$ROOT/bin/fm-herdr-lab.sh"
  local lab_session
  lab_session=$("$lab_helper" name fm-spawn-launch-submit)
  # shellcheck disable=SC2064
  trap "\"$lab_helper\" teardown \"$lab_session\" >/dev/null 2>&1 || true" EXIT

  if ! "$lab_helper" provision "$lab_session" >/dev/null 2>&1; then
    "$lab_helper" teardown "$lab_session" >/dev/null 2>&1 || true
    trap - EXIT
    echo "ok 9 - real Herdr lab test skipped (herdr lab provision failed)"
    return 0
  fi

  local res ses_ws seeded_tab task_res task_pane target cap process_info
  local pane_ready=false ready_samples=0
  fm_backend_source herdr
  res=$(HERDR_SESSION="$lab_session" fm_backend_herdr_container_ensure "/tmp" "standalone")
  ses_ws="${res%%	*}"
  seeded_tab="${res#*	}"

  task_res=$(HERDR_SESSION="$lab_session" fm_backend_herdr_create_task "$ses_ws" "fm-test-task" "/tmp" "$seeded_tab")
  task_pane="${task_res#* }"
  target="$lab_session:$task_pane"

  for _ in $(seq 1 100); do
    process_info=$(HERDR_SESSION="$lab_session" fm_backend_herdr_cli "$lab_session" pane process-info --pane "$task_pane" 2>/dev/null || true)
    if printf '%s' "$process_info" | jq -e '
      .result.process_info as $process
      | ($process.foreground_processes | length == 1)
        and ($process.foreground_processes[0].pid == $process.shell_pid)
    ' >/dev/null 2>&1; then
      ready_samples=$((ready_samples + 1))
      if [ "$ready_samples" -ge 10 ]; then
        pane_ready=true
        break
      fi
    else
      ready_samples=0
    fi
    sleep 0.1
  done
  if [ "$pane_ready" != true ]; then
    echo "test 9 failed: Herdr pane shell did not become ready" >&2
    exit 1
  fi

  local launch_cmd="printf 'HERDR_LAB_RESULT_%s\\n' EXECUTED;"

  # Submit and confirm via launch submit helper
  if ! HERDR_SESSION="$lab_session" fm_backend_launch_submit "herdr" "$target" "$launch_cmd" 5 0.3 "fm-test-task" >/dev/null 2>&1; then
    echo "test 9 failed: Herdr launch submit helper returned non-zero" >&2
    exit 1
  fi

  sleep 0.5
  cap=$(HERDR_SESSION="$lab_session" fm_backend_herdr_capture "$target" 10 "fm-test-task")

  "$lab_helper" teardown "$lab_session" >/dev/null 2>&1 || true
  trap - EXIT

  if printf '%s\n' "$cap" | grep -Fq "HERDR_LAB_RESULT_EXECUTED"; then
    echo "ok 9 - real Herdr lab launch execution"
  else
    echo "test 9 failed: executed command output not found in capture" >&2
    exit 1
  fi
}

test_instant_success
test_swallowed_enter_recovery
test_failed_confirmation
test_spawn_executable_failure
test_long_wrapped_launch_command
test_submitted_command_with_output_echo
test_capture_failure_handling
test_projected_herdr_launch_abort_cleanup
test_herdr_lab_submit
