#!/usr/bin/env bash
# Anyray one-click deploy on Azure Kubernetes Service (AKS).
#
# Provisions a managed AKS cluster, generates every secret locally, and installs
# the bundled Helm chart (gateway + optimizer + console proxy + Postgres) with the
# gateway API and console exposed as CIDR-scoped LoadBalancer Services. The Azure
# analog of the AWS CloudFormation / GKE Autopilot quick-launches: a managed
# control plane, no bootstrap server to SSH into.
#
# Designed to run in Azure Cloud Shell (az, kubectl, helm are preinstalled), but
# works from any machine with the Azure CLI, kubectl, and helm authenticated to
# your subscription (az login).
#
# Inputs come from the environment and fall back to an interactive prompt:
#   SUBSCRIPTION_ID   Azure subscription (default: az's active subscription)
#   LOCATION          Azure region (default: eastus)
#   RESOURCE_GROUP    Resource group, created if missing (default: anyray)
#   CLUSTER           AKS cluster name (default: anyray)
#   NAMESPACE         Kubernetes namespace (default: anyray)
#   NODE_VM_SIZE      Node pool VM size (default: Standard_D2s_v5)
#   NODE_COUNT        Node pool size (default: 2)
#   ALLOWED_CIDR      CIDR allowed to reach the console/gateway LBs. REQUIRED.
#                     Scope to your office/VPN range — never 0.0.0.0/0.
#   DEPLOYMENT_TOKEN  Anyray Cloud deployment token (adt_...). REQUIRED for metering.
#   IMAGE_TAG         Anyray image tag (default: latest)
#   DEFAULT_MODEL     anyray-default routing target (default: anthropic/claude-sonnet-4-5)
#
# Content stays encrypted at rest (ANYRAY_CONTENT_MODE=encrypted); only metadata
# is logged. The content key + pseudonym salt are generated locally and never
# leave your subscription.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OVERLAY="$(mktemp -t anyray-azure-values.XXXXXX.yaml)"
trap 'rm -f "$OVERLAY"' EXIT

# ---- Defaults / inputs ------------------------------------------------------
SUBSCRIPTION_ID="${SUBSCRIPTION_ID:-}"
LOCATION="${LOCATION:-eastus}"
RESOURCE_GROUP="${RESOURCE_GROUP:-anyray}"
CLUSTER="${CLUSTER:-anyray}"
NAMESPACE="${NAMESPACE:-anyray}"
NODE_VM_SIZE="${NODE_VM_SIZE:-Standard_D2s_v5}"
NODE_COUNT="${NODE_COUNT:-2}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
DEFAULT_MODEL="${DEFAULT_MODEL:-anthropic/claude-sonnet-4-5}"
ALLOWED_CIDR="${ALLOWED_CIDR:-}"
DEPLOYMENT_TOKEN="${DEPLOYMENT_TOKEN:-}"

prompt() { # prompt VAR "message"
  local var="$1" msg="$2" val
  eval "val=\${$var:-}"
  if [ -z "$val" ] && [ -t 0 ]; then
    read -r -p "$msg" val
    eval "$var=\$val"
  fi
}

prompt ALLOWED_CIDR     "CIDR allowed to reach the console/gateway (e.g. 203.0.113.0/24): "
prompt DEPLOYMENT_TOKEN "Anyray deployment token (adt_...): "

# ---- Validate ---------------------------------------------------------------
die() { echo "✗ $*" >&2; exit 1; }

[ -n "$ALLOWED_CIDR" ] || die "ALLOWED_CIDR is required — scope it to your office/VPN range."
[ "$ALLOWED_CIDR" != "0.0.0.0/0" ] || die "ALLOWED_CIDR must not be 0.0.0.0/0 — the console and gateway carry spend data and admin access."
echo "$ALLOWED_CIDR" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$' \
  || die "ALLOWED_CIDR must be a CIDR like 203.0.113.0/24."
echo "$DEPLOYMENT_TOKEN" | grep -Eq '^adt_[A-Za-z0-9_-]+$' \
  || die "DEPLOYMENT_TOKEN must look like adt_... — get one at https://app.anyray.ai (Deployments → Connect a deployment)."

for bin in az kubectl helm; do
  command -v "$bin" >/dev/null 2>&1 || die "$bin not found on PATH (Azure Cloud Shell has all three preinstalled)."
done

# Pin the subscription (default to az's active one).
if [ -n "$SUBSCRIPTION_ID" ]; then
  az account set --subscription "$SUBSCRIPTION_ID"
else
  SUBSCRIPTION_ID="$(az account show --query id -o tsv 2>/dev/null || true)"
  [ -n "$SUBSCRIPTION_ID" ] || die "No active Azure subscription — run 'az login' (or set SUBSCRIPTION_ID)."
fi

echo "→ Subscription: $SUBSCRIPTION_ID   Region: $LOCATION   Resource group: $RESOURCE_GROUP   Cluster: $CLUSTER   Namespace: $NAMESPACE"

# ---- 1. Resource providers + AKS cluster ------------------------------------
echo "→ Registering required resource providers (ContainerService, Network)…"
az provider register --namespace Microsoft.ContainerService --wait
az provider register --namespace Microsoft.Network --wait

echo "→ Ensuring resource group $RESOURCE_GROUP exists in $LOCATION…"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" >/dev/null

if az aks show --resource-group "$RESOURCE_GROUP" --name "$CLUSTER" >/dev/null 2>&1; then
  echo "→ AKS cluster $CLUSTER already exists — reusing it."
else
  echo "→ Creating AKS cluster $CLUSTER in $LOCATION (this takes a few minutes)…"
  az aks create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CLUSTER" \
    --location "$LOCATION" \
    --node-count "$NODE_COUNT" \
    --node-vm-size "$NODE_VM_SIZE" \
    --enable-managed-identity \
    --generate-ssh-keys
fi

echo "→ Fetching cluster credentials…"
az aks get-credentials --resource-group "$RESOURCE_GROUP" --name "$CLUSTER" --overwrite-existing

kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || kubectl create namespace "$NAMESPACE"

# ---- 2. Generate secrets + Helm values (host is set after the LBs come up) --
echo "→ Generating secrets and Helm values…"
( cd "$REPO_ROOT" && ./setup.sh --k8s --connect "$DEPLOYMENT_TOKEN" \
    --host "anyray.internal" --namespace "$NAMESPACE" >/dev/null )

# ---- 3. AKS overlay: expose gateway + console as CIDR-scoped LoadBalancers ---
# The bundled Postgres + the /data PVCs bind AKS's default-annotated `default`
# StorageClass (Azure Disk CSI), so no storageClass override is needed. nginx in
# the proxy reaches the gateway/optimizer by in-cluster FQDN (clusterDomain
# default cluster.local is correct on AKS).
cat > "$OVERLAY" <<YAML
image:
  tag: "${IMAGE_TAG}"
gateway:
  defaultModel: "${DEFAULT_MODEL}"
  service:
    type: LoadBalancer
    loadBalancerSourceRanges:
      - "${ALLOWED_CIDR}"
proxy:
  service:
    type: LoadBalancer
    loadBalancerSourceRanges:
      - "${ALLOWED_CIDR}"
YAML

# ---- 4. Apply secret (never clobber an existing one — the content key + admin
#         token must stay stable) and install/upgrade the chart ---------------
if kubectl get secret anyray-secrets -n "$NAMESPACE" >/dev/null 2>&1; then
  echo "→ Secret anyray-secrets already present in $NAMESPACE — keeping existing values."
else
  kubectl apply -n "$NAMESPACE" -f "$REPO_ROOT/anyray-secrets.yaml"
fi

echo "→ Installing the Anyray Helm chart…"
helm upgrade --install anyray "$REPO_ROOT/helm" \
  -f "$REPO_ROOT/my-values.yaml" -f "$OVERLAY" \
  --namespace "$NAMESPACE" --wait --timeout 10m

# ---- 5. Wait for the LoadBalancer IPs --------------------------------------
wait_for_lb() { # wait_for_lb <service> -> echoes external IP
  local svc="$1" ip="" i
  for i in $(seq 1 60); do
    ip="$(kubectl get svc "$svc" -n "$NAMESPACE" \
      -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"
    [ -n "$ip" ] && { echo "$ip"; return 0; }
    sleep 10
  done
  return 1
}

echo "→ Waiting for load balancer IPs (AKS provisions them in ~1–3 min)…"
GATEWAY_IP="$(wait_for_lb gateway)"       || die "gateway LoadBalancer never got an external IP — check 'kubectl get svc -n $NAMESPACE'."
CONSOLE_IP="$(wait_for_lb anyray-proxy)"  || die "console LoadBalancer never got an external IP — check 'kubectl get svc -n $NAMESPACE'."

GATEWAY_URL="http://${GATEWAY_IP}:8787"
CONSOLE_URL="http://${CONSOLE_IP}:3000"

# ---- 6. Re-stamp the public URLs now that the IPs are known -----------------
echo "→ Wiring the external URLs into the gateway…"
helm upgrade anyray "$REPO_ROOT/helm" \
  -f "$REPO_ROOT/my-values.yaml" -f "$OVERLAY" \
  --namespace "$NAMESPACE" \
  --set "host=${GATEWAY_IP}" \
  --set "gateway.publicUrl=${GATEWAY_URL}" \
  --set "gateway.consolePublicUrl=${CONSOLE_URL}" \
  --wait --timeout 5m

ADMIN_TOKEN="$(kubectl get secret anyray-secrets -n "$NAMESPACE" \
  -o jsonpath='{.data.ANYRAY_ADMIN_TOKEN}' | base64 --decode)"

cat <<DONE

✓ Anyray is live on AKS.

  Console:   ${CONSOLE_URL}
  Gateway:   ${GATEWAY_URL}
  Admin key: ${ADMIN_TOKEN}

Open the console, sign in with the admin key, then add a provider key and enroll
your developers (Invite developers). Point local tools at the gateway with:

  npx anyray-connect --gateway ${GATEWAY_URL}

The deployment appears as Connected at https://app.anyray.ai within a minute.
Both endpoints are reachable only from ${ALLOWED_CIDR}.
DONE
