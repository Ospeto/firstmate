#!/usr/bin/env bash
# bin/backends/paseo.sh - Paseo session-provider adapter.
#
# Supports both Paseo workspace terminals and native Paseo agents.
# When Firstmate spawns with backend=paseo, crewmates and secondmates are
# created as native Paseo agents within the active workspace, opening as tabs
# in Paseo Desktop and linked under the Subagents track.

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
  const local = data.localDaemon || data.LocalDaemon;
  const connected = data.connectedDaemon || data.ConnectedDaemon;
  if (local !== "running" && connected !== "reachable") {
    console.error("error: Paseo daemon is not running");
    process.exit(1);
  }
} catch (e) {
  process.exit(1);
}
'
}

# Resolve target string to raw agent ID
fm_backend_paseo_target_agent_id() {  # <target>
  local target=$1
  case "$target" in
    *:*) printf '%s' "${target#*:}" ;;
    *) printf '%s' "$target" ;;
  esac
}

# Resolve active Paseo workspace ID matching current directory or repo root
fm_backend_paseo_current_workspace_id() {  # [target-cwd]
  local cwd=${1:-$PWD}
  node -e '
const cp = require("child_process");
try {
  const list = JSON.parse(cp.execSync("paseo workspace ls --json 2>/dev/null", { encoding: "utf8" }));
  const cwd = process.argv[1];
  const ws = list.find(w => w.cwd === cwd) || list.find(w => cwd.startsWith(w.cwd));
  if (ws && ws.workspaceId) {
    process.stdout.write(ws.workspaceId);
    process.exit(0);
  }
} catch (e) {}
process.exit(1);
' "$cwd" 2>/dev/null
}

# Distinguish whether a target is an agent UUID or a terminal ID
fm_backend_paseo_is_agent() {  # <target>
  local target=$1
  paseo inspect "$target" --json >/dev/null 2>&1
}

# Validate that a native agent is owned by one exact Firstmate task and workspace.
fm_backend_paseo_agent_belongs_to_task() {  # <agent-id> <task-id> <worktree> <workspace-id>
  local agent_id=${1:-} task_id=${2:-} recorded_worktree=${3:-} expected_workspace=${4:-} out
  [ -n "$agent_id" ] || return 1
  [ -n "$recorded_worktree" ] || return 1
  [ -n "$expected_workspace" ] || return 1
  out=$(paseo inspect "$agent_id" --json 2>/dev/null) || return 1
  printf '%s' "$out" | node -e '
const fs = require("fs");
const path = require("path");
const [expectedTask, recordedWorktree, expectedWorkspace] = process.argv.slice(1);
let data;
try {
  data = JSON.parse(fs.readFileSync(0, "utf8"));
} catch (e) {
  process.exit(1);
}
const first = (...values) => values.find(value => value !== undefined && value !== null);
const labels = first(data.labels, data.Labels, data.agent?.labels, data.agent?.Labels);
const expectedLabel = "firstmate_task=" + expectedTask;
let labelOwned = false;
if (Array.isArray(labels)) {
  labelOwned = labels.some(label => label === expectedLabel || (
    label && typeof label === "object" &&
    (label.key === "firstmate_task" || label.Key === "firstmate_task") &&
    (label.value === expectedTask || label.Value === expectedTask)
  ));
} else if (labels && typeof labels === "object") {
  labelOwned = labels.firstmate_task === expectedTask || labels.FirstmateTask === expectedTask;
}
const name = first(data.name, data.Name, data.agent?.name, data.agent?.Name) || "";
const title = first(data.title, data.Title, data.agent?.title, data.agent?.Title) || "";
const identityOwned = labelOwned || name === "fm-" + expectedTask || title === "fm-" + expectedTask;
const actualCwd = first(data.cwd, data.Cwd, data.agent?.cwd, data.agent?.Cwd);
let actualWorkspace = first(
  data.workspaceId, data.WorkspaceId, data.workspace_id,
  data.workspace?.workspaceId, data.workspace?.WorkspaceId, data.workspace?.id, data.workspace?.Id,
  data.Workspace?.workspaceId, data.Workspace?.WorkspaceId, data.Workspace?.id, data.Workspace?.Id,
  data.agent?.workspaceId, data.agent?.WorkspaceId, data.agent?.workspace_id,
  data.agent?.workspace?.workspaceId, data.agent?.workspace?.id,
  data.agent?.Workspace?.WorkspaceId, data.agent?.Workspace?.Id
);
const normalize = value => {
  if (typeof value !== "string" || !path.isAbsolute(value)) return "";
  return path.normalize(path.resolve(value));
};
if (!actualWorkspace && actualCwd) {
  try {
    const cp = require("child_process");
    const list = JSON.parse(cp.execSync("paseo workspace ls --json 2>/dev/null", { encoding: "utf8" }));
    const ws = list.find(w => normalize(w.cwd) === normalize(actualCwd));
    if (ws && (ws.workspaceId || ws.id)) actualWorkspace = ws.workspaceId || ws.id;
  } catch (e) {}
}
if (!identityOwned || typeof actualWorkspace !== "string" || actualWorkspace !== expectedWorkspace ||
    normalize(actualCwd) === "" || normalize(recordedWorktree) === "" ||
    normalize(actualCwd) !== normalize(recordedWorktree)) {
  process.exit(1);
}
' "$task_id" "$recorded_worktree" "$expected_workspace"
}

# Target exists in Paseo
fm_backend_paseo_target_exists() {  # <target> [expected-label]
  local target=$1
  [ -n "$target" ] || return 1
  fm_backend_paseo_tool_check || return 1

  if fm_backend_paseo_is_agent "$target"; then
    return 0
  fi

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
  if (data.Status === "closed") {
    process.stdout.write("dead");
  } else if (data.Status === "running" || data.Status === "idle") {
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

  cap=$(fm_backend_paseo_composer_capture "$target") || { printf 'unknown'; return 0; }
  fm_composer_classify_screen "$cap" "$(fm_backend_paseo_composer_caps)"
}

# Send literal text to Paseo terminal or agent
fm_backend_paseo_send_literal() {  # <target> <text> [expected-label]
  local target=$1 text=$2
  [ -n "$target" ] || return 1
  fm_backend_paseo_tool_check || return 1

  if fm_backend_paseo_is_agent "$target"; then
    paseo send --no-wait "$target" "$text" >/dev/null 2>&1
  else
    paseo terminal send-keys "$target" "$text" >/dev/null 2>&1
  fi
}

fm_backend_paseo_send_text_line() {  # <target> <text> [expected-label]
  local target=$1 text=$2
  [ -n "$target" ] || return 1
  fm_backend_paseo_tool_check || return 1

  if fm_backend_paseo_is_agent "$target"; then
    paseo send --no-wait "$target" "$text" >/dev/null 2>&1
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
    paseo send --no-wait "$target" "$text" >/dev/null 2>&1
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
  local target=$1 out status terminals
  [ -n "$target" ] || {
    echo "error: refusing empty Paseo kill target" >&2
    return 1
  }
  fm_backend_paseo_tool_check || return 1

  if out=$(paseo inspect "$target" --json 2>/dev/null); then
    status=$(printf '%s' "$out" | node -e '
const fs = require("fs");
try {
  const data = JSON.parse(fs.readFileSync(0, "utf8"));
  const value = data.Status ?? data.status ?? data.agent?.Status ?? data.agent?.status;
  const archived = data.Archived ?? data.archived;
  if (archived === true) {
    process.stdout.write("archived");
  } else {
    process.stdout.write(String(value ?? "").toLowerCase());
  }
} catch (e) {
  process.exit(1);
}
') || {
      echo "error: could not read Paseo agent $target state" >&2
      return 1
    }
    if [ "$status" = archived ]; then
      return 0
    fi
    case "$status" in
      running|idle)
        if ! paseo stop "$target" >/dev/null 2>&1; then
          echo "error: Paseo agent $target could not be stopped" >&2
          return 1
        fi
        ;;
      closed) ;;
      *)
        echo "error: Paseo agent $target has unverifiable state '$status'" >&2
        return 1
        ;;
    esac
    if ! paseo archive "$target" >/dev/null 2>&1; then
      echo "error: Paseo agent $target could not be archived after stop" >&2
      return 1
    fi
    if ! out=$(paseo inspect "$target" --json 2>/dev/null); then
      echo "error: could not verify Paseo agent $target after archive" >&2
      return 1
    fi
    status=$(printf '%s' "$out" | node -e '
const fs = require("fs");
try {
  const data = JSON.parse(fs.readFileSync(0, "utf8"));
  const value = data.Status ?? data.status ?? data.agent?.Status ?? data.agent?.status;
  const archived = data.Archived ?? data.archived;
  if (archived === true) {
    process.stdout.write("archived");
  } else {
    process.stdout.write(String(value ?? "").toLowerCase());
  }
} catch (e) {
  process.exit(1);
}
') || {
      echo "error: could not verify Paseo agent $target after archive" >&2
      return 1
    }
    case "$status" in
      archived|closed) return 0 ;;
      *)
        echo "error: Paseo agent $target remains '$status' after archive; preserving task state" >&2
        return 1
        ;;
    esac
  fi

  # An inspect miss may mean a terminal target, but it is not proof that an
  # agent was closed. Require an inventory hit and verify it disappears.
  terminals=$(paseo terminal ls --json 2>/dev/null) || {
    echo "error: could not verify missing Paseo target $target" >&2
    return 1
  }
  if ! printf '%s' "$terminals" | node -e '
const fs = require("fs");
const target = process.argv[1];
try {
  const data = JSON.parse(fs.readFileSync(0, "utf8"));
  const list = Array.isArray(data) ? data : (data.terminals || data.Terminals || data.result?.terminals || []);
  process.exit(list.some(item => item && (item.id === target || item.Id === target || item.name === target || item.Name === target)) ? 0 : 1);
} catch (e) {
  process.exit(1);
}
' "$target"; then
    echo "error: Paseo target $target could not be found for verified cleanup" >&2
    return 1
  fi
  if ! paseo terminal kill "$target" >/dev/null 2>&1; then
    echo "error: Paseo terminal $target could not be killed" >&2
    return 1
  fi
  terminals=$(paseo terminal ls --json 2>/dev/null) || {
    echo "error: could not verify Paseo terminal $target after kill" >&2
    return 1
  }
  if printf '%s' "$terminals" | node -e '
const fs = require("fs");
const target = process.argv[1];
try {
  const data = JSON.parse(fs.readFileSync(0, "utf8"));
  const list = Array.isArray(data) ? data : (data.terminals || data.Terminals || data.result?.terminals || []);
  process.exit(list.some(item => item && (item.id === target || item.Id === target || item.name === target || item.Name === target)) ? 1 : 0);
} catch (e) {
  process.exit(1);
}
' "$target"; then
    echo "error: Paseo terminal $target remains after kill" >&2
    return 1
  fi
  return 0
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
  local workspace_id=$1 out result
  [ -n "$workspace_id" ] || {
    echo "error: refusing empty Paseo workspace id" >&2
    return 1
  }
  fm_backend_paseo_tool_check || return 1
  if ! paseo workspace archive "$workspace_id" --json; then
    echo "error: Paseo workspace $workspace_id could not be archived" >&2
    return 1
  fi
  if ! out=$(paseo workspace ls --json); then
    echo "error: could not verify archived Paseo workspace $workspace_id" >&2
    return 1
  fi
  result=$(printf '%s' "$out" | node -e '
const fs = require("fs");
const target = process.argv[1];
try {
  const data = JSON.parse(fs.readFileSync(0, "utf8"));
  const list = Array.isArray(data) ? data : (data.workspaces || data.Workspaces || data.result?.workspaces || []);
  const found = list.find(item => item && (item.workspaceId === target || item.WorkspaceId === target || item.id === target || item.Id === target));
  if (!found) process.stdout.write("gone");
  else {
    const state = String(found.status ?? found.Status ?? found.state ?? found.State ?? "").toLowerCase();
    process.stdout.write(state === "archived" || state === "closed" ? "archived" : "active");
  }
} catch (e) {
  process.stdout.write("invalid");
}
' "$workspace_id")
  case "$result" in
    gone|archived) return 0 ;;
    active)
      echo "error: Paseo workspace $workspace_id is still active after archive; preserving task state" >&2
      return 1
      ;;
    *)
      echo "error: could not verify Paseo workspace $workspace_id after archive" >&2
      return 1
      ;;
  esac
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

# Spawn an agent as a native tab in the active Paseo workspace
fm_backend_paseo_spawn_agent() { # <task_id> <title> <cwd> <brief_file> <model> <effort> <kind> [workspace_id]
  local task_id=$1 title=$2 cwd=$3 brief_file=$4 model=$5 effort=$6 kind=$7 ws_id=${8:-}
  local parent_flag=() out agent_id

  if [ -z "$ws_id" ] && [ -n "$cwd" ] && [ -d "$cwd" ]; then
    ws_id=$(paseo workspace ls --json 2>/dev/null | node -e '
const fs = require("fs");
const targetCwd = process.argv[1];
try {
  const list = JSON.parse(fs.readFileSync(0, "utf8"));
  const found = list.find(w => w.cwd === targetCwd || w.workspaceDirectory === targetCwd);
  if (found) process.stdout.write(found.workspaceId || found.id || "");
} catch (e) {}
' "$cwd")
  fi
  if [ -z "$ws_id" ]; then
    ws_id=$(fm_backend_paseo_current_workspace_id "$PWD" 2>/dev/null || true)
  fi
  [ -z "${PASEO_AGENT_ID:-}" ] || parent_flag=(--label "paseo.parent-agent-id=$PASEO_AGENT_ID")

  local target_model=${model:-antigravity/gemini-3.8-flash}
  [ "$target_model" != "default" ] || target_model="antigravity/gemini-3.8-flash"
  local target_effort=${effort:-medium}
  [ "$target_effort" != "default" ] || target_effort="medium"

  local ws_flag=()
  [ -z "$ws_id" ] || ws_flag=(--workspace "$ws_id")

  local prompt_text=""
  [ ! -f "$brief_file" ] || prompt_text=$(cat "$brief_file")
  [ -n "$prompt_text" ] || prompt_text="Task: $title"

  out=$(paseo agent run \
    --json \
    --provider pi \
    --model "$target_model" \
    --thinking "$target_effort" \
    --cwd "$cwd" \
    "${ws_flag[@]}" \
    --title "$title" \
    "${parent_flag[@]}" \
    --label "firstmate_task=$task_id" \
    --label "firstmate_kind=$kind" \
    --background \
    "$prompt_text") || return 1

  agent_id=$(printf '%s\n' "$out" | node -e '
const fs = require("fs");
let data;
try {
  data = JSON.parse(fs.readFileSync(0, "utf8"));
} catch (e) {
  process.exit(1);
}
const valid = value => typeof value === "string" && value.trim() !== "" && !/[\s\r\n]/.test(value);
const candidates = [
  data.agentId, data.AgentId, data.agent_id,
  data.id, data.Id,
  data.agent?.agentId, data.agent?.AgentId, data.agent?.agent_id,
  data.agent?.id, data.agent?.Id,
  data.Agent?.AgentId, data.Agent?.Id,
  data.result?.agentId, data.result?.AgentId, data.result?.agent_id,
  data.result?.id, data.result?.Id,
  data.Result?.agentId, data.Result?.AgentId, data.Result?.agent_id,
  data.Result?.id, data.Result?.Id
];
const agentId = candidates.find(valid);
if (agentId) process.stdout.write(agentId.trim());
else process.exit(1);
') || {
    echo "error: Paseo agent run returned invalid JSON without an agent ID" >&2
    return 1
  }
  [ -n "$agent_id" ] || {
    echo "error: Paseo agent run returned no agent ID" >&2
    return 1
  }

  if ! paseo agent open "$agent_id" >/dev/null 2>&1; then
    echo "warning: Paseo agent $agent_id was created but could not be opened; continuing with the native agent endpoint" >&2
  fi
  printf '%s' "$agent_id"
}
