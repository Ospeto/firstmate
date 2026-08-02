#!/usr/bin/env bash
# Resolve a project's delivery mode and yolo flag from the data/projects.md registry.
# Prints two words to stdout: "<mode> <yolo>" where mode is one of
# no-mistakes|direct-PR|local-only and yolo is on|off.
#
# Registry line format (data/projects.md):
#   - <name> - <desc> (added <date>)                  -> direct-PR on  (omitted mode default)
#   - <name> [<mode>] - <desc> (added <date>)          -> <mode> off
#   - <name> [<mode> +yolo] - <desc> (added <date>)    -> <mode> on
#
# mode = how a finished change reaches main:
#   no-mistakes  full pipeline -> PR -> captain merge
#   direct-PR    push + PR via gh-axi, no pipeline -> captain merge
#   local-only   local branch, no remote/PR -> captain approve -> guarded local merge
# yolo (orthogonal) = when on, firstmate may make routine approval decisions itself.
#   AGENTS.md section 7 is the single owner of authority exceptions, including
#   ask-user contract expansion and stronger captain boundaries.
#
# An unknown/missing project or malformed explicit mode falls back to
# "no-mistakes off" and warns to stderr, so uncertainty never drops the gate.
# Usage: fm-project-mode.sh <project-name>
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_ROOT="${FM_ROOT_OVERRIDE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FM_HOME="${FM_HOME:-${FM_ROOT_OVERRIDE:-$FM_ROOT}}"
DATA="${FM_DATA_OVERRIDE:-$FM_HOME/data}"
REG="$DATA/projects.md"
NAME=${1:?usage: fm-project-mode.sh <project-name>}

if [ ! -f "$REG" ]; then
  echo "warn: no registry at $REG; defaulting $NAME to no-mistakes off" >&2
  echo "no-mistakes off"
  exit 0
fi

# awk emits "<mode> <yolo>" (one line) or nothing if the project is absent.
parsed=$(awk -v n="$NAME" '
  $1=="-" && $2==n {
    mode="direct-PR"; yolo="on";
    if ($3 != "-" && $3 !~ /^\[/) { print "invalid"; exit }
    if ($3 ~ /^\[/) {
      s=""; closed=0;
      for (i=3; i<=NF; i++) {
        s = s (s==""?"":" ") $i;
        if ($i ~ /\]$/) { closed=1; break }
      }
      if (!closed || i >= NF || $(i+1) != "-") { print "invalid"; exit }
      gsub(/^\[/, "", s); gsub(/\]$/, "", s);
      k = split(s, a, " "); valid=1;
      if (k < 1 || a[1] == "") valid=0;
      if (a[1] !~ /^(no-mistakes|direct-PR|local-only)$/) valid=0;
      else mode=a[1];
      yolo="off";
      for (j=2; j<=k; j++) {
        if (a[j] == "+yolo" && yolo == "off") yolo="on";
        else valid=0;
      }
      if (!valid) { print "invalid"; exit }
    }
    print mode, yolo; exit
  }
' "$REG")

if [ -z "$parsed" ]; then
  echo "warn: project \"$NAME\" not in registry; defaulting to no-mistakes off" >&2
  echo "no-mistakes off"
  exit 0
fi

if [ "$parsed" = invalid ]; then
  echo "warn: malformed mode for $NAME; defaulting to no-mistakes off" >&2
  echo "no-mistakes off"
  exit 0
fi

mode=${parsed%% *}
yolo=${parsed##* }
case "$mode" in
  no-mistakes|direct-PR|local-only) ;;
  *) echo "warn: unknown mode \"$mode\" for $NAME; defaulting to no-mistakes off" >&2; mode=no-mistakes; yolo=off ;;
esac
case "$yolo" in on|off) ;; *) yolo=off ;; esac
echo "$mode $yolo"
