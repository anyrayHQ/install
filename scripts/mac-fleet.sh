#!/usr/bin/env bash
# On-demand macOS signing fleet lifecycle (RFC 0010).
#
# EC2 Mac dedicated hosts bill a 24-HOUR MINIMUM per allocation and CodeBuild
# MAC_ARM fleets cannot scale below baseCapacity=1, so a standing fleet would
# cost ~$450+/month. Instead the release workflow allocates a Mac ONLY when a
# signing run needs one: `up` creates the fleet + an ephemeral CodeBuild runner
# project (webhook-driven, gated to the maintainer actor); `down` deletes the
# RUNNER but leaves the fleet, so every run inside the already-paid 24h window
# reuses the same Mac and AWS reclaims it afterwards.
#
# **The billing unit is the DAY, not the release.** Deleting the fleet after each
# run does not refund the 24h minimum — it only guarantees the next run re-buys
# it. That cost ~$720/mo against 2.7h of real use; see the note on `down`.
#
# Idempotent: `up` reuses an existing fleet/project (including one in
# PENDING_DELETION, still buildable inside its window), `down` tolerates absence.
set -euo pipefail

REGION="${AWS_REGION:-eu-central-1}"
# Never hardcode the account id: this repo is PUBLIC, and a literal id hands a
# reader the other half of every role ARN below — enough to enumerate role names
# and probe them for a permissive cross-account trust policy. Take it from the
# environment when set, otherwise derive it from whoever is already
# authenticated (the callers assume the fleet role via OIDC first, so this
# resolves to the account that owns the fleet).
ACCOUNT="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)}"
case "$ACCOUNT" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
  *) echo "::error::cannot determine the AWS account id (got '${ACCOUNT}'): set AWS_ACCOUNT_ID, or configure credentials so 'aws sts get-caller-identity' succeeds"; exit 1 ;;
esac
FLEET="anyray-install-mac-fleet"
PROJECT="anyray-install-runner-mac"
FLEET_SERVICE_ROLE="arn:aws:iam::${ACCOUNT}:role/anyray-mac-fleet-service"
RUNNER_SERVICE_ROLE="arn:aws:iam::${ACCOUNT}:role/anyray-gha-runner-codebuild"
CODECONNECTION="arn:aws:codeconnections:${REGION}:${ACCOUNT}:connection/f9f248ff-57a1-4de0-8f46-52349e85eae9"
# Only this GitHub account id may start a runner (fork-PR RCE guard on a PUBLIC repo).
ACTOR_ACCOUNT_ID="16443050"
SOURCE_URL="https://github.com/anyrayHQ/install.git"

fleet_arn() {
  aws codebuild batch-get-fleets --region "$REGION" --names "$FLEET" \
    --query 'fleets[0].arn' --output text 2>/dev/null | grep -v '^None$' || true
}

up() {
  local arn; arn="$(fleet_arn)"
  if [ -z "$arn" ]; then
    echo "creating MAC_ARM fleet $FLEET (baseCapacity=1)…"
    arn="$(aws codebuild create-fleet --region "$REGION" --name "$FLEET" \
      --base-capacity 1 --environment-type MAC_ARM \
      --compute-type BUILD_GENERAL1_MEDIUM \
      --fleet-service-role "$FLEET_SERVICE_ROLE" \
      --query 'fleet.arn' --output text)"
  else
    echo "fleet already exists: $arn"
  fi

  echo "waiting for the fleet to be usable (Mac host allocation ~minutes)…"
  for _ in $(seq 1 60); do
    local st
    st="$(aws codebuild batch-get-fleets --region "$REGION" --names "$FLEET" \
      --query 'fleets[0].status.statusCode' --output text 2>/dev/null || echo PENDING)"
    echo "  fleet status: $st"
    case "$st" in
      # ACTIVE = freshly warmed. PENDING_DELETION = a prior release's fleet
      # inside its 24h-minimum window: CodeBuild keeps it "available to build
      # projects while pending deletion", so a release within 24h reuses the
      # same Mac at no additional host charge. Both are ready to build on.
      ACTIVE|PENDING_DELETION) break ;;
      CREATE_FAILED|UPDATE_ROLLBACK_FAILED|DELETING) echo "::error::fleet entered $st"; exit 1 ;;
    esac
    sleep 20
  done

  # Ephemeral runner project bound to the fleet. If it exists, repoint it.
  if aws codebuild batch-get-projects --region "$REGION" --names "$PROJECT" \
       --query 'projects[0].name' --output text 2>/dev/null | grep -q "$PROJECT"; then
    echo "updating existing project $PROJECT -> fleet $arn"
    aws codebuild update-project --region "$REGION" --name "$PROJECT" \
      --environment "type=MAC_ARM,image=aws/codebuild/macos-arm-base:14,computeType=BUILD_GENERAL1_MEDIUM,fleet={fleetArn=$arn}" >/dev/null
  else
    echo "creating project $PROJECT bound to fleet $arn"
    aws codebuild create-project --region "$REGION" --name "$PROJECT" \
      --description "Ephemeral on-demand macOS signing runner (RFC 0010); created/deleted per release by mac-fleet.sh" \
      --source "type=GITHUB,location=$SOURCE_URL,auth={type=CODECONNECTIONS,resource=$CODECONNECTION}" \
      --artifacts type=NO_ARTIFACTS \
      --environment "type=MAC_ARM,image=aws/codebuild/macos-arm-base:14,computeType=BUILD_GENERAL1_MEDIUM,fleet={fleetArn=$arn}" \
      --service-role "$RUNNER_SERVICE_ROLE" >/dev/null
    # Webhook: start a runner on a queued job, but ONLY for the maintainer actor
    # (public repo — a fork-PR actor must never start a Mac).
    aws codebuild create-webhook --region "$REGION" --project-name "$PROJECT" \
      --filter-groups "[[{\"type\":\"EVENT\",\"pattern\":\"WORKFLOW_JOB_QUEUED\"},{\"type\":\"ACTOR_ACCOUNT_ID\",\"pattern\":\"^${ACTOR_ACCOUNT_ID}$\"}]]" >/dev/null
  fi
  echo "mac fleet + runner project ready."
}

# Tear down the RUNNER (the security-relevant half: the webhook a fork actor
# could otherwise reach), but deliberately LEAVE THE FLEET.
#
# The Mac host bills a 24-HOUR MINIMUM per allocation, and `up` already knows a
# `PENDING_DELETION` fleet stays buildable for the rest of that window at no
# extra host charge. So deleting the fleet here buys nothing back — the 24h is
# already sunk — while guaranteeing the NEXT run inside the same day allocates a
# fresh one and pays the minimum again.
#
# That is exactly what happened. Measured 2026-08-01..17 in the shared account:
# 11 `CreateFleet` calls in 17 days, ~274h billed (16,446 min, $395 — a ~$720/mo
# run rate) against just 2.7h of actual fleet lifetime. 11 allocations x 24h
# minimum = 264h, which is the entire bill. The design intended "one 24h charge
# per release (~$15-16)"; the effective rate was $35.91 per allocation because
# releases cluster: 2026-08-13 ran the lane SIX times and 08-12 four times, and
# CloudTrail shows the shape plainly — 1 CreateFleet against 9 DeleteFleet calls
# on 08-13, 1 against 8 on 08-12. `up` is idempotent so parallel runs share one
# fleet, then every run's `down` deleted it and the next `up` re-bought the
# window. The teardown was racing itself.
#
# `down` now ALWAYS deletes the fleet, and that still gives the 24h window its
# full value: a deleted fleet sits in PENDING_DELETION and, per AWS ("Fleets
# are available to build projects while they are pending deletion"), keeps
# serving builds for the remainder of the already-paid window — verified live
# 2026-09-01, when a release created a same-name fleet while the previous one
# was still pending deletion. So same-day releases still reuse the paid Mac,
# there is still no re-buy churn, and reclamation no longer depends on anyone
# remembering.
#
# The previous design left the fleet ACTIVE on the premise that "AWS reclaims
# the host on its own afterwards". It does not — an ACTIVE fleet bills ~$67/day
# until something deletes it. That premise cost $877 in Aug 2026 (fleet created
# Aug 18, zero builds after its release, standing idle 13 days) and reproduced
# the same day it was diagnosed: the very release that verified this fix left
# another ACTIVE fleet behind. Billing caps at the 24h minimum ONLY via
# delete-fleet.
down() {
  if aws codebuild batch-get-projects --region "$REGION" --names "$PROJECT" \
       --query 'projects[0].name' --output text 2>/dev/null | grep -q "$PROJECT"; then
    aws codebuild delete-webhook --region "$REGION" --project-name "$PROJECT" 2>/dev/null || true
    aws codebuild delete-project --region "$REGION" --name "$PROJECT" && echo "deleted project $PROJECT"
  fi
  local arn; arn="$(fleet_arn)"
  if [ -n "$arn" ]; then
    aws codebuild delete-fleet --region "$REGION" --arn "$arn" \
      && echo "fleet deletion requested: it keeps serving builds for the rest of the" \
      && echo "paid 24h window (PENDING_DELETION), then AWS reclaims it."
  fi
  echo "mac runner torn down."
}

case "${1:-}" in
  up) up ;;
  down) down "$@" ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
