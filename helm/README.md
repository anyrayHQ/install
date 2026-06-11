# Anyray Helm Chart

Deploys the full Anyray stack to any Kubernetes cluster. No external chart
dependencies — all services are self-contained in this chart.

## Prerequisites

- Kubernetes 1.24+
- Helm 3.10+
- A default StorageClass (or set `*.storageClass` in values)
- `setup.sh --k8s` run locally to generate the Secret manifest

## Install

```bash
# 1. Generate secrets
./setup.sh --k8s --host <your-hostname-or-ip>
# Emits: anyray-secrets.yaml  my-values.yaml

# 2. Apply the Secret
kubectl apply -f anyray-secrets.yaml

# 3. Install the chart
helm install anyray ./helm -f my-values.yaml

# 4. Wait for pods
kubectl rollout status deployment/anyray-gateway
kubectl rollout status deployment/anyray-web

# 5. Access
#   Console: http://<host>:3000  (via NodePort or Ingress — see values.yaml)
#   Gateway: http://<host>:8787
```

## Upgrade

```bash
git pull
helm upgrade anyray ./helm -f my-values.yaml
```

## Exposing services

By default all Services are `ClusterIP`. To expose externally:

**NodePort (simplest for on-prem / bare metal):**
```bash
kubectl patch svc anyray-proxy -p '{"spec":{"type":"NodePort","ports":[{"port":3000,"nodePort":30000}]}}'
kubectl patch svc anyray-gateway -p '{"spec":{"type":"NodePort","ports":[{"port":8787,"nodePort":30787}]}}'
```

**LoadBalancer (cloud providers):**
Edit `values.yaml` — change the `type:` for proxy and gateway Services to `LoadBalancer`.

**Ingress:** Set `ingress.enabled: true` in your values file and fill in `ingress.className`
and any cert-manager annotations. See the commented example in `values.yaml`.

## v1 limitations to be aware of

- **Gateway and optimizer state is on single-attach PVCs.** Provider keys, routing
  config, spend and audit logs persist across pod restarts and upgrades (the PVCs
  also survive `helm uninstall` via a `helm.sh/resource-policy: keep` annotation).
  The trade-off: the volumes are `ReadWriteOnce`, so these Deployments use a
  `Recreate` strategy (brief downtime on upgrade) and must stay at `replicas: 1` —
  the chart fails fast if you raise replicas with persistence enabled. Scaling
  beyond one replica requires moving gateway state out of files (planned follow-up).
  Set `gateway.persistence.enabled: false` to fall back to ephemeral `emptyDir`.
- **Single-replica datastores.** Postgres, ClickHouse, MinIO, Redis are all `replicas: 1`
  StatefulSets — adequate for most orgs, but not HA. Use managed cloud equivalents
  (RDS, Cloud SQL, etc.) by pointing the env vars at an external host and removing the
  corresponding StatefulSet from the chart.

## Secrets

All secrets live in a single Kubernetes Secret named `anyray-secrets` (configurable
via `values.secretName`). Generate it with `./setup.sh --k8s`. Never commit
`anyray-secrets.yaml` — it is in `.gitignore` at the install repo root.

## Uninstall

```bash
helm uninstall anyray
kubectl delete -f anyray-secrets.yaml
# To also delete PVC data (destructive):
kubectl delete pvc -l app.kubernetes.io/instance=anyray
```
