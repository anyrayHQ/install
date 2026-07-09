#!/usr/bin/env bash
# Fail if the PUBLISHED Railway "anyray" template's service images have drifted
# from the pinned refs in railway/railway.template.json (the source of truth).
#
# Why this exists: Railway's template API can *read* a published template's
# serializedConfig but cannot *write* it — `templatePublish` accepts only
# metadata, and `templateGenerate` mints a NEW template code (which would break
# the stable `railway deploy -t anyray` link). So the one-click template's images
# can only be changed by hand in the dashboard. That manual step silently lagged
# once (fresh installs shipped v1.10.30 while releases were on v1.10.83, because
# the template still pinned ghcr :stable). This check is the alarm for that class.
#
# It fires only on MATERIAL drift — wrong registry/image, or a full minor/major
# version behind, or more than DRIFT_MAX_PATCH_LAG (default 5) patches behind. A
# one-release patch lag is EXPECTED (the manual template always trails the
# CI-bumped repo) and is tolerated, so the alarm isn't red after every release.
#
# It does NOT fix drift (can't, via API) — on failure it prints the exact
# dashboard edit to make (or use the always-current IaC path, railway/IAC.md).
#
# Needs RAILWAY_TOKEN (a Railway API token with read access to the template).
set -euo pipefail

TEMPLATE_CODE="${TEMPLATE_CODE:-anyray}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_TEMPLATE="$HERE/railway.template.json"
API="${RAILWAY_API:-https://backboard.railway.com/graphql/v2}"
# Only the Anyray-owned services are pinned by us; Postgres tracks upstream.
SERVICES=(gateway optimizer proxy)

: "${RAILWAY_TOKEN:?RAILWAY_TOKEN (Railway API token) is required}"
[ -f "$REPO_TEMPLATE" ] || { echo "::error::missing $REPO_TEMPLATE"; exit 2; }

query='query($c:String!){ template(code:$c){ serializedConfig } }'
body="$(jq -n --arg q "$query" --arg c "$TEMPLATE_CODE" '{query:$q,variables:{c:$c}}')"
resp="$(curl -sS --fail-with-body -X POST "$API" \
  -H "Authorization: Bearer $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$body")" || { echo "::error::Railway API request failed: $resp"; exit 2; }

if jq -e '.errors' >/dev/null 2>&1 <<<"$resp"; then
  echo "::error::Railway API error: $(jq -c '.errors' <<<"$resp")"; exit 2
fi

# serializedConfig.services is keyed by service id; each node has .name + .source.image
live="$(jq -r '.data.template.serializedConfig.services // {} | to_entries[]
  | "\(.value.name)\t\(.value.source.image // "")"' <<<"$resp")"
want="$(jq -r '.services[] | "\(.name)\t\(.source.image // "")"' "$REPO_TEMPLATE")"

img() { awk -F'\t' -v s="$1" '$1==s{print $2}' <<<"$2"; }
repo_of() { printf '%s' "${1%:*}"; }   # registry/name (before the last ':')
ver_of()  { printf '%s' "${1##*:}"; }  # tag (after the last ':')
# Parse "vX.Y.Z" -> "X Y Z" (empty if not semver).
semver() { local v="${1#v}"; [[ "$v" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] && echo "${BASH_REMATCH[1]} ${BASH_REMATCH[2]} ${BASH_REMATCH[3]}"; }

# The manual template ALWAYS lags the CI-bumped repo by a release or two (the marketplace
# template can only be edited by hand). An exact-match check is therefore red after every
# release — noise. Fail only on MATERIAL drift — the "shipped v1.10.30 for weeks" class —
# and tolerate a small patch lag. DRIFT_MAX_PATCH_LAG tunes the window.
MAX_LAG="${DRIFT_MAX_PATCH_LAG:-5}"
drift=0
for svc in "${SERVICES[@]}"; do
  l="$(img "$svc" "$live")"; w="$(img "$svc" "$want")"
  if [ -z "$w" ]; then echo "::warning::$svc not found in repo template — skipping"; continue; fi
  if [ -z "$l" ]; then echo "::error::DRIFT $svc: live image missing; expected '$w'"; drift=1; continue; fi
  if [ "$l" = "$w" ]; then echo "ok     $svc = $l"; continue; fi

  # Registry or image name changed = structural drift (e.g. abandoned ghcr :stable). Always fail.
  if [ "$(repo_of "$l")" != "$(repo_of "$w")" ]; then
    echo "::error::DRIFT $svc: wrong registry/image — live='$l' expected='$w'"; drift=1; continue
  fi
  read -r lM lm lp <<<"$(semver "$(ver_of "$l")")"
  read -r wM wm wp <<<"$(semver "$(ver_of "$w")")"
  if [ -z "$lM" ] || [ -z "$wM" ]; then
    echo "::error::DRIFT $svc: non-semver tag — live='$(ver_of "$l")' expected='$(ver_of "$w")'"; drift=1; continue
  fi
  if [ "$lM" -lt "$wM" ] || { [ "$lM" -eq "$wM" ] && [ "$lm" -lt "$wm" ]; }; then
    echo "::error::DRIFT $svc: a minor/major version behind — live='$l' expected='$w'"; drift=1; continue
  fi
  if [ "$lM" -gt "$wM" ] || { [ "$lM" -eq "$wM" ] && [ "$lm" -gt "$wm" ]; } || [ "$lp" -ge "$wp" ]; then
    echo "ok     $svc = $l (>= expected $w)"; continue   # ahead of, or same minor as, the repo
  fi
  lag=$(( wp - lp ))
  if [ "$lag" -gt "$MAX_LAG" ]; then
    echo "::error::DRIFT $svc: $lag patch versions behind (> $MAX_LAG) — live='$l' expected='$w'"; drift=1
  else
    echo "::notice::$svc lagging $lag patch(es) (<= $MAX_LAG, tolerated) — live='$l' expected='$w'"
  fi
done

if [ "$drift" -ne 0 ]; then
  cat >&2 <<'EOF'

The published Railway "anyray" template has drifted MATERIALLY from railway.template.json
(wrong registry, or a full version / many patches behind — not the normal one-release lag).
Railway's API cannot patch a template's images (dashboard-only), so fix it by hand:

  railway.com -> Workspace -> Templates -> Anyray -> Edit
    for each drifted service: Source -> Image -> set to the "expected" value above
  -> Update Template

Or steer installs to the always-current IaC path (railway config apply — see railway/IAC.md).
EOF
  exit 1
fi
echo "Published template is current (within the tolerated patch lag)."
