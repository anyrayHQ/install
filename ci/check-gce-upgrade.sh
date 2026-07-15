#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/install/gcp/gce" "$tmp/bin"
cp "$root/gcp/gce/upgrade.sh" "$tmp/install/gcp/gce/upgrade.sh"
printf '%s\n' \
  'ANYRAY_ADMIN_TOKEN=preserve-me' \
  'ANYRAY_IMAGE_TAG=v1.0.0' > "$tmp/install/.env"
printf '%s\n' \
  'services:' \
  '  gateway:' \
  '    image: "public.ecr.aws/anyray/gateway:${ANYRAY_IMAGE_TAG:-v1.2.3}"' \
  > "$tmp/install/docker-compose.yml"
cat > "$tmp/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${DOCKER_LOG:?}"

if [ "$1" = compose ] && [ "$2" = config ] && [ "${3:-}" = -q ]; then
  exit 0
fi
if [ "$1" = compose ] && [ "$2" = config ]; then
  service="${3:?service is required}"
  printf '%s\n' \
    'services:' \
    "  ${service}:" \
    "    image: public.ecr.aws/anyray/${service}:${ANYRAY_IMAGE_TAG:?}"
  exit 0
fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  image="${*: -1}"
  case "$image" in
    */gateway:*) printf '%s\n' "${GATEWAY_CAPABILITY:-true}" ;;
    */optimizer:*) printf '%s\n' "${OPTIMIZER_CAPABILITY:-true}" ;;
    *) exit 1 ;;
  esac
fi
DOCKER
chmod +x "$tmp/bin/docker" "$tmp/install/gcp/gce/upgrade.sh"

: > "$tmp/docker.log"
PATH="$tmp/bin:$PATH" DOCKER_LOG="$tmp/docker.log" \
  "$tmp/install/gcp/gce/upgrade.sh" >/dev/null
grep -qx 'ANYRAY_ADMIN_TOKEN=preserve-me' "$tmp/install/.env"
grep -qx 'ANYRAY_IMAGE_TAG=v1.2.3' "$tmp/install/.env"
grep -qx 'compose config -q' "$tmp/docker.log"
grep -qx 'compose config gateway' "$tmp/docker.log"
grep -qx 'compose config optimizer' "$tmp/docker.log"
grep -q 'image inspect .* public.ecr.aws/anyray/gateway:v1.2.3$' "$tmp/docker.log"
grep -q 'image inspect .* public.ecr.aws/anyray/optimizer:v1.2.3$' "$tmp/docker.log"
grep -qx 'compose pull' "$tmp/docker.log"
grep -qx 'compose up --pull never -d' "$tmp/docker.log"

sed -i.bak 's/v1.2.3/policy-stable/' "$tmp/install/docker-compose.yml"
rm -f "$tmp/install/docker-compose.yml.bak"
: > "$tmp/docker.log"
PATH="$tmp/bin:$PATH" DOCKER_LOG="$tmp/docker.log" \
  "$tmp/install/gcp/gce/upgrade.sh" >/dev/null
grep -qx 'ANYRAY_IMAGE_TAG=policy-stable' "$tmp/install/.env"
grep -q 'image inspect .* public.ecr.aws/anyray/gateway:policy-stable$' "$tmp/docker.log"
grep -q 'image inspect .* public.ecr.aws/anyray/optimizer:policy-stable$' "$tmp/docker.log"
grep -qx 'compose up --pull never -d' "$tmp/docker.log"

: > "$tmp/docker.log"
PATH="$tmp/bin:$PATH" DOCKER_LOG="$tmp/docker.log" \
  "$tmp/install/gcp/gce/upgrade.sh" v2.0.0 >/dev/null
grep -qx 'ANYRAY_IMAGE_TAG=v2.0.0' "$tmp/install/.env"
grep -q 'image inspect .* public.ecr.aws/anyray/gateway:v2.0.0$' "$tmp/docker.log"
grep -q 'image inspect .* public.ecr.aws/anyray/optimizer:v2.0.0$' "$tmp/docker.log"

before="$(cat "$tmp/install/.env")"
: > "$tmp/docker.log"
if PATH="$tmp/bin:$PATH" DOCKER_LOG="$tmp/docker.log" \
  OPTIMIZER_CAPABILITY=false \
  "$tmp/install/gcp/gce/upgrade.sh" v1.0.0 >/dev/null 2>&1; then
  echo 'legacy immutable image unexpectedly accepted' >&2
  exit 1
fi
[ "$(cat "$tmp/install/.env")" = "$before" ]
grep -qx 'compose pull' "$tmp/docker.log"
grep -q 'image inspect .* public.ecr.aws/anyray/gateway:v1.0.0$' "$tmp/docker.log"
grep -q 'image inspect .* public.ecr.aws/anyray/optimizer:v1.0.0$' "$tmp/docker.log"
! grep -q '^compose up ' "$tmp/docker.log"

: > "$tmp/docker.log"
if PATH="$tmp/bin:$PATH" DOCKER_LOG="$tmp/docker.log" \
  "$tmp/install/gcp/gce/upgrade.sh" latest >/dev/null 2>&1; then
  echo 'legacy moving channel unexpectedly accepted' >&2
  exit 1
fi
[ "$(cat "$tmp/install/.env")" = "$before" ]
[ ! -s "$tmp/docker.log" ]

echo 'OK: GCE reconciliation verifies both runtime capabilities before changing the install.'
