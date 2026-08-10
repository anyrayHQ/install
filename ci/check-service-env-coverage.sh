#!/usr/bin/env bash
#
# Assert every deploy-critical env var reaches its service in EVERY install
# template. A required var silently dropped from one template bricks or
# regresses that install path on the next image bump, and also catches a
# monorepo paired PR that wired the var into some templates but not all.
#
# Two contracts, because the two services fail in opposite ways:
#
#   gateway   (ci/critical-gateway-env.txt)   — fail-fasts without its vars, so a
#             drop is loud on first boot. Gated anyway: loud on the CUSTOMER's
#             machine is not the same as caught here.
#   optimizer (ci/critical-optimizer-env.txt) — treats them as OPTIONAL and
#             degrades in SILENCE. Prod 2026-08-08: no ANYRAY_SPEND_DB_URL on the
#             optimizer meant migration 0058's shared config store resolved null,
#             so every admin setting became per-pod and deploy-ephemeral with no
#             error anywhere. Only a gate like this catches that class.
#
# Requires: jq, helm, and my-values.yaml (run `./setup.sh --k8s --connect ...` first, as
# the CI job does). Compose / CFN / Railway are read from the source files, so
# only the Helm leg needs a render.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f my-values.yaml ]; then
  echo "::error::my-values.yaml missing — run ./setup.sh --k8s --connect <adt_token> … before this check"
  exit 1
fi

fail=0

# check_service <service> <contract> <compose-files…>
#
# Every extractor below is scoped to ONE service's block on purpose: grepping a
# whole template would pass on a var that is present only on a sibling service,
# which is exactly the bug being gated (the var WAS in every template — on the
# gateway).
check_service() {
  local svc="$1" contract="$2"
  shift 2
  local compose_files=("$@")

  local vars=()
  mapfile -t vars < <(grep -vE '^[[:space:]]*(#|$)' "$contract")

  local f railway_vars railway_iac_block cfn_block helm_render
  railway_vars="$(jq -r --arg s "$svc" \
    '.services[] | select(.name == $s) | .variables | keys[]' \
    railway/railway.template.json)"
  # The service's object literal in the Railway IaC source, `const <svc> =
  # service("<svc>"` to the closing `  });` of that call.
  railway_iac_block="$(awk -v s="$svc" '
    $0 ~ ("const " s " = service\\(\"" s "\"") { g = 1 }
    g { print }
    g && /^  \}\);/ { exit }
  ' .railway/railway.ts)"
  # The CloudFormation task-definition resource for this service.
  local cfn_resource
  cfn_resource="$(printf '%sTask' "$(tr '[:lower:]' '[:upper:]' <<<"${svc:0:1}")${svc:1}")"
  cfn_block="$(awk -v r="^  ${cfn_resource}:" '
    $0 ~ r { g = 1; print; next }
    g && /^  [A-Za-z][A-Za-z0-9]*:/ { exit }
    g { print }
  ' aws/anyray-quicklaunch.template.yaml)"
  # The rendered Helm Deployment for this service. `-s` selects the template
  # file, which is named after the service.
  helm_render="$(helm template t ./helm -f my-values.yaml -s "templates/${svc}.yaml")"

  local v miss
  for v in "${vars[@]}"; do
    miss=()
    for f in "${compose_files[@]}"; do
      grep -qE "^[[:space:]]*${v}:" \
        <<<"$(sed -n "/^  ${svc}:/,/^  [a-z][a-z_-]*:/p" "$f")" || miss+=("$f")
    done
    grep -qxF "$v" <<<"$railway_vars"                     || miss+=("railway")
    grep -qE "^[[:space:]]*${v}:" <<<"$railway_iac_block" || miss+=("railway-iac")
    grep -qE "\\b${v}\\b" <<<"$cfn_block"                 || miss+=("aws-cloudformation")
    grep -qE "name: ${v}\\b" <<<"$helm_render"            || miss+=("helm")
    if [ "${#miss[@]}" -ne 0 ]; then
      echo "::error::critical ${svc} env var ${v} missing from: ${miss[*]}"
      fail=1
    fi
  done

  if [ "$fail" -eq 0 ]; then
    echo "OK: all ${#vars[@]} critical ${svc} env var(s) wired into every install template."
  fi
}

# The gateway does not run in attach mode (optimizer-only topology), so its
# contract is checked against the full-stack compose alone.
check_service gateway ci/critical-gateway-env.txt docker-compose.yml
# The optimizer DOES run in attach mode, and that is the topology with no
# gateway to fall back on — nothing there ever pushes it a durable store — so
# docker-compose.attach.yml is checked too.
check_service optimizer ci/critical-optimizer-env.txt \
  docker-compose.yml docker-compose.attach.yml

exit "$fail"
