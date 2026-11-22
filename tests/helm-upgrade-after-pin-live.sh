#!/usr/bin/env bash
# Live check that `helm upgrade` works after the scheduled roll has pinned the
# images. Helm 4 installs and upgrades server-side by default: it owns the
# image field under its own field manager, so a pin written by any other
# manager leaves the next upgrade failing with a field conflict.
#
# Installs the chart on the policy-stable channel in a throwaway kind cluster
# with Helm 4's default apply method, fires the autoUpdate CronJob, then
# requires a plain `helm upgrade` (no flags) to succeed and to render the plain
# tag again. Runs the cycle twice, as two nightly rolls would.
#
# Usage:  tests/helm-upgrade-after-pin-live.sh [chart-dir]     (default: ./helm)
# Needs docker, kind, kubectl, helm 4, openssl and internet egress (the job
# pulls the policy-stable images from public.ecr.aws). Uses its own kubeconfig,
# never ~/.kube/config, and deletes only the cluster it created. The pods need
# not become ready: the pin and the upgrade do not wait for them.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CHART="$(cd "${1:-$HERE/../helm}" && pwd)"
CLUSTER=anyray-upgrade
CTX="kind-$CLUSTER"
NS=upgrade
WORK="$(mktemp -d)"
KCFG="$WORK/kubeconfig"
FAILS=0

k() { kubectl --kubeconfig "$KCFG" --context "$CTX" "$@"; }
h() { helm --kubeconfig "$KCFG" --kube-context "$CTX" "$@"; }
log() { printf '\n== %s\n' "$*"; }
check() { # label, expected, actual
  if [ "$2" = "$3" ]; then echo "PASS  $1: $3"; else echo "FAIL  $1: expected $2, got $3"; FAILS=$((FAILS + 1)); fi
}
gateway_image() { k -n "$NS" get deploy anyray-gateway -o jsonpath='{.spec.template.spec.containers[0].image}'; }

[ -f "$CHART/Chart.yaml" ] || { echo "not a chart directory: $CHART" >&2; exit 2; }
case "$(helm version --template '{{.Version}}' 2>/dev/null)" in
  v4.*) ;;
  *) echo "helm 4 is required: Helm 3 applies client-side and never shows the conflict" >&2; exit 2 ;;
esac
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

log "install $CHART on policy-stable (helm $(helm version --template '{{.Version}}'), default apply method)"
k create namespace "$NS" >/dev/null
k -n "$NS" create secret generic anyray-secrets \
  --from-literal=ANYRAY_ADMIN_TOKEN="ar-adm-$(openssl rand -hex 16)" \
  --from-literal=ANYRAY_OPTIMIZER_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=ANYRAY_CONTENT_KEY="$(openssl rand -hex 32)" \
  --from-literal=ANYRAY_DEPLOYMENT_TOKEN="adt_synthetic_$(openssl rand -hex 16)" \
  --from-literal=ANYRAY_PSEUDONYM_SALT="$(openssl rand -hex 32)" \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -hex 16)" >/dev/null
VALUES=(--set host=anyray.example.com --set postgres.storage=150Gi --set-string image.tag=policy-stable)
h install anyray "$CHART" -n "$NS" "${VALUES[@]}" >/dev/null || { echo "FAIL  helm install"; exit 1; }
check "installed on the plain tag" "public.ecr.aws/anyray/gateway:policy-stable" "$(gateway_image)"

# Only the Jobs below may pin, never the schedule.
k -n "$NS" patch cronjob anyray-autoupdate -p '{"spec":{"suspend":true}}' >/dev/null

for roll in 1 2; do
  log "roll $roll: fire the autoUpdate CronJob"
  k -n "$NS" create job "pin-$roll" --from=cronjob/anyray-autoupdate >/dev/null
  if k -n "$NS" wait --for=condition=complete "job/pin-$roll" --timeout=600s >/dev/null; then
    echo "PASS  the job completed"
  else
    echo "FAIL  the job did not complete"; FAILS=$((FAILS + 1))
    k -n "$NS" logs "job/pin-$roll" --all-containers --prefix 2>&1 | cut -c1-240 | sed 's/^/  /'
    break
  fi
  case "$(gateway_image)" in *:policy-stable@sha256:*) pinned=yes ;; *) pinned=no ;; esac
  check "roll $roll pinned the gateway to a digest" yes "$pinned"

  log "roll $roll: helm upgrade, same values, no flags"
  if out="$(h upgrade anyray "$CHART" -n "$NS" "${VALUES[@]}" 2>&1)"; then
    echo "PASS  helm upgrade succeeded"
  else
    echo "FAIL  helm upgrade failed:"; printf '%s\n' "$out" | cut -c1-400 | sed 's/^/  /'
    FAILS=$((FAILS + 1))
  fi
  check "roll $roll: the upgrade rendered the plain tag again" "public.ecr.aws/anyray/gateway:policy-stable" "$(gateway_image)"
done

log "RESULT: $FAILS failure(s)"
[ "$FAILS" = 0 ]
