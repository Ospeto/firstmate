#!/usr/bin/env bash
# bin/backends/paseo.sh - Paseo session-provider adapter.
#
# Supports both Paseo workspace terminals and native Paseo agents.
# When Firstmate spawns with backend=paseo, task workspaces and terminals
# are managed by Paseo, making worktrees and agents visible directly in
# Paseo Desktop.

# shellcheck source=bin/fm-composer-lib.sh
# shellcheck source=bin/fm-composer-lib.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/../fm-composer-lib.sh"

fm_backend_paseo_tool_check() {
  command -v paseo >/dev/null 2>&1 || {
    echo "error: backend=paseo selected but 'paseo' CLI is not installed on PATH" >&2
    return 1
  }
}

fm_backend_paseo_version_check() {
  fm_backend_paseo_tool_check || return 1
  paseo --version >/dev/null 2>&1 || {
    echo "error: failed to execute 'paseo --version'" >&2
    return 1
  }
}

fm_backend_paseo_daemon_check() {
  fm_backend_paseo_tool_check || return 1
  local out
  out=$(paseo status --json 2>/dev/null) || {
    echo "error: backend=paseo selected but 'paseo status' failed; start the Paseo daemon (paseo start)" >&2
    return 1
  }
  printf '%s' "$out" | node -e '
const fs = require("fs");
try {
  const data = JSON.parse(fs.readFileSync(0, "utf8"));
  if (data.LocalDaemon !== "running" && data.ConnectedDaemon !== "reachable") {
    console.error("error: Paseo daemon is not running");
    process.exit(1);
  }
} catch (e) {
  process.exit(1);
}
'
}

# Distinguish whether a target is an agent UUID or a terminal ID
fm_backend_paseo_is_agent() {  # <target>
  local target=$1
  # Check if paseo inspect succeeds for this target
  paseo inspect "$target" --json >/dev/null 2>&1
}

# Target exists in Paseo
fm_backend_paseo_target_exists() {  # <target> [expected-label]
  local target=$1
  [ -n "$target" ] || return 1
  fm_backend_paseo_tool_check || return 1

  if fm_backend_paseo_is_agent "$target"; then
    return 0
  fi

  # Otherwise check terminal list
  local terms
  terms=$(paseo terminal ls --json 2>/dev/null) || return 1
  printf '%s' "$terms" | node -e '
const fs = require("fs");
const target = process.argv[1];
try {
  const list = JSON.parse(fs.readFileSync(0, "utf8"));
  if (Array.isArray(list) && list.some(t => t.id === target || t.name === target)) {
    process.exit(0);
  }
} catch (e) {}
process.exit(1);
' "$target"
}

# Recovery-grade agent state: alive, dead, missing, unreadable
fm_backend_paseo_agent_state() {  # <target>
  local target=$1 out status
  [ -n "$target" ] || { printf 'missing'; return 0; }
  fm_backend_paseo_tool_check || { printf 'unreadable'; return 0; }

  if fm_backend_paseo_is_agent "$target"; then
    out=$(paseo inspect "$target" --json 2>/dev/null) || { printf 'missing'; return 0; }
    status=$(printf '%s' "$out" | node -e '
const fs = require("fs");
try {
  const data = JSON.parse(fs.readFileSync(0, "utf8"));
  if (data.Archived === true || data.Status === "closed") {
    process.stdout.write("dead");
  } else if (data.Status === "running") {
    process.stdout.write("alive");
  } else {
    process.stdout.write("dead");
  }
} catch (e) {
  process.stdout.write("unreadable");
}
')
    printf '%s' "${status:-unreadable}"
    return 0
  fi

  # If target is a terminal, check terminal presence
  if fm_backend_paseo_target_exists "$target"; then
    printf 'alive'
  else
    printf 'missing'
  fi
}

# Capture output from Paseo terminal or agent
fm_backend_paseo_capture() {  # <target> <lines> [expected-label]
  local target=$1 lines=${2:-40}
  [ -n "$target" ] || return 1
  fm_backend_paseo_tool_check || return 1

  if fm_backend_paseo_is_agent "$target"; then
    paseo logs "$target" 2>/dev/null | tail -n "$lines"
  else
    paseo terminal capture "$target" 2>/dev/null | tail -n "$lines"
  fi
}

fm_backend_paseo_composer_capture() {  # <target> [expected-label]
  fm_backend_paseo_capture "$1" "$FM_COMPOSER_CAPTURE_LINES"
}

fm_backend_paseo_composer_caps() {
  printf 'styled=0\ncursor=0\nidentity=0\nrows=%s\n' "$FM_COMPOSER_CAPTURE_LINES"
}

# Composer state for send verification
fm_backend_paseo_composer_state() {  # <target> [expected-label] -> empty|pending|unknown
  local target=$1 cap
  if fm_backend_paseo_is_agent "$target"; then
    local out
    out=$(paseo inspect "$target" --json 2>/dev/null) || { printf 'unknown'; return 0; }
    printf '%s' "$out" | node -e '
const fs = require("fs");
try {
  const data = JSON.parse(fs.readFileSync(0, "utf8"));
  if (data.Status === "running") {
    process.stdout.write("pending");
  } else if (data.Status === "idle") {
    process.stdout.write("empty");
  } else {
    process.stdout.write("unknown");
  }
} catch (e) {
  process.stdout.write("unknown");
}
'
    return 0
  fi

  # Terminal composer classification
  cap=$(fm_backend_paseo_composer_capture "$target") || { printf 'unknown'; return 0; }
  fm_composer_classify_screen "$cap" "$(fm_backend_paseo_composer_caps)"
}

# Send literal text to Paseo terminal or agent
fm_backend_paseo_send_literal() {  # <target> <text> [expected-label]
  local target=$1 text=$2
  [ -n "$target" ] || return 1
  fm_backend_paseo_tool_check || return 1

  if fm_backend_paseo_is_agent "$target"; then
    paseo send "$target" "$text" >/dev/null 2>&1
  else
    paseo terminal send-keys "$target" "$text" >/dev/null 2>&1
  fi
}

fm_backend_paseo_send_text_line() {  # <target> <text> [expected-label]
  local target=$1 text=$2
  [ -n "$target" ] || return 1
  fm_backend_paseo_tool_check || return 1

  if fm_backend_paseo_is_agent "$target"; then
    paseo send "$target" "$text" >/dev/null 2>&1
  else
    paseo terminal send-keys "$target" "$text" Enter >/dev/null 2>&1
  fi
}

# Submit text and verify
fm_backend_paseo_send_text_submit() {  # <target> <text> <retries> <enter-sleep> <settle> [expected-label]
  local target=$1 text=$2
  [ -n "$target" ] || return 1
  fm_backend_paseo_tool_check || return 1

  if fm_backend_paseo_is_agent "$target"; then
    paseo send "$target" "$text" >/dev/null 2>&1
    return 0
  fi

  paseo terminal send-keys "$target" "$text" Enter >/dev/null 2>&1
}

# Send key (C-c, Escape, Enter)
fm_backend_paseo_send_key() {  # <target> <key> [expected-label]
  local target=$1 key=$2
  [ -n "$target" ] || return 1
  fm_backend_paseo_tool_check || return 1

  if fm_backend_paseo_is_agent "$target"; then
    case "$key" in
      C-c|Escape|interrupt)
        paseo stop "$target" >/dev/null 2>&1 || true
        ;;
    esac
    return 0
  fi

  case "$key" in
    C-c) paseo terminal send-keys "$target" "^C" >/dev/null 2>&1 || true ;;
    Enter) paseo terminal send-keys "$target" Enter >/dev/null 2>&1 || true ;;
    Escape) paseo terminal send-keys "$target" Escape >/dev/null 2>&1 || true ;;
  esac
}

# Kill / cleanup the task
fm_backend_paseo_kill() {  # <target>
  local target=$1
  [ -n "$target" ] || return 0
  fm_backend_paseo_tool_check || return 0

  if fm_backend_paseo_is_agent "$target"; then
    paseo stop "$target" >/dev/null 2>&1 || true
    paseo archive "$target" >/dev/null 2>&1 || true
  else
    paseo terminal kill "$target" >/dev/null 2>&1 || true
  fi
}

# Workspace management helpers
fm_backend_paseo_workspace_create() {  # <project-path> <branch-name> [base-branch]
  local project_path=$1 branch_name=$2 base_branch=${3:-main} out
  fm_backend_paseo_tool_check || return 1
  out=$(paseo workspace create \
    --isolation worktree \
    --mode branch-off \
    --new-branch "$branch_name" \
    --base "$base_branch" \
    --path "$project_path" \
    --json) || return 1
  printf '%s' "$out"
}

fm_backend_paseo_remove_worktree() {  # <workspace-id>
  local workspace_id=$1
  [ -n "$workspace_id" ] || return 0
  fm_backend_paseo_tool_check || return 0
  paseo workspace archive "$workspace_id" --json >/dev/null 2>&1 || true
}

fm_backend_paseo_worktree_path() {  # <workspace-id>
  local workspace_id=$1 out
  [ -n "$workspace_id" ] || return 1
  fm_backend_paseo_tool_check || return 1
  out=$(paseo workspace ls --json 2>/dev/null) || return 1
  printf '%s' "$out" | node -e '
const fs = require("fs");
const targetId = process.argv[1];
try {
  const list = JSON.parse(fs.readFileSync(0, "utf8"));
  const found = list.find(w => w.workspaceId === targetId || w.id === targetId);
  if (found && found.cwd) {
    process.stdout.write(found.cwd);
    process.exit(0);
  }
} catch (e) {}
process.exit(1);
' "$workspace_id"
}
