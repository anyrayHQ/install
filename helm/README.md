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

## Install from the OCI registry (recommended for ArgoCD / GitOps)

The chart is published as an OCI artifact to the same public registry as the
images — no git clone, no `setup.sh`:

```bash
helm install anyray oci://public.ecr.aws/anyray/anyray \
  --version <x.y.z> \
  --namespace "$ANYRAY_NAMESPACE" \
  -f my-values.yaml
```

Browse released versions with `helm show chart oci://public.ecr.aws/anyray/anyray`.
Pulls are anonymous — nothing to authenticate.

### ArgoCD

Point an Application straight at the OCI chart:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: anyray
  namespace: argocd
spec:
  project: default
  source:
    repoURL: public.ecr.aws/anyray   # registry, no chart name
    chart: anyray
    targetRevision: 0.4.17             # a released chart version
    helm:
      valuesObject:
        host: anyray.example.com
        gateway:
          publicUrl: https://anyray.example.com
          consolePublicUrl: https://anyray.example.com
        # image.tag omitted → pinned to the chart's appVersion (see note below)
  destination:
    server: https://kubernetes.default.svc
    namespace: team-ai
```

The chart reads every credential from a Secret named `anyray-secrets` (see
[Secrets](#secrets)). Manage it the GitOps way — External Secrets Operator,
Sealed Secrets, or SOPS — or apply a plain manifest once. You do **not** need
`setup.sh` for a GitOps install; it is only a local convenience that writes that
Secret plus a starter values file, and it never runs inside your cluster. The two
keys that must be present are `ANYRAY_DEPLOYMENT_TOKEN` (your `adt_…` connect
token) and an `ANYRAY_PSEUDONYM_SALT` you generate once and keep in-cluster.

> **Image tags are pinned by default.** Each chart version ships a fixed
> `appVersion`, and images default to it — so a given `targetRevision` always
> deploys the same, auditable build, exactly what you want under GitOps. To
> follow compatible production builds instead, set `image.tag: policy-stable` in
> your values; the chart forces `imagePullPolicy: Always` for that channel.
> Kubernetes still needs an explicit rollout restart to resolve a new digest.
> Leave the tag unset for reproducible production deployments.

## Install from source (setup.sh)

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
# Run before the first upgrade from an older Secret. Safe to repeat.
./setup.sh --k8s --connect adt_XXXX --host <your-hostname-or-ip> --namespace "$ANYRAY_NAMESPACE"
kubectl apply -n "$ANYRAY_NAMESPACE" -f anyray-secrets.yaml
helm upgrade anyray ./helm -f my-values.yaml --namespace "$ANYRAY_NAMESPACE"
```

Apply the updated Secret before upgrading. The gateway pod will not start
without `ANYRAY_DEPLOYMENT_TOKEN` and `ANYRAY_PSEUDONYM_SALT`.

When following `policy-stable`, restart the app Deployments after each channel
promotion so Kubernetes resolves the new digest:

```bash
kubectl rollout restart deployment -n "$ANYRAY_NAMESPACE" \
  -l app.kubernetes.io/instance=anyray
kubectl rollout status deployment -n "$ANYRAY_NAMESPACE" \
  -l app.kubernetes.io/instance=anyray --timeout=10m
```

### Rollout behaviour and downtime

**With the default values an upgrade is not seamless, by construction.** Bundled
persistence puts the gateway and optimizer on a `ReadWriteOnce` PVC, which one node
must release before the replacement pod can mount it, so both Deployments use
`strategy: Recreate`: every old pod stops, and only then does a new one start.
Callers get connection failures through the proxy for as long as the replacement
takes to boot and pass its readiness probe. No setting makes a rolling update
possible while a single-attach volume is in play.

For a genuinely gap-free roll, take the components off the PVC — the chart then
switches them to `RollingUpdate` with `maxUnavailable` held at zero, so a
replacement is Ready before any old pod is retired (this holds even at one
replica, since the strategy surges a second pod first):

```yaml
gateway:
  persistence:
    enabled: false
  replicas: 2
optimizer:
  persistence:
    enabled: false
  replicas: 2
```

Read the trade-off in `## v1 limitations` below first: `emptyDir` means the gateway
state still kept in files resets when a pod is replaced — the runtime settings JSON
(content-capture mode, heartbeat tier), the entitlement-lease cache, the optimizer's
runtime config, and for now the default routing config. Everything
security-relevant — client keys, provider keys, per-user caps, model aliases, team
policy, the audit trail — already lives in Postgres and is unaffected, as are spend
and trace history.

Independent of the strategy, three values shape how termination is handled, and
each is overridable per component:

| Value | Default | What it does |
| --- | --- | --- |
| `preStopDrainSeconds` | `5` | Keeps a pod serving after termination starts but before SIGTERM, so requests stop arriving before the process stops listening. On the `Recreate` path this also lengthens the gap, since nothing starts until the old pod is gone — set `0` to trade in-flight requests for a shorter window. |
| `terminationGracePeriodSeconds` | `120` | Budget from "terminating" to SIGKILL. Must exceed `preStopDrainSeconds` plus the gateway's own drain of in-flight requests (`ANYRAY_SHUTDOWN_DRAIN_MS`, default 90000), or streams are cut mid-response and the developer's tool reports "Connection closed mid-response". A ceiling, not a delay; the chart refuses to render if the sum no longer fits. |
| `minReadySeconds` | `10` | How long a new pod must stay Ready before the rollout counts it available, so a pod that passes one probe and then crashes cannot retire the previous version. |
| `progressDeadlineSeconds` | `300` | How long a rollout may make no progress before it is marked failed. Unset, Kubernetes waits 600s, so a rollout whose pods never pass their probes stalls silently for ten minutes. Since `maxUnavailable` is 0 the outgoing pods serve throughout, so a shorter deadline costs no traffic — it is what makes `helm upgrade --atomic` roll back promptly. Must exceed `minReadySeconds`. |
| `revisionHistoryLimit` | `3` | Retired ReplicaSets kept per Deployment for rollback (Kubernetes default 10). |

### Probes

Each workload has a **readiness** probe (is this pod fit to receive traffic?) and,
from appVersion `v1.10.222`, a **liveness** and **startup** probe (should the
kubelet restart this pod?).

The liveness probe exists for one failure that readiness cannot fix: a *wedged*
process — an exhausted connection pool, a hung await — is up, gets pulled from the
Service by readiness, and is then never restarted. At `replicas: 1` that is a
silent permanent outage.

| Value | Default | What it does |
| --- | --- | --- |
| `livenessProbe.enabled` | `true` | Restarts a wedged pod. Targets `/livez` (gateway) or `/health` (optimizer) — deliberately **not** the readiness route, which turns 503 while draining; a liveness probe there would restart the pod mid-drain and reset every in-flight stream. Neither route checks a dependency, so a database blip cannot crashloop the fleet. |
| `livenessProbe.failureThreshold` x `periodSeconds` | `6` x `10s` | A full minute of failure before a restart. Slack on purpose: restarting a merely-slow pod is itself an outage. |
| `startupProbe.enabled` | `true` | Holds liveness off until the process answers once, so the liveness budget above need not cover a cold start. 60 x 5s, sized for a replica applying the migration ledger under an advisory lock. |
| `postgres.livenessProbe.enabled` | `true` | `pg_isready` against the bundled Postgres, with slack thresholds — interrupting crash recovery is worse than waiting it out. |

The gateway's probes render **only for an image that serves `/livez`** (appVersion
`v1.10.222` or later, or the `policy-stable` channel). Pinned to an earlier tag the
chart omits them rather than 404 every check and crashloop the deployment.

A `PodDisruptionBudget` (`podDisruptionBudget.maxUnavailable`, default `1`) is
created for each Deployment that runs two or more pods, capping how many pods a
node drain or autoscaler scale-down may remove at once. It is deliberately not
created for a single-replica workload: such a budget could never allow its only
pod to be evicted, and `kubectl drain` would block indefinitely on a node upgrade.
At the default `replicas: 1` that means only the proxy is covered.

`podDisruptionBudget.unhealthyPodEvictionPolicy` defaults to `AlwaysAllow`.
Kubernetes' own default (`IfHealthyBudget`) refuses to evict pods that are running
but not Ready unless the workload is already at full health, which makes a broken
workload permanently undrainable — a node upgrade then blocks forever on exactly
the pods serving no traffic. `AlwaysAllow` still protects every Ready pod through
`maxUnavailable`. Requires Kubernetes 1.26+; older clusters ignore the field.

### Spreading replicas across nodes

With no `affinity` set, the chart applies **soft** (preferred) pod anti-affinity
per component: replicas separate by `kubernetes.io/hostname` first, then by
`topology.kubernetes.io/zone`. Without it, two replicas routinely land on one
node, and a single node drain takes out the whole workload the second replica
exists to protect. Soft rather than required is deliberate — a required rule on a
single-node or capacity-tight cluster leaves pods `Pending` forever. Setting
`affinity` (globally or per component) replaces this wholesale.

## Billing

Billing is required. The chart always enables content-free usage metering.
Create or update the Secret with:

```bash
./setup.sh --k8s --connect adt_XXXX --host <your-hostname-or-ip> --namespace "$ANYRAY_NAMESPACE"
```

`setup.sh` adds the deployment token and a local pseudonym salt to
`anyray-secrets.yaml`. The chart requires both keys. The Billing URL and
verification key are pinned in the gateway image, and the salt stays in your
cluster. Tune the reporting interval with
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

The `/v1` path carries streaming completions that run for minutes and request bodies over a
megabyte, which ingress-nginx's stock 60s `proxy-read-timeout` and 1 MB `proxy-body-size` both cut
short. `ingress.streamingDefaults` (default `true`) therefore adds `proxy-read-timeout` and
`proxy-send-timeout` `3600`, `proxy-body-size` `32m`, and `proxy-buffering` `off`. Anything you set
in `ingress.annotations` wins over these key by key; set `streamingDefaults: false` to drop them
entirely. On the Gateway API path, `httpRoute.streamingDefaults` (default `true`) disables the
request timeout on the `/v1` and `/connect` rules, because an unset Gateway API request timeout is
implementation-specific and some implementations apply a value far below one completion.

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

All component images can be redirected to an internal registry. This changes
image distribution only; the deployment must still connect to the Anyray
Billing app. Leave the app `tag` empty to keep the chart's pinned appVersion,
or set a concrete `vX.Y.Z`:

```yaml
images:
  gateway:
    repository: registry.example.com/anyray/gateway
    tag: ""            # inherits the chart appVersion
  optimizer:
    repository: registry.example.com/anyray/optimizer
    tag: ""
  postgres:
    repository: registry.example.com/postgres
    tag: "17"
```

**Running NetworkPolicies?** The chart ships none, but if your cluster enforces
default-deny, allow — in addition to the obvious proxy→gateway→optimizer lanes —
**optimizer → Postgres on 5432**. The gateway auto-provisions the optimizer's
durable context stash against the same database at boot (no values change
involved), so this lane is easy to miss. Blocking it is non-fatal: the optimizer
declines the persist within its budget and falls back to in-memory (stashed
context then won't survive a pod restart). The symptom is
`Context stash persist failed: ETIMEDOUT` in the optimizer logs.

## Gateway runtime knobs

`/v1/*` is always restricted to verified developers (a minted client key) —
secure-by-default, no toggle. The remaining gateway security and traffic controls
are first-class Helm values:

```yaml
gateway:
  hsts: "true"
  trustProxy: "true"
  rateLimitRpm: "600"
  rateLimitIpRpm: "1200"
  rateLimitUnauthRpm: "60"
  maxConcurrentRequests: "20"
  maxBodyBytes: "10485760"
```

Use `gateway.extraEnv`, `optimizer.extraEnv`, or `proxy.extraEnv` for advanced
environment variables not modeled directly. Billing variables cannot be
overridden through `gateway.extraEnv`.

## Scaling

The proxy is stateless and defaults to two replicas. Enable its HPA when console
traffic needs to scale with cluster load:

```yaml
proxy:
  autoscaling:
    enabled: true
    minReplicas: 2
    maxReplicas: 10
```

Gateway and optimizer HPAs are also available, but the bundled data PVCs are
`ReadWriteOnce`, so autoscaling those components requires disabling their bundled
persistence and providing an external/shared state plan for production:

```yaml
gateway:
  persistence:
    enabled: false
  autoscaling:
    enabled: true
    minReplicas: 2
    maxReplicas: 10
optimizer:
  persistence:
    enabled: false
  autoscaling:
    enabled: true
    minReplicas: 2
    maxReplicas: 10
```

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

If the managed database sits behind a firewall or security-group allowlist,
permit **both the gateway and the optimizer pods** (in practice: the cluster's
egress source, e.g. the node or NAT addresses). The gateway hands the optimizer
this database for its durable context stash at boot, so an allowlist written for
the gateway alone silently degrades the optimizer to in-memory stash
(`Context stash persist failed: ETIMEDOUT` in its logs).

## v1 limitations to be aware of

- **Gateway and optimizer state is on single-attach PVCs — but much less of it than
  it used to be.** Everything security- or spend-relevant already lives in the shared
  Postgres rather than on these volumes: provider keys, client keys, per-user caps,
  model aliases, team policy, the admin/GDPR audit trail, and of course the spend and
  trace history. **Disabling persistence loses none of that.** What is still
  file-backed is the runtime settings JSON (content-capture mode, heartbeat tier), the
  entitlement-lease cache, the optimizer's runtime config, and the default routing
  config — the last of which moves to Postgres in the next gateway release. The PVCs
  also survive `helm uninstall`, via a `helm.sh/resource-policy: keep` annotation.
  The trade-off: the volumes are `ReadWriteOnce`, so these Deployments use a
  `Recreate` strategy — downtime on every upgrade, not merely a risk of it — and
  must stay at `replicas: 1`; the chart fails fast if you raise replicas with
  persistence enabled. Scaling beyond one replica requires moving the rest of that
  file-backed state into Postgres (in progress). Set
  `gateway.persistence.enabled: false` to fall back to ephemeral `emptyDir` and get a
  gap-free `RollingUpdate`, at the cost of resetting the state still held in files —
  see [Rollout behaviour and downtime](#rollout-behaviour-and-downtime).
- **Single-replica bundled Postgres.** The bundled Postgres is a `replicas: 1`
  StatefulSet — adequate for most orgs, but not HA. Use the external-Postgres
  values above for a managed cloud equivalent.

## Secrets

All secrets live in a single Kubernetes Secret named `anyray-secrets` (configurable
via `values.secretName`). Generate it with
`./setup.sh --k8s --connect <adt_token>`. Never commit
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
