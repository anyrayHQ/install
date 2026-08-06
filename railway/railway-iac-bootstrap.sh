#!/usr/bin/env bash
# Bootstrap for the Railway Infrastructure-as-Code install (.railway/railway.ts).
#
# `railway config apply` creates the services. This script adds:
#   1. generated secrets (preserve()d in railway.ts)
#   2. the operator's mandatory Billing deployment token
#   3. public domains for gateway (:8787) and proxy (:80) + the URLs that reference them
#
# Run after `railway config apply` with the project linked (`railway link`).
# Safe to re-run: generated secrets and domains are kept; a supplied token is set.
#
# Usage: railway/railway-iac-bootstrap.sh adt_deployment_token
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=railway/release-tag.sh
source "$here/release-tag.sh"

deployment_token="${1:-}"
if [ -n "$deployment_token" ]; then
  [[ "$deployment_token" =~ ^adt_[A-Za-z0-9_-]+$ ]] || {
    echo "deployment token must match adt_[A-Za-z0-9_-]+ (get one at https://app.anyray.ai)" >&2
    exit 1
  }
fi

iac_tag="$(sed -nE 's/^const TAG = "(v[0-9]+\.[0-9]+\.[0-9]+)";.*/\1/p' "$here/../.railway/railway.ts")"
anyray_valid_release_tag "$iac_tag" || {
  echo "could not read a pinned vX.Y.Z from .railway/railway.ts" >&2
  exit 1
}

command -v railway >/dev/null || { echo "railway CLI not found (https://docs.railway.com/guides/cli)"; exit 1; }
command -v openssl >/dev/null || { echo "openssl required for secret generation"; exit 1; }
railway status >/dev/null 2>&1 || { echo "No linked project — run 'railway link' first."; exit 1; }

hex() { openssl rand -hex "$1"; }

# Read a service's current value for KEY ("" if unset).
getvar() { railway variables -s "$1" --kv 2>/dev/null | sed -n "s/^$2=//p"; }

if [ -z "$deployment_token" ]; then
  existing_deployment_token="$(getvar gateway ANYRAY_DEPLOYMENT_TOKEN)"
  if [[ ! "$existing_deployment_token" =~ ^adt_[A-Za-z0-9_-]+$ ]]; then
    echo "Usage: railway/railway-iac-bootstrap.sh adt_deployment_token" >&2
    echo "a valid Billing deployment token is required on the first bootstrap" >&2
    exit 1
  fi
fi

# Set KEY=VALUE on service $1 only if currently empty (idempotent, no redeploy churn).
set_if_empty() {
  local svc="$1" key="$2" val="$3"
  if [ -z "$(getvar "$svc" "$key")" ]; then
    railway variables -s "$svc" --set "$key=$val" --skip-deploys >/dev/null
    echo "  set $svc.$key"
  else
    echo "  keep $svc.$key (already set)"
  fi
}

echo "== seeding generated secrets =="
# Canonical secrets live on the gateway; optimizer references them via railway.ts.
set_if_empty gateway ANYRAY_ADMIN_TOKEN "$(hex 24)"
set_if_empty gateway ANYRAY_CONTENT_KEY "$(hex 32)"      # 32-byte AES-256-GCM key
set_if_empty gateway ANYRAY_OPTIMIZER_TOKEN "$(hex 24)"
set_if_empty gateway ANYRAY_PSEUDONYM_SALT "$(hex 16)"
# Not a secret, but it belongs to the same "must exist before the first deploy"
# set. Railway's SIGTERM-to-SIGKILL buffer defaults to 0, so without this the
# gateway is killed the instant a deploy starts and its own drain
# (ANYRAY_SHUTDOWN_DRAIN_MS, 90s) never runs at all: every streaming turn in
# flight is cut, which the developer's tool reports as "Connection closed
# mid-response". Seeded here as well as in railway.template.json so a re-run
# fixes a project that predates the template change.
set_if_empty gateway RAILWAY_DEPLOYMENT_DRAINING_SECONDS "120"
set_if_empty proxy   ANYRAY_UPDATER_TOKEN "$(hex 16)"

# A re-run may omit the token only when the gateway already has one.
if [ -n "$deployment_token" ]; then
  railway variables -s gateway --set "ANYRAY_DEPLOYMENT_TOKEN=$deployment_token" --skip-deploys >/dev/null
  echo "  set gateway.ANYRAY_DEPLOYMENT_TOKEN"
else
  echo "  keep gateway.ANYRAY_DEPLOYMENT_TOKEN (already set)"
fi

echo "== generating public domains =="
railway domain -s gateway -p 8787 >/dev/null 2>&1 || true
railway domain -s proxy   -p 80   >/dev/null 2>&1 || true

gw_host="$(railway domain -s gateway 2>/dev/null | grep -oE '[a-z0-9-]+\.up\.railway\.app' | head -1)"
px_host="$(railway domain -s proxy   2>/dev/null | grep -oE '[a-z0-9-]+\.up\.railway\.app' | head -1)"
[ -n "$gw_host" ] && railway variables -s gateway --set "ANYRAY_GATEWAY_PUBLIC_URL=https://$gw_host" --skip-deploys >/dev/null
[ -n "$px_host" ] && railway variables -s gateway --set "ANYRAY_CONSOLE_PUBLIC_URL=https://$px_host" >/dev/null # last set triggers redeploy

echo
echo "Bootstrap complete."
echo "  Gateway API : ${gw_host:+https://$gw_host}"
echo "  Console     : ${px_host:+https://$px_host}"
echo "  Admin token : \$(railway variables -s gateway --kv | grep ANYRAY_ADMIN_TOKEN)"
echo "  Billing     : deployment token configured"
