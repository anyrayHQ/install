#!/usr/bin/env bash
# shellcheck disable=SC2016 # the node -e scripts use JS template literals, expanded by node
# Live check for topology=region (ANY-1905): boot a home (`single`) and a region
# (`topology=region`) of this chart in one throwaway kind cluster, and require,
# within 180 s of the region install:
#   - home lists the region with a recent contact and the region's own address;
#   - the region's /region-health reason is exactly "lease unavailable" (keys and
#     config arrived from home; CI has no licence, so no lease);
#   - anyray_region_schema_migrations has rows in the regional database;
#   - the region gateway's /livez answers 200;
#   - the optimizer runs in region mode (bootstrap-durable answers 404) and
#     adopted home's state through gateway-internal (a valid optimize call answers 200).
#
# Home serves https://home.anyray.example.com through ingress-nginx with a
# self-signed CA; a CoreDNS rewrite points that name at the controller, and the
# region gateway trusts the CA through NODE_EXTRA_CA_CERTS. The region refuses a
# home URL on a special-use TLD (.test, .local, ...), so the name is on
# example.com and never leaves the cluster.
#
# Usage:  tests/region-boot-live.sh [chart-dir]     (default: ./helm)
#   IMAGE_TAG overrides the app image tag (default: the chart's appVersion).
# Needs docker, kind, kubectl, helm, openssl, jq, curl and internet egress. Uses
# its own kubeconfig, never ~/.kube/config, and deletes only the cluster it
# created. Every secret is random, written to files under a private temp dir and
# loaded with --from-file, so none appears on a command line. The deployment
# token is synthetic, so home runs with metering off, set after install.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CHART="$(cd "${1:-$HERE/../helm}" && pwd)"
CLUSTER=anyray-region-boot
CTX="kind-$CLUSTER"
HOME_HOST=home.anyray.example.com
REGION_NAME=ci-region
REGION_HOST=region.anyray.example.com
INGRESS_NGINX_URL=https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.1/deploy/static/provider/cloud/deploy.yaml
INGRESS_NGINX_SHA256=c6dbb962b7b396369fce700bafe3f789fd25f31ca093d499f7c165dd31b0ecff
DEADLINE_S=180
WORK="$(mktemp -d)"
chmod 700 "$WORK"
KCFG="$WORK/kubeconfig"
FAILS=0

k() { kubectl --kubeconfig "$KCFG" --context "$CTX" "$@"; }
h() { helm --kubeconfig "$KCFG" --kube-context "$CTX" "$@"; }
log() { printf '\n== %s\n' "$*"; }
die() { echo "FAIL  $*"; exit 1; }
# gen <dir> <key> <prefix> <random bytes>: a random secret value in a file named after its key.
gen() { { printf '%s' "$3"; openssl rand -hex "$4"; } | tr -d '\n' >"$1/$2"; }

[ -f "$CHART/Chart.yaml" ] || { echo "not a chart directory: $CHART" >&2; exit 2; }
TAG="${IMAGE_TAG:-$(awk '/^appVersion:/ {gsub(/"/, "", $2); print $2}' "$CHART/Chart.yaml")}"
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

# Helm 4 applies server-side by default; the metering override below is a client-side patch.
APPLY=()
case "$(helm version --short 2>/dev/null)" in v4*) APPLY=(--server-side=false) ;; esac

log "kind cluster $CLUSTER (images $TAG)"
kind create cluster --name "$CLUSTER" --kubeconfig "$KCFG" --wait 120s >/dev/null 2>&1 \
  || { echo "kind create cluster failed (left in place: it may belong to another run)" >&2; exit 2; }
created=1

log "ingress-nginx and the home CA"
curl -fsSL "$INGRESS_NGINX_URL" -o "$WORK/ingress-nginx.yaml" || die "download ingress-nginx manifest"
echo "$INGRESS_NGINX_SHA256  $WORK/ingress-nginx.yaml" | sha256sum -c --status 2>/dev/null \
  || echo "$INGRESS_NGINX_SHA256  $WORK/ingress-nginx.yaml" | shasum -a 256 -c --status \
  || die "ingress-nginx manifest checksum mismatch"
k apply -f "$WORK/ingress-nginx.yaml" >/dev/null || die "apply ingress-nginx"
k -n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=300s >/dev/null \
  || die "ingress-nginx controller never rolled out"
k -n ingress-nginx wait --for=condition=complete job --all --timeout=180s >/dev/null \
  || die "ingress-nginx admission jobs did not complete"

openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=anyray region boot CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout "$WORK/ca.key" -out "$WORK/ca.crt" 2>/dev/null || die "CA"
openssl req -newkey rsa:2048 -nodes -subj "/CN=$HOME_HOST" \
  -keyout "$WORK/tls.key" -out "$WORK/tls.csr" 2>/dev/null || die "home key"
printf 'subjectAltName=DNS:%s\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' "$HOME_HOST" >"$WORK/tls.ext"
openssl x509 -req -days 2 -in "$WORK/tls.csr" -CA "$WORK/ca.crt" -CAkey "$WORK/ca.key" -CAcreateserial \
  -extfile "$WORK/tls.ext" -out "$WORK/tls.crt" 2>/dev/null || die "home certificate"

# The answer is rewritten back too, so resolvers see the name they asked for.
k -n kube-system get configmap coredns -o jsonpath='{.data.Corefile}' >"$WORK/Corefile" || die "read Corefile"
awk -v host="$HOME_HOST" -v target="ingress-nginx-controller.ingress-nginx.svc.cluster.local" '
  { print }
  /^\.:53 \{/ && !done {
    print "    rewrite stop {"
    print "        name exact " host " " target
    print "        answer name " target " " host
    print "    }"
    done = 1
  }' "$WORK/Corefile" >"$WORK/Corefile.new"
grep -q "name exact $HOME_HOST" "$WORK/Corefile.new" || die "Corefile has no .:53 block to rewrite"
k -n kube-system create configmap coredns --from-file=Corefile="$WORK/Corefile.new" --dry-run=client -o yaml \
  | k apply -f - >/dev/null 2>&1 || die "apply Corefile"
k -n kube-system rollout restart deployment/coredns >/dev/null
k -n kube-system rollout status deployment/coredns --timeout=120s >/dev/null || die "CoreDNS restart"

log "home: topology single at https://$HOME_HOST"
k create namespace home >/dev/null
mkdir -m 700 "$WORK/home-secrets"
gen "$WORK/home-secrets" ANYRAY_ADMIN_TOKEN ar-adm- 16
gen "$WORK/home-secrets" ANYRAY_OPTIMIZER_TOKEN "" 32
gen "$WORK/home-secrets" ANYRAY_CONTENT_KEY "" 32
gen "$WORK/home-secrets" ANYRAY_DEPLOYMENT_TOKEN adt_synthetic_ 16
gen "$WORK/home-secrets" ANYRAY_PSEUDONYM_SALT "" 32
gen "$WORK/home-secrets" POSTGRES_PASSWORD "" 16
k -n home create secret generic anyray-secrets --from-file="$WORK/home-secrets" >/dev/null || die "home Secret"
k -n home create secret tls home-tls --cert="$WORK/tls.crt" --key="$WORK/tls.key" >/dev/null || die "home TLS Secret"
cat >"$WORK/home-values.yaml" <<EOF
host: $HOME_HOST
postgres:
  storage: 150Gi
autoUpdate:
  enabled: false
gateway:
  replicas: 1
optimizer:
  replicas: 1
  resources:
    requests:
      cpu: 250m
proxy:
  replicas: 1
ingress:
  enabled: true
  className: nginx
  tls:
    - secretName: home-tls
      hosts: [$HOME_HOST]
EOF
h install home "$CHART" -n home "${APPLY[@]}" -f "$WORK/home-values.yaml" --set-string image.tag="$TAG" >/dev/null \
  || die "helm install home"
k -n home set env deployment/anyray-gateway ANYRAY_METERING_ENABLED=false >/dev/null || die "home metering off"
k -n home rollout status statefulset/anyray-postgres --timeout=600s >/dev/null || die "home Postgres never rolled out"
for d in anyray-gateway anyray-optimizer; do
  k -n home rollout status "deployment/$d" --timeout=900s >/dev/null || die "home $d never rolled out"
done

log "mint region $REGION_NAME on home"
# POST /admin/v1/regions (regions:write, deployment owner) answers 201 { region, token }.
# The admin token never leaves the home pod: node reads it from the pod's own env.
k -n home exec deploy/anyray-gateway -c gateway -- node -e '
  fetch("http://127.0.0.1:8787/admin/v1/regions", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.ANYRAY_ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ name: process.argv[1] }),
  }).then(async (r) => { process.stdout.write(await r.text()); process.exit(r.status === 201 ? 0 : 1); })
    .catch((e) => { console.error(String(e)); process.exit(1); });
' "$REGION_NAME" >"$WORK/mint.json" || die "mint region: $(jq -c 'del(.token)' "$WORK/mint.json" 2>/dev/null)"

log "region: topology region against home"
k create namespace region >/dev/null
mkdir -m 700 "$WORK/region-secrets"
jq -j '.token' "$WORK/mint.json" >"$WORK/region-secrets/ANYRAY_REGION_TOKEN"
grep -q '^arr_' "$WORK/region-secrets/ANYRAY_REGION_TOKEN" || die "mint response has no region token"
gen "$WORK/region-secrets" ANYRAY_OPTIMIZER_TOKEN "" 32
gen "$WORK/region-secrets" POSTGRES_PASSWORD "" 16
k -n region create secret generic anyray-secrets --from-file="$WORK/region-secrets" >/dev/null || die "region Secret"
k -n region create configmap home-ca --from-file=ca.crt="$WORK/ca.crt" >/dev/null || die "home CA ConfigMap"
cat >"$WORK/region-values.yaml" <<EOF
topology: region
host: $REGION_HOST
postgres:
  storage: 150Gi
autoUpdate:
  enabled: false
gateway:
  replicas: 1
  extraVolumes:
    - name: home-ca
      configMap:
        name: home-ca
  extraVolumeMounts:
    - name: home-ca
      mountPath: /etc/anyray/home-ca
      readOnly: true
  extraEnv:
    - name: NODE_EXTRA_CA_CERTS
      value: /etc/anyray/home-ca/ca.crt
optimizer:
  replicas: 1
  resources:
    requests:
      cpu: 250m
EOF
h install region "$CHART" -n region "${APPLY[@]}" -f "$WORK/region-values.yaml" --set-string image.tag="$TAG" >/dev/null \
  || die "helm install region"
started=$(date +%s)
k -n region rollout status statefulset/anyray-postgres --timeout=300s >/dev/null || die "region Postgres never rolled out"

# Each probe prints one line: PASS or the observed value.
home_lists_region() {
  k -n home exec deploy/anyray-gateway -c gateway -- node -e '
    fetch("http://127.0.0.1:8787/admin/v1/regions", { headers: { authorization: `Bearer ${process.env.ANYRAY_ADMIN_TOKEN}` } })
      .then((r) => r.json()).then((b) => {
        const r = (b.regions || []).find((x) => x.name === process.argv[1]);
        const age = r && r.lastSeenAt ? Date.now() - Date.parse(r.lastSeenAt) : null;
        const ok = age !== null && age < 120000 && r.url === process.argv[2];
        console.log(ok ? "PASS" : r ? `lastSeenAt=${r.lastSeenAt} url=${r.url}` : "no region");
      }).catch((e) => console.log(String(e)));
  ' "$REGION_NAME" "https://$REGION_HOST" 2>&1 | tail -1
}
region_health_reason() {
  k -n region exec deploy/anyray-gateway -c gateway -- node -e '
    fetch("http://127.0.0.1:8787/region-health").then((r) => r.json())
      .then((b) => console.log(b.reason === "lease unavailable" ? "PASS" : `reason=${b.reason}`))
      .catch((e) => console.log(String(e)));
  ' 2>&1 | tail -1
}
region_migrations() {
  local n
  n="$(k -n region exec statefulset/anyray-postgres -c postgres -- \
    psql -U postgres -d postgres -tAc 'SELECT count(*) FROM anyray_region_schema_migrations' 2>&1 | tail -1)"
  case "$n" in '' | 0 | *[!0-9]*) echo "rows=$n" ;; *) echo PASS ;; esac
}
region_livez() {
  k -n region exec deploy/anyray-gateway -c gateway -- node -e '
    fetch("http://127.0.0.1:8787/livez").then((r) => console.log(r.status === 200 ? "PASS" : `status=${r.status}`))
      .catch((e) => console.log(String(e)));
  ' 2>&1 | tail -1
}
# opt_status <path> <json body>: the status (and body head) a POST to the region optimizer answers with its own token.
opt_status() {
  k -n region exec deploy/anyray-optimizer -c optimizer -- /nodejs/bin/node -e '
    fetch(`http://127.0.0.1:8088${process.argv[1]}`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.ANYRAY_OPTIMIZER_TOKEN}`, "content-type": "application/json" },
      body: process.argv[2],
    }).then(async (r) => console.log(`${r.status} ${(await r.text()).slice(0, 120)}`))
      .catch((e) => console.log(String(e)));
  ' "$1" "$2" 2>&1 | tail -1
}
# Region mode: bootstrap-durable answers 404 before auth there; at home it is an admin route.
optimizer_region_mode() {
  local out
  out="$(opt_status /admin/optimizer/bootstrap-durable '{}')"
  case "$out" in "404 "*) echo PASS ;; *) echo "status=$out" ;; esac
}
# Adopted state: a valid optimize body answers 200; without home's state it is 503 region_state_pending.
optimizer_adopted_state() {
  local out
  out="$(opt_status /v1/optimize '{"endpoint":"/v1/messages","request":{"model":"synthetic-model","max_tokens":16,"messages":[{"role":"user","content":"hello"}]}}')"
  case "$out" in "200 "*) echo PASS ;; *) echo "status=$out" ;; esac
}

log "D8 checks, up to ${DEADLINE_S}s after the region install"
CHECKS=(home_lists_region region_health_reason region_migrations region_livez optimizer_region_mode optimizer_adopted_state)
declare -A RESULT
while :; do
  pending=0
  for c in "${CHECKS[@]}"; do
    [ "${RESULT[$c]:-}" = PASS ] && continue
    RESULT[$c]="$($c)"
    [ "${RESULT[$c]}" = PASS ] || pending=$((pending + 1))
  done
  [ "$pending" = 0 ] && break
  [ $(($(date +%s) - started)) -ge "$DEADLINE_S" ] && break
  sleep 5
done
echo "after $(($(date +%s) - started))s:"
for c in "${CHECKS[@]}"; do
  if [ "${RESULT[$c]}" = PASS ]; then echo "PASS  $c"; else echo "FAIL  $c: ${RESULT[$c]}"; FAILS=$((FAILS + 1)); fi
done

if [ "$FAILS" != 0 ]; then
  log "diagnostics"
  k get pods -A -o wide
  for d in anyray-gateway anyray-optimizer; do
    echo "--- region $d (last 40 lines)"
    k -n region logs "deploy/$d" --all-containers --tail=40 2>&1 | cut -c1-240
  done
fi

log "RESULT: $FAILS failure(s)"
[ "$FAILS" = 0 ]
