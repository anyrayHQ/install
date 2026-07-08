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
# the template still pinned ghcr :stable). This check is the alarm: it turns a
# silent, customer-discovered drift into a red CI run within a day of a release.
#
# It does NOT fix drift (can't, via API) — on failure it prints the exact
# dashboard edit to make.
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

drift=0
for svc in "${SERVICES[@]}"; do
  l="$(img "$svc" "$live")"; w="$(img "$svc" "$want")"
  if [ -z "$w" ]; then echo "::warning::$svc not found in repo template — skipping"; continue; fi
  if [ "$l" != "$w" ]; then
    echo "::error::DRIFT $svc: live='${l:-<missing>}' expected='$w'"
    drift=1
  else
    echo "ok  $svc = $l"
  fi
done

if [ "$drift" -ne 0 ]; then
  cat >&2 <<'EOF'

The published Railway "anyray" template is out of sync with railway.template.json.
Railway's API cannot patch a template's images (dashboard-only), so fix it by hand:

  railway.com -> Workspace -> Templates -> Anyray -> Edit
    for each drifted service: Source -> Image -> set to the "expected" value above
  -> Update Template

Then re-run this check (workflow_dispatch) or `railway/publish-template.sh test`.
EOF
  exit 1
fi
echo "Published template matches repo pins."
