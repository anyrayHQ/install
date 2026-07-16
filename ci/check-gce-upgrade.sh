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
DOCKER
chmod +x "$tmp/bin/docker" "$tmp/install/gcp/gce/upgrade.sh"

: > "$tmp/docker.log"
PATH="$tmp/bin:$PATH" DOCKER_LOG="$tmp/docker.log" \
  "$tmp/install/gcp/gce/upgrade.sh" >/dev/null
grep -qx 'ANYRAY_ADMIN_TOKEN=preserve-me' "$tmp/install/.env"
grep -qx 'ANYRAY_IMAGE_TAG=v1.2.3' "$tmp/install/.env"
grep -qx 'compose config -q' "$tmp/docker.log"
grep -qx 'compose pull' "$tmp/docker.log"
grep -qx 'compose up --pull never -d' "$tmp/docker.log"

sed -i.bak 's/v1.2.3/policy-stable/' "$tmp/install/docker-compose.yml"
rm -f "$tmp/install/docker-compose.yml.bak"
: > "$tmp/docker.log"
PATH="$tmp/bin:$PATH" DOCKER_LOG="$tmp/docker.log" \
  "$tmp/install/gcp/gce/upgrade.sh" >/dev/null
grep -qx 'ANYRAY_IMAGE_TAG=policy-stable' "$tmp/install/.env"
grep -qx 'compose up --pull never -d' "$tmp/docker.log"

: > "$tmp/docker.log"
PATH="$tmp/bin:$PATH" DOCKER_LOG="$tmp/docker.log" \
  "$tmp/install/gcp/gce/upgrade.sh" v2.0.0 >/dev/null
grep -qx 'ANYRAY_IMAGE_TAG=v2.0.0' "$tmp/install/.env"
grep -qx 'compose up --pull never -d' "$tmp/docker.log"

before="$(cat "$tmp/install/.env")"
: > "$tmp/docker.log"
if PATH="$tmp/bin:$PATH" DOCKER_LOG="$tmp/docker.log" \
  "$tmp/install/gcp/gce/upgrade.sh" latest >/dev/null 2>&1; then
  echo 'legacy moving channel unexpectedly accepted' >&2
  exit 1
fi
[ "$(cat "$tmp/install/.env")" = "$before" ]
[ ! -s "$tmp/docker.log" ]

echo 'OK: GCE reconciliation preserves the .env and accepts only supported tags.'
