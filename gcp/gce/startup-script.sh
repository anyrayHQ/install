#!/usr/bin/env bash
# Anyray GCE one-click — VM bootstrap (runs as root on first boot).
#
# Brings up the full Anyray stack with docker compose on a single Compute Engine
# VM. Everything that must survive a VM rebuild — the install repo, the generated
# .env (admin token, content key, Postgres password, pseudonym salt), all Docker
# volumes (gateway/optimizer /data + Postgres) — lives on a dedicated *persistent*
# disk, exposed at the friendly path /opt/anyray via a symlink. So deleting and
# recreating the VM (keeping the data disk) resumes with provider keys, developer
# enrollments, and spend history intact and in sync.
#
# Inputs arrive as instance metadata set by deploy.sh. Logs to
# /var/log/anyray-startup.log. Writes <repo>/.ready on success so deploy.sh knows
# provisioning finished and can read back the admin key.
set -euo pipefail
exec >>/var/log/anyray-startup.log 2>&1
echo "=== anyray startup $(date -u +%FT%TZ) ==="

DATA_MNT=/mnt/anyray-data
DATA_DEV=/dev/disk/by-id/google-anyray-data
REPO_DIR="$DATA_MNT/anyray"   # repo + .env on the persistent disk…
LINK_DIR=/opt/anyray          # …surfaced at the friendly path via a symlink

md() { # md <metadata-path> [default]
  curl -fsS -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/$1" 2>/dev/null || printf '%s' "${2:-}"
}

# ---- 1. Persistent data disk (format only the first time ever) -------------
echo "→ Preparing the persistent data disk…"
mkdir -p "$DATA_MNT"
if ! blkid "$DATA_DEV" >/dev/null 2>&1; then
  echo "  formatting $DATA_DEV (first use)…"
  mkfs.ext4 -m 0 -F "$DATA_DEV"
fi
grep -q "$DATA_MNT" /etc/fstab || \
  echo "$DATA_DEV $DATA_MNT ext4 discard,defaults,nofail 0 2" >> /etc/fstab
mount -a
mkdir -p "$DATA_MNT/docker"
mkdir -p "$(dirname "$LINK_DIR")"
ln -sfn "$REPO_DIR" "$LINK_DIR"

# ---- 2. Docker, with its data-root on the persistent disk ------------------
# Written before Docker starts so every image + volume lands on the data disk.
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<JSON
{ "data-root": "$DATA_MNT/docker" }
JSON
export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null 2>&1; then
  echo "→ Installing prerequisites + Docker…"
  apt-get update -y
  apt-get install -y git openssl ca-certificates curl
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

# ---- 3. Resume path: an existing deployment is on the data disk -------------
# True on a reboot, or on a fresh VM that reattached a prior data disk. Secrets
# already match the data on disk, so just bring the stack up — never re-run setup.
if [ -f "$REPO_DIR/.env" ]; then
  echo "→ Existing deployment found on the data disk — starting it."
  ( cd "$REPO_DIR" && docker compose up -d )
  touch "$REPO_DIR/.ready"
  echo "=== anyray startup resumed $(date -u +%FT%TZ) ==="
  exit 0
fi

# ---- 4. First-time provisioning: clone + secrets + connect -----------------
DEPLOYMENT_TOKEN="$(md instance/attributes/anyray-deployment-token)"
IMAGE_TAG="$(md instance/attributes/anyray-image-tag latest)"
DEFAULT_MODEL="$(md instance/attributes/anyray-default-model anthropic/claude-sonnet-4-5)"
EXTERNAL_IP="$(md instance/network-interfaces/0/access-configs/0/external-ip)"
echo "→ external IP: ${EXTERNAL_IP}   image tag: ${IMAGE_TAG}"

echo "→ Fetching the Anyray install repo…"
[ -d "$REPO_DIR/.git" ] || git clone --depth 1 https://github.com/anyrayHQ/install "$REPO_DIR"
cd "$REPO_DIR"

echo "→ Generating secrets and connecting to Anyray Portal…"
# --host = the VM's public IP, so the gateway reports a reachable URL to the
# portal and the console/gateway URLs print correctly. Every real secret (admin
# token, content key, Postgres password, pseudonym salt) is generated HERE into
# .env on the persistent disk — it never travels through instance metadata.
if [ -n "$DEPLOYMENT_TOKEN" ]; then
  ./setup.sh --connect "$DEPLOYMENT_TOKEN" --host "$EXTERNAL_IP"
else
  echo "  ⚠ no deployment token in metadata — running without --connect (metering off)"
  ./setup.sh --host "$EXTERNAL_IP"
fi

# Pin the image tag + default model for compose's variable substitution. setup.sh
# doesn't manage these, and it never prunes lines, so appending is safe.
grep -q '^ANYRAY_IMAGE_TAG='   .env || echo "ANYRAY_IMAGE_TAG=${IMAGE_TAG}" >> .env
grep -q '^ANYRAY_DEFAULT_MODEL=' .env || echo "ANYRAY_DEFAULT_MODEL=${DEFAULT_MODEL}" >> .env

echo "→ Starting the stack…"
docker compose pull
docker compose up -d

touch "$REPO_DIR/.ready"
echo "=== anyray startup complete $(date -u +%FT%TZ) ==="
