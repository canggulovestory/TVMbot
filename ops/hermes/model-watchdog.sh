#!/usr/bin/env bash
# Keeps the keyless Hermes provider usable when a free model is retired.
set -euo pipefail

PROFILE="tvm"
REPO_DIR="/root/tvmbot-v4"
ENV_FILE="$REPO_DIR/.env"
HEALTH_URL="http://127.0.0.1:8642/health"
RESPONSE_URL="http://127.0.0.1:8642/v1/responses"
CANDIDATES=(mimo-v2.5-free ling-3.0-flash-fin-free nemotron-3.5-lightning-free nemotron-3-ultra-free muse-spark-1.3-contributor-free)

response_is_healthy() {
  python3 - "$1" <<'PY'
import json, sys

try:
    body = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    raise SystemExit(1)

text = body.get("output_text", "")
if not text:
    text = "\n".join(
        content.get("text", "")
        for item in body.get("output", [])
        for content in item.get("content", [])
        if isinstance(content, dict)
    )
raise SystemExit(0 if "ZUZU_MODEL_OK" in text.upper() else 1)
PY
}

if [[ "${1:-}" == "--self-test" ]]; then
  pass_file="$(mktemp)"
  fail_file="$(mktemp)"
  trap 'rm -f "$pass_file" "$fail_file"' EXIT
  printf '%s\n' '{"output_text":"ZUZU_MODEL_OK"}' > "$pass_file"
  printf '%s\n' '{"output_text":"HTTP 401: Model retired"}' > "$fail_file"
  response_is_healthy "$pass_file" && ! response_is_healthy "$fail_file"
  echo "model watchdog self-test passed"
  exit 0
fi

exec 9>/var/lock/tvm-hermes-model-watchdog.lock
flock -n 9 || exit 0

[[ -r "$ENV_FILE" ]] || { echo "TVMbot environment not found" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
[[ -n "${HERMES_API_KEY:-}" ]] || { echo "HERMES_API_KEY not set" >&2; exit 1; }

probe() {
  local result status
  result="$(mktemp)"
  status="$(curl -sS --max-time 25 -o "$result" -w '%{http_code}' "$RESPONSE_URL" \
    -H "Authorization: Bearer $HERMES_API_KEY" \
    -H 'Content-Type: application/json' \
    -H 'X-Hermes-Session-Id: tvmbot-model-watchdog' \
    -d '{"model":"tvm","input":"Reply exactly: ZUZU_MODEL_OK","instructions":"Reply with exactly ZUZU_MODEL_OK. Do not call tools.","store":false}')" || { rm -f "$result"; return 1; }
  if [[ "$status" == "200" ]] && response_is_healthy "$result"; then
    rm -f "$result"
    return 0
  fi
  rm -f "$result"
  return 1
}

restart_hermes() {
  systemctl restart tvm-hermes.service
  for _ in $(seq 1 20); do
    curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null && return 0
    sleep 1
  done
  return 1
}

if probe; then
  exit 0
fi

current="$(hermes -p "$PROFILE" config get model.default 2>/dev/null || true)"
logger -t tvm-hermes-watchdog "model probe failed; checking fallback models"

for model in "${CANDIDATES[@]}"; do
  [[ "$model" == "$current" ]] && continue
  hermes -p "$PROFILE" config set model.default "$model" >/dev/null
  if restart_hermes && probe; then
    logger -t tvm-hermes-watchdog "recovered Hermes model: ${current:-unknown} -> $model"
    exit 0
  fi
done

if [[ -n "$current" ]]; then
  hermes -p "$PROFILE" config set model.default "$current" >/dev/null
  restart_hermes || true
fi
logger -p user.err -t tvm-hermes-watchdog "all Hermes model probes failed; kept ${current:-the previous model}"
exit 1
