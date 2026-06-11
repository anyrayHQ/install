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
