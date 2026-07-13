#!/usr/bin/env bash
# Fail if the PUBLISHED Helm channel (charts.anyray.ai) has fallen behind the
# chart pinned in helm/Chart.yaml — the source of truth this repo ships.
#
# Why this exists: the anyray chart is published to two channels — the OCI
# registry (oci://public.ecr.aws/anyray/anyray) and the classic HTTP repo
# charts.anyray.ai (the Artifact Hub listing). Both are published by the
# MONOREPO — publish-chart.yml (standalone) and deploy-prod.yml's publish step —
# which read THIS repo's helm/Chart.yaml. So the publish is not gated in this
# repo at all: a Chart.yaml bump can land here (a manual sync, or a promotion
# whose mirror step failed) with no corresponding publish, and then
# `helm repo add anyray https://charts.anyray.ai` + `helm upgrade` users and the
# Artifact Hub card silently keep getting the older release. That is exactly what
# happened — the channel served 0.4.51 / v1.10.107 while the repo pinned
# 0.4.52 / v1.10.108.
#
# This is the alarm for that class. It reads only the public index.yaml and this
# file — no credentials — and does NOT publish (it can't from here): on drift it
# prints the exact repair (dispatch the monorepo publish-chart workflow).
#
# charts.anyray.ai is the TRAILING channel: the mirror step re-runs whenever the
# HTTP repo is missing a version the OCI push already has, so if the HTTP repo is
# current the OCI registry is too. Checking it alone catches every "channel
# behind repo" case.
#
# Tolerates being at most DRIFT_MAX_LAG (default 0) chart-patch versions behind,
# for the brief window a publish is in flight; raise it for a quieter alarm.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART="$HERE/Chart.yaml"
INDEX_URL="${HELM_INDEX_URL:-https://charts.anyray.ai/index.yaml}"
MAX_LAG="${DRIFT_MAX_LAG:-0}"

[ -f "$CHART" ] || { echo "::error::missing $CHART"; exit 2; }

field() { sed -nE "s/^$1:[[:space:]]*\"?([^\"[:space:]]+)\"?.*/\1/p" "$CHART" | head -1; }
want_ver="$(field version)"
want_app="$(field appVersion)"
[ -n "$want_ver" ] || { echo "::error::could not read version from $CHART"; exit 2; }

idx="$(curl -fsSL "$INDEX_URL")" || { echo "::error::could not fetch $INDEX_URL"; exit 2; }
# Newest published chart version = highest semver under entries[].version. Sort
# rather than trust file order, so the check is robust to index regeneration.
pub_ver="$(printf '%s\n' "$idx" \
  | sed -nE 's/^[[:space:]]*version:[[:space:]]*([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' \
  | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"
# appVersion is display-only (the vX.Y.Z product tag users recognize); file order
# is newest-first, so head -1 is the newest entry's appVersion.
pub_app="$(printf '%s\n' "$idx" \
  | sed -nE 's/^[[:space:]]*appVersion:[[:space:]]*"?(v[0-9]+\.[0-9]+\.[0-9]+)"?.*/\1/p' \
  | head -1)"
[ -n "$pub_ver" ] || { echo "::error::no chart version found in published index $INDEX_URL"; exit 2; }

echo "repo    helm/Chart.yaml : version $want_ver  (appVersion ${want_app:-?})"
echo "channel charts.anyray.ai: version $pub_ver  (appVersion ${pub_app:-?})"

ver_ge() { # is $1 >= $2 ? (numeric semver compare on X.Y.Z)
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)" = "$1" ]
}
patch_lag() { # chart-patch distance $1 - $2 when same major.minor, else -1
  [ "${1%.*}" = "${2%.*}" ] || { echo -1; return; }
  echo $(( ${1##*.} - ${2##*.} ))
}

if ver_ge "$pub_ver" "$want_ver"; then
  echo "Published Helm channel is current (>= repo pin)."
  exit 0
fi

lag="$(patch_lag "$want_ver" "$pub_ver")"
if [ "$lag" -ge 0 ] && [ "$lag" -le "$MAX_LAG" ]; then
  echo "::notice::channel lagging $lag chart-patch(es) (<= $MAX_LAG, tolerated) — a publish is likely in flight"
  exit 0
fi

echo "::error::DRIFT: charts.anyray.ai serves anyray-$pub_ver (appVersion ${pub_app:-?}) but this repo pins $want_ver (appVersion ${want_app:-?})"
cat >&2 <<EOF

The published Helm channel has fallen behind helm/Chart.yaml. It is published by
the MONOREPO, not this repo, so repair it there:

  anyrayHQ/monorepo -> Actions -> "Publish Helm chart (standalone)" -> Run workflow
    (publish-chart.yml — reads anyrayHQ/install@main helm/Chart.yaml, pushes to the
     OCI registry + mirrors to charts.anyray.ai). It also self-heals on the next
     prod promotion (deploy-prod.yml).

Then verify:
  curl -s $INDEX_URL | grep -m1 -E 'version:|appVersion:'   # expect $want_ver / ${want_app:-?}
EOF
exit 1
