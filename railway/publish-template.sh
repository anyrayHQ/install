#!/usr/bin/env bash
#
# publish-template.sh -- assist updating the published Railway one-click template
# (`anyray`, https://railway.com/deploy/anyray).
#
# WHY THIS IS NOT A ONE-SHOT "REPUBLISH" COMMAND
# ----------------------------------------------
# Railway has NO API to set a template's variable VALUES:
#   * templatePublish(id, input) takes only metadata (category/description/readme
#     /image/...), there is no serializedConfig field.
#   * templateGenerate(projectId, environmentId) snapshots a LIVE project but
#     DROPS every plain-literal variable value (keeps only ${{...}} references).
#   * reading a published template's serializedConfig is "Not Authorized".
# So the final "Update Template" with the literal values (PORT, ANYRAY_CONTENT_MODE,
# ANYRAY_DEFAULT_MODEL, ...) is an irreducible dashboard Raw-Editor paste. This
# script removes everything AROUND that paste:
#
#   prep   (default)  Validate railway.template.json, regenerate the paste blocks
#                     (build-publish.sh), and print the exact ordered republish
#                     checklist with each service's block inlined -- so the manual
#                     step is copy-paste, not reconstruction.
#
#   test              Deploy the LIVE published template into a throwaway project
#                     (workspace token), run the health-check battery, then delete
#                     it. Catches boot regressions that static config review can't
#                     -- e.g. the proxy crash-loop when ANYRAY_UPDATER_TOKEN is
#                     missing. Use it to confirm an update actually works.
#
# USAGE
#   railway/publish-template.sh [prep]
#   railway/publish-template.sh test
#
# ENV (test only)
#   RAILWAY_WORKSPACE_TOKEN   required -- a workspace token (railway.com -> your
#                             workspace -> tokens). NOT an account token; account
#                             tokens 401 on template deploys, the CLI OAuth token
#                             can create projects but cannot deploy templates.
#   RAILWAY_WORKSPACE_ID      workspace to create the throwaway project in
#                             (default: Othentic).
#   ANYRAY_PROVIDER_KEY_ANTHROPIC  optional -- set to exercise a real chat
#                             completion; otherwise default-model routing is
#                             checked by the provider it resolves to.
#
# DEPS  bash, jq, curl; (test also) the railway CLI logged in (`railway whoami`).

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tpl="$here/railway.template.json"
api="https://backboard.railway.com/graphql/v2"
template_code="anyray"
default_workspace="eef73845-ee51-42b4-87b1-2873cd0d36fb" # Othentic

mode="${1:-prep}"

die() { echo "error: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

have jq   || die "jq is required"
have curl || die "curl is required"
[ -f "$tpl" ] || die "$tpl not found"
jq -e . "$tpl" >/dev/null || die "$tpl is not valid JSON"

# ---------------------------------------------------------------- prep ---------
prep() {
  echo "==> validating + regenerating publish artifacts"
  "$here/build-publish.sh" >/dev/null
  local services; services="$(jq -r '.services[].name' "$tpl")"

  echo
  echo "================= REPUBLISH CHECKLIST (anyray) ================="
  echo "Railway can't set template var VALUES via API, so this is a dashboard"
  echo "paste. railway.com/workspace/templates -> Anyray -> (...) Edit."
  echo "For each service below: open Variables -> Raw Editor, Cmd+A, paste the"
  echo "block, Update Variables, then Save the service. Then Update Template."
  echo
  for svc in $services; do
    local image hc sc
    image="$(jq -r --arg n "$svc" '.services[]|select(.name==$n)|.source.image // "(source build)"' "$tpl")"
    hc="$(jq -r --arg n "$svc" '.services[]|select(.name==$n)|.deploy.healthcheckPath // "(none)"' "$tpl")"
    sc="$(jq -r --arg n "$svc" '.services[]|select(.name==$n)|.deploy.startCommand // "(image default)"' "$tpl")"
    echo "----- $svc  [image: $image | healthcheck: $hc | start: $sc] -----"
    cat "$here/.publish/$svc.vars"
    echo
  done
  echo "After publishing, verify (cache-bust!):  railway/publish-template.sh test"
  echo "  or read-only:  https://railway.com/new/template/anyray?v=N  (no login)"
  echo "==============================================================="
}

# ---------------------------------------------------------------- test ---------
# GraphQL with the workspace token. $1=query, $2=variables-json (default {}).
gql() {
  local q="$1" v="${2:-}"
  [ -n "$v" ] || v='{}'
  jq -n --arg q "$q" --argjson v "$v" '{query:$q,variables:$v}' \
  | curl -sS -X POST "$api" \
      -H "Authorization: Bearer $RAILWAY_WORKSPACE_TOKEN" \
      -H "Content-Type: application/json" \
      -H "User-Agent: anyray-publish/1.0" \
      -d @-
}

PROJECT_ID=""
cleanup_test() {
  if [ -n "$PROJECT_ID" ]; then
    echo "==> tearing down throwaway project $PROJECT_ID"
    gql 'mutation($id:String!){projectDelete(id:$id)}' "$(jq -n --arg id "$PROJECT_ID" '{id:$id}')" >/dev/null \
      && echo "    deleted" || echo "    WARN: delete failed -- remove project $PROJECT_ID manually"
  fi
  [ -n "${WORKDIR:-}" ] && rm -rf "$WORKDIR"
}

run_test() {
  : "${RAILWAY_WORKSPACE_TOKEN:?set RAILWAY_WORKSPACE_TOKEN (a workspace token) -- see header}"
  have railway || die "the railway CLI is required for 'test'"
  railway whoami >/dev/null 2>&1 || die "run 'railway login' first ('test' uses the CLI to create the project)"
  local workspace="${RAILWAY_WORKSPACE_ID:-$default_workspace}"

  trap cleanup_test EXIT
  WORKDIR="$(mktemp -d)"
  local name="anyray-tmpl-test-$$"

  echo "==> creating throwaway project '$name'"
  PROJECT_ID="$(cd "$WORKDIR" && railway init -n "$name" -w "$workspace" --json | jq -r '.id')"
  [ -n "$PROJECT_ID" ] && [ "$PROJECT_ID" != null ] || die "project create failed"
  echo "    $PROJECT_ID"

  echo "==> deploying published template '$template_code'"
  ( cd "$WORKDIR" && RAILWAY_API_TOKEN="$RAILWAY_WORKSPACE_TOKEN" railway deploy -t "$template_code" ) \
    || die "template deploy failed (is the workspace token valid?)"

  # resolve environment + services
  local proj envid
  proj="$(gql 'query($id:String!){project(id:$id){environments{edges{node{id name}}}services{edges{node{id name}}}}}' \
            "$(jq -n --arg id "$PROJECT_ID" '{id:$id}')")"
  envid="$(echo "$proj" | jq -r '.data.project.environments.edges[0].node.id')"
  echo "    environment $envid"

  echo "==> waiting for services to settle"
  local tries=0 pending=1
  while [ "$pending" = 1 ] && [ "$tries" -lt 40 ]; do
    local deps
    deps="$(gql 'query($p:String!,$e:String!){deployments(input:{projectId:$p,environmentId:$e},first:20){edges{node{serviceId status createdAt}}}}' \
              "$(jq -n --arg p "$PROJECT_ID" --arg e "$envid" '{p:$p,e:$e}')")"
    # latest status per service
    local table
    table="$(echo "$deps" | jq -r '
      .data.deployments.edges | map(.node)
      | group_by(.serviceId) | map(max_by(.createdAt))
      | .[] | "\(.serviceId) \(.status)"')"
    pending=0
    while read -r _sid status; do
      [ -z "$status" ] && continue
      case "$status" in SUCCESS|CRASHED|FAILED|REMOVED) ;; *) pending=1 ;; esac
    done <<< "$table"
    tries=$((tries+1))
    [ "$pending" = 1 ] && sleep 6
  done

  # map service ids -> names; one final status query, parsed once
  declare -A NAME
  while read -r id nm; do NAME["$id"]="$nm"; done < <(echo "$proj" | jq -r '.data.project.services.edges[]|.node|"\(.id) \(.name)"')
  local final latest gw_id="" px_id="" crashed=0
  final="$(gql 'query($p:String!,$e:String!){deployments(input:{projectId:$p,environmentId:$e},first:20){edges{node{serviceId status createdAt}}}}' \
            "$(jq -n --arg p "$PROJECT_ID" --arg e "$envid" '{p:$p,e:$e}')")"
  latest="$(echo "$final" | jq -r '.data.deployments.edges|map(.node)|group_by(.serviceId)|map(max_by(.createdAt))|.[]|"\(.serviceId) \(.status)"')"
  echo "    service status:"
  while read -r sid status; do
    [ -z "$status" ] && continue
    local nm="${NAME[$sid]:-$sid}"
    printf "      %-10s %s\n" "$nm" "$status"
    [ "$nm" = gateway ] && gw_id="$sid"
    [ "$nm" = proxy ]   && px_id="$sid"
    [ "$status" != SUCCESS ] && crashed=1
  done <<< "$latest"

  if [ "$crashed" = 1 ]; then
    echo "==> a service did not reach SUCCESS -- recent proxy/gateway logs:" >&2
    for sid in "$px_id" "$gw_id"; do
      [ -z "$sid" ] && continue
      local did
      did="$(gql 'query($p:String!,$e:String!,$s:String!){deployments(input:{projectId:$p,environmentId:$e,serviceId:$s},first:1){edges{node{id}}}}' \
               "$(jq -n --arg p "$PROJECT_ID" --arg e "$envid" --arg s "$sid" '{p:$p,e:$e,s:$s}')" | jq -r '.data.deployments.edges[0].node.id')"
      echo "--- ${NAME[$sid]} ($did) ---" >&2
      gql 'query($d:String!){deploymentLogs(deploymentId:$d,limit:25){message}}' \
        "$(jq -n --arg d "$did" '{d:$d}')" | jq -r '.data.deploymentLogs[].message' | tail -8 >&2 || true
    done
    echo "RESULT: FAIL (service crash) -- see logs above" >&2
    return 1
  fi

  # public domains + admin token
  echo "==> generating domains + reading admin token"
  local gw px tok
  gw="$(gql 'mutation($i:ServiceDomainCreateInput!){serviceDomainCreate(input:$i){domain}}' \
         "$(jq -n --arg e "$envid" --arg s "$gw_id" '{i:{environmentId:$e,serviceId:$s,targetPort:8787}}')" | jq -r '.data.serviceDomainCreate.domain')"
  px="$(gql 'mutation($i:ServiceDomainCreateInput!){serviceDomainCreate(input:$i){domain}}' \
         "$(jq -n --arg e "$envid" --arg s "$px_id" '{i:{environmentId:$e,serviceId:$s,targetPort:80}}')" | jq -r '.data.serviceDomainCreate.domain')"
  tok="$(gql 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}' \
          "$(jq -n --arg p "$PROJECT_ID" --arg e "$envid" --arg s "$gw_id" '{p:$p,e:$e,s:$s}')" | jq -r '.data.variables.ANYRAY_ADMIN_TOKEN')"
  echo "    gateway https://$gw"
  echo "    proxy   https://$px"

  echo "==> health checks"
  local fail=0
  _retry() { # url, expected-code, label
    local i code
    for i in $(seq 1 15); do
      code="$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$1" || true)"
      [ "$code" = "$2" ] && { printf "      PASS  %-26s %s\n" "$3" "$code"; return 0; }
      sleep 4
    done
    printf "      FAIL  %-26s got %s want %s\n" "$3" "$code" "$2"; fail=1; return 1
  }
  _retry "https://$gw/" 200 "gateway liveness /"
  _retry "https://$px/anyray-login" 200 "console /anyray-login"
  local health
  health="$(curl -s -m 12 "https://$gw/admin/health" -H "Authorization: Bearer $tok" || true)"
  if echo "$health" | jq -e '.ok==true' >/dev/null 2>&1; then
    printf "      PASS  %-26s %s\n" "/admin/health ok" "$(echo "$health" | jq -c '{observability:.observability.ok,spend:.spend.ok,optimizer:.optimizer.ok}')"
  else
    printf "      FAIL  %-26s %s\n" "/admin/health" "$(echo "$health" | head -c 160)"; fail=1
  fi
  # default-model routing: resolves to anthropic (auth-fails without a key, that's fine)
  local route
  route="$(curl -s -m 20 "https://$gw/v1/chat/completions" -H "Authorization: Bearer $tok" \
            -H "Content-Type: application/json" \
            -d '{"model":"anyray-default","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' || true)"
  if echo "$route" | jq -e '.provider=="anthropic" or (.choices|length>0)' >/dev/null 2>&1; then
    printf "      PASS  %-26s %s\n" "anyray-default routing" "-> anthropic"
  else
    printf "      WARN  %-26s %s\n" "anyray-default routing" "$(echo "$route" | head -c 160)"
  fi

  echo
  [ "$fail" = 0 ] && { echo "RESULT: PASS -- the published one-click template boots and is healthy."; return 0; }
  echo "RESULT: FAIL -- see checks above." >&2; return 1
}

case "$mode" in
  prep) prep ;;
  test) run_test ;;
  -h|--help|help) sed -n '2,40p' "$0" ;;
  *) die "unknown mode '$mode' (use: prep | test)" ;;
esac
