#!/usr/bin/env bash
# bin/fm-update-upstream.sh - Update Firstmate cleanly from real upstream
# (https://github.com/kunchenguid/firstmate) while preserving local integrations.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

fail() {
  echo "error: $*" >&2
  exit 1
}

require_clean_tree() {
  local status
  status=$(git -C "$ROOT" status --porcelain --untracked-files=all)
  [ -z "$status" ] || fail "refusing upstream update with uncommitted changes in $ROOT"
}

require_clean_tree

echo "==> 1. Fetching and updating Firstmate from upstream..."
if UPDATE_OUTPUT=$("$ROOT/bin/fm-update.sh" "$@" 2>&1); then
  printf '%s\n' "$UPDATE_OUTPUT"
else
  rc=$?
  printf '%s\n' "$UPDATE_OUTPUT" >&2
  fail "upstream update failed (exit $rc)"
fi

echo "==> 2. Re-applying Paseo tab and backend integration..."
PATCH="$ROOT/.git/paseo-backend.patch"
if [ -f "$PATCH" ]; then
  if git -C "$ROOT" apply --check "$PATCH"; then
    git -C "$ROOT" apply "$PATCH"
  else
    echo "standard patch check failed; attempting a verified three-way apply" >&2
    git -C "$ROOT" apply --3way "$PATCH"
  fi
fi

# Restore integration files only when the upstream update removed one. Stage the
# complete recovery set in a temporary directory before writing any file.
INTEGRATION_FILES=(
  bin/backends/paseo.sh
  bin/fm-jev.sh
  bin/fm-jev-lib.sh
  bin/jev-triage
  tests/fm-jev-smoke.test.sh
  tests/fm-backend-paseo.test.sh
)
missing=0
for file in "${INTEGRATION_FILES[@]}"; do
  [ -f "$ROOT/$file" ] || missing=1
done
if [ "$missing" -eq 1 ]; then
  RECOVERY_DIR=$(mktemp -d "${TMPDIR:-/tmp}/fm-update-upstream.XXXXXX")
  trap 'rm -rf -- "$RECOVERY_DIR"' EXIT
  for file in "${INTEGRATION_FILES[@]}"; do
    git -C "$ROOT" cat-file -e "feature/paseo-jev-integration:$file" \
      || fail "integration recovery source is missing: feature/paseo-jev-integration:$file"
    mkdir -p "$RECOVERY_DIR/$(dirname "$file")"
    git -C "$ROOT" show "feature/paseo-jev-integration:$file" > "$RECOVERY_DIR/$file"
  done
  for file in "${INTEGRATION_FILES[@]}"; do
    [ -f "$ROOT/$file" ] || {
      mkdir -p "$ROOT/$(dirname "$file")"
      cp "$RECOVERY_DIR/$file" "$ROOT/$file"
    }
  done
  rm -rf -- "$RECOVERY_DIR"
  trap - EXIT
fi

echo "==> 3. Verifying Jev System-1 integration..."
[ -x "$ROOT/tests/fm-jev-smoke.test.sh" ] \
  || fail "Jev smoke test is missing or not executable"
"$ROOT/tests/fm-jev-smoke.test.sh"

echo "==> 4. Reloading Paseo plugins..."
if command -v paseo >/dev/null 2>&1; then
  paseo plugin reload firstmate-paseo
  paseo plugin reload paseo-antigravity-quotas
  paseo plugin reload paseo-compact-adviser
else
  echo "Paseo CLI is not installed; plugin reload skipped."
fi

# This command deliberately does not rewrite branches or publish anything.
# Branch synchronization is a separate reviewed operation, so a failed update
# cannot discard local work or replace a remote branch unexpectedly.
echo "==> 5. Upstream update complete; no branch rewrite or remote push performed."
