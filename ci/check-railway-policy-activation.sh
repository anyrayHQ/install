#!/usr/bin/env bash

# Exercise the Railway capability boundary without deploying anything. Image
# versions remain pinned and equal, but they never select install semantics.
# The repository capability marker alone controls prompts/bootstrap behavior.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=railway/policy-capability.sh
source "$root/railway/policy-capability.sh"

die() {
  echo "error: $*" >&2
  exit 1
}

tag_from_service() {
  local service="$1"
  anyray_tag_from_image "$(jq -r --arg name "$service" \
    '.services[] | select(.name == $name) | .source.image // empty' \
    "$root/railway/railway.template.json")"
}

gateway_tag="$(tag_from_service gateway)"
optimizer_tag="$(tag_from_service optimizer)"
proxy_tag="$(tag_from_service proxy)"
iac_tag="$(sed -nE 's/^const TAG = "(v[0-9]+\.[0-9]+\.[0-9]+)";.*/\1/p' \
  "$root/.railway/railway.ts")"

[ -n "$gateway_tag" ] || die "Railway gateway image is not pinned to vX.Y.Z"
[ "$optimizer_tag" = "$gateway_tag" ] || die "Railway optimizer pin differs from gateway"
[ "$proxy_tag" = "$gateway_tag" ] || die "Railway proxy pin differs from gateway"
[ "$iac_tag" = "$gateway_tag" ] || die "Railway IaC and JSON pins differ"

jq -e '.services[] | select(.name == "gateway") | .variables
       | has("ANYRAY_SPEND_DB_URL")
         and has("ANYRAY_CONTENT_KEY")
         and has("ANYRAY_PERSISTENT_TRANSCRIPT_POLICY_ACTIVATE_AT")
         and .ANYRAY_PERSISTENT_TRANSCRIPT_POLICY_ACTIVATE_AT == ""' \
  "$root/railway/railway.template.json" >/dev/null
grep -q 'ANYRAY_PERSISTENT_TRANSCRIPT_POLICY_ACTIVATE_AT: preserve()' \
  "$root/.railway/railway.ts"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

make_case() {
  local name="$1" tag="$2" capability="$3" case_dir
  case_dir="$tmp/$name"
  mkdir -p "$case_dir/railway" "$case_dir/.railway" \
    "$case_dir/compatibility" "$case_dir/bin"
  cp "$root/railway/build-publish.sh" \
     "$root/railway/policy-capability.sh" \
     "$root/railway/railway-iac-bootstrap.sh" \
     "$root/railway/railway.template.json" \
     "$case_dir/railway/"
  cp "$root/.railway/railway.ts" "$case_dir/.railway/railway.ts"
  if [ "$capability" = enabled ]; then
    cp "$root/compatibility/persistentTranscriptPolicyV1" \
      "$case_dir/compatibility/persistentTranscriptPolicyV1"
  fi

  jq --arg tag "$tag" '
    .services |= map(
      if (.name == "gateway" or .name == "optimizer" or .name == "proxy")
      then .source.image |= sub(":v[0-9]+\\.[0-9]+\\.[0-9]+$"; ":" + $tag)
      else . end
    )
  ' "$case_dir/railway/railway.template.json" > "$case_dir/template.next"
  mv "$case_dir/template.next" "$case_dir/railway/railway.template.json"
  sed -i.bak -E "s/^const TAG = \"v[0-9]+\.[0-9]+\.[0-9]+\";/const TAG = \"$tag\";/" \
    "$case_dir/.railway/railway.ts"
  rm "$case_dir/.railway/railway.ts.bak"

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "%s\n" "$*" >> "${RAILWAY_TEST_LOG:?}"' \
    'if [ "${1:-}" = variables ] && [[ " $* " == *" --kv "* ]] && [ -n "${RAILWAY_EXISTING_ACTIVATION:-}" ]; then' \
    '  printf "ANYRAY_PERSISTENT_TRANSCRIPT_POLICY_ACTIVATE_AT=%s\n" "$RAILWAY_EXISTING_ACTIVATION"' \
    'fi' \
    'if [ "${1:-}" = domain ]; then' \
    '  [[ " $* " == *" -s gateway "* ]] && printf "gateway-test.up.railway.app\n"' \
    '  [[ " $* " == *" -s proxy "* ]] && printf "proxy-test.up.railway.app\n"' \
    'fi' \
    'exit 0' > "$case_dir/bin/railway"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "%064d\n" 0' > "$case_dir/bin/openssl"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "%s\n" "$*" >> "${DATE_TEST_LOG:?}"' \
    '[[ " $* " == *" +1 hour "* || " $* " == *" -v+1H "* ]] || exit 1' \
    'printf "2099-01-01T01:00:00.000Z\n"' > "$case_dir/bin/date"
  chmod +x "$case_dir/bin/railway" "$case_dir/bin/openssl" "$case_dir/bin/date"

  printf '%s' "$case_dir"
}

shared_test_tag=v9.8.7

pre_dir="$(make_case legacy-artifact "$shared_test_tag" legacy)"
"$pre_dir/railway/build-publish.sh" >/dev/null
if grep -q '^ANYRAY_PERSISTENT_TRANSCRIPT_POLICY_ACTIVATE_AT=' \
  "$pre_dir/railway/.publish/gateway.vars"; then
  die "legacy artifact exposes the activation prompt"
fi
: > "$pre_dir/railway.log"
: > "$pre_dir/date.log"
PATH="$pre_dir/bin:$PATH" RAILWAY_TEST_LOG="$pre_dir/railway.log" \
  DATE_TEST_LOG="$pre_dir/date.log" \
  "$pre_dir/railway/railway-iac-bootstrap.sh" >/dev/null
if grep -q 'ANYRAY_PERSISTENT_TRANSCRIPT_POLICY_ACTIVATE_AT' "$pre_dir/railway.log"; then
  die "legacy artifact bootstrap writes the activation timestamp"
fi
[ ! -s "$pre_dir/date.log" ] || die "legacy artifact bootstrap generated an unused timestamp"

capability_dir="$(make_case capability-artifact "$shared_test_tag" enabled)"
"$capability_dir/railway/build-publish.sh" >/dev/null
grep -qx 'ANYRAY_PERSISTENT_TRANSCRIPT_POLICY_ACTIVATE_AT=' \
  "$capability_dir/railway/.publish/gateway.vars"
: > "$capability_dir/railway.log"
: > "$capability_dir/date.log"
PATH="$capability_dir/bin:$PATH" RAILWAY_TEST_LOG="$capability_dir/railway.log" \
  DATE_TEST_LOG="$capability_dir/date.log" \
  "$capability_dir/railway/railway-iac-bootstrap.sh" >/dev/null
grep -q -- '--set ANYRAY_PERSISTENT_TRANSCRIPT_POLICY_ACTIVATE_AT=2099-01-01T01:00:00.000Z' \
  "$capability_dir/railway.log"
grep -q '+1 hour' "$capability_dir/date.log"

: > "$capability_dir/railway.log"
PATH="$capability_dir/bin:$PATH" RAILWAY_TEST_LOG="$capability_dir/railway.log" \
  DATE_TEST_LOG="$capability_dir/date.log" \
  RAILWAY_EXISTING_ACTIVATION="2098-12-31T23:00:00.000Z" \
  "$capability_dir/railway/railway-iac-bootstrap.sh" >/dev/null
if grep -q -- '--set ANYRAY_PERSISTENT_TRANSCRIPT_POLICY_ACTIVATE_AT=' \
  "$capability_dir/railway.log"; then
  die "policy IaC bootstrap replaced an existing activation timestamp"
fi

mismatch_dir="$(make_case mismatch "$shared_test_tag" enabled)"
jq '(.services[] | select(.name == "optimizer") | .source.image) |= sub(":v9.8.7$"; ":v9.8.8")' \
  "$mismatch_dir/railway/railway.template.json" > "$mismatch_dir/template.next"
mv "$mismatch_dir/template.next" "$mismatch_dir/railway/railway.template.json"
if "$mismatch_dir/railway/build-publish.sh" >/dev/null 2>&1; then
  die "one-click publish accepted mismatched Railway image pins"
fi

grep -q 'if anyray_install_has_capability' \
  "$root/railway/publish-template.sh"

echo "OK: Railway activation follows $ANYRAY_PERSISTENT_TRANSCRIPT_POLICY_CAPABILITY and all pins match $gateway_tag."
