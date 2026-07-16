#!/usr/bin/env bash
# Reconcile an existing GCE install with the checked-out template release.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="$root/.env"
compose_file="$root/docker-compose.yml"

[ -f "$env_file" ] || { echo "error: $env_file is missing" >&2; exit 1; }
[ -f "$compose_file" ] || { echo "error: $compose_file is missing" >&2; exit 1; }

template_tag="$(sed -nE 's#.*ANYRAY_IMAGE_TAG:-(v[0-9]+\.[0-9]+\.[0-9]+|policy-stable)\}.*#\1#p' \
  "$compose_file" | head -1)"
target="${1:-$template_tag}"
[[ "$target" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ || "$target" = policy-stable ]] || {
  echo "error: target must be policy-stable or an immutable vX.Y.Z tag" >&2
  exit 2
}

cd "$root"
ANYRAY_IMAGE_TAG="$target" docker compose config -q
ANYRAY_IMAGE_TAG="$target" docker compose pull

if grep -q '^ANYRAY_IMAGE_TAG=' "$env_file"; then
  sed -i.bak -E "s/^ANYRAY_IMAGE_TAG=.*/ANYRAY_IMAGE_TAG=${target}/" "$env_file"
  rm -f "$env_file.bak"
else
  printf 'ANYRAY_IMAGE_TAG=%s\n' "$target" >> "$env_file"
fi

ANYRAY_IMAGE_TAG="$target" docker compose up --pull never -d
echo "Anyray GCE install reconciled to ${target}."
