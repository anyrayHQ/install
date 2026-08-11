#!/usr/bin/env bash
#
# Assert every deploy-critical env var reaches its service in EVERY install
# template. A required var silently dropped from one template bricks or
# regresses that install path on the next image bump, and also catches a
# monorepo paired PR that wired the var into some templates but not all.
#
# One contract per service, because the services fail in different ways:
#
#   gateway   (ci/critical-gateway-env.txt)   — fail-fasts without its vars, so a
#             drop is loud on first boot. Gated anyway: loud on the CUSTOMER's
#             machine is not the same as caught here.
#   optimizer (ci/critical-optimizer-env.txt) — treats them as OPTIONAL and
#             degrades in SILENCE. Prod 2026-08-08: no ANYRAY_SPEND_DB_URL on the
#             optimizer meant migration 0058's shared config store resolved null,
#             so every admin setting became per-pod and deploy-ephemeral with no
#             error anywhere. Only a gate like this catches that class.
#   endpoint-control (ci/critical-endpoint-control-env.txt) — the optimizer's
#             failure class again (RFC 0014): no database var means a silent
#             in-memory fallback that loses every enrollment on restart.
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

# Extra `helm template --set` flags for the next check_service call; reset by
# each caller that needs it. See the render comment inside check_service.
helm_extra_set=""

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

  # CloudFormation logical ids and JS identifiers cannot carry hyphens, so a
  # hyphenated service name maps to PascalCase / camelCase there:
  # endpoint-control -> EndpointControlTask / endpointControl.
  local cfn_resource iac_const
  cfn_resource="$(awk -F- '{ for (i = 1; i <= NF; i++) printf "%s%s", toupper(substr($i, 1, 1)), substr($i, 2) }' <<<"$svc")Task"
  iac_const="$(awk -F- '{ printf "%s", $1; for (i = 2; i <= NF; i++) printf "%s%s", toupper(substr($i, 1, 1)), substr($i, 2) }' <<<"$svc")"

  local f railway_vars railway_iac_block cfn_block helm_render
  railway_vars="$(jq -r --arg s "$svc" \
    '.services[] | select(.name == $s) | .variables | keys[]' \
    railway/railway.template.json)"
  # The service's object literal in the Railway IaC source, `const <camel> =
  # service("<svc>"` to the closing `  });` of that call.
  railway_iac_block="$(awk -v c="$iac_const" -v s="$svc" '
    $0 ~ ("const " c " = service\\(\"" s "\"") { g = 1 }
    g { print }
    g && /^  \}\);/ { exit }
  ' .railway/railway.ts)"
  cfn_block="$(awk -v r="^  ${cfn_resource}:" '
    $0 ~ r { g = 1; print; next }
    g && /^  [A-Za-z][A-Za-z0-9]*:/ { exit }
    g { print }
  ' aws/anyray-quicklaunch.template.yaml)"
  # The rendered Helm Deployment for this service. `-s` selects the template
  # file, which is named after the service.
  #
  # helm_extra_set lets a caller render the shape a var is actually contracted
  # for. It exists for exactly one case: the chart ships ingress.enabled=false,
  # and endpoint-control's public URL is deliberately only emitted when an edge
  # (Ingress or HTTPRoute) actually routes the agent-plane paths — deriving it
  # from `host` on a LoadBalancer install would bake an origin no laptop can
  # reach into every minted installer. Rendering the routed shape here keeps
  # "every template wires it" honest; the negative half — that it stays absent
  # WITHOUT a routed edge — is asserted separately at the bottom of this file.
  # shellcheck disable=SC2086 # deliberate word-splitting of the --set list
  helm_render="$(helm template t ./helm -f my-values.yaml -s "templates/${svc}.yaml" ${helm_extra_set:-})"

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
# endpoint-control (RFC 0014) is in the optimizer's failure class — optional
# vars, silent degradation (in-memory store, 503 admin plane) — and does not
# run in attach mode, so its contract is checked against the full-stack
# compose alone. Rendered with an Ingress because that is the shape its public
# URL is contracted for (see the render comment in check_service).
helm_extra_set="--set ingress.enabled=true"
check_service endpoint-control ci/critical-endpoint-control-env.txt \
  docker-compose.yml
helm_extra_set=""

# The negative half of the public-URL contract: with NO edge routing the
# agent-plane paths (the chart default, and the shape the AKS/GKE one-click
# scripts install — LoadBalancer Services, ingress off, a placeholder host),
# the chart must emit NO public URL at all. A URL derived from `host` there is
# worse than none: minting succeeds and writes an unreachable origin into every
# installer and MDM profile, which only surfaces on the laptop that can't
# enrol.
if helm template t ./helm -f my-values.yaml -s templates/endpoint-control.yaml \
  | grep -q 'ANYRAY_ENDPOINT_CONTROL_PUBLIC_URL'; then
  echo "::error::endpoint-control got a public URL with no Ingress/HTTPRoute routing the agent plane — it would be an origin no agent can reach"
  fail=1
else
  echo "OK: endpoint-control emits no public URL until an edge routes the agent plane."
fi

exit "$fail"
