#!/usr/bin/env bash
#
# verify-deploy.sh — post-deploy health check for an Anyray stack.
#
# With --claim, local health is only half the result: the script waits for the
# newly rotated deployment credential to phone home, reports local verification,
# and exits 0 only after Billing confirms the install claim is `ready`.
set -euo pipefail

INSTALL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${INSTALL_ROOT}/.env"
SECRET_FILE="${INSTALL_ROOT}/anyray-secrets.yaml"

GATEWAY_URL=""
ADMIN_TOKEN=""
DEPLOYMENT_TOKEN=""
CLAIM_URL=""
JSON_OUTPUT=0
JSON_ERROR_EMITTED=0
TOKEN_LOADED=0
VERIFY_COMPLETE=0

usage() {
  cat <<'EOF'
Usage: ./scripts/verify-deploy.sh [options] [gateway-url] [admin-token]

Options:
  --claim <install_url>  Verify against a short-lived Billing install claim.
  --json                 Stream content-free NDJSON states (requires --claim).
  -h, --help             Show this help.
EOF
}

positionals=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --claim) CLAIM_URL="${2:?--claim needs an install URL}"; shift 2 ;;
    --json) JSON_OUTPUT=1; shift ;;
    --*) echo "✗ unknown flag: $1" >&2; usage >&2; exit 1 ;;
    *) positionals+=("$1"); shift ;;
  esac
done

if [ "${#positionals[@]}" -gt 2 ]; then
  echo "✗ expected at most [gateway-url] [admin-token]" >&2
  exit 1
fi
GATEWAY_URL="${positionals[0]:-}"
ADMIN_TOKEN="${positionals[1]:-}"

if [ "$JSON_OUTPUT" -eq 1 ]; then
  exec 3>&1
  exec 1>/dev/null
fi

emit_json_status() {
  [ "$JSON_OUTPUT" -eq 1 ] || return 0
  case "$1" in
    gateway_connected|ready)
      printf '{"status":"%s"}\n' "$1" >&3 ;;
    error)
      JSON_ERROR_EMITTED=1
      printf '{"status":"error","errorCode":"%s"}\n' "${2:-verification_failed}" >&3 ;;
  esac
}

get_env() {
  [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | head -1 || true
}

get_yaml_secret() {
  [ -f "$SECRET_FILE" ] || return 0
  encoded="$(sed -n "s/^[[:space:]]*$1:[[:space:]]*//p" "$SECRET_FILE" | head -1)"
  [ -n "$encoded" ] || return 0
  printf '%s' "$encoded" | openssl base64 -d -A 2>/dev/null || true
}

valid_deployment_token() {
  [[ "$1" =~ ^adt_[A-Za-z0-9_-]+$ ]]
}

claim_url_valid() {
  cp_origin="$(get_env ANYRAY_CONTROL_PLANE_URL)"
  [ -n "$cp_origin" ] || cp_origin="$(get_yaml_secret ANYRAY_CONTROL_PLANE_URL)"
  [ -n "$cp_origin" ] || cp_origin="https://app.anyray.ai"
  cp_origin="${cp_origin%/}"
  case "$cp_origin" in
    https://*) : ;;
    *) return 1 ;;
  esac
  case "$CLAIM_URL" in
    "${cp_origin}/install/"*) claim_token="${CLAIM_URL#"${cp_origin}/install/"}" ;;
    *) return 1 ;;
  esac
  [[ "$claim_token" =~ ^aic_[A-Za-z0-9_-]{16,128}$ ]] &&
    [ "$CLAIM_URL" = "${cp_origin}/install/${claim_token}" ]
}

report_claim_progress() {
  status="$1"
  error_code="${2:-}"
  [ "$TOKEN_LOADED" -eq 1 ] || return 1
  if [ "$status" = error ]; then
    body="{\"status\":\"error\",\"errorCode\":\"${error_code:-verification_failed}\"}"
  else
    body="{\"status\":\"${status}\"}"
  fi
  for _attempt in 1 2 3; do
    if curl -q --config - >/dev/null 2>&1 <<EOF
url = "${CLAIM_URL}/progress"
request = "POST"
header = "Accept: application/json"
header = "Content-Type: application/json"
header = "Authorization: Bearer ${DEPLOYMENT_TOKEN}"
data = "${body//\"/\\\"}"
connect-timeout = 10
max-time = 30
fail
silent
show-error
EOF
    then
      return 0
    fi
  done
  return 1
}

verify_exit() {
  code=$?
  if [ "$code" -ne 0 ]; then
    if [ "$TOKEN_LOADED" -eq 1 ] && [ "$VERIFY_COMPLETE" -eq 0 ]; then
      report_claim_progress error verification_failed >/dev/null 2>&1 || true
    fi
    if [ "$JSON_ERROR_EMITTED" -eq 0 ]; then
      emit_json_status error verification_failed
    fi
  fi
}
trap verify_exit EXIT

fail_verify() {
  emit_json_status error "$1"
  echo "✗ $2" >&2
  exit 1
}

if [ "$JSON_OUTPUT" -eq 1 ] && [ -z "$CLAIM_URL" ]; then
  fail_verify invalid_arguments "--json requires --claim <install_url>"
fi

if [ -n "$CLAIM_URL" ]; then
  claim_url_valid || fail_verify invalid_claim_url "--claim does not match this install's configured Billing origin"
  command -v openssl >/dev/null 2>&1 || fail_verify missing_dependency "openssl is required to read deployment credentials"
  # Do not let `bash -x` echo the credential reads or later curl configs.
  case "$-" in *x*) set +x ;; esac
  DEPLOYMENT_TOKEN="$(get_env ANYRAY_DEPLOYMENT_TOKEN)"
  if ! valid_deployment_token "$DEPLOYMENT_TOKEN"; then
    DEPLOYMENT_TOKEN="$(get_yaml_secret ANYRAY_DEPLOYMENT_TOKEN)"
  fi
  valid_deployment_token "$DEPLOYMENT_TOKEN" || fail_verify missing_deployment_token "could not read the deployment token from .env or anyray-secrets.yaml"
  TOKEN_LOADED=1
fi

if [ -z "$GATEWAY_URL" ]; then
  GATEWAY_URL="$(get_env ANYRAY_GATEWAY_PUBLIC_URL)"
  [ -n "$GATEWAY_URL" ] || GATEWAY_URL="http://localhost:8787"
fi
if [ -z "$ADMIN_TOKEN" ]; then
  ADMIN_TOKEN="$(get_env ANYRAY_ADMIN_TOKEN)"
  [ -n "$ADMIN_TOKEN" ] || ADMIN_TOKEN="$(get_yaml_secret ANYRAY_ADMIN_TOKEN)"
fi
GATEWAY_URL="${GATEWAY_URL%/}"

echo "→ Verifying Anyray at ${GATEWAY_URL}"

# Poll liveness for roughly 90 seconds. First boot may still be pulling images.
printf '  gateway liveness … '
live=0
for _ in $(seq 1 45); do
  if curl -fsS --connect-timeout 3 --max-time 5 -o /dev/null "${GATEWAY_URL}/" 2>/dev/null; then
    live=1
    break
  fi
  sleep 2
done
if [ "$live" != 1 ]; then
  echo "UNREACHABLE"
  fail_verify gateway_unreachable "the gateway never answered; confirm the URL and deployment"
fi
echo "ok"

if [ -z "$ADMIN_TOKEN" ]; then
  if [ -n "$CLAIM_URL" ]; then
    fail_verify missing_admin_token "claim verification requires ANYRAY_ADMIN_TOKEN in .env or anyray-secrets.yaml"
  fi
  echo "  (no admin token found — skipping deep health)"
  VERIFY_COMPLETE=1
  exit 0
fi

# Query deep health without placing the admin credential in argv. The response
# is content-free, but malformed bodies still stay out of diagnostics.
BODY="$(curl -q --config - 2>/dev/null <<EOF
url = "${GATEWAY_URL}/admin/health"
header = "Authorization: Bearer ${ADMIN_TOKEN}"
connect-timeout = 10
max-time = 30
silent
show-error
EOF
)" || true
if [ -z "$BODY" ]; then
  fail_verify health_unavailable "/admin/health returned no response"
fi

if command -v jq >/dev/null 2>&1; then
  OVERALL="$(printf '%s' "$BODY" | jq -r 'if has("ok") then .ok else "missing" end' 2>/dev/null || true)"
  if [ "$OVERALL" != true ] && [ "$OVERALL" != false ]; then
    fail_verify invalid_health_response "could not read /admin/health"
  fi
  printf '%s' "$BODY" | jq -r '
    "  observability: ok=" + (.observability.ok|tostring) + " configured=" + (.observability.configured|tostring),
    "  spend:         ok=" + (.spend.ok|tostring),
    "  optimizer:     ok=" + (.optimizer.ok|tostring) + " configured=" + (.optimizer.configured|tostring),
    "  portal:        metering=" + (.portal.metering|tostring) + " lease=" + (.portal.lease|tostring)'

  obs_conf="$(printf '%s' "$BODY" | jq -r '.observability.configured')"
  obs_ok="$(printf '%s' "$BODY" | jq -r '.observability.ok')"
  spend_ok="$(printf '%s' "$BODY" | jq -r '.spend.ok')"
  opt_conf="$(printf '%s' "$BODY" | jq -r '.optimizer.configured')"
  opt_ok="$(printf '%s' "$BODY" | jq -r '.optimizer.ok')"

  [ "$obs_conf" = false ] && echo "    ⚠ observability not configured — set the observability database URL"
  [ "$obs_conf" = true ] && [ "$obs_ok" = false ] && echo "    ⚠ observability store unreachable"
  [ "$spend_ok" = false ] && echo "    ⚠ spend store unreachable"
  [ "$opt_conf" = true ] && [ "$opt_ok" = false ] && echo "    ⚠ optimizer not answering (the gateway remains fail-open)"
else
  OVERALL="$(printf '%s' "$BODY" | grep -o '"ok":[a-z]*' | head -1 | sed 's/"ok"://')"
fi
unset BODY

if [ "$OVERALL" != true ]; then
  fail_verify health_failed "deployment health is not green; address the failing leg and retry"
fi

if [ -z "$CLAIM_URL" ]; then
  echo "✓ Deployment healthy — all required legs are green."
  VERIFY_COMPLETE=1
  exit 0
fi

claim_status() {
  response="$(curl -q --config - 2>/dev/null <<EOF
url = "${CLAIM_URL}"
header = "Accept: application/json"
connect-timeout = 10
max-time = 30
fail
silent
show-error
EOF
)" || return 1
  printf '%s' "$response" | tr -d '\r\n' | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([a-z_]*\)".*/\1/p'
}

# Billing owns gateway_connected because only it can prove a heartbeat arrived
# after redemption. Wait for that proof before submitting local Ready.
gateway_connected=0
for _ in $(seq 1 45); do
  status="$(claim_status)" || status=""
  case "$status" in
    ready)
      emit_json_status ready
      echo "✓ Deployment verified and Billing reports Ready."
      VERIFY_COMPLETE=1
      exit 0 ;;
    gateway_connected)
      gateway_connected=1
      emit_json_status gateway_connected
      break ;;
    error)
      fail_verify install_claim_error "Billing reports that the install needs attention" ;;
    pending|claimed|preflight|configured|'') sleep 2 ;;
    *) fail_verify invalid_claim_response "Billing returned an unknown install status" ;;
  esac
done
[ "$gateway_connected" -eq 1 ] || fail_verify gateway_not_connected "the deployment did not phone home before the verification timeout"

report_claim_progress ready || fail_verify ready_rejected "Billing did not accept the local Ready report"

# Confirm the state through the public poll surface. Do not trust only the POST
# transport result; the portal and the agent both consume this final state.
for _ in $(seq 1 10); do
  status="$(claim_status)" || status=""
  if [ "$status" = ready ]; then
    emit_json_status ready
    echo "✓ Deployment verified and Billing reports Ready."
    VERIFY_COMPLETE=1
    exit 0
  fi
  [ "$status" = error ] && fail_verify install_claim_error "Billing reports that the install needs attention"
  sleep 1
done

fail_verify ready_not_confirmed "Billing did not confirm Ready"
