#!/usr/bin/env bash
#
# Assert every deploy-critical gateway env var (ci/critical-gateway-env.txt)
# reaches the gateway in EVERY install template. A fail-fast / secret / DB-URL /
# coordinated-rollout var the gateway needs, silently dropped from one template,
# bricks or regresses that install path on the next image bump. This also catches
# a monorepo paired PR that wired the var into some templates but not all.
#
# Requires: jq, helm, and my-values.yaml (run `./setup.sh --k8s ...` first, as
# the CI job does). Compose / CFN / Railway are read from the source files, so
# only the Helm leg needs a render.
set -euo pipefail
cd "$(dirname "$0")/.."

contract="ci/critical-gateway-env.txt"
mapfile -t vars < <(grep -vE '^[[:space:]]*(#|$)' "$contract")

if [ ! -f my-values.yaml ]; then
  echo "::error::my-values.yaml missing — run ./setup.sh --k8s … before this check"
  exit 1
fi

# Per-template gateway env, as text we grep the var name against.
compose_block="$(sed -n '/^  gateway:/,/^  [a-z][a-z_-]*:/p' docker-compose.yml)"
# Check the Railway source contract, not .publish/gateway.vars: the publish
# generator intentionally omits the empty activation prompt for pre-policy pins.
railway_vars="$(jq -r '.services[] | select(.name == "gateway") | .variables | keys[]' railway/railway.template.json)"
railway_iac_block="$(awk '/const gateway = service\("gateway"/{g=1;print;next} g && /const optimizer = service\("optimizer"/{exit} g{print}' .railway/railway.ts)"
# The CloudFormation GatewayTask resource block (2-space-indented resource key).
cfn_block="$(awk '/^  GatewayTask:/{g=1;print;next} g && /^  [A-Za-z][A-Za-z0-9]*:/{exit} g{print}' aws/anyray-quicklaunch.template.yaml)"
# The rendered Helm gateway Deployment (env entries are `- name: ANYRAY_…`).
helm_render="$(helm template t ./helm -f my-values.yaml -s templates/gateway.yaml)"

fail=0
for v in "${vars[@]}"; do
  miss=()
  grep -qE "^[[:space:]]*${v}:" <<<"$compose_block" || miss+=("docker-compose.yml")
  grep -qxF "$v" <<<"$railway_vars"                 || miss+=("railway")
  grep -qE "^[[:space:]]*${v}:" <<<"$railway_iac_block" || miss+=("railway-iac")
  grep -qE "\\b${v}\\b" <<<"$cfn_block"             || miss+=("aws-cloudformation")
  grep -qE "name: ${v}\\b" <<<"$helm_render"        || miss+=("helm")
  if [ "${#miss[@]}" -ne 0 ]; then
    echo "::error::critical gateway env var ${v} missing from: ${miss[*]}"
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "OK: all ${#vars[@]} critical gateway env var(s) wired into every install template."
fi
exit "$fail"
