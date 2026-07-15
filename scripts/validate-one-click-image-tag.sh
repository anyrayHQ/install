#!/usr/bin/env bash

# GKE/AKS one-click deploys may use only the chart's audited image set or the
# capability-compatible moving channel. Other immutable tags need the manual
# Helm flow, where the operator verifies both runtime OCI capability labels.
set -euo pipefail

requested="${1:?usage: validate-one-click-image-tag.sh IMAGE_TAG [Chart.yaml]}"
chart="${2:-helm/Chart.yaml}"

[ -f "$chart" ] || {
  echo "error: Helm chart not found: $chart" >&2
  exit 2
}

app_version="$(sed -nE 's/^appVersion:[[:space:]]*"?([^"[:space:]]+)"?.*/\1/p' "$chart" | head -1)"
if [[ ! "$app_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: Helm chart appVersion is not an immutable vX.Y.Z tag: ${app_version:-missing}" >&2
  exit 2
fi

if [ "$requested" = "$app_version" ] || [ "$requested" = policy-stable ]; then
  exit 0
fi
if [[ "$requested" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: IMAGE_TAG=$requested is not accepted by the one-click Kubernetes deploy; use $app_version or policy-stable. For another immutable release, use the documented manual Helm flow after verifying both gateway and optimizer OCI capability labels." >&2
  exit 1
fi
echo "error: IMAGE_TAG must be $app_version or policy-stable; latest, stable, and malformed tags are not supported." >&2
exit 1
