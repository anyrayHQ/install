{{/*
Expand the name of the chart.
*/}}
{{- define "anyray.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Resolve and validate the coordinated persistent-transcript policy instant.

The policy first ships in v1.10.117. Legacy image pairs can omit the instant;
policy-capable gateway or optimizer tags require it because the Deployments roll
independently, even at one replica. Unknown/moving tags are treated as capable.
Once set, the value remains explicit on later upgrades and is intentionally
valid whether the configured instant is future or past.
*/}}
{{- define "anyray.persistentTranscriptPolicyActivateAt" -}}
{{- $policyRequired := false -}}
{{- range $component := list "gateway" "optimizer" -}}
{{- $image := index $.Values.images $component | default dict -}}
{{- $tag := $image.tag | default $.Values.image.tag | default $.Chart.AppVersion | toString -}}
{{- if not (regexMatch `^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$` $tag) -}}
{{- $policyRequired = true -}}
{{- else if semverCompare ">=1.10.117-0" $tag -}}
{{- $policyRequired = true -}}
{{- end -}}
{{- end -}}
{{- $configured := .Values.persistentTranscriptPolicyActivateAt | default "" | toString | trim -}}
{{- if and $policyRequired (not $configured) -}}
{{- fail "persistentTranscriptPolicyActivateAt is required for gateway/optimizer image tags v1.10.117 or newer: set one shared future ISO-8601 instant before the first compatible rollout, then preserve it on later upgrades" -}}
{{- end -}}
{{- $activateAt := $configured -}}
{{- if and $activateAt (not (regexMatch `^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[0-1])T([0-1][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,9})?(Z|[+-](0[0-9]|1[0-4]):[0-5][0-9])$` $activateAt)) -}}
{{- fail "persistentTranscriptPolicyActivateAt must be a valid timezone-qualified ISO-8601 instant such as 2026-07-15T12:00:00.000Z" -}}
{{- end -}}
{{- if $activateAt -}}
{{- $_ := mustToDate "2006-01-02T15:04:05Z07:00" $activateAt -}}
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
this chart ships), giving reproducible, auditable deploys. Set image.tag (e.g.
"latest") to ride a moving channel for testing, or a per-component tag to pin one
image. appVersion is always set, so a bare (untagged) reference should not occur;
the else branch is a defensive fallback.
*/}}
{{- define "anyray.image" -}}
{{- $image := index .context.Values.images .component | default dict -}}
{{- $repository := required (printf "images.%s.repository is required" .component) $image.repository -}}
{{- $tag := $image.tag | default .context.Values.image.tag | default .context.Chart.AppVersion -}}
{{- $globalRegistry := (.context.Values.global | default dict).imageRegistry | default "" -}}
{{- if $globalRegistry -}}
{{- /* Air-gapped / private-registry mirror: swap the registry host of every image
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
{{- default .context.Values.image.pullPolicy $image.pullPolicy -}}
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
