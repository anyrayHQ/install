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
#   ha      — create the candidate with HighAvailability + EnableAutoscaling,
#             assert the auto-sized Multi-AZ database and the scaling targets
#             and policies, probe, delete.
#   flip    — a stack that runs with EnableAutoUpdate=false, one release
#             behind (FROM_TAG), gets ONE stack update on its previous
#             template: EnableAutoUpdate=true and ImageTag=TO_TAG. Polls the
#             gateway through the update, asserts the updater now exists and
#             every service moved, then asks the updater for ROLL_TAG and
#             asserts that roll too.
#   self    — the same starting stack, but the update flips EnableAutoUpdate
#             only. The gateway now has an applier and is behind, so it must
#             move itself to TO_TAG with no further stack update.
#
# The candidate is staged in S3 (TEMPLATE_BUCKET) and deployed by URL: the
# template is past CloudFormation's 51,200-byte --template-body cap.
#
# Probes (per round):
#   1. GET :3000/console/ unauthenticated → 200 sign-in page, NOT an nginx 500.
#   2. POST :3000/admin/auth/login with the admin key → an anyray_admin_session
#      cookie, then GET :3000/console/ with it → 200 (console SPA).
#   3. GET :3000/admin/health through the proxy with that session → 200
#      (proxy→gateway seam).
#   4. scripts/verify-deploy.sh against :8787 (deep per-leg health).
#
# Required env: TEMPLATE, LANE, VPC_ID, SUBNET_A, SUBNET_B, DEPLOYMENT_TOKEN
#   (a real adt_ token; a placeholder never gets an entitlement lease, so the
#   gateway's /readyz stays 503 and the stack never finishes creating).
# Optional: STACK (name), PUBLISHED_URL, ALLOWED_CIDR (defaults to caller IP/32),
#           TEMPLATE_BUCKET (defaults to anyray-cfn-smoke-tpl-<account>, with
#           -<region> appended outside eu-central-1: the URL must name the
#           bucket's own region),
#           KEEP=1 to skip teardown (debugging).
# flip and self also take: FROM_TAG (required, the release the stack starts
#   on), TO_TAG (defaults to the candidate's ImageTag), BASE_REF (a full commit
#   sha of this repo whose template the stack is created from; defaults to the
#   candidate), and for flip ROLL_TAG (a release newer than TO_TAG).
set -euo pipefail

TEMPLATE="${TEMPLATE:?path to candidate template}"
LANE="${LANE:?fresh|update|ha|flip|self}"
VPC_ID="${VPC_ID:?}"; SUBNET_A="${SUBNET_A:?}"; SUBNET_B="${SUBNET_B:?}"
STACK="${STACK:-cfn-smoke-${LANE}-$(date +%s)}"
PUBLISHED_URL="${PUBLISHED_URL:-https://anyray-quicklaunch.s3.us-east-1.amazonaws.com/anyray-quicklaunch.template.yaml}"
ALLOWED_CIDR="${ALLOWED_CIDR:-$(curl -fsS --max-time 10 https://checkip.amazonaws.com)/32}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOYMENT_TOKEN="${DEPLOYMENT_TOKEN:?a real adt_ deployment token (repo secret ANYRAY_CFN_SMOKE_DEPLOYMENT_TOKEN)}"
REGION="${AWS_REGION:-$(aws configure get region)}"
if [ -z "${TEMPLATE_BUCKET:-}" ]; then
  TEMPLATE_BUCKET="anyray-cfn-smoke-tpl-$(aws sts get-caller-identity --query Account --output text)"
  # The first bucket lives in eu-central-1. A stack elsewhere gets its own, so
  # the regional URL below names the region the bucket is really in.
  [ "$REGION" = eu-central-1 ] || TEMPLATE_BUCKET="${TEMPLATE_BUCKET}-${REGION}"
fi
CANDIDATE_KEY="candidate-${STACK}.yaml"
CANDIDATE_URL="https://${TEMPLATE_BUCKET}.s3.${REGION}.amazonaws.com/${CANDIDATE_KEY}"
BASE_KEY="base-${STACK}.yaml"
POLL_LOG="$(mktemp)"
POLL_PID=""

template_image_tag() {
  awk '
    /^  ImageTag:$/ { in_image_tag = 1; next }
    in_image_tag && /^    Default:/ { print $2; exit }
    in_image_tag && /^  [A-Za-z][A-Za-z0-9]*:/ { exit }
  ' "$@"
}

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
  "ParameterKey=DeploymentToken,ParameterValue=${DEPLOYMENT_TOKEN}"
)
CANDIDATE_PARAMS=("${BASE_PARAMS[@]}")

cleanup() {
  local rc=$?
  if [ -n "$POLL_PID" ]; then kill "$POLL_PID" 2>/dev/null || true; fi
  if [ "$rc" -ne 0 ]; then
    # The stack is about to be deleted — surface WHY it failed while we still can.
    echo "→ failed stack events for ${STACK} (exit ${rc}):"
    aws cloudformation describe-stack-events --stack-name "$STACK" \
      --query "StackEvents[?contains(ResourceStatus,'FAILED')].[LogicalResourceId,ResourceStatus,ResourceStatusReason]" \
      --output table 2>/dev/null || true
  fi
  aws s3 rm --only-show-errors "s3://${TEMPLATE_BUCKET}/${CANDIDATE_KEY}" || true
  aws s3 rm --only-show-errors "s3://${TEMPLATE_BUCKET}/${BASE_KEY}" || true
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

  # The console takes the admin key once, at POST /admin/auth/login (JSON
  # only), and answers with an HttpOnly anyray_admin_session cookie. Since
  # monorepo #4923 (2026-10-27) the proxy no longer turns an `anyray_key`
  # cookie into a bearer token, so sending the raw key as a cookie gets a 401.
  # The key goes in on stdin, never on a command line.
  local session
  session="$(jq -Rc '{admin_token: .}' <<<"$token" \
    | curl -s -o /dev/null -D - --max-time 15 -H 'content-type: application/json' \
        --data-binary @- "${console}/admin/auth/login" \
    | tr -d '\r' \
    | sed -n 's/^[Ss]et-[Cc]ookie: \(anyray_admin_session=[^;]*\).*/\1/p' | head -n 1)"
  [ -n "$session" ] || {
    echo "::error::[${round}] POST /admin/auth/login set no anyray_admin_session cookie"; return 1; }

  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
    -H "Cookie: ${session}" "${console}/console/")"
  [ "$code" = 200 ] || { echo "::error::[${round}] authenticated /console/ → ${code}"; return 1; }

  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
    -H "Cookie: ${session}" "${console}/admin/health")"
  [ "$code" = 200 ] || { echo "::error::[${round}] /admin/health via proxy → ${code}"; return 1; }

  "${HERE}/verify-deploy.sh" "$gateway" "$token"
  echo "✓ [${round}] console + gateway healthy"
}

phys() {
  aws cloudformation describe-stack-resource --stack-name "$STACK" --logical-resource-id "$1" \
    --query StackResourceDetail.PhysicalResourceId --output text
}

# "<class>\t<MultiAZ>" of the stack's database.
db_state() {
  aws rds describe-db-instances --db-instance-identifier "$(phys Db)" \
    --query 'DBInstances[0].[DBInstanceClass,MultiAZ]' --output text
}

# One "<resource id>\t<min>\t<max>" line per ECS scalable target in this stack.
scalable_targets() {
  aws application-autoscaling describe-scalable-targets --service-namespace ecs \
    --query "ScalableTargets[?starts_with(ResourceId,'service/$(phys Cluster)/')].[ResourceId,MinCapacity,MaxCapacity]" \
    --output text
}

expect() { # expect <what> <actual> <wanted>
  [ "$2" = "$3" ] || { echo "::error::${1}: got '${2}', want '${3}'"; exit 1; }
  echo "✓ ${1}: ${2}"
}

# ---- helpers for the flip and self lanes ------------------------------------

service_arns() {
  aws ecs list-services --cluster "$(phys Cluster)" --query 'serviceArns[]' --output text
}

# The distinct image tags across every service's task definition, space
# separated. One tag means all the services run the same release.
image_tags() {
  local cluster arn td
  cluster="$(phys Cluster)"
  for arn in $(service_arns); do
    td="$(aws ecs describe-services --cluster "$cluster" --services "$arn" \
      --query 'services[0].taskDefinition' --output text)"
    aws ecs describe-task-definition --task-definition "$td" \
      --query 'taskDefinition.containerDefinitions[].image' --output text
  done | tr '\t' '\n' | sed 's/.*://' | sort -u | paste -sd' ' -
}

# A roll with a 120s deregistration delay can outlast one 10-minute waiter.
services_stable() {
  local cluster arns
  cluster="$(phys Cluster)"
  arns="$(service_arns)"
  # shellcheck disable=SC2086  # the ARN list is split on purpose
  aws ecs wait services-stable --cluster "$cluster" --services $arns ||
    aws ecs wait services-stable --cluster "$cluster" --services $arns
}

# "yes" when the stack owns the updater's API.
has_updater() {
  local id
  id="$(aws cloudformation describe-stack-resources --stack-name "$STACK" \
    --query "StackResources[?LogicalResourceId=='UpdaterApi'].PhysicalResourceId" --output text)"
  if [ -n "$id" ] && [ "$id" != None ]; then echo yes; else echo no; fi
}

admin_token() {
  aws secretsmanager get-secret-value \
    --secret-id "$(output AdminTokenCmd | grep -oE 'arn:aws:secretsmanager:[^ ]+')" \
    --query SecretString --output text
}

# GET /admin/update-status on the gateway: versions and update state, no
# content. The admin key rides a curl config on stdin, never argv.
update_status() {
  local token gateway
  token="$(admin_token)"; gateway="$(output GatewayURL)"
  curl -q --config - 2>/dev/null <<EOF || true
url = "${gateway}/admin/update-status"
header = "Authorization: Bearer ${token}"
connect-timeout = 10
max-time = 30
silent
EOF
}

status_field() { update_status | jq -r "$1" 2>/dev/null || true; }

STATUS_VIEW='{version, updateMethod, hasApplier, autoSoftUpdates, updateClass,
  target: .preflight.target, preflight: .preflight.status,
  advisory: (.update != null), loop: .autoUpdateLoop}'

show_status() { update_status | jq -c "$STATUS_VIEW" 2>/dev/null || echo "(no update status)"; }

# POST the trigger the gateway itself sends: bearer admin key plus a target.
updater_post() { # updater_post <tag>
  local endpoint token
  endpoint="$(aws apigatewayv2 get-api --api-id "$(phys UpdaterApi)" --query ApiEndpoint --output text)"
  token="$(admin_token)"
  curl -q --config - 2>/dev/null <<EOF
url = "${endpoint}"
request = "POST"
header = "Authorization: Bearer ${token}"
header = "content-type: application/json"
data = "{\"target\":\"${1}\"}"
connect-timeout = 10
max-time = 40
silent
EOF
}

# Poll the gateway's liveness path in the background while a roll runs.
poll_start() {
  local url
  url="$(output GatewayURL)/"
  : > "$POLL_LOG"
  (
    while :; do
      code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 5 "$url" || true)"
      printf '%s %s\n' "$(date -u +%H:%M:%S)" "$code"
      sleep 2
    done
  ) >> "$POLL_LOG" &
  POLL_PID=$!
}

poll_stop() { # poll_stop <label>
  kill "$POLL_PID" 2>/dev/null || true
  wait "$POLL_PID" 2>/dev/null || true
  POLL_PID=""
  local total bad
  total="$(wc -l < "$POLL_LOG" | tr -d ' ')"
  bad="$(grep -vc ' 200$' "$POLL_LOG" || true)"
  echo "→ [${1}] gateway answered 200 on $((total - bad)) of ${total} polls"
  if [ "$bad" -gt 0 ]; then
    echo "::warning::[${1}] ${bad} of ${total} gateway polls were not 200"
    grep -v ' 200$' "$POLL_LOG" | head -40
  fi
}

# The URL of the template the starting stack is created from: the candidate,
# or this repo's template at BASE_REF, staged beside it.
base_template_url() {
  if [ -z "${BASE_REF:-}" ]; then printf '%s' "$CANDIDATE_URL"; return 0; fi
  [[ "$BASE_REF" =~ ^[0-9a-f]{40}$ ]] || { echo "BASE_REF must be a full commit sha" >&2; return 2; }
  local file
  file="$(mktemp)"
  git -C "${HERE}/.." fetch --quiet --depth 1 origin "$BASE_REF"
  git -C "${HERE}/.." show "${BASE_REF}:${TEMPLATE}" > "$file"
  aws s3 cp --only-show-errors "$file" "s3://${TEMPLATE_BUCKET}/${BASE_KEY}"
  printf 'https://%s.s3.%s.amazonaws.com/%s' "$TEMPLATE_BUCKET" "$REGION" "$BASE_KEY"
}

# Every stored parameter kept, except the ones named: <key> <value> pairs.
update_params() {
  local params
  # The backticks are JMESPath boolean literals, not shell interpolation.
  # shellcheck disable=SC2016
  params="$(aws cloudformation describe-stacks --stack-name "$STACK" \
    --query 'Stacks[0].Parameters[].{ParameterKey:ParameterKey,UsePreviousValue:`true`}' --output json)"
  while [ "$#" -ge 2 ]; do
    params="$(jq --arg key "$1" --arg value "$2" \
      'map(if .ParameterKey == $key then {ParameterKey: $key, ParameterValue: $value} else . end)' <<<"$params")"
    shift 2
  done
  printf '%s' "$params"
}

# One stack update on the template the stack already has, polled throughout.
update_on_previous_template() { # <label> <key> <value> [<key> <value>...]
  local label="$1"; shift
  local params
  params="$(update_params "$@")"
  poll_start
  aws cloudformation update-stack --stack-name "$STACK" --use-previous-template \
    --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
    --parameters "$params" >/dev/null
  aws cloudformation wait stack-update-complete --stack-name "$STACK"
  poll_stop "$label"
}

# Stage the candidate: it is past the 51,200-byte --template-body cap, so every
# create/update of it goes through --template-url.
aws s3api head-bucket --bucket "$TEMPLATE_BUCKET" 2>/dev/null || {
  aws s3api create-bucket --bucket "$TEMPLATE_BUCKET" \
    --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
  aws s3api put-public-access-block --bucket "$TEMPLATE_BUCKET" \
    --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
}
aws s3 cp --only-show-errors "$TEMPLATE" "s3://${TEMPLATE_BUCKET}/${CANDIDATE_KEY}"

case "$LANE" in
  fresh)
    echo "→ create ${STACK} from candidate ${TEMPLATE}"
    aws cloudformation create-stack --stack-name "$STACK" \
      --template-url "$CANDIDATE_URL" \
      --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
      --parameters "${CANDIDATE_PARAMS[@]}" >/dev/null
    aws cloudformation wait stack-create-complete --stack-name "$STACK"
    expect "database (blank class, no HA)" "$(db_state)" $'db.t4g.small\tFalse'
    expect "scalable targets (autoscaling off)" "$(scalable_targets)" ""
    probe fresh
    ;;
  ha)
    echo "→ create ${STACK} from candidate with HighAvailability + EnableAutoscaling"
    aws cloudformation create-stack --stack-name "$STACK" \
      --template-url "$CANDIDATE_URL" \
      --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
      --parameters "${CANDIDATE_PARAMS[@]}" \
        ParameterKey=HighAvailability,ParameterValue=true \
        ParameterKey=EnableAutoscaling,ParameterValue=true >/dev/null
    aws cloudformation wait stack-create-complete --stack-name "$STACK"
    expect "database (blank class, HA)" "$(db_state)" $'db.t4g.medium\tTrue'
    targets="$(scalable_targets)"
    expect "gateway scaling range" "$(grep -F 'GatewayService' <<<"$targets" | cut -f2,3)" $'2\t3'
    expect "optimizer scaling range" "$(grep -F 'OptimizerService' <<<"$targets" | cut -f2,3)" $'2\t6'
    expect "scaling policies" "$(aws application-autoscaling describe-scaling-policies --service-namespace ecs \
      --query "length(ScalingPolicies[?starts_with(PolicyName,'${STACK}-')])" --output text)" 2
    probe ha
    ;;
  update)
    echo "→ create ${STACK} from PUBLISHED template"
    published_params=("${BASE_PARAMS[@]}")
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
    set +e
    upd_err="$(aws cloudformation update-stack --stack-name "$STACK" \
      --template-url "$CANDIDATE_URL" \
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
  flip|self)
    FROM_TAG="${FROM_TAG:?the release the stack starts on, e.g. v1.10.595}"
    TO_TAG="${TO_TAG:-$CANDIDATE_IMAGE_TAG}"
    ROLL_TAG="${ROLL_TAG:-}"
    for tag in "$FROM_TAG" "$TO_TAG" ${ROLL_TAG:+"$ROLL_TAG"}; do
      [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a release tag: ${tag}" >&2; exit 2; }
    done
    base_url="$(base_template_url)"

    echo "→ create ${STACK} at ${FROM_TAG} with EnableAutoUpdate=false (template: ${BASE_REF:-candidate})"
    aws cloudformation create-stack --stack-name "$STACK" \
      --template-url "$base_url" \
      --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
      --parameters "${BASE_PARAMS[@]}" \
        ParameterKey=EnableAutoUpdate,ParameterValue=false \
        "ParameterKey=ImageTag,ParameterValue=${FROM_TAG}" >/dev/null
    aws cloudformation wait stack-create-complete --stack-name "$STACK"
    probe off
    expect "updater while EnableAutoUpdate=false" "$(has_updater)" no
    expect "image tags (created)" "$(image_tags)" "$FROM_TAG"
    expect "gateway has an applier (off)" "$(status_field .hasApplier)" false
    show_status

    if [ "$LANE" = flip ]; then
      echo "→ one stack update: EnableAutoUpdate=true and ImageTag=${TO_TAG}"
      update_on_previous_template flip EnableAutoUpdate true ImageTag "$TO_TAG"
    else
      echo "→ one stack update: EnableAutoUpdate=true only (stays on ${FROM_TAG})"
      update_on_previous_template flip EnableAutoUpdate true
    fi
    expect "updater while EnableAutoUpdate=true" "$(has_updater)" yes
    show_status

    if [ "$LANE" = flip ]; then
      expect "image tags (after the update)" "$(image_tags)" "$TO_TAG"
      probe on
      expect "gateway has an applier (on)" "$(status_field .hasApplier)" true
      expect "automatic soft updates" "$(status_field .autoSoftUpdates)" true
      expect "gateway version" "$(status_field .version)" "${TO_TAG#v}"

      # The loop's first check runs two minutes after the gateway boots.
      echo "→ wait for the gateway's own update check"
      outcome=""
      for _ in $(seq 1 30); do
        outcome="$(status_field '.autoUpdateLoop.outcome // empty')"
        [ -n "$outcome" ] && break
        sleep 20
      done
      show_status
      expect "gateway's own update check" "$outcome" up-to-date

      if [ -n "$ROLL_TAG" ]; then
        echo "→ ask the updater for ${ROLL_TAG}, the way the gateway does"
        answer="$(updater_post "$ROLL_TAG" || true)"
        jq -c '{status, tag, target, updated, alreadyCurrent}' <<<"$answer" || echo "(unreadable updater answer)"
        expect "updater answer" "$(jq -r '.status // empty' <<<"$answer" 2>/dev/null || true)" ok
        expect "image tags (updater asked)" "$(image_tags)" "$ROLL_TAG"
        poll_start
        services_stable
        poll_stop "updater roll"
        probe rolled
        expect "gateway version (rolled)" "$(status_field .version)" "${ROLL_TAG#v}"
      fi
    else
      echo "→ wait for the gateway to move itself ${FROM_TAG} → ${TO_TAG}"
      poll_start
      moved=""
      for i in $(seq 1 70); do
        tags="$(image_tags)"
        if [ "$tags" = "$TO_TAG" ]; then moved=yes; break; fi
        if [ $((i % 4)) -eq 0 ]; then
          echo "  $(date -u +%H:%M:%S) tags=${tags} loop=$(status_field '.autoUpdateLoop | tojson')"
        fi
        sleep 30
      done
      if [ -z "$moved" ]; then
        poll_stop "self-update (never happened)"
        show_status
        echo "::error::the gateway did not move itself to ${TO_TAG} within 35 minutes"
        exit 1
      fi
      services_stable
      poll_stop "self-update"
      probe self-updated
      show_status
      expect "gateway version (self-updated)" "$(status_field .version)" "${TO_TAG#v}"

      echo "→ the stack's own ImageTag catches up to ${TO_TAG}"
      update_on_previous_template "ImageTag catch-up" ImageTag "$TO_TAG"
      expect "image tags (ImageTag caught up)" "$(image_tags)" "$TO_TAG"
      probe caught-up
    fi
    ;;
  *) echo "unknown LANE=${LANE}"; exit 2 ;;
esac
