{{/*
Expand the name of the chart.
*/}}
{{- define "anyray.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Resolve the install artifact's persistent-transcript capability. */}}
{{- define "anyray.persistentTranscriptPolicyCapability" -}}
{{- $annotations := .Chart.Annotations | default dict -}}
{{- $capability := index $annotations "anyray.ai/persistent-transcript-policy-v1" | default "" | toString -}}
{{- if and $capability (ne $capability "true") -}}
{{- fail "chart annotation anyray.ai/persistent-transcript-policy-v1 must be true when present" -}}
{{- end -}}
{{- if eq $capability "true" -}}true{{- else -}}false{{- end -}}
{{- end }}

{{/* Resolve an app component's effective image tag. */}}
{{- define "anyray.effectiveImageTag" -}}
{{- $image := index .context.Values.images .component | default dict -}}
{{- $image.tag | default .context.Values.image.tag | default .context.Chart.AppVersion | toString -}}
{{- end }}

{{/*
Resolve and validate the coordinated persistent-transcript policy instant.

The chart annotation is the capability boundary. A capable chart requires the
instant because the Deployments roll independently, even at one replica; an
older chart revision without the annotation retains its legacy behavior. Image
versions do not activate the policy, but a capable artifact still rejects image
combinations that cannot prove the gateway/optimizer protocol is coordinated.
Once set, the value remains explicit on later upgrades and is intentionally
valid whether the configured instant is future or past. Online Helm upgrades
read the live gateway Deployment and require that its value remains exact.
Offline renderers may acknowledge a completed initial rollout explicitly after
the operator verifies both capable Deployments.
*/}}
{{- define "anyray.persistentTranscriptPolicyActivateAt" -}}
{{- $policyRequired := eq (include "anyray.persistentTranscriptPolicyCapability" .) "true" -}}
{{- if $policyRequired -}}
{{- $gatewayTag := include "anyray.effectiveImageTag" (dict "component" "gateway" "context" .) -}}
{{- $optimizerTag := include "anyray.effectiveImageTag" (dict "component" "optimizer" "context" .) -}}
{{- $gatewayImage := index .Values.images "gateway" | default dict -}}
{{- $optimizerImage := index .Values.images "optimizer" | default dict -}}
{{- $gatewayRepository := $gatewayImage.repository | default "" | toString -}}
{{- $optimizerRepository := $optimizerImage.repository | default "" | toString -}}
{{- $globalRegistry := (.Values.global | default dict).imageRegistry | default "" | toString -}}
{{- if ne $gatewayTag $optimizerTag -}}
{{- fail (printf "capability-aware chart requires equal gateway and optimizer image tags (got %s and %s)" $gatewayTag $optimizerTag) -}}
{{- end -}}
{{- if or (eq $gatewayTag "latest") (eq $gatewayTag "stable") -}}
{{- fail (printf "capability-aware chart rejects legacy moving channel %s; use the chart appVersion or policy-stable" $gatewayTag) -}}
{{- end -}}
{{- $knownTag := or (eq $gatewayTag (.Chart.AppVersion | toString)) (eq $gatewayTag "policy-stable") -}}
{{- $defaultRepositories := and (eq $globalRegistry "") (eq $gatewayRepository "public.ecr.aws/anyray/gateway") (eq $optimizerRepository "public.ecr.aws/anyray/optimizer") -}}
{{- $knownImages := and $knownTag $defaultRepositories -}}
{{- $confirmed := eq (.Values.persistentTranscriptPolicyImageCapabilityConfirmed | default false | toString) "true" -}}
{{- if and (not $knownImages) (not $confirmed) -}}
{{- fail (printf "custom gateway/optimizer images (%s:%s, %s:%s) require persistentTranscriptPolicyImageCapabilityConfirmed=true after verifying both images declare persistent-transcript-policy-v1" $gatewayRepository $gatewayTag $optimizerRepository $optimizerTag) -}}
{{- end -}}
{{- if and (not $knownTag) (not (regexMatch `^v[0-9]+\.[0-9]+\.[0-9]+$` $gatewayTag)) -}}
{{- fail (printf "custom gateway/optimizer image tag %s must be an immutable vX.Y.Z tag" $gatewayTag) -}}
{{- end -}}
{{- end -}}
{{- $configured := .Values.persistentTranscriptPolicyActivateAt | default "" | toString | trim -}}
{{- if and $policyRequired (not $configured) -}}
{{- fail "persistentTranscriptPolicyActivateAt is required by this capability-aware chart: set one shared future ISO-8601 instant before the first rollout, then preserve it on later upgrades" -}}
{{- end -}}
{{- $activateAt := $configured -}}
{{- if and $activateAt (not (regexMatch `^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[0-1])T([0-1][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,9})?(Z|[+-](0[0-9]|1[0-4]):[0-5][0-9])$` $activateAt)) -}}
{{- fail "persistentTranscriptPolicyActivateAt must be a valid timezone-qualified ISO-8601 instant such as 2026-07-15T12:00:00.000Z" -}}
{{- end -}}
{{- if $activateAt -}}
{{- $activationTime := mustToDate "2006-01-02T15:04:05Z07:00" $activateAt -}}
{{- if $policyRequired -}}
{{- $gatewayName := printf "%s-gateway" (include "anyray.fullname" .) -}}
{{- $liveGateway := lookup "apps/v1" "Deployment" .Release.Namespace $gatewayName -}}
{{- $liveActivateAt := "" -}}
{{- if $liveGateway -}}
{{- $containers := dig "spec" "template" "spec" "containers" (list) $liveGateway -}}
{{- range $container := $containers -}}
{{- if eq ($container.name | default "" | toString) "gateway" -}}
{{- range $env := ($container.env | default (list)) -}}
{{- if eq ($env.name | default "" | toString) "ANYRAY_PERSISTENT_TRANSCRIPT_POLICY_ACTIVATE_AT" -}}
{{- $liveActivateAt = $env.value | default "" | toString | trim -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- $offlineVerifiedRaw := .Values.persistentTranscriptPolicyInitialRolloutVerified | default false -}}
{{- if not (kindIs "bool" $offlineVerifiedRaw) -}}
{{- fail "persistentTranscriptPolicyInitialRolloutVerified must be a boolean" -}}
{{- end -}}
{{- $offlineVerified := eq $offlineVerifiedRaw true -}}
{{- if $liveActivateAt -}}
{{- if ne $liveActivateAt $activateAt -}}
{{- fail (printf "persistentTranscriptPolicyActivateAt must preserve the live gateway value exactly (live %s, configured %s)" $liveActivateAt $activateAt) -}}
{{- end -}}
{{- else if not $offlineVerified -}}
{{- $minimumActivationUnix := add (now | unixEpoch | int64) 1800 -}}
{{- $activationUnix := $activationTime | unixEpoch | int64 -}}
{{- if lt $activationUnix $minimumActivationUnix -}}
{{- fail "persistentTranscriptPolicyActivateAt must be at least 30 minutes in the future for a first capable rollout; clear the stale value and rerun setup.sh immediately before Helm, or choose a new future value. For an offline GitOps renderer only after both initial capable Deployments are verified healthy, preserve the exact timestamp and set persistentTranscriptPolicyInitialRolloutVerified=true" -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- $activateAt -}}
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
this chart ships), giving reproducible, auditable deploys. Capability-aware
charts accept policy-stable as their moving channel; latest/stable are legacy
channels and are rejected. appVersion is always set, so a bare (untagged)
reference should not occur; the else branch is a defensive fallback.
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
serviceAccountName: {{ include "anyray.serviceAccountName" $context }}
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
