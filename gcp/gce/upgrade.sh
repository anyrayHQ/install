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

capability_label='ai.anyray.capability.persistent-transcript-policy-v1'

resolve_service_image() {
  local service="$1"
  local config image

  config="$(ANYRAY_IMAGE_TAG="$target" docker compose config "$service")" || {
    echo "error: could not resolve the $service image for $target" >&2
    return 1
  }
  image="$(awk -v service="$service" '
    $0 == "  " service ":" { in_service = 1; next }
    in_service && /^  [^ ]/ { exit }
    in_service && /^    image: / {
      sub(/^    image: /, "")
      print
      exit
    }
  ' <<<"$config")"
  [ -n "$image" ] || {
    echo "error: compose did not resolve an image for $service" >&2
    return 1
  }
  printf '%s\n' "$image"
}

verify_capability() {
  local service="$1"
  local image="$2"
  local label_value

  echo "Verifying $service image capability ($image)..."
  label_value="$(docker image inspect \
    --format "{{ index .Config.Labels \"$capability_label\" }}" "$image" 2>/dev/null)" || {
    echo "error: could not inspect $service image $image" >&2
    return 1
  }
  [ "$label_value" = true ] || {
    echo "error: $service image $image does not declare $capability_label=true" >&2
    return 1
  }
}

cd "$root"
ANYRAY_IMAGE_TAG="$target" docker compose config -q
gateway_image="$(resolve_service_image gateway)"
optimizer_image="$(resolve_service_image optimizer)"
ANYRAY_IMAGE_TAG="$target" docker compose pull
verify_capability gateway "$gateway_image"
verify_capability optimizer "$optimizer_image"

if grep -q '^ANYRAY_IMAGE_TAG=' "$env_file"; then
  sed -i.bak -E "s/^ANYRAY_IMAGE_TAG=.*/ANYRAY_IMAGE_TAG=${target}/" "$env_file"
  rm -f "$env_file.bak"
else
  printf 'ANYRAY_IMAGE_TAG=%s\n' "$target" >> "$env_file"
fi

ANYRAY_IMAGE_TAG="$target" docker compose up --pull never -d
echo "Anyray GCE install reconciled to ${target}."
