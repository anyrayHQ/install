{{/*
Expand the name of the chart.
*/}}
{{- define "anyray.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Resolve an app component's effective image tag. */}}
{{- define "anyray.effectiveImageTag" -}}
{{- $image := index .context.Values.images .component | default dict -}}
{{- $image.tag | default .context.Values.image.tag | default .context.Chart.AppVersion | toString -}}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "anyray.fullname" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels applied to every resource.
*/}}
{{- define "anyray.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Selector labels for a given component.
Usage: include "anyray.selectorLabels" (dict "component" "gateway" "context" .)
*/}}
{{- define "anyray.selectorLabels" -}}
app.kubernetes.io/name: anyray
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/instance: {{ .context.Release.Name }}
{{- end }}

{{/*
Secret key reference helper.
Usage: include "anyray.secretRef" (dict "key" "ANYRAY_ADMIN_TOKEN" "context" .)
*/}}
{{- define "anyray.secretRef" -}}
secretKeyRef:
  name: {{ .context.Values.secretName }}
  key: {{ .key }}
{{- end }}

{{/*
External Secret key reference helper.
Usage: include "anyray.externalSecretRef" .Values.postgres.external.databaseUrlSecretKeyRef
*/}}
{{- define "anyray.externalSecretRef" -}}
secretKeyRef:
  name: {{ required "secretKeyRef.name is required" .name }}
  key: {{ required "secretKeyRef.key is required" .key }}
{{- with .optional }}
  optional: {{ . }}
{{- end }}
{{- end }}

{{/*
Image helper. Tag resolution, most specific first:
  images.<component>.tag  >  image.tag  >  .Chart.AppVersion
So by default every app image is pinned to the chart's appVersion (the release
this chart ships), giving reproducible, auditable deploys. policy-stable is the
moving channel; latest/stable are legacy channels. appVersion is always set, so
a bare (untagged) reference should not occur; the else branch is a defensive
fallback.
*/}}
{{- define "anyray.image" -}}
{{- $image := index .context.Values.images .component | default dict -}}
{{- $repository := required (printf "images.%s.repository is required" .component) $image.repository -}}
{{- $tag := include "anyray.effectiveImageTag" (dict "component" .component "context" .context) -}}
{{- $globalRegistry := (.context.Values.global | default dict).imageRegistry | default "" -}}
{{- if $globalRegistry -}}
{{- /* Private-registry mirror: swap the registry host of every image
       so one value repoints all of them (e.g. public.ecr.aws/anyray/gateway ->
       my.registry:5000/anyray/gateway). The image path after the host is preserved
       so a straight `crane cp` mirror works. */ -}}
{{- $repository = printf "%s/%s" $globalRegistry (regexReplaceAll "^[^/]+/" $repository "") -}}
{{- end -}}
{{- if $tag -}}
{{- printf "%s:%s" $repository $tag -}}
{{- else -}}
{{- $repository -}}
{{- end -}}
{{- end }}

{{/*
Per-component imagePullPolicy helper.
*/}}
{{- define "anyray.imagePullPolicy" -}}
{{- $image := index .context.Values.images .component | default dict -}}
{{- $tag := include "anyray.effectiveImageTag" (dict "component" .component "context" .context) -}}
{{- if eq $tag "policy-stable" -}}
Always
{{- else -}}
{{- default .context.Values.image.pullPolicy $image.pullPolicy -}}
{{- end -}}
{{- end }}

{{/*
ServiceAccount name helper.
*/}}
{{- define "anyray.serviceAccountName" -}}
{{- if .Values.serviceAccount.name -}}
{{- .Values.serviceAccount.name -}}
{{- else if .Values.serviceAccount.create -}}
{{- include "anyray.fullname" . -}}
{{- else -}}
default
{{- end -}}
{{- end }}

{{/*
Common pod labels and annotations.
Usage: include "anyray.podMetadata" (dict "component" "gateway" "context" .)
*/}}
{{- define "anyray.podMetadata" -}}
labels:
  {{- include "anyray.selectorLabels" (dict "component" .component "context" .context) | nindent 2 }}
  {{- with .context.Values.podLabels }}
  {{- toYaml . | nindent 2 }}
  {{- end }}
{{- with .context.Values.podAnnotations }}
annotations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{/*
Common pod spec fields. Excludes podSecurityContext for components that need a
component-specific security context.

Scheduling fields (nodeSelector / affinity / tolerations /
topologySpreadConstraints / priorityClassName) are per-component overridable:
pass (dict "component" <name> "context" .) and a non-empty .Values.<name>.<field>
wins over the global .Values.<field>; unset falls back to the global. Called with
the bare root context (.) it emits the global values only. The component blocks
that carry overrides are gateway / optimizer / proxy / postgres.

terminationGracePeriodSeconds resolves the same way but keys off hasKey rather
than truthiness, so an explicit component-level 0 is honoured instead of falling
back to the global (Go templates treat 0 as empty).
*/}}
{{- define "anyray.podSpecCommonNoSecurity" -}}
{{- $context := . -}}
{{- $overrides := dict -}}
{{- $component := "" -}}
{{- if hasKey . "context" -}}
{{- $context = .context -}}
{{- $component = toString .component -}}
{{- $overrides = (index $context.Values .component | default dict) -}}
{{- end -}}
{{- $nodeSelector := $overrides.nodeSelector | default $context.Values.nodeSelector -}}
{{- $affinity := $overrides.affinity | default $context.Values.affinity -}}
{{- $tolerations := $overrides.tolerations | default $context.Values.tolerations -}}
{{- $topologySpreadConstraints := $overrides.topologySpreadConstraints | default $context.Values.topologySpreadConstraints -}}
{{- $priorityClassName := $overrides.priorityClassName | default $context.Values.priorityClassName -}}
{{- $terminationGrace := $context.Values.terminationGracePeriodSeconds -}}
{{- if hasKey $overrides "terminationGracePeriodSeconds" -}}
{{- $terminationGrace = $overrides.terminationGracePeriodSeconds -}}
{{- end -}}
serviceAccountName: {{ include "anyray.serviceAccountName" $context }}
{{- if not (kindIs "invalid" $terminationGrace) }}
terminationGracePeriodSeconds: {{ int $terminationGrace }}
{{- end }}
{{- with $context.Values.image.pullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- if $affinity }}
affinity:
  {{- toYaml $affinity | nindent 2 }}
{{- else if $component }}
{{- /* No affinity configured: fall back to soft per-component anti-affinity so
       replicas separate by node (then zone) instead of stacking on one. */}}
affinity:
  {{- include "anyray.defaultAffinity" (dict "component" $component "context" $context) | nindent 2 }}
{{- end }}
{{- with $tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $topologySpreadConstraints }}
topologySpreadConstraints:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $priorityClassName }}
priorityClassName: {{ . | quote }}
{{- end }}
{{- end }}

{{/*
Common pod spec fields including the global podSecurityContext. Accepts the bare
root context or (dict "component" <name> "context" .) — see podSpecCommonNoSecurity.
*/}}
{{- define "anyray.podSpecCommon" -}}
{{- $context := . -}}
{{- if hasKey . "context" -}}
{{- $context = .context -}}
{{- end -}}
{{- include "anyray.podSpecCommonNoSecurity" . }}
{{- with $context.Values.podSecurityContext }}
securityContext:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{/*
Common container security context.
*/}}
{{- define "anyray.containerSecurityContext" -}}
{{- with .Values.containerSecurityContext }}
securityContext:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{/*
Container lifecycle preStop hook. Holds the pod open for preStopDrainSeconds
BEFORE SIGTERM, covering the window where Kubernetes has begun terminating the
pod but its removal from the Service endpoints has not yet reached every
kube-proxy / nginx upstream. Without the pause those in-flight requests land on
a process that is already shutting down and surface to the caller as a reset
connection rather than a retryable response.

Emits nothing at 0 (or nil), so the hook can be switched off. Per-component
overridable via .Values.<component>.preStopDrainSeconds — keyed off hasKey so an
explicit 0 is honoured.

Uses `sleep` rather than the native preStop `sleep:` action because that field
requires Kubernetes >= 1.29 and this chart declares no kubeVersion floor. All
three runtime images carry a full userland — the `FROM scratch` final stages
copy one in from their assemble stage — so /bin/sleep is present in each.
*/}}
{{- define "anyray.preStopDrain" -}}
{{- $context := . -}}
{{- $overrides := dict -}}
{{- $component := "" -}}
{{- if hasKey . "context" -}}
{{- $context = .context -}}
{{- $component = toString .component -}}
{{- $overrides = (index $context.Values .component | default dict) -}}
{{- end -}}
{{- $seconds := $context.Values.preStopDrainSeconds -}}
{{- if hasKey $overrides "preStopDrainSeconds" -}}
{{- $seconds = $overrides.preStopDrainSeconds -}}
{{- end -}}
{{- $grace := $context.Values.terminationGracePeriodSeconds -}}
{{- if hasKey $overrides "terminationGracePeriodSeconds" -}}
{{- $grace = $overrides.terminationGracePeriodSeconds -}}
{{- end -}}
{{- if and (not (kindIs "invalid" $seconds)) (gt (int $seconds) 0) -}}
{{- /* The pre-stop sleep is spent INSIDE the termination budget, so a pause at
or above it means the kubelet SIGKILLs the container before the app is ever
signalled — every in-flight request reset, and the app's own drain never runs.
Fail the render rather than ship that silently. */ -}}
{{- if and (not (kindIs "invalid" $grace)) (ge (int $seconds) (int $grace)) -}}
{{- fail (printf "preStopDrainSeconds (%d) must be less than terminationGracePeriodSeconds (%d): the pre-stop pause is spent inside the termination budget, so the container would be SIGKILLed before it is ever sent SIGTERM" (int $seconds) (int $grace)) -}}
{{- end -}}
{{- /* The pause is only half the budget: after SIGTERM the app drains its own
in-flight requests. The gateway does that for ANYRAY_SHUTDOWN_DRAIN_MS — and a
drain running past the remaining budget puts SIGKILL back in the middle of it,
which is the very thing terminationGracePeriodSeconds was set to prevent.

Seed the GATEWAY's compiled-in default (90000, gateway/src/start-server.ts) so
the check covers the path nobody configures, then let an extraEnv override
replace it, and check the SUM. Seeding it only for the gateway is deliberate:
the optimizer installs no SIGTERM handler at all and the proxy drains on
nginx's own SIGQUIT, so charging either of them a 90s drain would fail renders
over a wait they never perform.

CHANGE-BOTH-TOGETHER: this constant mirrors SHUTDOWN_DRAIN_MS in the monorepo
(gateway/src/start-server.ts). Lower it here and the guard stops protecting the
real default; raise the app's without raising this and a stock install is
SIGKILLed mid-drain again. */ -}}
{{- $drainMs := ternary 90000 0 (eq $component "gateway") -}}
{{- range $env := ($overrides.extraEnv | default list) -}}
{{- if eq (toString $env.name) "ANYRAY_SHUTDOWN_DRAIN_MS" -}}
{{- $drainMs = int (toString $env.value) -}}
{{- end -}}
{{- end -}}
{{- if and (gt $drainMs 0) (not (kindIs "invalid" $grace)) -}}
{{- $needed := add (int $seconds) (div (add $drainMs 999) 1000) -}}
{{- if ge $needed (int $grace) -}}
{{- fail (printf "preStopDrainSeconds (%ds) plus ANYRAY_SHUTDOWN_DRAIN_MS (%dms) needs %ds, which leaves no headroom under terminationGracePeriodSeconds (%ds): the kubelet would SIGKILL as the drain ends, or during it, resetting in-flight streams. Raise terminationGracePeriodSeconds above %d" (int $seconds) $drainMs $needed (int $grace) $needed) -}}
{{- end -}}
{{- end -}}
lifecycle:
  preStop:
    exec:
      command: ["sleep", "{{ int $seconds }}"]
{{- end -}}
{{- end }}

{{/*
Deployment minReadySeconds — how long a new pod must stay Ready before the
rollout treats it as available, so a pod that passes one probe and then crashes
cannot retire the previous version. Per-component overridable; explicit 0 is
honoured (hasKey, not truthiness).
*/}}
{{- define "anyray.minReadySeconds" -}}
{{- $context := . -}}
{{- $overrides := dict -}}
{{- if hasKey . "context" -}}
{{- $context = .context -}}
{{- $overrides = (index $context.Values .component | default dict) -}}
{{- end -}}
{{- $seconds := $context.Values.minReadySeconds -}}
{{- if hasKey $overrides "minReadySeconds" -}}
{{- $seconds = $overrides.minReadySeconds -}}
{{- end -}}
{{- if not (kindIs "invalid" $seconds) -}}
minReadySeconds: {{ int $seconds }}
{{- end -}}
{{- end }}

{{/*
Rollout bookkeeping shared by every Deployment.

revisionHistoryLimit bounds the retired ReplicaSets kept for rollback. The
Kubernetes default of 10 is not free here: each one pins its pod template, and on
a chart this size that is the difference between a readable `kubectl get rs` and
a wall. Ten is more rollback depth than anyone uses; three covers "roll back the
bad release and the one before it".

progressDeadlineSeconds is the one that matters for availability. Left unset,
Kubernetes uses 600s: a rollout whose new pods never pass their probes sits
"progressing" for ten minutes before it is marked failed, and nothing surfaces
until then. Since maxUnavailable is 0 on every rolling workload the old pods keep
serving throughout, so a shorter deadline costs no traffic — it only makes a
stuck rollout say so, which is what a `helm upgrade --atomic` waits on to trigger
its rollback.
*/}}
{{- define "anyray.rolloutMeta" -}}
{{- $context := . -}}
{{- $overrides := dict -}}
{{- if hasKey . "context" -}}
{{- $context = .context -}}
{{- $overrides = (index $context.Values .component | default dict) -}}
{{- end -}}
{{- $history := $context.Values.revisionHistoryLimit -}}
{{- if hasKey $overrides "revisionHistoryLimit" -}}
{{- $history = $overrides.revisionHistoryLimit -}}
{{- end -}}
{{- $deadline := $context.Values.progressDeadlineSeconds -}}
{{- if hasKey $overrides "progressDeadlineSeconds" -}}
{{- $deadline = $overrides.progressDeadlineSeconds -}}
{{- end -}}
{{- if not (kindIs "invalid" $history) }}
revisionHistoryLimit: {{ int $history }}
{{- end }}
{{- if not (kindIs "invalid" $deadline) }}
{{- /* progressDeadlineSeconds must exceed minReadySeconds or the rollout is
declared failed before a healthy pod can ever be counted available. */ -}}
{{- $ready := $context.Values.minReadySeconds -}}
{{- if hasKey $overrides "minReadySeconds" -}}
{{- $ready = $overrides.minReadySeconds -}}
{{- end -}}
{{- if and (not (kindIs "invalid" $ready)) (le (int $deadline) (int $ready)) -}}
{{- fail (printf "progressDeadlineSeconds (%d) must be greater than minReadySeconds (%d), or the rollout is marked failed before a healthy pod can be counted available" (int $deadline) (int $ready)) -}}
{{- end }}
progressDeadlineSeconds: {{ int $deadline }}
{{- end }}
{{- end }}

{{/*
Liveness probe — "should the kubelet kill this pod?", and nothing else.

This is the failure a readiness probe alone leaves running forever: a wedged
event loop (an exhausted pg pool, a hung await). Readiness takes the pod out of
the Service, and then nothing ever puts it back or restarts it — with one replica
that is a silent, permanent outage. It cost a customer a fleet-dark window on
2026-08-06.

Two properties make it safe, and both are load-bearing:

  * It targets `/livez`, NOT `/`. The readiness route turns 503 on SIGTERM so a
    draining pod leaves the Service; a liveness probe pointed there would restart
    the container mid-drain and reset every in-flight stream — the exact
    "Connection closed mid-response" the drain budget exists to prevent.
  * `/livez` checks no dependency. A probe that touched Postgres would turn a
    database blip into a fleet-wide crashloop: every replica killed at once for a
    fault restarting cannot fix. Dependency health is the admin-gated
    `/admin/health`, a diagnostic, not a probe.

`failureThreshold` x `periodSeconds` is deliberately slack (60s). Liveness is the
blunt instrument — restarting a pod that was merely slow is itself an outage, so
it must fire well after readiness has already pulled the pod from the Service.

VERSION GUARD: `/livez` ships from the appVersion named below. Rendering this
probe against an older image would 404 every check and crashloop the whole
deployment on `helm upgrade` — a self-inflicted outage far worse than the wedge
it prevents. So it renders only when the effective tag is a release known to
serve the route; anything unrecognised (a custom tag, a private mirror tag)
falls back to today's behaviour of no liveness probe. `policy-stable` is the
moving newest-build channel and always carries it.
*/}}
{{/*
The appVersion floor for everything this chart's availability posture depends on
the IMAGE to provide. One constant, because both features ship in the same
release and splitting it would invite the two to drift:

  * `GET /livez`, the liveness probe target (below);
  * the fleetd installer store moving to Postgres (0057), which is what makes
    gateway.persistence.enabled=false lossless.

CHANGE-BOTH-TOGETHER: this must name the release that actually carries both. Set
too low, the probes 404 and the deployment crashloops; set too high, the chart
silently keeps the old single-replica posture.
*/}}
{{- /* v1.10.222 and .223 were cut BEFORE /livez and 0057 merged, so an earlier
       draft of this floor named a release that has neither. Verify against
       `git tag` before changing it. */ -}}
{{- define "anyray.haFloor" -}}v1.10.224{{- end }}

{{/*
Whether the resolved image for a component is at least `floor`.

Returns "" (falsey) for anything unrecognised — a private-mirror tag, a custom
build, a channel name we do not know — so every caller degrades to the older,
safer behaviour rather than assuming a capability the image may not have.
`policy-stable` is the moving newest-build channel and always qualifies.

Usage: include "anyray.atLeastAppVersion" (dict "component" "gateway" "floor" (include "anyray.haFloor" .) "context" .)
*/}}
{{- define "anyray.atLeastAppVersion" -}}
{{- $tag := include "anyray.effectiveImageTag" (dict "component" .component "context" .context) -}}
{{- if eq $tag "policy-stable" -}}
true
{{- else if regexMatch "^v?[0-9]+\\.[0-9]+\\.[0-9]+$" $tag -}}
{{- if semverCompare (printf ">=%s-0" (trimPrefix "v" .floor)) (trimPrefix "v" $tag) -}}
true
{{- end -}}
{{- end -}}
{{- end }}

{{- define "anyray.servesLivez" -}}
{{- include "anyray.atLeastAppVersion" (dict "component" .component "floor" (include "anyray.haFloor" .context) "context" .context) -}}
{{- end }}

{{- define "anyray.livenessProbe" -}}
{{- $context := .context -}}
{{- $overrides := (index $context.Values .component | default dict) -}}
{{- $probe := $context.Values.livenessProbe -}}
{{- if hasKey $overrides "livenessProbe" -}}
{{- $probe = $overrides.livenessProbe -}}
{{- end -}}
{{- if and $probe $probe.enabled -}}
{{- /* `unguarded` callers name a route that has existed in every released image
       (the optimizer's static /health); everything else must clear the /livez
       version floor or render nothing. */ -}}
{{- if or .unguarded (include "anyray.servesLivez" (dict "component" .component "context" $context)) -}}
livenessProbe:
  httpGet:
    path: {{ $probe.path | default .path | default "/livez" }}
    port: {{ .port }}
  initialDelaySeconds: {{ $probe.initialDelaySeconds | default 15 }}
  periodSeconds: {{ $probe.periodSeconds | default 10 }}
  timeoutSeconds: {{ $probe.timeoutSeconds | default 5 }}
  failureThreshold: {{ $probe.failureThreshold | default 6 }}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
Startup probe — decouples "slow to boot" from "wedged".

Without one, a liveness probe has to be lenient enough to cover the worst-case
cold start (image pull, migration ledger, onnxruntime warm-up), which makes it
too slow to catch a wedge later. The startup probe holds liveness off entirely
until the process answers once, so liveness can then be tight. Its budget is
generous on purpose: the gateway applies the migration ledger under an advisory
lock on first connect, so one replica in a cold cluster can legitimately take
minutes while its peers wait on the lock.
*/}}
{{- define "anyray.startupProbe" -}}
{{- $context := .context -}}
{{- $overrides := (index $context.Values .component | default dict) -}}
{{- $probe := $context.Values.startupProbe -}}
{{- if hasKey $overrides "startupProbe" -}}
{{- $probe = $overrides.startupProbe -}}
{{- end -}}
{{- if and $probe $probe.enabled -}}
{{- if or .unguarded (include "anyray.servesLivez" (dict "component" .component "context" $context)) -}}
startupProbe:
  httpGet:
    path: {{ $probe.path | default .path | default "/livez" }}
    port: {{ .port }}
  periodSeconds: {{ $probe.periodSeconds | default 5 }}
  timeoutSeconds: {{ $probe.timeoutSeconds | default 5 }}
  failureThreshold: {{ $probe.failureThreshold | default 360 }}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
Scheduling spread.

An unset `affinity` used to mean "put the pods anywhere", which at proxy
replicas: 2 routinely lands both on one node — a single node drain then takes out
the whole workload the second replica exists to protect. So an unset affinity now
resolves to SOFT (preferred) pod anti-affinity per component: the scheduler
separates replicas by hostname when it can, and still schedules when it cannot.
Soft rather than required is the point — a required rule on a single-node or
capacity-tight cluster leaves pods Pending forever, trading a rare correlated
failure for a certain one. An explicit `affinity` still replaces this wholesale.
*/}}
{{- define "anyray.defaultAffinity" -}}
podAntiAffinity:
  preferredDuringSchedulingIgnoredDuringExecution:
    - weight: 100
      podAffinityTerm:
        topologyKey: kubernetes.io/hostname
        labelSelector:
          matchLabels:
            {{- include "anyray.selectorLabels" (dict "component" .component "context" .context) | nindent 12 }}
    - weight: 50
      podAffinityTerm:
        topologyKey: topology.kubernetes.io/zone
        labelSelector:
          matchLabels:
            {{- include "anyray.selectorLabels" (dict "component" .component "context" .context) | nindent 12 }}
{{- end }}

{{/*
External dependency guardrails.
*/}}
{{- define "anyray.requirePostgres" -}}
{{- if and (not .Values.postgres.enabled) (not .Values.postgres.external.databaseUrl) (not .Values.postgres.external.databaseUrlSecretKeyRef.name) -}}
{{- fail "postgres.enabled=false requires postgres.external.databaseUrl or postgres.external.databaseUrlSecretKeyRef" -}}
{{- end -}}
{{- end }}

{{/*
Gateway trace + spend store env. The gateway persists content-free traces +
observations to Postgres (anyray_traces / anyray_observations, auto-created;
content AES-256-GCM encrypted at rest) and reads them in-process. Defaults to the
in-chart Postgres; honors postgres.external for a managed database.

POSTGRES_PASSWORD must precede ANYRAY_OBSERVABILITY_DB_URL when it is interpolated:
k8s only resolves $(VAR) against vars declared earlier in the env list.
*/}}
{{- define "anyray.observabilityDbEnv" -}}
{{- include "anyray.requirePostgres" . }}
{{- if .Values.postgres.external.databaseUrlSecretKeyRef.name }}
- name: ANYRAY_OBSERVABILITY_DB_URL
  valueFrom:
    {{- include "anyray.externalSecretRef" .Values.postgres.external.databaseUrlSecretKeyRef | nindent 4 }}
- name: ANYRAY_SPEND_DB_URL
  valueFrom:
    {{- include "anyray.externalSecretRef" .Values.postgres.external.databaseUrlSecretKeyRef | nindent 4 }}
{{- else if .Values.postgres.external.databaseUrl }}
- name: ANYRAY_OBSERVABILITY_DB_URL
  value: {{ .Values.postgres.external.databaseUrl | quote }}
- name: ANYRAY_SPEND_DB_URL
  value: {{ .Values.postgres.external.databaseUrl | quote }}
{{- else }}
- name: POSTGRES_PASSWORD
  valueFrom:
    {{- include "anyray.secretRef" (dict "key" "POSTGRES_PASSWORD" "context" .) | nindent 4 }}
- name: ANYRAY_OBSERVABILITY_DB_URL
  value: "postgresql://postgres:$(POSTGRES_PASSWORD)@{{ include "anyray.fullname" . }}-postgres:5432/postgres"
- name: ANYRAY_SPEND_DB_URL
  value: "postgresql://postgres:$(POSTGRES_PASSWORD)@{{ include "anyray.fullname" . }}-postgres:5432/postgres"
{{- end }}
{{- end }}

{{/*
Optimizer durable-stash env: ANYRAY_SPEND_DB_URL only (same three source
branches as anyray.observabilityDbEnv). Deliberately NOT the paired helper —
setting ANYRAY_OBSERVABILITY_DB_URL on the optimizer would half-enable its
BYO /v1/record path, which full-stack installs don't use.
*/}}
{{- define "anyray.spendDbEnv" -}}
{{- include "anyray.requirePostgres" . }}
{{- if .Values.postgres.external.databaseUrlSecretKeyRef.name }}
- name: ANYRAY_SPEND_DB_URL
  valueFrom:
    {{- include "anyray.externalSecretRef" .Values.postgres.external.databaseUrlSecretKeyRef | nindent 4 }}
{{- else if .Values.postgres.external.databaseUrl }}
- name: ANYRAY_SPEND_DB_URL
  value: {{ .Values.postgres.external.databaseUrl | quote }}
{{- else }}
- name: POSTGRES_PASSWORD
  valueFrom:
    {{- include "anyray.secretRef" (dict "key" "POSTGRES_PASSWORD" "context" .) | nindent 4 }}
- name: ANYRAY_SPEND_DB_URL
  value: "postgresql://postgres:$(POSTGRES_PASSWORD)@{{ include "anyray.fullname" . }}-postgres:5432/postgres"
{{- end }}
{{- end }}

{{/*
End-point control store env: ANYRAY_CP_DATABASE_URL, resolved through the SAME
three source branches as the gateway's DB env (anyray.observabilityDbEnv /
anyray.spendDbEnv) so the service always lands on the database the gateway's
ANYRAY_SPEND_DB_URL points at — its endpoint_* tables coexist there
(boot-applied idempotent schema). A separate helper because the var name
differs; the branch logic must stay in lockstep with the two above.
*/}}
{{- define "anyray.cpDatabaseUrlEnv" -}}
{{- include "anyray.requirePostgres" . }}
{{- if .Values.postgres.external.databaseUrlSecretKeyRef.name }}
- name: ANYRAY_CP_DATABASE_URL
  valueFrom:
    {{- include "anyray.externalSecretRef" .Values.postgres.external.databaseUrlSecretKeyRef | nindent 4 }}
{{- else if .Values.postgres.external.databaseUrl }}
- name: ANYRAY_CP_DATABASE_URL
  value: {{ .Values.postgres.external.databaseUrl | quote }}
{{- else }}
- name: POSTGRES_PASSWORD
  valueFrom:
    {{- include "anyray.secretRef" (dict "key" "POSTGRES_PASSWORD" "context" .) | nindent 4 }}
- name: ANYRAY_CP_DATABASE_URL
  value: "postgresql://postgres:$(POSTGRES_PASSWORD)@{{ include "anyray.fullname" . }}-postgres:5432/postgres"
{{- end }}
{{- end }}
