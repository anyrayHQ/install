#!/usr/bin/env bash
# Live check for the autoUpdate pin (ANY-1685): install the chart on the
# policy-stable channel in a throwaway kind cluster, fire the autoUpdate
# CronJob once, and require every app Deployment to land on
# `:policy-stable@sha256:…` with its running pods on that image.
#
# The unit test (autoupdate-pin.test.mjs) proves the script runs through a
# ConfigMap symlink against a fake API server. This proves the real thing: the
# kubelet's mount, the real API server, the real image pulls.
#
# Usage:  tests/autoupdate-pin-live.sh [chart-dir]     (default: ./helm)
# Needs docker, kind, kubectl, helm, openssl and internet egress (the job pulls
# the policy-stable images from public.ecr.aws). Uses its own kubeconfig, never
# ~/.kube/config, and deletes only the cluster it created. The node is capped
# at 3 CPUs and 5 GiB so it can share a Docker VM. Secrets are random values
# that live only in the cluster; the deployment token is synthetic, so the
# gateway runs in-network (no Billing app lease), set after install.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CHART="$(cd "${1:-$HERE/../helm}" && pwd)"
CLUSTER=anyray-pin
CTX="kind-$CLUSTER"
NS=pin
WORK="$(mktemp -d)"
KCFG="$WORK/kubeconfig"
FAILS=0

k() { kubectl --kubeconfig "$KCFG" --context "$CTX" "$@"; }
h() { helm --kubeconfig "$KCFG" --kube-context "$CTX" "$@"; }
log() { printf '\n== %s\n' "$*"; }
check() { # label, expected, actual
  if [ "$2" = "$3" ]; then echo "PASS  $1: $3"; else echo "FAIL  $1: expected $2, got $3"; FAILS=$((FAILS + 1)); fi
}

[ -f "$CHART/Chart.yaml" ] || { echo "not a chart directory: $CHART" >&2; exit 2; }
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  echo "a kind cluster named $CLUSTER already exists; delete it first (this script only deletes what it created)" >&2
  exit 2
fi

created=0
cleanup() {
  if [ "$created" = 1 ]; then
    kind delete cluster --name "$CLUSTER" --kubeconfig "$KCFG" >/dev/null 2>&1 && echo "deleted kind cluster $CLUSTER"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

log "kind cluster $CLUSTER"
kind create cluster --name "$CLUSTER" --kubeconfig "$KCFG" --wait 120s >/dev/null 2>&1 \
  || { echo "kind create cluster failed (left in place: it may belong to another run)" >&2; exit 2; }
created=1
docker update --cpus 3 --memory 5g --memory-swap 5g "${CLUSTER}-control-plane" >/dev/null \
  && echo "node capped: 3 CPUs, 5 GiB"

log "install $CHART on policy-stable"
k create namespace "$NS" >/dev/null
k -n "$NS" create secret generic anyray-secrets \
  --from-literal=ANYRAY_ADMIN_TOKEN="ar-adm-$(openssl rand -hex 16)" \
  --from-literal=ANYRAY_OPTIMIZER_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=ANYRAY_CONTENT_KEY="$(openssl rand -hex 32)" \
  --from-literal=ANYRAY_DEPLOYMENT_TOKEN="adt_synthetic_$(openssl rand -hex 16)" \
  --from-literal=ANYRAY_PSEUDONYM_SALT="$(openssl rand -hex 32)" \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -hex 16)" >/dev/null
# Client-side apply so the in-network override below is not a field conflict.
h install anyray "$CHART" -n "$NS" --server-side=false --set host=anyray.example.com \
  --set postgres.storage=150Gi --set-string image.tag=policy-stable >/dev/null \
  || { echo "FAIL  helm install"; exit 1; }
k -n "$NS" set env deployment/anyray-gateway ANYRAY_METERING_ENABLED=false >/dev/null
k -n "$NS" rollout status statefulset/anyray-postgres --timeout=600s >/dev/null
for d in anyray-gateway anyray-optimizer anyray-proxy; do
  k -n "$NS" rollout status "deployment/$d" --timeout=900s >/dev/null \
    || { echo "FAIL  $d never rolled out"; FAILS=$((FAILS + 1)); }
done
for d in anyray-gateway anyray-optimizer anyray-proxy; do
  echo "before: $d $(k -n "$NS" get deploy "$d" -o jsonpath='{.spec.template.spec.containers[0].image}')"
done

log "fire the autoUpdate CronJob once"
k -n "$NS" create job pin-live --from=cronjob/anyray-autoupdate >/dev/null
if k -n "$NS" wait --for=condition=complete job/pin-live --timeout=900s >/dev/null; then
  echo "PASS  the job completed"
else
  echo "FAIL  the job did not complete"; FAILS=$((FAILS + 1))
fi
echo "job log:"
k -n "$NS" logs job/pin-live --all-containers --prefix 2>&1 | cut -c1-240 | sed 's/^/  /'

for d in anyray-gateway anyray-optimizer anyray-proxy; do
  img="$(k -n "$NS" get deploy "$d" -o jsonpath='{.spec.template.spec.containers[0].image}')"
  echo "after:  $d $img"
  case "$img" in *:policy-stable@sha256:*) pinned=yes ;; *) pinned=no ;; esac
  check "$d pinned to policy-stable@sha256" yes "$pinned"
  k -n "$NS" rollout status "deployment/$d" --timeout=900s >/dev/null \
    || { echo "FAIL  $d did not settle"; FAILS=$((FAILS + 1)); }
  # rollout status returns once the new pods are available, while the old ones
  # may still be draining (gateway and optimizer: up to 120s). Wait for them to
  # go, so an old pod is never read as the new state.
  selector="app.kubernetes.io/component=${d#anyray-}"
  for _ in $(seq 1 60); do
    terminating="$(k -n "$NS" get pods -l "$selector" \
      -o jsonpath='{range .items[*]}{.metadata.deletionTimestamp}{"\n"}{end}' | grep -c . || true)"
    [ "$terminating" = 0 ] && break
    sleep 5
  done
  check "$d old pods gone after the roll" 0 "$terminating"
  running="$(k -n "$NS" get pods -l "$selector" \
    -o jsonpath='{range .items[*]}{.spec.containers[0].image}{"\n"}{end}' | sort -u)"
  check "$d running pods all on the pinned image" "$img" "$running"
done

log "RESULT: $FAILS failure(s)"
[ "$FAILS" = 0 ]
