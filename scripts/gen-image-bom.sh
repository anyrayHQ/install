#!/usr/bin/env bash
# Generate the image bill-of-materials (BOM) for the Anyray Helm chart — the exact
# set of container images a private-registry install must mirror. Redirecting
# image pulls does not make the deployment air-gapped: Billing connectivity is
# mandatory.
#
# It renders the chart with `helm template` and extracts every `image:` reference,
# so the list always matches what the chart actually deploys (no drift). When
# `crane` is on PATH it also resolves each tag to an immutable @sha256 digest, so
# the mirror is reproducible; otherwise it emits tag-pinned refs.
#
# Usage:
#   scripts/gen-image-bom.sh [helm-template-args...]           # print to stdout
#   scripts/gen-image-bom.sh > anyray-images.txt               # save a BOM file
#   scripts/gen-image-bom.sh --set image.tag=v1.10.87          # pass chart values
#
# Then mirror into your registry, e.g.:
#   while read -r img; do crane cp "$img" "my.registry:5000/${img#*/}"; done < anyray-images.txt
set -euo pipefail

chart_dir="$(cd "$(dirname "$0")/../helm" && pwd)"

# host= is required by the chart but irrelevant to the image set.
refs="$(
  helm template anyray "$chart_dir" --set host=mirror.invalid \
    "$@" \
    | grep -oE 'image:[[:space:]]*"?[^[:space:]"]+' \
    | sed -E 's/^image:[[:space:]]*"?//' \
    | sort -u
)"

if [ -z "${refs//[[:space:]]/}" ]; then
  echo "error: no images found in the rendered chart" >&2
  exit 1
fi

have_crane=0
command -v crane >/dev/null 2>&1 && have_crane=1 || \
  echo "note: crane not found — emitting tag-pinned refs (install crane for @sha256 digest pinning)" >&2

while IFS= read -r ref; do
  [ -n "$ref" ] || continue
  if [ "$have_crane" = 1 ]; then
    digest="$(crane digest "$ref" 2>/dev/null || true)"
    if [ -n "$digest" ]; then
      # name@sha256:… (immutable) — keep the tag in a trailing comment for humans.
      printf '%s@%s  # %s\n' "${ref%:*}" "$digest" "$ref"
      continue
    fi
    echo "warn: could not resolve digest for $ref — leaving tag-pinned" >&2
  fi
  printf '%s\n' "$ref"
done <<< "$refs"
