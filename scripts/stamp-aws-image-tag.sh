#!/usr/bin/env bash

# Stamp only Parameters.ImageTag.Default in the AWS Quick Launch template.
# Capability metadata, rollout rules, and health semantics belong to the
# template revision and must remain byte-stable across nightly image bumps.
set -euo pipefail

version="${1:?usage: stamp-aws-image-tag.sh vX.Y.Z [template]}"
template="${2:-aws/anyray-quicklaunch.template.yaml}"

if [[ ! "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "invalid immutable image tag: ${version}" >&2
  exit 2
fi
if [ ! -f "$template" ]; then
  echo "CloudFormation template not found: ${template}" >&2
  exit 2
fi

current="$(awk '
  /^  ImageTag:$/ { in_image_tag = 1; next }
  in_image_tag && /^    Default:/ { print $2; exit }
  in_image_tag && /^  [A-Za-z][A-Za-z0-9]*:/ { exit }
' "$template")"
if [[ ! "$current" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ImageTag.Default is not an immutable release tag in ${template}: ${current:-missing}" >&2
  exit 1
fi
if [ "$current" = "$version" ]; then
  echo "AWS Quick Launch image tag already ${version}"
  exit 0
fi

tmp="$(mktemp "${template}.tmp.XXXXXX")"
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT

awk -v version="$version" '
  /^  ImageTag:$/ {
    in_image_tag = 1
    print
    next
  }
  in_image_tag && /^    Default:/ {
    print "    Default: " version
    changed++
    next
  }
  in_image_tag && /^  [A-Za-z][A-Za-z0-9]*:/ { in_image_tag = 0 }
  { print }
  END {
    if (changed != 1) exit 42
  }
' "$template" > "$tmp" || {
  echo "could not locate exactly one ImageTag.Default in ${template}" >&2
  exit 1
}

chmod 0644 "$tmp"
mv "$tmp" "$template"
trap - EXIT
echo "AWS Quick Launch image tag: ${current} -> ${version}"
