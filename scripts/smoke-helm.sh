#!/usr/bin/env bash
#
# smoke-helm.sh — LIVE Helm chart smoke test on a real Kubernetes cluster.
#
# `helm template` rendering (validate-artifacts) proves the chart renders; it
# cannot prove it behaves — the EKS console outage (#54, proxy needed FQDN
# upstreams) was invisible to rendering and only observable on a live cluster.
# This script installs the chart for real (the CI workflow provides a kind
# cluster), probes the golden paths, and tears down. It drives the exact
# customer flow: `setup.sh --k8s` generates the Secret + values.
#
# Lanes (pick with LANE):
#   fresh    — install the CANDIDATE chart (./helm), probe.
#   upgrade  — install the PUBLISHED chart (what customers run today) from
#              oci://public.ecr.aws/h4e6s7a8/anyray, probe, then
#              `helm upgrade` to the candidate — the customer upgrade path —
#              and probe again.
#
# Probes mirror scripts/smoke-aws.sh:
#   1. GET /console/ unauthenticated → 200 sign-in page, NOT an nginx 500.
#   2. GET /console/ with the admin cookie → 200 (console SPA).
#   3. GET /admin/health through the proxy → 200 (proxy→gateway seam).
#   4. scripts/verify-deploy.sh against the gateway (deep per-leg health).
set -euo pipefail

LANE="${LANE:?fresh|upgrade}"
NS="${NS:-anyray-smoke}"
RELEASE="${RELEASE:-anyray}"
PUBLISHED_CHART="${PUBLISHED_CHART:-oci://public.ecr.aws/h4e6s7a8/anyray}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
PF_PIDS=()

stop_forwards() {
  for pid in "${PF_PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  PF_PIDS=()
  pkill -f "port-forward --namespace ${NS}" 2>/dev/null || true
}

cleanup() {
  stop_forwards
  [ "${KEEP:-0}" = 1 ] && { echo "KEEP=1 — leaving release ${RELEASE} in ${NS}"; return 0; }
  helm uninstall "$RELEASE" -n "$NS" --wait --timeout 3m 2>/dev/null || true
  kubectl delete namespace "$NS" --ignore-not-found --timeout=2m || true
}
trap cleanup EXIT

# --- customer setup flow: Secret + values from setup.sh --------------------
cd "$REPO_ROOT"
./setup.sh --k8s --namespace "$NS" --host anyray.smoke.local \
  --connect adt_cismoke0000000000
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -n "$NS" -f anyray-secrets.yaml

install_chart() {
  local chart="$1" what="$2"
  echo "→ helm install ${RELEASE} (${what}: ${chart})"
  helm install "$RELEASE" "$chart" -n "$NS" -f my-values.yaml \
    --wait --timeout 12m
}

probe() {
  local round="$1" token proxy_svc code body
  token="$(kubectl get secret -n "$NS" anyray-secrets \
    -o jsonpath='{.data.ANYRAY_ADMIN_TOKEN}' | base64 -d)"
  proxy_svc="$(kubectl get svc -n "$NS" \
    -l app.kubernetes.io/component=proxy -o jsonpath='{.items[0].metadata.name}')"

  # helm --wait returns as soon as the (loosely-gated) deployments count
  # ready, often while images are still pulling — wait for real pod
  # readiness first, best-effort (the probe loop below is authoritative).
  kubectl wait --namespace "$NS" --for=condition=ready pod \
    -l app.kubernetes.io/component=proxy --timeout=420s || true
  kubectl wait --namespace "$NS" --for=condition=ready pod \
    -l app.kubernetes.io/component=gateway --timeout=420s || true

  # Port-forwards for the probe round (the chart's Ingress needs a controller
  # kind doesn't run; the seams under test — proxy→gateway DNS, auth gate —
  # sit behind the Services, which port-forward exercises). kubectl
  # port-forward exits whenever its pod restarts (gateway boots against
  # postgres, images still pulling), so each forward runs in a respawn loop.
  ( while true; do
      kubectl port-forward --namespace "$NS" "svc/${proxy_svc}" 13000:80 \
        >/dev/null 2>&1
      sleep 1
    done ) &
  PF_PIDS+=($!)
  ( while true; do
      kubectl port-forward --namespace "$NS" svc/gateway 18787:8787 \
        >/dev/null 2>&1
      sleep 1
    done ) &
  PF_PIDS+=($!)
  sleep 3

  echo "→ [${round}] probing console via ${proxy_svc}"
  local i code=""
  for i in $(seq 1 120); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      http://127.0.0.1:13000/console/ || true)"
    [ "$code" = 200 ] && break
    sleep 5
  done
  if [ "$code" != 200 ]; then
    echo "::error::[${round}] unauthenticated /console/ returned ${code} (expected 200 sign-in page)."
    [ "$code" = 500 ] && echo "::error::Bare 500 = the proxy failed its /__auth subrequest — it cannot resolve/reach the gateway Service (the #54 FQDN class). kubectl logs -n ${NS} -l app.kubernetes.io/component=proxy"
    return 1
  fi
  body="$(curl -s --max-time 10 http://127.0.0.1:13000/console/)"
  printf '%s' "$body" | grep -qi 'sign in' || {
    echo "::error::[${round}] /console/ is 200 but not the sign-in page."; return 1; }

  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    -H "Cookie: anyray_key=${token}" http://127.0.0.1:13000/console/)"
  [ "$code" = 200 ] || { echo "::error::[${round}] authenticated /console/ → ${code}"; return 1; }

  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
    -H "Cookie: anyray_key=${token}" http://127.0.0.1:13000/admin/health)"
  [ "$code" = 200 ] || { echo "::error::[${round}] /admin/health via proxy → ${code}"; return 1; }

  "${HERE}/verify-deploy.sh" http://127.0.0.1:18787 "$token"

  stop_forwards
  echo "✓ [${round}] console + gateway healthy"
}

case "$LANE" in
  fresh)
    install_chart ./helm candidate
    probe fresh
    ;;
  upgrade)
    install_chart "$PUBLISHED_CHART" published
    probe published
    echo "→ helm upgrade to candidate (the customer upgrade path)"
    helm upgrade "$RELEASE" ./helm -n "$NS" -f my-values.yaml \
      --wait --timeout 12m
    probe upgraded
    ;;
  *) echo "unknown LANE=${LANE}"; exit 2 ;;
esac
