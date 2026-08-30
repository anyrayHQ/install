#!/usr/bin/env bash
# On-demand macOS signing fleet lifecycle (RFC 0010).
#
# EC2 Mac dedicated hosts bill a 24-HOUR MINIMUM per allocation and CodeBuild
# MAC_ARM fleets cannot scale below baseCapacity=1, so a standing fleet would
# cost ~$450+/month. Instead the release workflow allocates a Mac ONLY when a
# signing run needs one: `up` creates the fleet + an ephemeral CodeBuild runner
# project (webhook-driven, gated to the maintainer actor); `down` deletes the
# RUNNER but leaves the fleet, so every run inside the already-paid 24h window
# reuses the same Mac; `reap` deletes the fleet once that window has closed.
#
# **The billing unit is the DAY, not the release.** Deleting the fleet after each
# run does not refund the 24h minimum — it only guarantees the next run re-buys
# it. That cost ~$720/mo against 2.7h of real use; see the note on `down`.
#
# `reap` closes the loop. A fleet that is merely LEFT never goes away on its
# own: CodeBuild keeps it ACTIVE and it bills the Mac every day, whether or not
# a release runs. Measured 2026-08-18..29 — one CreateFleet, no DeleteFleet, and
# a flat $34.56/day for twelve days including four with zero signing runs. So
# `down` keeps the fleet for the rest of the paid window and a scheduled `reap`
# removes it after the window closes with nothing running.
#
# Idempotent: `up` reuses an existing fleet/project (including one in
# PENDING_DELETION, still buildable inside its window), `down` and `reap`
# tolerate absence.
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
# Leaving the fleet makes the 24h window do the job it is already paid for: the
# first release of a day allocates and every release within 24h reuses. AWS does
# NOT reclaim the host afterwards — an ACTIVE fleet bills until something deletes
# it — so `reap` (below, scheduled daily) is what closes the window. Together the
# worst case is one minimum per ACTIVE day and nothing on an idle one.
#
# Pass `--release-fleet` to force the old behaviour. It does not save money
# inside an open window; it exists for the case where the fleet is wedged
# (CREATE_FAILED / UPDATE_ROLLBACK_FAILED) and must be cleared so the next `up`
# can build a healthy one.
down() {
  if aws codebuild batch-get-projects --region "$REGION" --names "$PROJECT" \
       --query 'projects[0].name' --output text 2>/dev/null | grep -q "$PROJECT"; then
    aws codebuild delete-webhook --region "$REGION" --project-name "$PROJECT" 2>/dev/null || true
    aws codebuild delete-project --region "$REGION" --name "$PROJECT" && echo "deleted project $PROJECT"
  fi
  if [ "${2:-}" = "--release-fleet" ] || [ "${RELEASE_MAC_FLEET:-}" = "true" ]; then
    local arn; arn="$(fleet_arn)"
    if [ -n "$arn" ]; then
      aws codebuild delete-fleet --region "$REGION" --arn "$arn" \
        && echo "deleted fleet (forced; the 24h minimum is already sunk and is NOT refunded)"
    fi
  else
    echo "fleet left in place: the 24h minimum is already paid, so the next run"
    echo "inside that window reuses this Mac for free. The scheduled 'reap' job"
    echo "deletes it once the window closes; AWS never reclaims it on its own."

  fi
  echo "mac runner torn down."
}

# Delete the fleet once its paid 24h window has closed and nothing is using it.
#
# `down` deliberately keeps the fleet so later releases the SAME day reuse the
# already-paid Mac. Nothing then ever removed it: CodeBuild does not reclaim an
# ACTIVE fleet, so the host kept billing $34.56/day indefinitely. Measured
# 2026-08-18..29 in account 637423459445 — one CreateFleet, zero DeleteFleet,
# twelve consecutive billed days, four of them with no signing run at all
# ($138 for nothing). This is the other half of the fix in install#351: keep the
# fleet for the WINDOW, not forever.
#
# Two gates, both required, so this can never take a Mac out from under a live
# release:
#   1. The fleet is older than the 24h minimum. A fleet allocated minutes ago is
#      immune, which is what makes the `up` path safe — see the race note below.
#   2. The ephemeral runner project is absent. `up` creates it and `down`
#      removes it, so its presence means a signing lane is mid-flight.
#
# Residual race, and why it is acceptable: a release whose `up` reuses a fleet
# ALREADY older than 24h could, in the seconds before it creates the project,
# collide with a reap. `up` re-checks and recreates a vanished fleet, so the
# outcome is a slower provision, not a failed release. Schedule this off-peak
# regardless.
#
# `--dry-run` (or REAP_DRY_RUN=true) reports the decision and deletes nothing.
reap() {
  local dry=""
  case "${2:-}" in --dry-run) dry=1 ;; esac
  [ "${REAP_DRY_RUN:-}" = "true" ] && dry=1

  local arn; arn="$(fleet_arn)"
  if [ -z "$arn" ]; then
    echo "no fleet — nothing to reap."
    return 0
  fi

  if aws codebuild batch-get-projects --region "$REGION" --names "$PROJECT" \
       --query 'projects[0].name' --output text 2>/dev/null | grep -q "$PROJECT"; then
    echo "runner project $PROJECT still exists — a signing lane is in flight; not reaping."
    return 0
  fi

  # `created` is the allocation instant, which is exactly when the 24h minimum
  # started. Reusing a fleet does not reset it, so this measures the window and
  # not the last release.
  local created age_hours
  created="$(aws codebuild batch-get-fleets --region "$REGION" --names "$FLEET" \
    --query 'fleets[0].created' --output text 2>/dev/null || true)"
  if [ -z "$created" ] || [ "$created" = "None" ]; then
    echo "::warning::cannot read the fleet creation time — not reaping (absence of evidence is not an idle fleet)"
    return 0
  fi
  # Both GNU and BSD date refuse the other's parse flags, and the runner is
  # Amazon Linux while a maintainer may run this on macOS. python3 is on both.
  age_hours="$(python3 -c '
import datetime,sys
created=datetime.datetime.fromisoformat(sys.argv[1])
now=datetime.datetime.now(datetime.timezone.utc)
print(int((now-created).total_seconds()//3600))
' "$created" 2>/dev/null || true)"
  case "$age_hours" in
    ''|*[!0-9]*) echo "::warning::cannot compute the fleet age from '${created}' — not reaping"; return 0 ;;
  esac

  if [ "$age_hours" -lt 24 ]; then
    echo "fleet is ${age_hours}h old — inside the paid 24h window, keeping it."
    return 0
  fi

  if [ -n "$dry" ]; then
    echo "DRY RUN: would delete fleet $FLEET (${age_hours}h old, no runner project)."
    return 0
  fi
  aws codebuild delete-fleet --region "$REGION" --arn "$arn"
  echo "deleted fleet $FLEET after ${age_hours}h — the next release allocates a fresh 24h window."
}

case "${1:-}" in
  up) up ;;
  down) down "$@" ;;
  reap) reap "$@" ;;
  *) echo "usage: $0 up|down [--release-fleet] | reap [--dry-run]" >&2; exit 2 ;;
esac
