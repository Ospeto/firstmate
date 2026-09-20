#!/usr/bin/env bash
# tests/fm-jev-smoke.test.sh - Smoke tests for Firstmate Jev System-1 CLI.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pass() { printf 'ok - %s\n' "$1"; }
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }

# 1. Test API key resolution
# shellcheck source=bin/fm-jev-lib.sh
. "$ROOT/bin/fm-jev-lib.sh"
key=$(fm_jev_api_key) || fail "fm_jev_api_key failed to resolve TYPESAFE_API_KEY"
[ -n "$key" ] || fail "resolved API key is empty"
pass "resolved TYPESAFE_API_KEY"

# 2. Test live connection
out=$("$ROOT/bin/fm-jev.sh" test) || fail "fm-jev.sh test failed"
echo "$out" | grep -q "Jev Response OK" || fail "test response missing expected marker"
pass "live Jev API connection verified"

# 3. Test watchdog loop detection
tmp_dir=$(mktemp -d "/tmp/fm-jev-test.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT

printf 'error: connection failed\nerror: connection failed\nerror: connection failed\n' > "$tmp_dir/task1.status"
out=$(FM_STATE_OVERRIDE="$tmp_dir" "$ROOT/bin/fm-jev.sh" watchdog task1 2>&1 || true)
echo "$out" | grep -q "trajectory=looping" || fail "watchdog did not detect looping: $out"
pass "watchdog correctly detected looping state"

printf 'working: wrote tests\ndone: all 15 tests passing\n' > "$tmp_dir/task2.status"
out=$(FM_STATE_OVERRIDE="$tmp_dir" "$ROOT/bin/fm-jev.sh" watchdog task2 2>&1 || true)
echo "$out" | grep -q "trajectory=done" || fail "watchdog did not detect done: $out"
pass "watchdog correctly detected completed state"

# 4. Test PR triage
out=$("$ROOT/bin/fm-jev.sh" triage-pr "docs: fix typo in README" "1 line modified") || true
echo "$out" | grep -q "verdict=auto_pass" || fail "PR triage did not auto_pass trivial docs: $out"
pass "triage-pr correctly auto-passed low-risk docs PR"

out=$("$ROOT/bin/fm-jev.sh" triage-pr "feat: in-memory EPUB XML parser" "Parsing untrusted EPUB archives with raw XML entity expansion") || true
echo "$out" | grep -q "verdict=oracle_audit" || fail "PR triage did not flag security-sensitive PR: $out"
pass "triage-pr correctly escalated security-sensitive PR to Oracle audit"

# 5. Test decision escalation
out=$("$ROOT/bin/fm-jev.sh" escalate "Should I name the test file user.test.ts?" "user.test.ts vs user.spec.ts") || true
echo "$out" | grep -q "verdict=obvious" || fail "escalate did not mark naming convention as obvious: $out"
pass "escalate correctly identified obvious convention decision"

out=$("$ROOT/bin/fm-jev.sh" escalate "Should I delete the production database tables?" "delete tables vs keep tables") || true
echo "$out" | grep -q "verdict=subjective" || fail "escalate did not mark destructive question as subjective: $out"
pass "escalate correctly identified destructive decision needing captain input"

# 6. Test dispatch routing
out=$("$ROOT/bin/fm-jev.sh" dispatch "Fix typo in documentation link")
echo "$out" | grep -q "model_tier=flash" || fail "dispatch did not route routine task to flash: $out"
pass "dispatch correctly routed routine task to flash"

out=$("$ROOT/bin/fm-jev.sh" dispatch "Diagnose complex intermittent deadlock and race condition under network partition")
echo "$out" | grep -q -E "model_tier=sol|model_tier=luna" || fail "dispatch did not route complex task to sol/luna: $out"
pass "dispatch correctly routed complex debugging task to reasoning tier"

# 7. Test compaction check
out=$("$ROOT/bin/fm-jev.sh" compact-check "PR #12 merged to main, all 70 unit tests pass, LaunchAgent restarted. Ready for next task.") || true
echo "$out" | grep -q "compact_safe=yes" || fail "compact-check did not mark finished task as safe: $out"
pass "compact-check correctly identified finished unit of work"

echo "ALL 7 JEV SMOKE TESTS PASSED."
