# Anyray Helm Chart

Deploys the full Anyray stack — gateway, optimizer, proxy (console), and Postgres
— to any Kubernetes cluster. No external chart dependencies; all services are
self-contained in this chart. The gateway persists content-free traces, spend,
and observations to Postgres (`anyray_traces` / `anyray_observations`,
auto-created; any stored content is AES-256-GCM encrypted at rest) and reads them
in-process — there is no separate observability backend to run.

## Prerequisites

- Kubernetes 1.24+
- Helm 3.10+
- A default StorageClass (or set `*.storageClass` in values)
- A target namespace that already exists, if you install outside your current namespace
- `setup.sh --k8s --connect <adt_token>` run locally to generate the Secret manifest

## Install

```bash
# 1. Choose the namespace (optional, but recommended)
export ANYRAY_NAMESPACE="team-ai"   # replace with your target namespace

# 2. Generate secrets
./setup.sh --k8s --connect adt_XXXX --host <your-hostname-or-ip> --namespace "$ANYRAY_NAMESPACE"
# Emits: anyray-secrets.yaml  my-values.yaml

# 3. Apply the Secret
kubectl apply -n "$ANYRAY_NAMESPACE" -f anyray-secrets.yaml

# 4. Install the chart
helm install anyray ./helm -f my-values.yaml --namespace "$ANYRAY_NAMESPACE"

# 5. Wait for pods
kubectl rollout status -n "$ANYRAY_NAMESPACE" deployment/anyray-gateway
kubectl rollout status -n "$ANYRAY_NAMESPACE" deployment/anyray-proxy

# 6. Access
#   Ingress:  console https://<host>/  gateway https://<host>/v1
#   NodePort: console http://<node-ip>:30000  gateway http://<node-ip>:30787
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

Note: the `gateway` and `optimizer` Services use bare (unprefixed) names because
nginx inside the proxy image hardcodes those upstream hostnames. Install the chart
in its own namespace to avoid name collisions.

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

For TLS / Ingress installs, set the gateway and console public URLs explicitly so
links and auth callbacks use the externally reachable scheme and host:

```yaml
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
`optimizer`, `proxy`, or `postgres` blocks. A component-level value replaces the
global for that field (it does not merge); an unset component inherits the global.
Use it to place a specific workload on its own node pool — for example, keep the
Postgres pod on a dedicated instance type while everything else stays on the
default nodes:

```yaml
postgres:
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
    tag: stable
  optimizer:
    repository: registry.example.com/anyray/optimizer
    tag: stable
  postgres:
    repository: registry.example.com/postgres
    tag: "17"
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
  rateLimitIpRpm: "1200"
  rateLimitUnauthRpm: "60"
  maxConcurrentRequests: "20"
  maxBodyBytes: "10485760"
```

Use `gateway.extraEnv`, `optimizer.extraEnv`, or `proxy.extraEnv` for advanced
environment variables not modeled directly.

## External Postgres

The chart bundles a single-replica Postgres StatefulSet for the gateway's trace +
spend store. To use a managed database instead, disable the bundled StatefulSet
and point the gateway at your external endpoint (the gateway reads it as
`ANYRAY_OBSERVABILITY_DB_URL`). Prefer a Secret reference for the credential:

```yaml
postgres:
  enabled: false
  external:
    databaseUrlSecretKeyRef:
      name: anyray-external-postgres
      key: DATABASE_URL
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
- **Single-replica bundled Postgres.** The bundled Postgres is a `replicas: 1`
  StatefulSet — adequate for most orgs, but not HA. Use the external-Postgres
  values above for a managed cloud equivalent.

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

### Mixed-architecture clusters (arm64 + amd64 nodes)

Every image the chart ships is a **multi-arch manifest list** (`linux/amd64` +
`linux/arm64`) — the gateway, optimizer, and proxy images plus Postgres — so
Kubernetes schedules each pod onto any node and pulls the matching architecture
automatically. **No `nodeSelector` by architecture is required.**

To deliberately pin a workload to a node pool (e.g. keep Postgres on a specific
instance type), set `nodeSelector` / `affinity` / `tolerations` /
`topologySpreadConstraints` — either globally (every pod) or **per component** on
the individual `gateway` / `optimizer` / `proxy` / `postgres` blocks. See
[Cluster policy knobs](#cluster-policy-knobs).
