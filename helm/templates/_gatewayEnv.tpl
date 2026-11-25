{{- define "anyray.gatewayEnv" -}}
{{- include "anyray.observabilityDbEnv" . | nindent 0 }}
- name: ANYRAY_OPTIMIZER_URL
  value: "http://optimizer:8088"
- name: ANYRAY_OPTIMIZER_TOKEN
  valueFrom:
    {{- include "anyray.secretRef" (dict "key" "ANYRAY_OPTIMIZER_TOKEN" "context" .) | nindent 4 }}
{{- include "anyray.optimizerSigningKeyEnv" . }}
{{- with .Values.gateway.defaultModel }}
# What `anyray-default` routes to when a request names no model;
# without it the gateway falls back to a stale alias and 404s.
- name: ANYRAY_DEFAULT_MODEL
  value: {{ . | quote }}
{{- end }}
- name: ANYRAY_CONTENT_KEY
  valueFrom:
    {{- include "anyray.secretRef" (dict "key" "ANYRAY_CONTENT_KEY" "context" .) | nindent 4 }}
# Rotation only: the key(s) in use before the last change, so portable threads
# sealed under them keep working. Optional, so a Secret without the key is fine.
- name: ANYRAY_CONTENT_KEY_PREVIOUS
  valueFrom:
    {{- include "anyray.optionalSecretRef" (dict "key" "ANYRAY_CONTENT_KEY_PREVIOUS" "context" .) | nindent 4 }}
- name: ANYRAY_ALLOW_PLAINTEXT
  value: {{ .Values.gateway.allowPlaintext | quote }}
- name: ANYRAY_ADMIN_TOKEN
  valueFrom:
    {{- include "anyray.secretRef" (dict "key" "ANYRAY_ADMIN_TOKEN" "context" .) | nindent 4 }}
# All runtime-state files (settings, spend, provider/client keys,
# routing, user caps, audit logs, GDPR log, entitlement lease) live
# under one directory on the volume; the gateway derives every path
# from ANYRAY_DATA_DIR. Override an individual file with its
# ANYRAY_*_FILE var only if you need to (the per-file var wins).
- name: ANYRAY_DATA_DIR
  value: /data
# Billing is required. setup.sh writes the token and local salt to
# the Secret; the image pins the Billing URL and verification key.
# Kubernetes requires both Secret keys before starting this pod.
- name: ANYRAY_METERING_ENABLED
  value: "true"
- name: ANYRAY_DEPLOYMENT_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secretName }}
      key: ANYRAY_DEPLOYMENT_TOKEN
- name: ANYRAY_PSEUDONYM_SALT
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secretName }}
      key: ANYRAY_PSEUDONYM_SALT
- name: ANYRAY_METERING_INTERVAL_MS
  value: {{ .Values.gateway.metering.intervalMs | quote }}
- name: ANYRAY_ENTITLEMENT_GRACE_MS
  value: {{ .Values.gateway.metering.graceMs | quote }}
{{- with .Values.gateway.metering.seatExclude }}
- name: ANYRAY_SEAT_EXCLUDE
  value: {{ . | quote }}
{{- end }}
{{- with .Values.gateway.upstreamUrl }}
- name: ANYRAY_UPSTREAM_URL
  value: {{ . | quote }}
{{- end }}
{{- with .Values.gateway.customHostAllowlist }}
- name: ANYRAY_CUSTOM_HOST_ALLOWLIST
  value: {{ . | quote }}
{{- end }}
{{- with .Values.gateway.trustedCustomHosts }}
- name: TRUSTED_CUSTOM_HOSTS
  value: {{ . | quote }}
{{- end }}
{{- /* The gateway self-reports this URL to Anyray Cloud on each metering
       beat; it's what enrollment links hand a developer's tools. Default it
       to https://<host> (the Ingress endpoint) when publicUrl isn't set, so a
       plain `--host` install doesn't leave enrollment links with no gateway.
       NodePort / non-TLS installs override via gateway.publicUrl. */}}
{{- $gatewayPublicUrl := include "anyray.gatewayPublicUrl" . }}
{{- with $gatewayPublicUrl }}
- name: ANYRAY_GATEWAY_PUBLIC_URL
  value: {{ . | quote }}
{{- end }}
{{- /* A wildcard is no URL a client can dial; an explicitly plain-HTTP install keeps its gateway URL. */}}
{{- if and (eq .Values.topology "split") .Values.inference.host (not (contains "*" .Values.inference.host)) (not (hasPrefix "http://" (toString $gatewayPublicUrl))) }}
# The model base URL management hands out; inference pods accept it as their own /mcp host.
- name: ANYRAY_INFERENCE_PUBLIC_URL
  value: {{ printf "https://%s" .Values.inference.host | quote }}
{{- end }}
{{- with include "anyray.consolePublicUrl" (dict "gatewayPublicUrl" $gatewayPublicUrl "context" .) }}
- name: ANYRAY_CONSOLE_PUBLIC_URL
  value: {{ . | quote }}
{{- end }}
{{- with .Values.gateway.hsts }}
- name: ANYRAY_HSTS
  value: {{ . | quote }}
{{- end }}
{{- with .Values.gateway.trustProxy }}
- name: ANYRAY_TRUST_PROXY
  value: {{ . | quote }}
{{- end }}
{{- with .Values.gateway.rateLimitRpm }}
- name: ANYRAY_RATE_LIMIT_RPM
  value: {{ . | quote }}
{{- end }}
{{- with .Values.gateway.rateLimitIpRpm }}
- name: ANYRAY_RATE_LIMIT_IP_RPM
  value: {{ . | quote }}
{{- end }}
{{- with .Values.gateway.rateLimitUnauthRpm }}
- name: ANYRAY_RATE_LIMIT_UNAUTH_RPM
  value: {{ . | quote }}
{{- end }}
{{- with .Values.gateway.spendRetentionDays }}
- name: ANYRAY_SPEND_RETENTION_DAYS
  value: {{ . | quote }}
{{- end }}
{{- include "anyray.gatewayLimitsEnv" . }}
{{- with .Values.gateway.maxBodyBytes }}
- name: ANYRAY_MAX_BODY_BYTES
  value: {{ . | quote }}
{{- end }}
{{- with .Values.gateway.extraEnv }}
{{- toYaml . | nindent 0 }}
{{- end }}
{{- end }}

{{- define "anyray.gatewayPublicUrl" -}}
{{- .Values.gateway.publicUrl | default (ternary (printf "https://%s" .Values.host) "" (not (empty .Values.host))) -}}
{{- end }}

{{- /* Region gateway env: the region token is the mode, and the spend DB URL is the regional database. */}}
{{- define "anyray.regionEnv" -}}
- name: ANYRAY_REGION_TOKEN
  valueFrom:
    {{- include "anyray.secretRef" (dict "key" "ANYRAY_REGION_TOKEN" "context" .) | nindent 4 }}
- name: ANYRAY_OPTIMIZER_URL
  value: "http://optimizer:8088"
- name: ANYRAY_OPTIMIZER_TOKEN
  valueFrom:
    {{- include "anyray.secretRef" (dict "key" "ANYRAY_OPTIMIZER_TOKEN" "context" .) | nindent 4 }}
{{- include "anyray.optimizerSigningKeyEnv" . }}
{{- include "anyray.spendDbEnv" . | nindent 0 }}
{{- with include "anyray.gatewayPublicUrl" . }}
- name: ANYRAY_GATEWAY_PUBLIC_URL
  value: {{ . | quote }}
{{- end }}
{{- with .Values.gateway.trustProxy }}
- name: ANYRAY_TRUST_PROXY
  value: {{ . | quote }}
{{- end }}
{{- with .Values.gateway.rateLimitRpm }}
- name: ANYRAY_RATE_LIMIT_RPM
  value: {{ . | quote }}
{{- end }}
{{- with .Values.gateway.rateLimitIpRpm }}
- name: ANYRAY_RATE_LIMIT_IP_RPM
  value: {{ . | quote }}
{{- end }}
{{- with .Values.gateway.rateLimitUnauthRpm }}
- name: ANYRAY_RATE_LIMIT_UNAUTH_RPM
  value: {{ . | quote }}
{{- end }}
{{- include "anyray.gatewayLimitsEnv" . }}
{{- with .Values.gateway.maxBodyBytes }}
- name: ANYRAY_MAX_BODY_BYTES
  value: {{ . | quote }}
{{- end }}
{{- with .Values.gateway.extraEnv }}
{{- toYaml . | nindent 0 }}
{{- end }}
{{- end }}

{{- /* Shared by home and region gateways so the signing key cannot reach one and miss the other. */}}
{{- define "anyray.optimizerSigningKeyEnv" -}}
{{- if .Values.optimizerRequestSigning.enabled }}
# Gateway→optimizer request signing (ANY-202) — the PRIVATE half.
# Never place this on the optimizer: it holds the public half only,
# and that asymmetry is the entire security property.
#
# `optional: true` so an install that has enabled signing before
# adding the key to its Secret degrades to unsigned (which the
# optimizer, also unconfigured, accepts) instead of crashlooping the
# gateway. Turn the gateway on FIRST, then the optimizer.
- name: ANYRAY_OPTIMIZER_SIGNING_KEY
  valueFrom:
    {{- include "anyray.optionalSecretRef" (dict "key" "ANYRAY_OPTIMIZER_SIGNING_KEY" "context" .) | nindent 4 }}
{{- end }}
{{- end }}

{{- define "anyray.gatewayLimitsEnv" -}}
{{- with .Values.gateway.maxConcurrentRequests }}
- name: ANYRAY_MAX_CONCURRENT_REQUESTS
  value: {{ . | quote }}
{{- end }}
{{- with .Values.gateway.authFailLimit }}
- name: ANYRAY_AUTH_FAIL_LIMIT
  value: {{ . | quote }}
{{- end }}
{{- end }}

{{- /* Unset, the gateway reports its own URL with port 3000, where only Docker Compose serves the console. */}}
{{- define "anyray.consolePublicUrl" -}}
{{- $v := .context.Values }}
{{- if $v.gateway.consolePublicUrl }}
{{- $v.gateway.consolePublicUrl }}
{{- else if and $v.host (not (contains "*" $v.host)) }}
{{- $origin := trimSuffix "/" (toString .gatewayPublicUrl) }}
{{- $served := list }}
{{- if $v.ingress.enabled }}
{{- range $v.ingress.hosts }}{{ $served = append $served (default $v.host .host) }}{{ end }}
{{- if not $v.ingress.hosts }}{{ $served = append $served $v.host }}{{ end }}
{{- end }}
{{- if $v.httpRoute.enabled }}
{{- $served = concat $served ($v.httpRoute.hostnames | default (list $v.host)) }}
{{- end }}
{{- if and (has $v.host $served) (has $origin (list (printf "https://%s" $v.host) (printf "http://%s" $v.host))) }}
{{- $origin }}
{{- end }}
{{- end }}
{{- end }}
