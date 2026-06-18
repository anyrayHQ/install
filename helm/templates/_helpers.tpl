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
Usage: include "anyray.externalSecretRef" .Values.redis.external.authSecretKeyRef
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
*/}}
{{- define "anyray.podSpecCommonNoSecurity" -}}
serviceAccountName: {{ include "anyray.serviceAccountName" . }}
{{- with .Values.image.pullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.topologySpreadConstraints }}
topologySpreadConstraints:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.priorityClassName }}
priorityClassName: {{ . | quote }}
{{- end }}
{{- end }}

{{/*
Common pod spec fields including the global podSecurityContext.
*/}}
{{- define "anyray.podSpecCommon" -}}
{{- include "anyray.podSpecCommonNoSecurity" . }}
{{- with .Values.podSecurityContext }}
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

{{- define "anyray.requireClickHouse" -}}
{{- if and (not .Values.clickhouse.enabled) (or (not .Values.clickhouse.external.url) (not .Values.clickhouse.external.migrationUrl)) -}}
{{- fail "clickhouse.enabled=false requires clickhouse.external.url and clickhouse.external.migrationUrl" -}}
{{- end -}}
{{- end }}

{{- define "anyray.requireRedis" -}}
{{- if and (not .Values.redis.enabled) (not .Values.redis.external.host) -}}
{{- fail "redis.enabled=false requires redis.external.host" -}}
{{- end -}}
{{- end }}

{{/*
Postgres env for Langfuse web/worker.
*/}}
{{- define "anyray.postgresEnv" -}}
{{- include "anyray.requirePostgres" . }}
{{- if .Values.postgres.external.databaseUrlSecretKeyRef.name }}
- name: DATABASE_URL
  valueFrom:
    {{- include "anyray.externalSecretRef" .Values.postgres.external.databaseUrlSecretKeyRef | nindent 4 }}
{{- else if .Values.postgres.external.databaseUrl }}
- name: DATABASE_URL
  value: {{ .Values.postgres.external.databaseUrl | quote }}
{{- else }}
# POSTGRES_PASSWORD must precede DATABASE_URL: k8s only resolves
# $(VAR) against vars declared earlier in the env list.
- name: POSTGRES_PASSWORD
  valueFrom:
    {{- include "anyray.secretRef" (dict "key" "POSTGRES_PASSWORD" "context" .) | nindent 4 }}
- name: DATABASE_URL
  value: "postgresql://postgres:$(POSTGRES_PASSWORD)@{{ include "anyray.fullname" . }}-postgres:5432/postgres"
{{- end }}
{{- end }}

{{/*
ClickHouse env for Langfuse web/worker.
*/}}
{{- define "anyray.clickhouseEnv" -}}
{{- include "anyray.requireClickHouse" . }}
{{- $migrationUrl := default (printf "clickhouse://%s-clickhouse:9000" (include "anyray.fullname" .)) .Values.clickhouse.external.migrationUrl -}}
{{- $url := default (printf "http://%s-clickhouse:8123" (include "anyray.fullname" .)) .Values.clickhouse.external.url -}}
- name: CLICKHOUSE_MIGRATION_URL
  value: {{ $migrationUrl | quote }}
- name: CLICKHOUSE_URL
  value: {{ $url | quote }}
- name: CLICKHOUSE_USER
  value: {{ .Values.clickhouse.external.user | quote }}
- name: CLICKHOUSE_PASSWORD
{{- if .Values.clickhouse.external.passwordSecretKeyRef.name }}
  valueFrom:
    {{- include "anyray.externalSecretRef" .Values.clickhouse.external.passwordSecretKeyRef | nindent 4 }}
{{- else if .Values.clickhouse.external.password }}
  value: {{ .Values.clickhouse.external.password | quote }}
{{- else if .Values.clickhouse.enabled }}
  valueFrom:
    {{- include "anyray.secretRef" (dict "key" "CLICKHOUSE_PASSWORD" "context" .) | nindent 4 }}
{{- else }}
  value: ""
{{- end }}
- name: CLICKHOUSE_CLUSTER_ENABLED
  value: "false"
{{- end }}

{{/*
Object storage env for Langfuse web/worker.
*/}}
{{- define "anyray.objectStorageEnv" -}}
{{- $defaultEndpoint := "" -}}
{{- if .Values.minio.enabled -}}
{{- $defaultEndpoint = printf "http://%s-minio:9000" (include "anyray.fullname" .) -}}
{{- end -}}
{{- $eventEndpoint := default $defaultEndpoint .Values.objectStorage.eventUpload.endpoint -}}
{{- $mediaEndpoint := default $defaultEndpoint .Values.objectStorage.mediaUpload.endpoint -}}
- name: LANGFUSE_S3_EVENT_UPLOAD_BUCKET
  value: {{ .Values.objectStorage.eventUpload.bucket | quote }}
- name: LANGFUSE_S3_EVENT_UPLOAD_REGION
  value: {{ .Values.objectStorage.eventUpload.region | quote }}
- name: LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID
{{- if .Values.objectStorage.accessKeyIdSecretKeyRef.name }}
  valueFrom:
    {{- include "anyray.externalSecretRef" .Values.objectStorage.accessKeyIdSecretKeyRef | nindent 4 }}
{{- else }}
  value: {{ .Values.objectStorage.accessKeyId | quote }}
{{- end }}
- name: LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY
{{- if .Values.objectStorage.secretAccessKeySecretKeyRef.name }}
  valueFrom:
    {{- include "anyray.externalSecretRef" .Values.objectStorage.secretAccessKeySecretKeyRef | nindent 4 }}
{{- else if .Values.objectStorage.secretAccessKey }}
  value: {{ .Values.objectStorage.secretAccessKey | quote }}
{{- else if .Values.minio.enabled }}
  valueFrom:
    {{- include "anyray.secretRef" (dict "key" "MINIO_ROOT_PASSWORD" "context" .) | nindent 4 }}
{{- else }}
  value: ""
{{- end }}
- name: LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT
  value: {{ $eventEndpoint | quote }}
- name: LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE
  value: {{ .Values.objectStorage.eventUpload.forcePathStyle | quote }}
- name: LANGFUSE_S3_EVENT_UPLOAD_PREFIX
  value: {{ .Values.objectStorage.eventUpload.prefix | quote }}
- name: LANGFUSE_S3_MEDIA_UPLOAD_BUCKET
  value: {{ .Values.objectStorage.mediaUpload.bucket | quote }}
- name: LANGFUSE_S3_MEDIA_UPLOAD_REGION
  value: {{ .Values.objectStorage.mediaUpload.region | quote }}
- name: LANGFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID
{{- if .Values.objectStorage.accessKeyIdSecretKeyRef.name }}
  valueFrom:
    {{- include "anyray.externalSecretRef" .Values.objectStorage.accessKeyIdSecretKeyRef | nindent 4 }}
{{- else }}
  value: {{ .Values.objectStorage.accessKeyId | quote }}
{{- end }}
- name: LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY
{{- if .Values.objectStorage.secretAccessKeySecretKeyRef.name }}
  valueFrom:
    {{- include "anyray.externalSecretRef" .Values.objectStorage.secretAccessKeySecretKeyRef | nindent 4 }}
{{- else if .Values.objectStorage.secretAccessKey }}
  value: {{ .Values.objectStorage.secretAccessKey | quote }}
{{- else if .Values.minio.enabled }}
  valueFrom:
    {{- include "anyray.secretRef" (dict "key" "MINIO_ROOT_PASSWORD" "context" .) | nindent 4 }}
{{- else }}
  value: ""
{{- end }}
- name: LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT
  value: {{ $mediaEndpoint | quote }}
- name: LANGFUSE_S3_MEDIA_UPLOAD_FORCE_PATH_STYLE
  value: {{ .Values.objectStorage.mediaUpload.forcePathStyle | quote }}
- name: LANGFUSE_S3_MEDIA_UPLOAD_PREFIX
  value: {{ .Values.objectStorage.mediaUpload.prefix | quote }}
{{- end }}

{{/*
Redis env for Langfuse web/worker.
*/}}
{{- define "anyray.redisEnv" -}}
{{- include "anyray.requireRedis" . }}
{{- $host := default (printf "%s-redis" (include "anyray.fullname" .)) .Values.redis.external.host -}}
- name: REDIS_HOST
  value: {{ $host | quote }}
- name: REDIS_PORT
  value: {{ .Values.redis.external.port | quote }}
- name: REDIS_AUTH
{{- if .Values.redis.external.authSecretKeyRef.name }}
  valueFrom:
    {{- include "anyray.externalSecretRef" .Values.redis.external.authSecretKeyRef | nindent 4 }}
{{- else if .Values.redis.external.auth }}
  value: {{ .Values.redis.external.auth | quote }}
{{- else if .Values.redis.enabled }}
  valueFrom:
    {{- include "anyray.secretRef" (dict "key" "REDIS_AUTH" "context" .) | nindent 4 }}
{{- else }}
  value: ""
{{- end }}
{{- end }}
