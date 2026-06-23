{{/*
Expand the name of the chart.
*/}}
{{- define "anyray.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
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
Image helper. App images inherit .Values.image.tag when their component tag is empty.
*/}}
{{- define "anyray.image" -}}
{{- $image := index .context.Values.images .component | default dict -}}
{{- $repository := required (printf "images.%s.repository is required" .component) $image.repository -}}
{{- $tag := default .context.Values.image.tag $image.tag -}}
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
