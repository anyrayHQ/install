#!/usr/bin/env bash
#
# verify-deploy.sh — post-deploy health check for an Anyray stack.
#
# Polls the gateway for liveness, then queries the admin-gated /admin/health
# endpoint and prints a per-leg verdict (gateway / observability / spend /
# optimizer / portal) with a targeted remedy for any failing leg. This turns a
# confusing "half-working" deploy — gateway proxies fine, but the console can't
# load traces — into a self-diagnosing one-liner.
#
# Usage:
#   ./scripts/verify-deploy.sh                          # reads .env (Docker install)
#   ./scripts/verify-deploy.sh <gateway-url> [admin-token]
#
# Exit code: 0 when every required leg is healthy, 1 otherwise (so it doubles as
# a scriptable gate in CI / a deploy pipeline).
set -euo pipefail

GATEWAY_URL="${1:-}"
ADMIN_TOKEN="${2:-}"

# Fall back to the .env the Docker/compose install writes at the repo root.
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
get_env() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | head -1 || true; }

if [ -z "$GATEWAY_URL" ]; then
  GATEWAY_URL="$(get_env ANYRAY_GATEWAY_PUBLIC_URL)"
  [ -z "$GATEWAY_URL" ] && GATEWAY_URL="http://localhost:8787"
fi
[ -z "$ADMIN_TOKEN" ] && ADMIN_TOKEN="$(get_env ANYRAY_ADMIN_TOKEN)"
GATEWAY_URL="${GATEWAY_URL%/}"

echo "→ Verifying Anyray at ${GATEWAY_URL}"

# 1) Liveness — poll up to ~90s (first boot pulls images and starts services).
printf '  gateway liveness … '
live=0
for _ in $(seq 1 45); do
  if curl -fsS -o /dev/null "${GATEWAY_URL}/"; then live=1; break; fi
  sleep 2
done
if [ "$live" != 1 ]; then
  echo "UNREACHABLE"
  echo "    The gateway never answered ${GATEWAY_URL}/ — confirm it is deployed and"
  echo "    the URL/port is correct (the gateway listens on :8787)."
  exit 1
fi
echo "ok"

if [ -z "$ADMIN_TOKEN" ]; then
  echo "  (no admin token found — skipping deep health. Pass it as arg 2, or set"
  echo "   ANYRAY_ADMIN_TOKEN in .env, to check observability / spend / optimizer.)"
  exit 0
fi

# 2) Deep health. /admin/health returns 503 (not 200) when a required leg is down,
#    so do NOT use curl -f here — we need the body in both cases.
BODY="$(curl -sS "${GATEWAY_URL}/admin/health" -H "Authorization: Bearer ${ADMIN_TOKEN}" 2>/dev/null || true)"
if [ -z "$BODY" ]; then
  echo "  /admin/health returned nothing — is the admin token correct?"
  exit 1
fi

if command -v jq >/dev/null 2>&1; then
  # NOTE: `.ok // empty` would swallow a legitimate `false` (jq treats false as
  # empty), so read the field explicitly and accept only true/false as valid.
  OVERALL="$(printf '%s' "$BODY" | jq -r 'if has("ok") then .ok else "missing" end' 2>/dev/null || true)"
  if [ "$OVERALL" != true ] && [ "$OVERALL" != false ]; then
    echo "  Could not read /admin/health (bad admin token, or an unexpected response):"
    printf '%s\n' "$BODY"
    exit 1
  fi
  printf '%s' "$BODY" | jq -r '
    "  observability: ok=" + (.observability.ok|tostring) + " configured=" + (.observability.configured|tostring),
    "  spend:         ok=" + (.spend.ok|tostring),
    "  optimizer:     ok=" + (.optimizer.ok|tostring) + " configured=" + (.optimizer.configured|tostring),
    "  portal:        metering=" + (.portal.metering|tostring) + " lease=" + (.portal.lease|tostring)'

  obs_conf="$(printf '%s' "$BODY" | jq -r '.observability.configured')"
  obs_ok="$(printf '%s' "$BODY" | jq -r '.observability.ok')"
  spend_ok="$(printf '%s' "$BODY" | jq -r '.spend.ok')"
  opt_conf="$(printf '%s' "$BODY" | jq -r '.optimizer.configured')"
  opt_ok="$(printf '%s' "$BODY" | jq -r '.optimizer.ok')"

  [ "$obs_conf" = false ] && echo "    ⚠ observability not configured — set ANYRAY_OBSERVABILITY_DB_URL (or ANYRAY_SPEND_DB_URL) to your Postgres; the console Traces view will be empty without it."
  [ "$obs_conf" = true ] && [ "$obs_ok" = false ] && echo "    ⚠ observability store unreachable — confirm Postgres is running and reachable on the private network."
  [ "$spend_ok" = false ] && echo "    ⚠ spend store unreachable — check ANYRAY_SPEND_DB_URL and that Postgres is up."
  [ "$opt_conf" = true ] && [ "$opt_ok" = false ] && echo "    ⚠ optimizer not answering — the gateway still serves (fail-open); check the optimizer service if you expect savings."
else
  # No jq — print the raw report and read the top-level ok flag.
  printf '%s\n' "$BODY"
  OVERALL="$(printf '%s' "$BODY" | grep -o '"ok":[a-z]*' | head -1 | sed 's/"ok"://')"
fi

if [ "$OVERALL" = true ]; then
  echo "✓ Deployment healthy — all required legs are green."
else
  echo "✗ Deployment NOT healthy — address the flagged leg(s) above, then re-run."
  exit 1
fi
