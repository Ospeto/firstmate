#!/usr/bin/env bash
# fm-process-lib.sh - process inspection and worktree process ownership helpers.
#
# Shared one-owner helpers for inspecting live processes associated with a
# task or worktree.

# fm_process_pids_with_cwd_under <dir>: print the PIDs of every live process
# whose current working directory is exactly <dir> or under it.
# Excludes this script's own PID ($$) and subshell PID (${BASHPID:-$$}).
# Returns 0 on success (prints matching PIDs, or empty if none).
# Returns 1 if the check could not establish a safe result (e.g. lsof failed or
# is unavailable), so callers can fail closed.
fm_process_pids_with_cwd_under() { # <dir>
      local dir=$1 out pid path line
      [ -n "$dir" ] && [ -d "$dir" ] || return 0
      dir=$(cd "$dir" 2>/dev/null && pwd -P) || return 1
      command -v lsof >/dev/null 2>&1 || return 1
      out=$(lsof -a -d cwd -Fpn 2>/dev/null) || return 1
      [ -n "$out" ] || return 0
      pid=
      while IFS= read -r line; do
            case "$line" in
            p*)
                  pid=${line#p}
                  case "$pid" in '' | *[!0-9]*) return 1 ;; esac
                  ;;
            fcwd) [ -n "$pid" ] || return 1 ;;
            n*)
                  [ -n "$pid" ] || return 1
                  path=${line#n}
                  case "$path" in
                  "$dir" | "$dir"/*)
                        if [ -n "$pid" ] && [ "$pid" != "$$" ] && [ "$pid" != "${BASHPID:-$$}" ]; then
                              printf '%s\n' "$pid"
                        fi
                        ;;
                  esac
                  ;;
            '') ;;
            *) return 1 ;;
            esac
      done <<EOF
$out
EOF
}
