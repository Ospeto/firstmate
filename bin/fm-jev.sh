#!/usr/bin/env bash
# bin/fm-jev.sh - Unified TypeSafe Jev System-1 CLI for Firstmate.
#
# Commands:
#   watchdog <task-id>                  Classify agent trajectory (progressing, looping, waiting_user, done)
#   triage-pr <title> [summary]         Classify PR risk (auto_pass vs oracle_audit)
#   escalate <question> [options]       Classify decision type (obvious vs subjective)
#   dispatch <brief-path|text>          Classify task complexity and recommended model tier
#   compact-check <log-path|text>       Check if a unit of work is finished for safe compaction
#
# Usage: bin/fm-jev.sh <subcommand> [args...]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-$FM_ROOT}"
FM_STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"

# shellcheck source=bin/fm-jev-lib.sh
. "$SCRIPT_DIR/fm-jev-lib.sh"

usage() {
  cat <<'EOF'
Usage: fm-jev.sh <subcommand> [args...]

Subcommands:
  watchdog <task-id>               Evaluate agent loop/stagnation state
  triage-pr <title> [summary]      Grade PR for auto-pass vs Oracle audit
  escalate <question> [options]    Judge obvious convention vs subjective decision
  dispatch <brief-path|text>       Determine task complexity and model tier
  compact-check <path|text>        Check whether unit of work is finished for compaction
  test                             Run self-test against Jev System-1 API

EOF
  exit 1
}

subcmd=${1:-}
shift || true

case "$subcmd" in
  watchdog)
    task_id=${1:-}
    [ -n "$task_id" ] || { echo "error: missing task-id for watchdog" >&2; exit 1; }

    # Gather recent state from status log and live terminal if available
    recent_text=""
    status_file="$FM_STATE/$task_id.status"
    if [ -f "$status_file" ]; then
      recent_text=$(tail -n 25 "$status_file" 2>/dev/null || true)
    fi

    # Supplement with terminal peek if alive
    if [ -x "$SCRIPT_DIR/fm-peek.sh" ]; then
      peek_out=$(FM_HOME="$FM_HOME" "$SCRIPT_DIR/fm-peek.sh" "$task_id" 15 2>/dev/null || true)
      [ -z "$peek_out" ] || recent_text="$recent_text"$'\n--- live output ---\n'"$peek_out"
    fi

    [ -n "$recent_text" ] || {
      echo "trajectory=unknown confidence=0.0 reason=no_recent_logs"
      exit 0
    }

    state_input="Task: $task_id"$'\n'"Recent activity:"$'\n'"$recent_text"
    questions='{
      "trajectory": {
        "type": "choice",
        "instructions": "Evaluate the agent trajectory. Decide whether the agent is making forward progress, stuck in a repetitive failure loop, waiting for user input, or finished.",
        "criteria": {
          "progressing": "Actively making progress, writing code, executing tests, or reading relevant files.",
          "looping": "Repeating the exact same failure, running the same broken command repeatedly without progress, or confused in an error cycle.",
          "waiting_user": "Explicitly waiting for human approval, answering an ask-user question, or paused by captain.",
          "done": "Work is completed, PR opened, or deliverable achieved."
        }
      }
    }'

    resp=$(fm_jev_query "$state_input" "$questions" 3) || exit 1
    choice=$(fm_jev_choice "$resp" "trajectory")
    conf=$(fm_jev_confidence "$resp" "trajectory")

    echo "trajectory=${choice:-unknown} confidence=${conf:-0.0}"
    if [ "$choice" = "looping" ]; then
      exit 2
    fi
    exit 0
    ;;

  triage-pr)
    pr_title=${1:-}
    pr_summary=${2:-""}
    [ -n "$pr_title" ] || { echo "error: missing PR title for triage-pr" >&2; exit 1; }

    state_input="PR: $pr_title"$'\n'"Summary/Diff:"$'\n'"$pr_summary"
    questions='{
      "triage": {
        "type": "choice",
        "instructions": "Decide whether this pull request is safe for autonomous merging (routine, well-tested, low-risk change) or requires an independent Oracle security/architecture audit (security-sensitive, complex state, architectural risk, or unverified boundaries).",
        "criteria": {
          "auto_pass": "Low-risk, routine feature, documentation, or well-tested straightforward change suitable for auto-merge.",
          "oracle_audit": "High risk, security-sensitive (crypto, auth, XML/EPUB parsing, path traversal), architecture change, or complex state mutation."
        }
      }
    }'

    resp=$(fm_jev_query "$state_input" "$questions" 3) || exit 1
    choice=$(fm_jev_choice "$resp" "triage")
    conf=$(fm_jev_confidence "$resp" "triage")

    echo "verdict=${choice:-unknown} confidence=${conf:-0.0}"
    if [ "$choice" = "auto_pass" ]; then
      exit 0
    else
      exit 1
    fi
    ;;

  escalate)
    question_text=${1:-}
    options_text=${2:-""}
    [ -n "$question_text" ] || { echo "error: missing question text for escalate" >&2; exit 1; }

    state_input="Question: $question_text"$'\n'"Options:"$'\n'"$options_text"
    questions='{
      "decision": {
        "type": "choice",
        "instructions": "Decide whether this agent question is an obvious reversible convention decision (safe for autonomous firstmate resolution) or a genuinely subjective/destructive choice that must be escalated to the captain.",
        "criteria": {
          "obvious": "Routine convention, styling, standard test mock, or reversible implementation detail that follows existing patterns.",
          "subjective": "Genuinely subjective product trade-off, API design choice, destructive action, scope expansion, or security policy."
        }
      }
    }'

    resp=$(fm_jev_query "$state_input" "$questions" 3) || exit 1
    choice=$(fm_jev_choice "$resp" "decision")
    conf=$(fm_jev_confidence "$resp" "decision")

    echo "verdict=${choice:-unknown} confidence=${conf:-0.0}"
    if [ "$choice" = "obvious" ]; then
      exit 0
    else
      exit 1
    fi
    ;;

  dispatch)
    target=${1:-}
    [ -n "$target" ] || { echo "error: missing brief path or text for dispatch" >&2; exit 1; }

    if [ -f "$target" ]; then
      brief_text=$(head -n 50 "$target")
    else
      brief_text="$target"
    fi

    state_input="Task Brief:"$'\n'"$brief_text"
    questions='{
      "complexity": {
        "type": "choice",
        "instructions": "Classify the engineering complexity of this task brief.",
        "criteria": {
          "routine": "Straightforward fix, documentation, small UI tweak, or well-defined single-file update.",
          "moderate": "Standard multi-file feature, integration, or refactor with clear scope.",
          "complex": "Deep architectural debugging, subtle concurrency/race bug, security overhaul, or ambiguous investigation."
        }
      },
      "model_tier": {
        "type": "choice",
        "instructions": "Choose the optimal model tier for this task.",
        "criteria": {
          "flash": "Fast, high-throughput model (e.g. Gemini 3.8 Flash) for routine or moderate work.",
          "luna": "Maximum-thinking reasoning model (e.g. GPT-5.6 Luna) for complex architecture or security work.",
          "sol": "Specialized deep-troubleshooting model (e.g. GPT-5.6 Sol) for stuck/recovering tasks."
        }
      }
    }'

    resp=$(fm_jev_query "$state_input" "$questions" 3) || exit 1
    complexity=$(fm_jev_choice "$resp" "complexity")
    tier=$(fm_jev_choice "$resp" "model_tier")
    conf=$(fm_jev_confidence "$resp" "model_tier")

    echo "complexity=${complexity:-routine} model_tier=${tier:-flash} confidence=${conf:-0.0}"
    exit 0
    ;;

  compact-check)
    target=${1:-}
    [ -n "$target" ] || { echo "error: missing log path or text for compact-check" >&2; exit 1; }

    if [ -f "$target" ]; then
      log_text=$(tail -n 30 "$target")
    else
      log_text="$target"
    fi

    state_input="Session activity:"$'\n'"$log_text"
    questions='{
      "done": {
        "type": "choice",
        "instructions": "Decide whether the assistant latest unit of work in this conversation is finished and reported.",
        "criteria": {
          "finished": "Finished and reported, PR merged or deliverable reached, ready for context reset or next task.",
          "not_finished": "The assistant is in the middle of active implementation, debugging, or owes a next step."
        }
      }
    }'

    resp=$(fm_jev_query "$state_input" "$questions" 3) || exit 1
    choice=$(fm_jev_choice "$resp" "done")
    conf=$(fm_jev_confidence "$resp" "done")

    if [ "$choice" = "finished" ]; then
      echo "compact_safe=yes confidence=${conf:-0.0}"
      exit 0
    else
      echo "compact_safe=no confidence=${conf:-0.0}"
      exit 1
    fi
    ;;

  test)
    echo "Testing Jev API connection..."
    test_resp=$(fm_jev_query "Unit tests pass 100%, commit clean, PR opened." '{"status":{"type":"choice","instructions":"Is work done?","criteria":{"yes":"finished","no":"working"}}}')
    test_choice=$(fm_jev_choice "$test_resp" "status")
    test_conf=$(fm_jev_confidence "$test_resp" "status")
    echo "Jev Response OK: choice=$test_choice confidence=$test_conf"
    exit 0
    ;;

  *)
    usage
    ;;
esac
