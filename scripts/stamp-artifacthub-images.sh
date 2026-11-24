#!/usr/bin/env bash

# Write the chart's artifacthub.io/images annotation from a default render.
#
# Artifact Hub finds a chart's images (and runs its Trivy scan on them) by
# rendering the chart with its default values. Since chart 0.5.45 that render
# fails on purpose: postgres.storage defaults below the retention floor, so a
# fresh install has to size its volume (anyray.validatePostgresStorage). With
# no images found, Artifact Hub listed none and scanned nothing for every chart
# from 0.5.45 on. It reads this annotation instead of rendering when present.
#
# The render acknowledges the small volume, which changes no image, so the list
# is exactly what a default install deploys. The prod promotion runs this after
# it pins appVersion; helm-chart.yml runs --check so the list cannot go stale.
#
# usage: stamp-artifacthub-images.sh [--check] [chart-dir]
set -euo pipefail

check=0
if [ "${1:-}" = "--check" ]; then
  check=1
  shift
fi
chart="${1:-helm}"
chart_yaml="${chart}/Chart.yaml"
helm_bin="${HELM:-helm}"

if [ ! -f "$chart_yaml" ]; then
  echo "Helm chart not found: ${chart_yaml}" >&2
  exit 2
fi

render="$("$helm_bin" template anyray "$chart" --set postgres.acknowledgeSmallVolume=true)" || {
  echo "could not render ${chart} with default values; artifacthub.io/images not written" >&2
  exit 1
}

mapfile -t images < <(
  printf '%s\n' "$render" |
    sed -nE 's/^[[:space:]]*-?[[:space:]]*image:[[:space:]]*"?([^"[:space:]]+)"?.*$/\1/p' |
    sort -u
)
if [ "${#images[@]}" -eq 0 ]; then
  echo "the default render of ${chart} has no images; artifacthub.io/images not written" >&2
  exit 1
fi

block="  artifacthub.io/images: |"$'\n'
for image in "${images[@]}"; do
  ref="${image%%@*}"
  repo="${ref##*/}"
  name="${repo%%:*}"
  block+="    - name: ${name}"$'\n'"      image: ${image}"$'\n'
done

tmp="$(mktemp "${chart_yaml}.tmp.XXXXXX")"
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT

# Replace the existing block in place, or add it at the end of the top-level
# annotations map. The block's own lines are the ones indented past the key.
BLOCK="$block" awk '
  function emit() {
    if (!done) { printf "%s", ENVIRON["BLOCK"]; done = 1 }
  }
  /^annotations:[[:space:]]*$/ { in_annotations = 1; print; next }
  in_annotations && /^  artifacthub\.io\/images:/ { replacing = 1; next }
  replacing && /^    / { next }
  replacing { replacing = 0; emit() }
  in_annotations && /^[^[:space:]#]/ { emit(); in_annotations = 0 }
  { print }
  END {
    if (in_annotations || replacing) emit()
    if (!done) exit 42
  }
' "$chart_yaml" > "$tmp" || {
  echo "no top-level annotations map in ${chart_yaml}" >&2
  exit 1
}

if [ "$check" -eq 1 ]; then
  if ! cmp -s "$chart_yaml" "$tmp"; then
    diff -u "$chart_yaml" "$tmp" >&2 || true
    echo "artifacthub.io/images in ${chart_yaml} does not match the default render; run scripts/stamp-artifacthub-images.sh" >&2
    exit 1
  fi
  echo "artifacthub.io/images matches the default render (${#images[@]} images)"
  exit 0
fi

if cmp -s "$chart_yaml" "$tmp"; then
  echo "artifacthub.io/images already current (${#images[@]} images)"
  exit 0
fi
chmod 0644 "$tmp"
mv "$tmp" "$chart_yaml"
echo "artifacthub.io/images: stamped ${#images[@]} images"
