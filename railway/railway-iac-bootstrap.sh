#!/usr/bin/env bash
# One-time bootstrap for the Railway Infrastructure-as-Code install (.railway/railway.ts).
#
# `railway config apply` provisions the services and wires every internal reference,
# but two things IaC can't express declaratively are seeded here (idempotently):
#   1. generated secrets, plus the policy activation instant once the IaC image
#      pin supports it (preserve()d in railway.ts)
#   2. public domains for gateway (:8787) and proxy (:80) + the URLs that reference them
#
# Run AFTER `railway config apply`, with the target project/environment linked
# (`railway link`). Safe to re-run: existing secrets/domains are left untouched.
#
# Usage: railway/railway-iac-bootstrap.sh [adt_deployment_token]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=railway/policy-version.sh
source "$here/policy-version.sh"

iac_tag="$(sed -nE 's/^const TAG = "(v[0-9]+\.[0-9]+\.[0-9]+)";.*/\1/p' "$here/../.railway/railway.ts")"
anyray_valid_release_tag "$iac_tag" || {
  echo "could not read a pinned vX.Y.Z from .railway/railway.ts" >&2
  exit 1
}

command -v railway >/dev/null || { echo "railway CLI not found (https://docs.railway.com/guides/cli)"; exit 1; }
command -v openssl >/dev/null || { echo "openssl required for secret generation"; exit 1; }
railway status >/dev/null 2>&1 || { echo "No linked project — run 'railway link' first."; exit 1; }

hex() { openssl rand -hex "$1"; }

future_policy_activation_at() {
  local value=""
  value="$(date -u -d '+1 hour' '+%Y-%m-%dT%H:%M:%S.000Z' 2>/dev/null)" || \
    value="$(date -u -v+1H '+%Y-%m-%dT%H:%M:%S.000Z' 2>/dev/null)" || true
  [ -n "$value" ] || {
    echo "could not calculate a future policy activation instant with date" >&2
    return 1
  }
  printf '%s' "$value"
}

# Read a service's current value for KEY ("" if unset).
getvar() { railway variables -s "$1" --kv 2>/dev/null | sed -n "s/^$2=//p"; }

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

# The activation value must reach a running gateway before its future instant;
# unlike secret seeding, deliberately trigger the gateway redeploy when added.
set_activation_if_empty() {
  local value="$1"
  if [ -z "$(getvar gateway ANYRAY_PERSISTENT_TRANSCRIPT_POLICY_ACTIVATE_AT)" ]; then
    railway variables -s gateway \
      --set "ANYRAY_PERSISTENT_TRANSCRIPT_POLICY_ACTIVATE_AT=$value" >/dev/null
    echo "  set gateway.ANYRAY_PERSISTENT_TRANSCRIPT_POLICY_ACTIVATE_AT (redeploying)"
  else
    echo "  keep gateway.ANYRAY_PERSISTENT_TRANSCRIPT_POLICY_ACTIVATE_AT (already set)"
  fi
}

echo "== seeding generated secrets =="
# Canonical secrets live on the gateway; optimizer references them via railway.ts.
set_if_empty gateway ANYRAY_ADMIN_TOKEN "$(hex 24)"
set_if_empty gateway ANYRAY_CONTENT_KEY "$(hex 32)"      # 32-byte AES-256-GCM key
set_if_empty gateway ANYRAY_OPTIMIZER_TOKEN "$(hex 24)"
set_if_empty gateway ANYRAY_PSEUDONYM_SALT "$(hex 16)"
if anyray_policy_enabled_for_tag "$iac_tag"; then
  set_activation_if_empty "$(future_policy_activation_at)"
else
  echo "  skip gateway.ANYRAY_PERSISTENT_TRANSCRIPT_POLICY_ACTIVATE_AT ($iac_tag predates $ANYRAY_PERSISTENT_TRANSCRIPT_POLICY_MIN_TAG)"
fi
set_if_empty proxy   ANYRAY_UPDATER_TOKEN "$(hex 16)"

# Metering deployment token (adt_…): from arg, else leave for the grace window.
if [ "${1:-}" != "" ]; then
  railway variables -s gateway --set "ANYRAY_DEPLOYMENT_TOKEN=$1" --skip-deploys >/dev/null
  echo "  set gateway.ANYRAY_DEPLOYMENT_TOKEN"
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
echo "Connect metering later with: railway/railway-iac-bootstrap.sh adt_your_token"
