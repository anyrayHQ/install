# Anyray Helm Chart

Deploys the full Anyray stack to any Kubernetes cluster. No external chart
dependencies — all services are self-contained in this chart.

## Prerequisites

- Kubernetes 1.24+
- Helm 3.10+
- A default StorageClass (or set `*.storageClass` in values)
- A target namespace that already exists, if you install outside your current namespace
- `setup.sh --k8s` run locally to generate the Secret manifest

## Install

```bash
# 1. Choose the namespace (optional, but recommended)
export ANYRAY_NAMESPACE="team-ai"   # replace with your target namespace

# 2. Generate secrets
./setup.sh --k8s --host <your-hostname-or-ip> --namespace "$ANYRAY_NAMESPACE"
# Emits: anyray-secrets.yaml  my-values.yaml

# 3. Apply the Secret
kubectl apply -n "$ANYRAY_NAMESPACE" -f anyray-secrets.yaml

# 4. Install the chart
helm install anyray ./helm -f my-values.yaml --namespace "$ANYRAY_NAMESPACE"

# 5. Wait for pods
kubectl rollout status -n "$ANYRAY_NAMESPACE" deployment/anyray-gateway
kubectl rollout status -n "$ANYRAY_NAMESPACE" deployment/anyray-web

# 6. Access
#   Console: http://<host>:3000  (via NodePort or Ingress — see values.yaml)
#   Gateway: http://<host>:8787
```

Use an existing namespace unless your cluster policy says the installer should
create one. If you are allowed to create it, run
`kubectl create namespace "$ANYRAY_NAMESPACE"` before applying the Secret.
Omit `--namespace` and the `-n` / `--namespace` flags to use your current kubectl
and Helm namespace. `setup.sh` never creates a namespace automatically and never
assumes `default`.

## Upgrade

```bash
git pull
helm upgrade anyray ./helm -f my-values.yaml --namespace "$ANYRAY_NAMESPACE"
```

## Connect to Anyray Cloud (metering)

To meter usage and receive a signed entitlement lease (so the deployment shows
**Connected** in the portal), generate the manifests with `--connect`:

```bash
./setup.sh --k8s --connect adt_XXXX --host <your-hostname-or-ip> --namespace "$ANYRAY_NAMESPACE"
```

This folds `ANYRAY_DEPLOYMENT_TOKEN` and a locally-generated `ANYRAY_PSEUDONYM_SALT`
into `anyray-secrets.yaml` and sets `gateway.metering.enabled: true` in `my-values.yaml`.
The chart then injects the metering env into the gateway (the token + salt are read from
the Secret; the control-plane host and the vendor verify key stay pinned in the gateway
image). Without `--connect` the install is fully standalone (`gateway.metering.enabled: false`).

The pseudonym salt never leaves your cluster — it pseudonymizes employee identifiers
before the content-free usage rollup is sent. Tune cadence with
`gateway.metering.intervalMs` / `gateway.metering.graceMs`.

## Exposing services

By default all Services are `ClusterIP`. To expose externally:

**NodePort (simplest for on-prem / bare metal):**
```yaml
proxy:
  service:
    type: NodePort
    nodePort: 30000
gateway:
  service:
    type: NodePort
    nodePort: 30787
```

Note: the `gateway`, `web`, and `optimizer` Services use bare (unprefixed) names
because nginx inside the proxy image hardcodes those upstream hostnames. Install
the chart in its own namespace to avoid name collisions.

**LoadBalancer (cloud providers):**
Set the proxy and gateway service type in `my-values.yaml`, and scope traffic to your org/VPN:
```yaml
proxy:
  service:
    type: LoadBalancer
    loadBalancerSourceRanges:
      - 203.0.113.0/24
gateway:
  service:
    type: LoadBalancer
    loadBalancerSourceRanges:
      - 203.0.113.0/24
```

**Ingress:** Set `ingress.enabled: true` in your values file and fill in `ingress.className`
and any cert-manager annotations. See the commented example in `values.yaml`.

For TLS / Ingress installs, set the console's public URL explicitly so auth
callbacks use the externally reachable scheme and host:

```yaml
web:
  nextauthUrl: https://anyray.example.com
gateway:
  publicUrl: https://anyray.example.com
  consolePublicUrl: https://anyray.example.com
```

If you need multiple Ingress hosts or non-default paths, use `ingress.hosts`:

```yaml
ingress:
  enabled: true
  className: nginx
  hosts:
    - host: anyray.example.com
      paths:
        console: /
        gateway: /v1
        admin: /admin
```

## Cluster policy knobs

Set these values when your cluster requires a specific service account, private
registry pull secret, scheduling constraints, or pod security context:

```yaml
serviceAccount:
  create: true
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/anyray

image:
  pullSecrets:
    - name: ghcr-pull-secret

nodeSelector:
  workload: ai-platform
tolerations:
  - key: dedicated
    operator: Equal
    value: ai-platform
    effect: NoSchedule
podSecurityContext:
  runAsNonRoot: true
containerSecurityContext:
  allowPrivilegeEscalation: false
```

All component images can be redirected to an internal registry:

```yaml
images:
  gateway:
    repository: registry.example.com/anyray/gateway
    tag: v1.10.3
  optimizer:
    repository: registry.example.com/anyray/optimizer
    tag: v1.10.3
  web:
    repository: registry.example.com/langfuse/langfuse
    tag: "3"
```

## Gateway runtime knobs

Gateway security and traffic controls are first-class Helm values:

```yaml
gateway:
  requireClientKeys: "true"
  requireVerifiedDev: "true"
  hsts: "true"
  trustProxy: "true"
  rateLimitRpm: "600"
  rateLimitUnauthRpm: "60"
  maxBodyBytes: "10485760"
```

Use `gateway.extraEnv`, `optimizer.extraEnv`, `web.extraEnv`, `worker.extraEnv`,
or `proxy.extraEnv` for advanced environment variables not modeled directly.

## External backing services

The chart is self-contained by default. To use managed services, disable the
bundled StatefulSet and point the web/worker pods at your external endpoint.
Prefer Secret references for credentials:

```yaml
postgres:
  enabled: false
  external:
    databaseUrlSecretKeyRef:
      name: anyray-external-postgres
      key: DATABASE_URL

clickhouse:
  enabled: false
  external:
    migrationUrl: clickhouse://clickhouse.example.com:9000
    url: https://clickhouse.example.com:8123
    user: clickhouse
    passwordSecretKeyRef:
      name: anyray-external-clickhouse
      key: CLICKHOUSE_PASSWORD

minio:
  enabled: false
objectStorage:
  accessKeyIdSecretKeyRef:
    name: anyray-external-s3
    key: AWS_ACCESS_KEY_ID
  secretAccessKeySecretKeyRef:
    name: anyray-external-s3
    key: AWS_SECRET_ACCESS_KEY
  eventUpload:
    bucket: anyray-langfuse
    region: us-east-1
    endpoint: https://s3.amazonaws.com
    forcePathStyle: "false"
  mediaUpload:
    bucket: anyray-langfuse
    region: us-east-1
    endpoint: https://s3.amazonaws.com
    forcePathStyle: "false"

redis:
  enabled: false
  external:
    host: redis.example.com
    port: "6379"
    authSecretKeyRef:
      name: anyray-external-redis
      key: REDIS_AUTH
```

## v1 limitations to be aware of

- **Gateway and optimizer state is on single-attach PVCs.** Provider keys, routing
  config, spend and audit logs persist across pod restarts and upgrades (the PVCs
  also survive `helm uninstall` via a `helm.sh/resource-policy: keep` annotation).
  The trade-off: the volumes are `ReadWriteOnce`, so these Deployments use a
  `Recreate` strategy (brief downtime on upgrade) and must stay at `replicas: 1` —
  the chart fails fast if you raise replicas with persistence enabled. Scaling
  beyond one replica requires moving gateway state out of files (planned follow-up).
  Set `gateway.persistence.enabled: false` to fall back to ephemeral `emptyDir`.
- **Single-replica bundled datastores.** Postgres, ClickHouse, MinIO, Redis are
  all `replicas: 1` StatefulSets when enabled — adequate for most orgs, but not
  HA. Use the external-service values above for managed cloud equivalents.

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

Add `--namespace "$ANYRAY_NAMESPACE"` to `helm uninstall` and `-n "$ANYRAY_NAMESPACE"`
to `kubectl delete` commands when you installed into a specific namespace.
