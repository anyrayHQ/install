#!/usr/bin/env bash
# On-demand macOS signing fleet lifecycle (RFC 0010).
#
# EC2 Mac dedicated hosts bill a 24-HOUR MINIMUM per allocation and CodeBuild
# MAC_ARM fleets cannot scale below baseCapacity=1, so a standing fleet would
# cost ~$450+/month. Instead the release workflow allocates a Mac ONLY for the
# duration of a signing run and releases it immediately after: `up` creates the
# fleet + an ephemeral CodeBuild runner project (webhook-driven, gated to the
# maintainer actor), `down` deletes both. Net cost is one 24h-minimum Mac charge
# per release (~$15-16), never a standing bill.
#
# Idempotent: `up` reuses an existing fleet/project, `down` tolerates absence.
set -euo pipefail

REGION="${AWS_REGION:-eu-central-1}"
ACCOUNT="${AWS_ACCOUNT_ID:-637423459445}"
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

  echo "waiting for the fleet to reach ACTIVE (Mac host allocation ~minutes)…"
  for _ in $(seq 1 60); do
    local st
    st="$(aws codebuild batch-get-fleets --region "$REGION" --names "$FLEET" \
      --query 'fleets[0].status.statusCode' --output text 2>/dev/null || echo PENDING)"
    echo "  fleet status: $st"
    case "$st" in
      ACTIVE) break ;;
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

down() {
  if aws codebuild batch-get-projects --region "$REGION" --names "$PROJECT" \
       --query 'projects[0].name' --output text 2>/dev/null | grep -q "$PROJECT"; then
    aws codebuild delete-webhook --region "$REGION" --project-name "$PROJECT" 2>/dev/null || true
    aws codebuild delete-project --region "$REGION" --name "$PROJECT" && echo "deleted project $PROJECT"
  fi
  local arn; arn="$(fleet_arn)"
  if [ -n "$arn" ]; then
    aws codebuild delete-fleet --region "$REGION" --arn "$arn" && echo "deleted fleet (Mac released; 24h-min still applies)"
  fi
  echo "mac fleet torn down."
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
