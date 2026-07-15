#!/usr/bin/env bash
#
# smoke-aws.sh — LIVE CloudFormation quicklaunch smoke test.
#
# Static validation (cfn-lint) proves the template parses; it cannot prove the
# stack *behaves* — the July 2026 console-500 shipped green through every static
# check because nginx's runtime DNS could not resolve the ECS Service Connect
# alias, something only a real deploy exposes. This script deploys for real and
# probes the golden paths, then tears everything down.
#
# Lanes (pick with LANE):
#   fresh   — create a stack from the CANDIDATE template, probe, delete.
#   update  — create a stack from the PUBLISHED template (what customers run
#             today), probe, then UPDATE it to the candidate — the exact path
#             an existing customer takes — and probe again. Catches
#             update-only failures (e.g. Cloud Map name collisions, in-place
#             transitions ECS refuses) that a fresh create never sees.
#
# Probes (per round):
#   1. GET :3000/console/ unauthenticated → 200 sign-in page, NOT an nginx 500.
#   2. GET :3000/console/ with the admin cookie → 200 (console SPA).
#   3. GET :3000/admin/health through the proxy → 200 (proxy→gateway seam).
#   4. scripts/verify-deploy.sh against :8787 (deep per-leg health).
#
# Required env: TEMPLATE, LANE, VPC_ID, SUBNET_A, SUBNET_B.
# Optional: STACK (name), PUBLISHED_URL, ALLOWED_CIDR (defaults to caller IP/32),
#           POLICY_ACTIVATE_AT (defaults two hours ahead), KEEP=1 to skip
#           teardown (debugging).
set -euo pipefail

TEMPLATE="${TEMPLATE:?path to candidate template}"
LANE="${LANE:?fresh|update}"
VPC_ID="${VPC_ID:?}"; SUBNET_A="${SUBNET_A:?}"; SUBNET_B="${SUBNET_B:?}"
STACK="${STACK:-cfn-smoke-${LANE}-$(date +%s)}"
PUBLISHED_URL="${PUBLISHED_URL:-https://anyray-quicklaunch.s3.us-east-1.amazonaws.com/anyray-quicklaunch.template.yaml}"
ALLOWED_CIDR="${ALLOWED_CIDR:-$(curl -fsS --max-time 10 https://checkip.amazonaws.com)/32}"
HERE="$(cd "$(dirname "$0")" && pwd)"

future_policy_activation_at() {
  local value=""
  value="$(date -u -d '+2 hours' '+%Y-%m-%dT%H:%M:%S.000Z' 2>/dev/null)" || \
    value="$(date -u -v+2H '+%Y-%m-%dT%H:%M:%S.000Z' 2>/dev/null)" || true
  [ -n "$value" ] || {
    echo "could not calculate a future policy activation instant with date" >&2
    return 1
  }
  printf '%s' "$value"
}

template_image_tag() {
  awk '
    /^  ImageTag:$/ { in_image_tag = 1; next }
    in_image_tag && /^    Default:/ { print $2; exit }
    in_image_tag && /^  [A-Za-z][A-Za-z0-9]*:/ { exit }
  ' "$@"
}

policy_activation_required() {
  # v1.10.116 is the last image that predates the policy contract. Any other
  # immutable release pin must supply the coordinated activation instant.
  [ "$1" != 'v1.10.116' ]
}

POLICY_ACTIVATE_AT="${POLICY_ACTIVATE_AT:-$(future_policy_activation_at)}"
CANDIDATE_IMAGE_TAG="$(template_image_tag "$TEMPLATE")"
if [[ ! "$CANDIDATE_IMAGE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "candidate CloudFormation ImageTag.Default is not immutable: ${CANDIDATE_IMAGE_TAG:-missing}" >&2
  exit 2
fi
BASE_PARAMS=(
  "ParameterKey=VpcId,ParameterValue=${VPC_ID}"
  "ParameterKey=SubnetA,ParameterValue=${SUBNET_A}"
  "ParameterKey=SubnetB,ParameterValue=${SUBNET_B}"
  "ParameterKey=AllowedCidr,ParameterValue=${ALLOWED_CIDR}"
  "ParameterKey=DeploymentToken,ParameterValue=adt_cismoke0000000000"
)
CANDIDATE_PARAMS=("${BASE_PARAMS[@]}")
if policy_activation_required "$CANDIDATE_IMAGE_TAG"; then
  CANDIDATE_PARAMS+=("ParameterKey=PersistentTranscriptPolicyActivateAt,ParameterValue=${POLICY_ACTIVATE_AT}")
fi

cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    # The stack is about to be deleted — surface WHY it failed while we still can.
    echo "→ failed stack events for ${STACK} (exit ${rc}):"
    aws cloudformation describe-stack-events --stack-name "$STACK" \
      --query "StackEvents[?contains(ResourceStatus,'FAILED')].[LogicalResourceId,ResourceStatus,ResourceStatusReason]" \
      --output table 2>/dev/null || true
  fi
  [ "${KEEP:-0}" = 1 ] && { echo "KEEP=1 — leaving stack ${STACK}"; return 0; }
  echo "→ teardown ${STACK}"
  aws cloudformation delete-stack --stack-name "$STACK" || true
  aws cloudformation wait stack-delete-complete --stack-name "$STACK" || \
    echo "::warning::teardown of ${STACK} did not complete — janitor will retry"
}
trap cleanup EXIT

output() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

probe() {
  local round="$1" console gateway token secret_arn body
  console="$(output ConsoleURL)"; gateway="$(output GatewayURL)"
  secret_arn="$(output AdminTokenCmd | grep -oE 'arn:aws:secretsmanager:[^ ]+')"
  token="$(aws secretsmanager get-secret-value --secret-id "$secret_arn" \
    --query SecretString --output text)"

  echo "→ [${round}] probing ${console}"

  # The console proxy is healthy from boot, but the gateway behind the /__auth
  # gate waits on RDS + migrations; poll the login page until the stack settles.
  local code=""
  for _ in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${console}/console/" || true)"
    [ "$code" = 200 ] && break
    sleep 10
  done
  if [ "$code" != 200 ]; then
    echo "::error::[${round}] unauthenticated /console/ returned ${code} (expected 200 sign-in page)."
    [ "$code" = 500 ] && echo "::error::A bare 500 here is the proxy failing its /__auth subrequest — check that the proxy can RESOLVE and REACH the gateway (see /anyray/${STACK}/proxy logs)."
    return 1
  fi
  body="$(curl -s --max-time 15 "${console}/console/")"
  printf '%s' "$body" | grep -qi 'sign in' || {
    echo "::error::[${round}] /console/ is 200 but is not the sign-in page."; return 1; }

  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
    -H "Cookie: anyray_key=${token}" "${console}/console/")"
  [ "$code" = 200 ] || { echo "::error::[${round}] authenticated /console/ → ${code}"; return 1; }

  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
    -H "Cookie: anyray_key=${token}" "${console}/admin/health")"
  [ "$code" = 200 ] || { echo "::error::[${round}] /admin/health via proxy → ${code}"; return 1; }

  "${HERE}/verify-deploy.sh" "$gateway" "$token"
  echo "✓ [${round}] console + gateway healthy"
}

case "$LANE" in
  fresh)
    echo "→ create ${STACK} from candidate ${TEMPLATE}"
    aws cloudformation create-stack --stack-name "$STACK" \
      --template-body "file://${TEMPLATE}" \
      --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
      --parameters "${CANDIDATE_PARAMS[@]}" >/dev/null
    aws cloudformation wait stack-create-complete --stack-name "$STACK"
    probe fresh
    ;;
  update)
    echo "→ create ${STACK} from PUBLISHED template"
    published_params=("${BASE_PARAMS[@]}")
    published_template="$(curl -fsS --max-time 30 "$PUBLISHED_URL")"
    published_image_tag="$(template_image_tag <<<"$published_template")"
    if grep -q '^  PersistentTranscriptPolicyActivateAt:' <<<"$published_template" \
      && policy_activation_required "$published_image_tag"; then
      published_params+=("ParameterKey=PersistentTranscriptPolicyActivateAt,ParameterValue=${POLICY_ACTIVATE_AT}")
    fi
    aws cloudformation create-stack --stack-name "$STACK" \
      --template-url "$PUBLISHED_URL" \
      --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
      --parameters "${published_params[@]}" >/dev/null
    aws cloudformation wait stack-create-complete --stack-name "$STACK"
    probe published

    echo "→ update ${STACK} to candidate (the customer upgrade path)"
    # The backticks are JMESPath boolean literals, not shell interpolation.
    # shellcheck disable=SC2016
    upd_params="$(aws cloudformation describe-stacks --stack-name "$STACK" \
      --query 'Stacks[0].Parameters[].{ParameterKey:ParameterKey,UsePreviousValue:`true`}' --output json)"
    # Existing stacks commonly have ImageTag=latest stored from the old
    # template. Replace it with the candidate's immutable pin instead of asking
    # CloudFormation to preserve a value the staged template now rejects.
    upd_params="$(jq --arg image "$CANDIDATE_IMAGE_TAG" '
      if any(.ParameterKey == "ImageTag") then
        map(if .ParameterKey == "ImageTag" then {ParameterKey: "ImageTag", ParameterValue: $image} else . end)
      else . + [{ParameterKey: "ImageTag", ParameterValue: $image}]
      end
    ' <<<"$upd_params")"
    if policy_activation_required "$CANDIDATE_IMAGE_TAG"; then
      upd_params="$(jq --arg value "$POLICY_ACTIVATE_AT" '
        if any(.ParameterKey == "PersistentTranscriptPolicyActivateAt") then
          map(if .ParameterKey == "PersistentTranscriptPolicyActivateAt" then {ParameterKey: "PersistentTranscriptPolicyActivateAt", ParameterValue: $value} else . end)
        else . + [{ParameterKey: "PersistentTranscriptPolicyActivateAt", ParameterValue: $value}]
        end
      ' <<<"$upd_params")"
    fi
    set +e
    upd_err="$(aws cloudformation update-stack --stack-name "$STACK" \
      --template-body "file://${TEMPLATE}" \
      --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
      --parameters "$upd_params" 2>&1 >/dev/null)"; rc=$?
    set -e
    if [ $rc -ne 0 ]; then
      # Candidate == published (e.g. the weekly cron on main): nothing to update
      # is a pass — the published round already probed green.
      printf '%s' "$upd_err" | grep -q 'No updates are to be performed' && {
        echo "✓ candidate is identical to published — update lane is a no-op"; exit 0; }
      echo "::error::update-stack failed: ${upd_err}"; exit 1
    fi
    aws cloudformation wait stack-update-complete --stack-name "$STACK"
    probe updated
    ;;
  *) echo "unknown LANE=${LANE}"; exit 2 ;;
esac
