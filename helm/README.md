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

## Connect to Anyray Portal (metering)

Metering is **on by default** (`gateway.metering.enabled: true`) — every deployment
connects to Anyray Portal for content-free usage rollups and a signed entitlement lease.
Generate the manifests with `--connect` so the Secret carries a deployment token:

```bash
./setup.sh --k8s --connect adt_XXXX --host <your-hostname-or-ip> --namespace "$ANYRAY_NAMESPACE"
```

This folds `ANYRAY_DEPLOYMENT_TOKEN` and a locally-generated `ANYRAY_PSEUDONYM_SALT`
into `anyray-secrets.yaml` and keeps `gateway.metering.enabled: true` in `my-values.yaml`.
The chart then injects the metering env into the gateway (the token + salt are read from
the Secret; the control-plane host and the vendor verify key stay pinned in the gateway
image). If you install with `enabled: true` but no deployment token in the Secret, the
gateway serves through the first-boot grace window and then blocks `/v1` until a token is
wired — so always generate the Secret with `--connect`.

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

`nodeSelector`, `affinity`, `tolerations`, `topologySpreadConstraints`, and
`priorityClassName` can also be set **per component**, on any of the `gateway`,
`optimizer`, `proxy`, `web`, `worker`, `postgres`, `clickhouse`, `minio`, or
`redis` blocks. A component-level value replaces the global for that field (it does
not merge); an unset component inherits the global. Use it to place a specific
workload on its own node pool — for example, keep the heavy ClickHouse pod on a
dedicated instance type while everything else stays on the default nodes:

```yaml
clickhouse:
  nodeSelector:
    node.kubernetes.io/instance-type: r6i.xlarge
  tolerations:
    - key: dedicated
      operator: Equal
      value: data-plane
      effect: NoSchedule
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

## Troubleshooting

### Postgres won't start — `initdb: directory "/var/lib/postgresql/data" exists but is not empty` / `lost+found`

A volume mounted at the root of an `ext4` filesystem — which is what most cloud
block stores provision, e.g. an **AWS EBS** PVC — always contains a `lost+found`
directory, and Postgres's `initdb` refuses any non-empty data directory. The chart
avoids this by initializing into a `pgdata` subdirectory of the mount
(`PGDATA=/var/lib/postgresql/data/pgdata`). If you fork the Postgres template or
mount your own volume, keep `PGDATA` (or a `subPath`) pointed at a subdirectory,
never the mount root.

### MinIO crashes on start — `mkdir: cannot create directory '/data/langfuse': Permission denied`

The bundled MinIO image runs as a nonroot user (uid `65532`). A freshly provisioned
PVC is root-owned, so without an `fsGroup` the nonroot process can't create its
bucket directory. The chart sets `minio.podSecurityContext.fsGroup: 65532` so the
kubelet chowns the volume on mount. If you override `minio.podSecurityContext`, keep
an `fsGroup` that matches the image's run user, or the volume stays unwritable.

### Mixed-architecture clusters (arm64 + amd64 nodes)

Every image the chart ships is a **multi-arch manifest list** (`linux/amd64` +
`linux/arm64`) — the five Anyray images plus the observability backend, Postgres, ClickHouse, Redis,
and MinIO — so Kubernetes schedules each pod onto any node and pulls the matching
architecture automatically. **No `nodeSelector` by architecture is required.**

The one thing to watch: MinIO is pinned by digest (Chainguard's free tier only
publishes `:latest`). That pin **must reference the multi-arch index digest**, not a
single-platform child manifest — otherwise the MinIO pod fails to schedule on the
"other" architecture's nodes. The default in `values.yaml` is an index digest;
refresh it with `docker buildx imagetools inspect cgr.dev/chainguard/minio:latest`
and confirm the result is an `image.index` (manifest list) before re-pinning.

To deliberately pin workloads to a node pool (e.g. keep ClickHouse on a specific
instance type), set `nodeSelector` / `affinity` / `tolerations` /
`topologySpreadConstraints` — either globally (every pod) or **per component** on
the individual `gateway` / `clickhouse` / `minio` / … blocks. See
[Cluster policy knobs](#cluster-policy-knobs).
