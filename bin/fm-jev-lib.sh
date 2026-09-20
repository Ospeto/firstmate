#!/usr/bin/env bash
# bin/fm-jev-lib.sh - Shared TypeSafe Jev System-1 API client.
#
# Jev is a fast (~150ms), calibrated discrete classification engine
# (https://api.typesafe.ai/v1/systemone) used by Firstmate for high-speed
# decision triage, anti-looping watchdog, model dispatch, and PR checks.

FM_JEV_ENDPOINT="https://api.typesafe.ai/v1/systemone"
FM_JEV_MODEL="jev-latest"
FM_JEV_TIMEOUT_SECS=8

# Resolve the TypeSafe API key from environment or .env file
fm_jev_api_key() {
  if [ -n "${TYPESAFE_API_KEY:-}" ]; then
    printf '%s' "$TYPESAFE_API_KEY"
    return 0
  fi

  local root=${FM_ROOT:-${FM_HOME:-$PWD}}
  local env_file="$root/.env"
  if [ -f "$env_file" ]; then
    local key
    key=$(grep -E '^TYPESAFE_API_KEY=' "$env_file" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r"')
    if [ -n "$key" ]; then
      printf '%s' "$key"
      return 0
    fi
  fi
  return 1
}

# Post a System-1 classification request to Jev.
# Usage: fm_jev_query <state_string> <questions_json_string> [timeout_seconds]
fm_jev_query() {
  local state=$1 questions_json=$2 timeout=${3:-$FM_JEV_TIMEOUT_SECS}
  local key payload resp

  key=$(fm_jev_api_key) || {
    echo "error: TYPESAFE_API_KEY is not set in environment or .env" >&2
    return 1
  }

  [ -n "$state" ] || {
    echo "error: state context is empty for Jev query" >&2
    return 1
  }

  [ -n "$questions_json" ] || {
    echo "error: questions JSON is empty for Jev query" >&2
    return 1
  }

  # Construct request payload safely via node to handle escaping
  payload=$(node -e '
const fs = require("fs");
const model = process.argv[1];
const state = process.argv[2];
const questions = JSON.parse(process.argv[3]);
process.stdout.write(JSON.stringify({ model, state, questions }));
' "$FM_JEV_MODEL" "$state" "$questions_json" 2>/dev/null) || {
    echo "error: failed to serialize Jev request payload" >&2
    return 1
  }

  # Execute HTTP call with bounded timeout and single retry on transient error
  local tmp_out
  tmp_out=$(mktemp "/tmp/fm-jev-query.XXXXXX") || return 1
  local http_code
  http_code=$(curl -s -o "$tmp_out" -w "%{http_code}" \
    -X POST "$FM_JEV_ENDPOINT" \
    -H "Authorization: Bearer $key" \
    -H "Content-Type: application/json" \
    --max-time "$timeout" \
    --data-binary "$payload" 2>/dev/null || echo "000")

  if [ "$http_code" = "000" ] || [ "$http_code" = "502" ] || [ "$http_code" = "503" ] || [ "$http_code" = "504" ]; then
    sleep 0.5
    http_code=$(curl -s -o "$tmp_out" -w "%{http_code}" \
      -X POST "$FM_JEV_ENDPOINT" \
      -H "Authorization: Bearer $key" \
      -H "Content-Type: application/json" \
      --max-time "$timeout" \
      --data-binary "$payload" 2>/dev/null || echo "000")
  fi

  if [ "$http_code" != "200" ]; then
    local err_msg
    err_msg=$(cat "$tmp_out" 2>/dev/null | head -c 200 || true)
    rm -f "$tmp_out"
    echo "error: Jev API request failed with HTTP $http_code ($err_msg)" >&2
    return 1
  fi

  resp=$(cat "$tmp_out")
  rm -f "$tmp_out"
  printf '%s' "$resp"
}

# Extract choice for a question
fm_jev_choice() { # <response_json> <question_name>
  local json=$1 question=$2
  printf '%s' "$json" | node -e '
const fs = require("fs");
const q = process.argv[1];
try {
  const data = JSON.parse(fs.readFileSync(0, "utf8"));
  const ans = data?.answers?.[q];
  if (ans && ans.choice) {
    process.stdout.write(String(ans.choice));
    process.exit(0);
  }
} catch (e) {}
process.exit(1);
' "$question" 2>/dev/null
}

# Extract confidence (0.00 to 1.00) for a question
fm_jev_confidence() { # <response_json> <question_name>
  local json=$1 question=$2
  printf '%s' "$json" | node -e '
const fs = require("fs");
const q = process.argv[1];
try {
  const data = JSON.parse(fs.readFileSync(0, "utf8"));
  const ans = data?.answers?.[q];
  if (ans && typeof ans.confidence === "number") {
    process.stdout.write(String(ans.confidence));
    process.exit(0);
  }
} catch (e) {}
process.exit(1);
' "$question" 2>/dev/null
}
