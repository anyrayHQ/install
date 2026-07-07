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

dump_diagnostics() {
  echo "== pods"; kubectl get pods -n "$NS" -o wide || true
  echo "== events"; kubectl get events -n "$NS" --sort-by=.lastTimestamp | tail -40 || true
  local pod
  for pod in $(kubectl get pods -n "$NS" -o name); do
    echo "== describe ${pod}"; kubectl describe -n "$NS" "$pod" | tail -25 || true
    echo "== logs ${pod}"
    kubectl logs -n "$NS" "$pod" --all-containers --tail=40 2>/dev/null || true
  done
}

cleanup() {
  local rc=$?
  stop_forwards
  # Teardown destroys the evidence — dump cluster state FIRST on failure.
  if [ "$rc" -ne 0 ]; then
    echo "::group::diagnostics (exit ${rc})"; dump_diagnostics; echo "::endgroup::"
  fi
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
  local round="$1" token proxy_svc code
  token="$(kubectl get secret -n "$NS" anyray-secrets \
    -o jsonpath='{.data.ANYRAY_ADMIN_TOKEN}' | base64 -d)"
  proxy_svc="$(kubectl get svc -n "$NS" \
    -l app.kubernetes.io/component=proxy -o jsonpath='{.items[0].metadata.name}')"

  # Probes run IN-CLUSTER via a long-lived curl pod hitting the Services over
  # cluster DNS — the same path real traffic takes, and none of the
  # port-forward fragility (a forward dies with its pod and its stderr is
  # invisible in CI).
  if ! kubectl get pod -n "$NS" smoke-prober >/dev/null 2>&1; then
    kubectl run smoke-prober -n "$NS" --image=curlimages/curl:8.10.1 \
      --restart=Never --command -- sleep 3600
  fi
  kubectl wait --namespace "$NS" --for=condition=ready pod/smoke-prober --timeout=120s

  pcurl() { kubectl exec -n "$NS" smoke-prober -- curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }

  echo "→ [${round}] probing console via ${proxy_svc}"
  local i code=""
  for i in $(seq 1 120); do
    code="$(pcurl "http://${proxy_svc}/console/" || true)"
    [ "$code" = 200 ] && break
    sleep 5
  done
  if [ "$code" != 200 ]; then
    echo "::error::[${round}] unauthenticated /console/ returned ${code} (expected 200 sign-in page)."
    [ "$code" = 500 ] && echo "::error::Bare 500 = the proxy failed its /__auth subrequest — it cannot resolve/reach the gateway Service (the #54 FQDN class)."
    return 1
  fi
  kubectl exec -n "$NS" smoke-prober -- curl -s --max-time 10 \
    "http://${proxy_svc}/console/" | grep -qi 'sign in' || {
    echo "::error::[${round}] /console/ is 200 but not the sign-in page."; return 1; }

  code="$(pcurl -H "Cookie: anyray_key=${token}" "http://${proxy_svc}/console/")"
  [ "$code" = 200 ] || { echo "::error::[${round}] authenticated /console/ → ${code}"; return 1; }

  code="$(pcurl -H "Cookie: anyray_key=${token}" "http://${proxy_svc}/admin/health")"
  [ "$code" = 200 ] || { echo "::error::[${round}] /admin/health via proxy → ${code}"; return 1; }

  # Deep health straight against the gateway Service (in-cluster stand-in for
  # scripts/verify-deploy.sh, which needs a host-reachable URL).
  kubectl exec -n "$NS" smoke-prober -- curl -s --max-time 15 \
    -H "Authorization: Bearer ${token}" http://gateway:8787/admin/health \
    | grep -q '"ok":true' || {
    echo "::error::[${round}] gateway /admin/health not ok"; return 1; }

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
