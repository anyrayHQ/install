#!/usr/bin/env bash

# Sign one Windows installer through Azure Artifact Signing using GitHub OIDC.
#
# The Azure credentials are deliberately never accepted on argv: the GitHub OIDC
# request token can mint a bearer allowed to sign Anyray releases, and command
# lines are visible to peer processes on a shared runner. Callers provide a
# pinned jsign jar in JSIGN_JAR and verify the signed artifact independently.

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <artifact> <product-name> <product-url>" >&2
  exit 2
fi

artifact="$1"
product_name="$2"
product_url="$3"

if [ ! -f "$artifact" ]; then
  echo "artifact is not a regular file: $artifact" >&2
  exit 2
fi

required=(
  ACTIONS_ID_TOKEN_REQUEST_TOKEN
  ACTIONS_ID_TOKEN_REQUEST_URL
  AZURE_SIGNING_CLIENT_ID
  AZURE_SIGNING_TENANT_ID
  AZURE_SIGNING_ENDPOINT
  AZURE_SIGNING_ACCOUNT_PROFILE
  JSIGN_JAR
  RUNNER_TEMP
)
missing=()
for name in "${required[@]}"; do
  if [ -z "${!name:-}" ]; then
    missing+=("$name")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  printf 'missing required signing configuration: %s\n' "${missing[*]}" >&2
  exit 1
fi

if [ ! -f "$JSIGN_JAR" ]; then
  echo "JSIGN_JAR is not a regular file: $JSIGN_JAR" >&2
  exit 1
fi

case "$AZURE_SIGNING_ACCOUNT_PROFILE" in
  */*/*|/*|*/)
    echo 'AZURE_SIGNING_ACCOUNT_PROFILE must be exactly <account>/<certificate-profile>' >&2
    exit 1
    ;;
  */*) ;;
  *)
    echo 'AZURE_SIGNING_ACCOUNT_PROFILE must be exactly <account>/<certificate-profile>' >&2
    exit 1
    ;;
esac

# The endpoint controls where jsign sends the bearer token. Accept only Azure's
# public signing data-plane host, with no path, userinfo, port, or query string.
endpoint_host="${AZURE_SIGNING_ENDPOINT#https://}"
endpoint_host="${endpoint_host%/}"
endpoint_ok=''
case "$AZURE_SIGNING_ENDPOINT" in
  https://*)
    case "$endpoint_host" in
      *[!a-zA-Z0-9.-]*) ;;
      *[!/.].codesigning.azure.net) endpoint_ok=1 ;;
    esac
    ;;
esac
if [ -z "$endpoint_ok" ]; then
  echo 'AZURE_SIGNING_ENDPOINT must be exactly https://<region>.codesigning.azure.net' >&2
  exit 1
fi

hex='[0-9a-fA-F]'
# shellcheck disable=SC2254 # Intentional glob validation, not a regular expression.
case "$AZURE_SIGNING_TENANT_ID" in
  $hex$hex$hex$hex$hex$hex$hex$hex-$hex$hex$hex$hex-$hex$hex$hex$hex-$hex$hex$hex$hex-$hex$hex$hex$hex$hex$hex$hex$hex$hex$hex$hex$hex) ;;
  *)
    echo 'AZURE_SIGNING_TENANT_ID must be a GUID' >&2
    exit 1
    ;;
esac

umask 077
oidc_file="$RUNNER_TEMP/anyray-azure-oidc.jwt"
access_token_file="$RUNNER_TEMP/anyray-azure-signing.token"
cleanup() {
  rm -f "$oidc_file" "$access_token_file"
}
trap cleanup EXIT

oidc_token="$(printf 'header = "Authorization: Bearer %s"\n' "$ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  | curl -fsSL --proto '=https' --proto-redir '=https' --config - \
    "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=api%3A%2F%2FAzureADTokenExchange" \
  | jq -er '.value')"
echo "::add-mask::$oidc_token"
printf '%s' "$oidc_token" > "$oidc_file"
unset oidc_token

if ! response="$(curl -fsSL --fail-with-body --proto '=https' --proto-redir '=https' \
  "https://login.microsoftonline.com/${AZURE_SIGNING_TENANT_ID}/oauth2/v2.0/token" \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode "client_id=${AZURE_SIGNING_CLIENT_ID}" \
  --data-urlencode 'scope=https://codesigning.azure.net/.default' \
  --data-urlencode 'client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer' \
  --data-urlencode "client_assertion@$oidc_file")"; then
  error="$(printf '%s' "$response" | jq -r '[.error, .error_description] | map(select(.)) | join(": ")' 2>/dev/null | head -c 400)"
  echo "Azure token exchange failed: ${error:-unknown error}" >&2
  exit 1
fi
access_token="$(printf '%s' "$response" | jq -er '.access_token')"
unset response
echo "::add-mask::$access_token"
printf '%s' "$access_token" > "$access_token_file"
unset access_token

java -jar "$JSIGN_JAR" \
  --storetype TRUSTEDSIGNING \
  --keystore "$AZURE_SIGNING_ENDPOINT" \
  --storepass "file:$access_token_file" \
  --alias "$AZURE_SIGNING_ACCOUNT_PROFILE" \
  --alg SHA-256 \
  --name "$product_name" \
  --url "$product_url" \
  "$artifact"
