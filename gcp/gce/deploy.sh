#!/usr/bin/env bash
# Anyray one-click deploy on a Google Compute Engine VM.
#
# Stands up the full Anyray stack (gateway + optimizer + console + Postgres) with
# docker compose on ONE Compute Engine VM, with all container state on a
# dedicated persistent disk. The lightweight, single-box counterpart to the GKE
# Autopilot one-click (gcp/deploy.sh): no Kubernetes, no managed database, no
# load balancer — cheapest way to run Anyray managed on Google Cloud.
#
# Why a VM and not Cloud Run: the gateway keeps provider keys and developer
# enrollments as files on a persistent /data volume and runs as a single
# instance, so it wants durable local disk, not an ephemeral serverless FS.
#
# Designed to run in Cloud Shell (gcloud is preinstalled) via the "Open in Cloud
# Shell" button, but works from any machine with the gcloud SDK authenticated to
# your project.
#
# Inputs come from the environment (the Cloud Shell walkthrough sets them) and
# fall back to an interactive prompt:
#   PROJECT_ID        GCP project (default: gcloud's active project)
#   ZONE              VM zone (default: us-central1-a)
#   INSTANCE          VM name (default: anyray)
#   MACHINE_TYPE      VM size (default: e2-standard-2 — 2 vCPU / 8 GB)
#   DISK_SIZE         Persistent data-disk size (default: 20GB)
#   ALLOWED_CIDR      CIDR allowed to reach the console/gateway. REQUIRED.
#                     Scope to your office/VPN range — never 0.0.0.0/0.
#   DEPLOYMENT_TOKEN  Anyray Cloud deployment token (adt_...). REQUIRED for metering.
#   IMAGE_TAG         Anyray image tag (default: latest)
#   DEFAULT_MODEL     anyray-default routing target (default: anthropic/claude-sonnet-4-5)
#   NETWORK           VPC network (default: default)
#
# Content stays encrypted at rest (ANYRAY_CONTENT_MODE=encrypted); only metadata
# is logged. The admin token, content key, Postgres password, and pseudonym salt
# are generated on the VM and never leave it. Only the adt_ deployment token (a
# metering credential, not an admin key) is passed via instance metadata.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

# ---- Defaults / inputs ------------------------------------------------------
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
ZONE="${ZONE:-us-central1-a}"
INSTANCE="${INSTANCE:-anyray}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-standard-2}"
DISK_SIZE="${DISK_SIZE:-20GB}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
DEFAULT_MODEL="${DEFAULT_MODEL:-anthropic/claude-sonnet-4-5}"
NETWORK="${NETWORK:-default}"
ALLOWED_CIDR="${ALLOWED_CIDR:-}"
DEPLOYMENT_TOKEN="${DEPLOYMENT_TOKEN:-}"
TAG=anyray
IAP_CIDR="35.235.240.0/20"   # Google IAP TCP-forwarding range — the only SSH source

prompt() { # prompt VAR "message"
  local var="$1" msg="$2" val
  eval "val=\${$var:-}"
  if [ -z "$val" ] && [ -t 0 ]; then
    read -r -p "$msg" val
    eval "$var=\$val"
  fi
}

prompt PROJECT_ID      "GCP project id: "
prompt ALLOWED_CIDR    "CIDR allowed to reach the console/gateway (e.g. 203.0.113.0/24): "
prompt DEPLOYMENT_TOKEN "Anyray deployment token (adt_...): "

# ---- Validate ---------------------------------------------------------------
die() { echo "✗ $*" >&2; exit 1; }

[ -n "$PROJECT_ID" ]   || die "PROJECT_ID is required (gcloud config set project <id>)."
[ -n "$ALLOWED_CIDR" ] || die "ALLOWED_CIDR is required — scope it to your office/VPN range."
[ "$ALLOWED_CIDR" != "0.0.0.0/0" ] || die "ALLOWED_CIDR must not be 0.0.0.0/0 — the console and gateway carry spend data and admin access."
echo "$ALLOWED_CIDR" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$' \
  || die "ALLOWED_CIDR must be a CIDR like 203.0.113.0/24."
echo "$DEPLOYMENT_TOKEN" | grep -Eq '^adt_[A-Za-z0-9_-]+$' \
  || die "DEPLOYMENT_TOKEN must look like adt_... — get one at https://app.anyray.ai (Deployments → Connect a deployment)."
[ -f "$HERE/startup-script.sh" ] || die "startup-script.sh not found next to deploy.sh."

command -v gcloud >/dev/null 2>&1 || die "gcloud not found on PATH (Cloud Shell has it preinstalled)."

echo "→ Project: $PROJECT_ID   Zone: $ZONE   Instance: $INSTANCE   Machine: $MACHINE_TYPE"

# ---- 1. APIs ----------------------------------------------------------------
gcloud config set project "$PROJECT_ID" >/dev/null
echo "→ Enabling required APIs (compute, iap)…"
gcloud services enable compute.googleapis.com iap.googleapis.com --project "$PROJECT_ID" >/dev/null

# ---- 2. Firewall: console/gateway from your CIDR, SSH only via IAP ----------
fw() { # fw <name> <rules> <source-ranges> <description>
  if gcloud compute firewall-rules describe "$1" --project "$PROJECT_ID" >/dev/null 2>&1; then
    echo "→ Firewall rule $1 already exists — leaving it as-is."
  else
    echo "→ Creating firewall rule $1…"
    gcloud compute firewall-rules create "$1" \
      --project "$PROJECT_ID" --network "$NETWORK" \
      --direction INGRESS --action ALLOW --rules "$2" \
      --source-ranges "$3" --target-tags "$TAG" \
      --description "$4" >/dev/null
  fi
}
fw anyray-allow-web "tcp:8787,tcp:3000" "$ALLOWED_CIDR" "Anyray console + gateway, scoped to the operator CIDR."
fw anyray-allow-iap-ssh "tcp:22" "$IAP_CIDR" "SSH to the Anyray VM only via Google IAP TCP forwarding."

# ---- 3. The VM (reused if it already exists — never recreate, keep the data) -
if gcloud compute instances describe "$INSTANCE" --zone "$ZONE" --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "→ Instance $INSTANCE already exists in $ZONE — reusing it (re-run is idempotent)."
else
  # The data disk is never auto-deleted with the VM, so a rebuild keeps provider
  # keys + enrollments. Reattach it if it survived a prior VM; create it the first
  # time. (auto-delete=no on an existing disk means a fresh `create` would collide.)
  if gcloud compute disks describe "${INSTANCE}-data" --zone "$ZONE" --project "$PROJECT_ID" >/dev/null 2>&1; then
    echo "→ Reattaching existing data disk ${INSTANCE}-data (preserves prior keys + enrollments)…"
    DISK_FLAG=(--disk "name=${INSTANCE}-data,device-name=anyray-data,auto-delete=no")
  else
    echo "→ Creating a ${DISK_SIZE} persistent data disk…"
    DISK_FLAG=(--create-disk "name=${INSTANCE}-data,device-name=anyray-data,size=${DISK_SIZE},type=pd-balanced,auto-delete=no")
  fi
  echo "→ Creating VM $INSTANCE (Ubuntu 24.04 LTS)…"
  gcloud compute instances create "$INSTANCE" \
    --project "$PROJECT_ID" --zone "$ZONE" \
    --machine-type "$MACHINE_TYPE" \
    --network-interface "network=${NETWORK},stack-type=IPV4_ONLY" \
    --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
    --boot-disk-size 20GB --boot-disk-type pd-balanced \
    "${DISK_FLAG[@]}" \
    --tags "$TAG" \
    --metadata "anyray-image-tag=${IMAGE_TAG},anyray-default-model=${DEFAULT_MODEL},anyray-deployment-token=${DEPLOYMENT_TOKEN}" \
    --metadata-from-file "startup-script=${HERE}/startup-script.sh"
fi

EXTERNAL_IP="$(gcloud compute instances describe "$INSTANCE" --zone "$ZONE" --project "$PROJECT_ID" \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)')"
GATEWAY_URL="http://${EXTERNAL_IP}:8787"
CONSOLE_URL="http://${EXTERNAL_IP}:3000"

# ---- 4. Wait for first-boot provisioning, then read back the admin key -------
# Provisioning (Docker install + image pulls + first boot) runs from the startup
# script and takes a few minutes. We poll over IAP SSH for the .ready marker.
echo "→ Waiting for first-boot provisioning (Docker install + image pull, ~3–6 min)…"
ssh_vm() { # ssh_vm <remote-command>
  gcloud compute ssh "$INSTANCE" --zone "$ZONE" --project "$PROJECT_ID" \
    --tunnel-through-iap --command "$1" -- -o StrictHostKeyChecking=no -o ConnectTimeout=15 2>/dev/null
}

ADMIN_TOKEN=""
for i in $(seq 1 40); do
  if ssh_vm 'test -f /opt/anyray/.ready'; then
    ADMIN_TOKEN="$(ssh_vm "sudo sed -n 's/^ANYRAY_ADMIN_TOKEN=//p' /opt/anyray/.env | head -n1" || true)"
    break
  fi
  sleep 15
done

# ---- 5. Report --------------------------------------------------------------
if [ -n "$ADMIN_TOKEN" ]; then
  cat <<DONE

✓ Anyray is live on a Compute Engine VM.

  Console:   ${CONSOLE_URL}
  Gateway:   ${GATEWAY_URL}
  Admin key: ${ADMIN_TOKEN}

Open the console, sign in with the admin key, then add a provider key and enroll
your developers (Invite developers). Point local tools at the gateway with:

  npx anyray-connect --gateway ${GATEWAY_URL}

The deployment appears as Connected at https://app.anyray.ai within a minute.
Both endpoints are reachable only from ${ALLOWED_CIDR}.
DONE
else
  cat <<PENDING

→ The VM is up and still finishing first boot (or IAP SSH wasn't reachable yet).

  Console:   ${CONSOLE_URL}
  Gateway:   ${GATEWAY_URL}

Read the admin key once provisioning completes:

  gcloud compute ssh ${INSTANCE} --zone ${ZONE} --tunnel-through-iap \\
    --command "sudo sed -n 's/^ANYRAY_ADMIN_TOKEN=//p' /opt/anyray/.env | head -n1"

Watch provisioning progress:

  gcloud compute ssh ${INSTANCE} --zone ${ZONE} --tunnel-through-iap \\
    --command "sudo tail -f /var/log/anyray-startup.log"

Both endpoints are reachable only from ${ALLOWED_CIDR}.
PENDING
fi
