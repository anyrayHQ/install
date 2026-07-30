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
{{- if hasKey . "context" -}}
{{- $context = .context -}}
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
{{- with $affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
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
{{- if hasKey . "context" -}}
{{- $context = .context -}}
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
in-flight requests. The gateway does that for ANYRAY_SHUTDOWN_DRAIN_MS, which an
operator raises through extraEnv for long streaming completions — and raising it
past the remaining budget puts SIGKILL back in the middle of the drain, which is
the very thing terminationGracePeriodSeconds was set to prevent. Read the
override back out of extraEnv and check the SUM. */ -}}
{{- $drainMs := 0 -}}
{{- range $env := ($overrides.extraEnv | default list) -}}
{{- if eq (toString $env.name) "ANYRAY_SHUTDOWN_DRAIN_MS" -}}
{{- $drainMs = int (toString $env.value) -}}
{{- end -}}
{{- end -}}
{{- if and (gt $drainMs 0) (not (kindIs "invalid" $grace)) -}}
{{- $needed := add (int $seconds) (div (add $drainMs 999) 1000) -}}
{{- if gt $needed (int $grace) -}}
{{- fail (printf "preStopDrainSeconds (%ds) plus ANYRAY_SHUTDOWN_DRAIN_MS (%dms) needs %ds, which exceeds terminationGracePeriodSeconds (%ds): the kubelet would SIGKILL mid-drain and reset in-flight streams. Raise terminationGracePeriodSeconds to at least %d" (int $seconds) $drainMs $needed (int $grace) $needed) -}}
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
