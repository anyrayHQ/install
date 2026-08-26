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

**Your values file must set `postgres.storage`.** The gateway keeps 90 days of
trace content by default, so the store grows for three months before the first
prune reclaims anything, and the size lands in a StatefulSet
`volumeClaimTemplate` that Kubernetes makes immutable. A fresh install below
`postgres.minStorageGi` (50Gi) is refused at render time rather than
provisioning a volume that wedges later:

```yaml
postgres:
  storage: 50Gi     # or your own measured 90-day figure
```

Running a smaller volume deliberately (short `ANYRAY_SPEND_RETENTION_DAYS`, or
`ANYRAY_CONTENT_MODE=off` so no content is stored) needs
`postgres.acknowledgeSmallVolume: true`. ArgoCD and Flux render with `helm
template`, which reports an install, so an existing deployment already below the
floor needs that same line to keep syncing; its live volume is untouched.
Sizing model and the queries that measure your own rate:
https://docs.anyray.ai/get-started/install/choose-your-setup#size-the-datastore-before-you-install

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

**The gateway rolls without a gap by default.** Since chart 0.5.0
`gateway.persistence.enabled` defaults to `false`, which is what allows
`replicas: 2` and the `RollingUpdate` strategy with `maxUnavailable` held at zero:
a replacement is Ready before any old pod is retired.

That volume is `ReadWriteOnce`, so one node must release it before a replacement
can mount it. Any component still on it uses `strategy: Recreate` (every old pod
stops, and only then does a new one start) and is capped at one replica. No
setting makes a rolling update possible while a single-attach volume is in play.

The **optimizer** is still on its PVC by default, so it still rolls that way. The
gateway fails open when the optimizer is unreachable, so this costs money rather
than availability: the fail-open path forwards the original request, busting the
provider prompt cache on every warm session for the length of the gap. Take it
off the volume too if that matters more than its per-pod runtime config:

```yaml
optimizer:
  persistence:
    enabled: false
  replicas: 2
```

Note the optimizer's admin-edited runtime config is per pod, so above one replica
a console change reaches only the pod that served the request.

Running the gateway on `emptyDir` is lossless as of appVersion v1.10.224, and the
chart refuses to render an older image without the volume. Everything an operator
sets now lives in the shared Postgres and is read identically by every replica:
client keys, provider keys, per-user caps, model aliases, team policy, the audit
trail, the runtime settings (content-capture mode, heartbeat tier), the default
routing config, the end-point fleet config, and the fleetd installers. Spend and
trace history were always there.

What still resets with the pod is the entitlement-lease cache, which is
deliberately node-local and re-fetched, and the optimizer's own runtime config if
you take the optimizer off its volume too.

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
from appVersion `v1.10.224`, a **liveness** and **startup** probe (should the
kubelet restart this pod?).

The liveness probe exists for one failure that readiness cannot fix: a *wedged*
process — an exhausted connection pool, a hung await — is up, gets pulled from the
Service by readiness, and is then never restarted. At `replicas: 1` that is a
silent permanent outage.

| Value | Default | What it does |
| --- | --- | --- |
| `livenessProbe.enabled` | `true` | Restarts a wedged pod. Targets `/livez` (gateway) or `/health` (optimizer) — deliberately **not** the readiness route, which turns 503 while draining; a liveness probe there would restart the pod mid-drain and reset every in-flight stream. Neither route checks a dependency, so a database blip cannot crashloop the fleet. |
| `livenessProbe.failureThreshold` x `periodSeconds` | `6` x `10s` | A full minute of failure before a restart. Slack on purpose: restarting a merely-slow pod is itself an outage. |
| `startupProbe.enabled` | `true` | Holds liveness off until the process answers once, so the liveness budget above need not cover a cold start. 360 x 5s = 30 minutes, which must cover a full migration run: the gateway applies the ordered ledger at boot and refuses to serve on an unmigrated schema, so it opens no port until every pending migration has run, and the ledger allows a single statement 30 minutes (`MIGRATION_QUERY_TIMEOUT_MS`). A startup probe only ever delays a *restart*, never traffic, so the budget costs nothing. |
| `postgres.livenessProbe.enabled` | `true` | `pg_isready` against the bundled Postgres, with slack thresholds — interrupting crash recovery is worse than waiting it out. |

The gateway's probes render **only for an image that serves `/livez`** (appVersion
`v1.10.224` or later, or the `policy-stable` channel). Pinned to an earlier tag the
chart omits them rather than 404 every check and crashloop the deployment.

A `PodDisruptionBudget` (`podDisruptionBudget.maxUnavailable`, default `1`) is
created for each Deployment that runs two or more pods, capping how many pods a
node drain or autoscaler scale-down may remove at once. It is deliberately not
created for a single-replica workload: such a budget could never allow its only
pod to be evicted, and `kubectl drain` would block indefinitely on a node upgrade.
At the defaults that covers the gateway and the proxy, both at `replicas: 2`, but
not the optimizer, which stays at one while it keeps its volume.

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

### The end-point agent plane

The `endpoint-control` service (device evidence for employee laptops) is the one
component whose clients live outside the cluster, so it needs a route of its own.
On an Ingress or HTTPRoute install the chart adds three fixed prefixes —
`/api/v1/osquery`, `/api/fleet/orbit`, `/api/v1/evidence` — on the same host the
console and gateway already use. The agent protocol anchors those paths at the
root, so they are not configurable; the gateway serves no `/api/*` route, so
nothing collides, and no second hostname or certificate is involved. Everything
else the service exposes (`/admin/*`, `/readyz`, `/livez`) stays in-cluster: the
gateway reaches its admin plane over the cluster Service.

Two consequences worth knowing before you install:

- **`LoadBalancer` and `NodePort` installs route none of it.** Nothing external
  reaches the agent plane, so the chart deliberately leaves
  `ANYRAY_ENDPOINT_CONTROL_PUBLIC_URL` unset rather than guessing an origin from
  `host` — a guessed origin would be baked into every installer and MDM profile
  the service mints and fail only on the laptop. Expose the plane yourself and
  set `endpoint-control.publicUrl` to the origin that reaches it.
- **`endpoint-control.enabled: false`** drops the Deployment, the Service, the
  ingress rules, and the gateway's pointer at it, leaving the end-point lane
  dormant. Use it if a device-evidence plane hasn't cleared your security review,
  or if you pin `image.tag` below `v1.10.246` — the first release that published
  this image, so older pins have nothing to pull.

## Restricting the optimizer to the gateway

The optimizer is a ClusterIP Service on `:8088` and is deliberately never on the
Ingress, so it is unreachable from outside the cluster. Inside the namespace it
is open: any pod can dial it with the bearer token from `anyray-secrets` and get
the full optimization pipeline, bypassing the gateway — which is the component
that records spend. `networkPolicy.enabled` restricts `:8088` to the gateway
pods.

```yaml
networkPolicy:
  enabled: true
  # Append rules for a caller of your own — a metrics scraper, a second gateway.
  optimizerExtraIngress:
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: prometheus
      ports:
        - protocol: TCP
          port: 8088
```

**It is off by default, and enabling it needs one verification step.** Whether
kubelet's liveness/readiness probes are subject to NetworkPolicy depends on your
CNI, and there is no portable way to express "the node this pod runs on" in a
policy. Cilium and Calico allow host-to-local-pod by default; some others do
not, and on those every optimizer pod fails its liveness probe and crashloops. A
down optimizer is not a safe failure — the gateway fails open and forwards the
original request, busting the provider prompt cache on every warm session, which
costs more than the optimization it lost.

So after enabling it:

```bash
kubectl -n "$ANYRAY_NAMESPACE" rollout status deploy/anyray-optimizer
kubectl -n "$ANYRAY_NAMESPACE" get pods -l app.kubernetes.io/component=optimizer
```

If the pods do not stay Ready, your CNI filters probes: set
`networkPolicy.enabled: false`. On a cluster with no policy controller at all
the rule is silently inert rather than harmful. Note that enabling it also cuts
any Prometheus/OTel scrape of the optimizer unless you add the scraper under
`optimizerExtraIngress`.

This is defence in depth rather than the whole control: the optimizer also
verifies the deployment's signed entitlement lease itself, so a lapsed or
suspended subscription is refused whatever calls it.

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

- **The optimizer is still on a single-attach PVC.** The gateway is not, as of
  chart 0.5.0: everything an operator sets moved to the shared Postgres, so it runs
  on `emptyDir`, rolls without a gap, and scales past one replica. The optimizer's
  runtime config is the one admin-mutable store still held per pod, so it keeps its
  volume by default and therefore keeps the `Recreate` strategy and `replicas: 1`.
  That costs money rather than availability: the gateway fails open when the
  optimizer is unreachable, and the fail-open path busts the provider prompt cache
  on warm sessions. Set `optimizer.persistence.enabled: false` to trade that config
  for a gap-free roll. Both PVCs survive `helm uninstall` via a
  `helm.sh/resource-policy: keep` annotation.
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
