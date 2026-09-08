#!/usr/bin/env bash
# On-demand macOS signing fleet lifecycle (RFC 0010).
#
# EC2 Mac dedicated hosts bill a 24-HOUR MINIMUM per allocation and CodeBuild
# MAC_ARM fleets cannot scale below baseCapacity=1, so a standing fleet would
# cost ~$450+/month. Instead the release workflow allocates a Mac ONLY when a
# signing run needs one: `up` creates the fleet + an ephemeral CodeBuild runner
# project (webhook-driven, gated to the maintainer actor); `down` deletes the
# runner and requests fleet deletion. Pending deletion preserves whatever
# portion of the paid minimum AWS still makes available, then releases the host.
# Leaving an ACTIVE fleet behind does not cap billing at 24 hours.
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
# The monorepo's macOS runner project shares THIS fleet but lives in another
# repo, so nothing else repoints it when the fleet is recreated. A CodeBuild
# project stores the fleet's full ARN, UUID included, and `up` mints a NEW uuid
# every time the previous fleet has been reclaimed — so the peer is left
# pointing at a fleet that no longer exists. It does not error: the webhook
# still fires, CodeBuild cannot place the build, and the job sits queued until
# GitHub's 24h ceiling kills it. That is exactly how monorepo run 34100865742
# sat 23h and how sign-macos logged a 1440.0-minute "runtime" (2026-09-08).
PEER_PROJECTS="anyray-gha-runner-mac"
FLEET_SERVICE_ROLE="arn:aws:iam::${ACCOUNT}:role/anyray-mac-fleet-service"
RUNNER_SERVICE_ROLE="arn:aws:iam::${ACCOUNT}:role/anyray-gha-runner-codebuild"
CODECONNECTION="arn:aws:codeconnections:${REGION}:${ACCOUNT}:connection/<codeconnection-id>"
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
  local ready=false
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
      ACTIVE|PENDING_DELETION) ready=true; break ;;
      CREATE_FAILED|UPDATE_ROLLBACK_FAILED|DELETING) echo "::error::fleet entered $st"; exit 1 ;;
    esac
    sleep 20
  done

  if [ "$ready" != true ]; then
    echo '::error::Mac fleet did not become usable within 20 minutes'
    exit 1
  fi

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
  # Same fleet, different repo: repoint every peer project too, or the next
  # release silently strands them (see PEER_PROJECTS above). Best-effort by
  # design — a peer that has been retired must not fail this release.
  for peer in $PEER_PROJECTS; do
    if aws codebuild batch-get-projects --region "$REGION" --names "$peer" \
         --query 'projects[0].name' --output text 2>/dev/null | grep -q "$peer"; then
      if aws codebuild update-project --region "$REGION" --name "$peer" \
           --environment "type=MAC_ARM,image=aws/codebuild/macos-arm-base:14,computeType=BUILD_GENERAL1_MEDIUM,fleet={fleetArn=$arn}" >/dev/null; then
        echo "repointed peer project $peer -> fleet $arn"
      else
        echo "::warning::could not repoint peer project $peer; its macOS jobs will queue until it is repointed"
      fi
    else
      echo "peer project $peer not present; skipping"
    fi
  done

  echo "mac fleet + runner project ready."
}

# All release callers hold the same workflow concurrency group until teardown.
# Request deletion even after a failed build: ACTIVE fleets keep billing.
# Do not remove delete-fleet in an attempt to reuse the paid minimum.
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
