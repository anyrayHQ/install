#!/usr/bin/env bash

# A capability-aware install revision must never publish against legacy image
# pins. Read the immutable Railway defaults, then inspect only each remote image
# config (no layers) for the runtime label emitted by the matching monorepo
# capability marker.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
template="$root/railway/railway.template.json"
label='ai.anyray.capability.persistent-transcript-policy-v1'

command -v crane >/dev/null || { echo "error: crane is required" >&2; exit 2; }
command -v jq >/dev/null || { echo "error: jq is required" >&2; exit 2; }
[ -s "$root/compatibility/persistentTranscriptPolicyV1" ] || {
  echo "error: install capability marker is missing" >&2
  exit 1
}

expected_tag=""
for service in gateway optimizer; do
  image="$(jq -er --arg service "$service" \
    '.services[] | select(.name == $service) | .source.image' "$template")"
  if [[ ! "$image" =~ :v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "error: $service image is not pinned to an immutable vX.Y.Z tag: $image" >&2
    exit 1
  fi
  tag="${image##*:}"
  if [ -n "$expected_tag" ] && [ "$tag" != "$expected_tag" ]; then
    echo "error: gateway and optimizer capability pins differ ($expected_tag != $tag)" >&2
    exit 1
  fi
  expected_tag="$tag"

  config="$(crane config --platform linux/amd64 "$image")" || {
    echo "error: could not read $service image config for $tag" >&2
    exit 1
  }
  jq -e --arg label "$label" '.config.Labels[$label] == "true"' \
    <<<"$config" >/dev/null || {
      echo "error: $service image $tag does not declare $label=true" >&2
      exit 1
    }
done

echo "OK: gateway and optimizer $expected_tag declare $label=true."
