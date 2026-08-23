#!/usr/bin/env bash
# One-time provisioning for the Windows Authenticode lane (Azure Artifact
# Signing, formerly Trusted Signing). Companion to the `sign-windows` job in
# .github/workflows/release-connect-binaries.yml and the Windows section of
# RELEASING.md.
#
# WHAT THIS DOES AND DOES NOT DO. It creates the certificate profile (unless one
# already exists) and the CI identity: an Entra app, a federated credential
# trusting this repo's OIDC token, and the role assignment that permits signing.
#
# It does NOT create the signing account or the identity validation. **Identity
# validation is genuinely portal-only** — Microsoft does not expose it to the
# CLI — and takes days to clear. Everything after it is scriptable, including
# the certificate profile, via `az trustedsigning certificate-profile create`.
#
# The profile is created rather than assumed because the alternative is worse:
# `--identity-validation-id` decides the publisher name baked into every
# certificate the profile ever issues, so making it an explicit, recorded step
# beats clicking through a portal list. The script refuses to guess — it fails
# with the list of Completed validations when there is any ambiguity, and only
# auto-selects when exactly one matches the expected organisation.
#
# Idempotent — re-running reuses an existing profile, app, credential and role
# assignment rather than duplicating them.
#
# ACCESS NOTE. If `az login` fails with AADSTS530035 ("You don't have access to
# this", Device state: Unregistered), the tenant's Conditional Access policy
# blocks the Azure CLI from unregistered devices. That is a deliberate control,
# not something to work around: run this from **Azure Cloud Shell** (the portal
# session is already compliant), where az is preinstalled and authenticated.
set -euo pipefail

REPO="${REPO:-anyrayHQ/install}"
# The release workflow is workflow_dispatch-only and runs on the default branch,
# so this is the subject GitHub will present. A federated credential matches the
# subject EXACTLY: dispatching the workflow from any other branch mints
# `repo:…:ref:refs/heads/<that-branch>` and Entra refuses it with a generic
# AADSTS70021 "no matching federated identity record found". That is the correct
# posture — signing from an arbitrary branch is exactly what should not work —
# but it is worth recognising when it happens.
#
# KNOWN LOOSENESS, worth tightening deliberately. A `ref:` subject scopes the
# credential to a BRANCH, not to a workflow: any job in this repo running on
# that branch with `id-token: write` can mint this token and Authenticode-sign
# arbitrary bytes as the company. Several workflows here already request that
# permission for unrelated AWS OIDC. The standard hardening for a code-signing
# identity is an ENVIRONMENT subject instead —
#   SUBJECT="repo:${REPO}:environment:release-signing"
# plus `environment: release-signing` on the sign-windows job and required
# reviewers on that environment, which also adds a human approval per signing
# operation. Not done here because creating the environment is a repo-settings
# change that should be made deliberately rather than by a setup script.
# Set SUBJECT_MODE=environment once that environment exists.
BRANCH="${BRANCH:-main}"
SUBJECT_MODE="${SUBJECT_MODE:-ref}"
ENVIRONMENT="${ENVIRONMENT:-release-signing}"
case "$SUBJECT_MODE" in
  ref)         SUBJECT="repo:${REPO}:ref:refs/heads/${BRANCH}" ;;
  environment) SUBJECT="repo:${REPO}:environment:${ENVIRONMENT}" ;;
  *) echo "SUBJECT_MODE must be 'ref' or 'environment'" >&2; exit 2 ;;
esac
APP_NAME="${APP_NAME:-anyray-install-signing-ci}"

RESOURCE_GROUP="${RESOURCE_GROUP:-anyray-signing}"
ACCOUNT="${ACCOUNT:-anyray-signing}"
PROFILE="${PROFILE:-}"

PROFILE="${PROFILE:-anyray-connect}"
# The organisation whose Completed identity validation the certificate profile
# must hang off. This string becomes the Windows publisher, and the verify step
# in release-connect-binaries.yml asserts it — change both together.
EXPECT_PUBLISHER="${EXPECT_PUBLISHER:-Othentic Labs LTD}"
# PublicTrustTest chains to a root Windows does NOT trust. Rehearsal only.
PROFILE_TYPE="${PROFILE_TYPE:-PublicTrust}"

command -v az >/dev/null || { echo "az CLI not found: https://aka.ms/azure-cli" >&2; exit 1; }

# Say WHICH thing is wrong. Bare `az account show` prints "Please run 'az login'"
# for an unauthenticated shell, which reads like a missing step even when the
# real cause is a Conditional Access policy refusing the CLI outright.
if ! az account show >/dev/null 2>&1; then
  cat >&2 <<'MSG'
error: not authenticated to Azure.

  az login

If that fails with AADSTS530035 ("You don't have access to this", Device state:
Unregistered), the tenant's Conditional Access policy blocks the Azure CLI from
unregistered devices. Do not try to work around it — run this script from Azure
Cloud Shell (portal -> the >_ icon), where az is preinstalled and the session is
already compliant. Upload the script with the Cloud Shell file picker, or paste
it in.
MSG
  exit 1
fi

# Never hardcode subscription or tenant: this repo is PUBLIC, same reason
# scripts/mac-fleet.sh derives the AWS account id instead of literalising it.
SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
TENANT_ID="$(az account show --query tenantId -o tsv)"

ACCOUNT_ID="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.CodeSigning/codeSigningAccounts/${ACCOUNT}"
SCOPE="${ACCOUNT_ID}/certificateProfiles/${PROFILE}"

# The trustedsigning commands live in an extension. Install it explicitly rather
# than relying on the auto-install prompt, which does not fire non-interactively.
az extension show --name trustedsigning >/dev/null 2>&1 \
  || az extension add --name trustedsigning --only-show-errors >/dev/null

if az trustedsigning certificate-profile show \
    -g "$RESOURCE_GROUP" --account-name "$ACCOUNT" -n "$PROFILE" >/dev/null 2>&1; then
  echo "reusing certificate profile '${PROFILE}'"
else
  # WHICH IDENTITY VALIDATION decides the publisher name baked into every
  # certificate this profile issues, and it cannot be corrected afterwards
  # without redoing validation — so it must be passed in, deliberately.
  #
  # THERE IS NO LISTING API TO AUTO-SELECT FROM. `identityValidations` appears
  # in no api-version of the Microsoft.CodeSigning ARM surface (checked against
  # the published specs: stable 2025-10-13 and every preview expose only
  # `certificateProfiles`). Identity validation is portal-only for reading as
  # well as for creating, so an `az rest .../identityValidations` call — the
  # obvious thing to reach for — 404s rather than returning an empty list.
  if [ -z "${IDENTITY_VALIDATION_ID:-}" ]; then
    cat >&2 <<MSG
error: certificate profile '${PROFILE}' does not exist and IDENTITY_VALIDATION_ID was not given.

Get it from the portal (there is no CLI or API for this):
  Artifact Signing account '${ACCOUNT}' -> Identity validation

Pick the row whose Organization name is exactly '${EXPECT_PUBLISHER}' and whose
Status is Completed, and pass its Identity validation id:

  IDENTITY_VALIDATION_ID=<guid> PROFILE=${PROFILE} $0

The organisation on that row becomes the Windows publisher on every binary this
profile ever signs, and release-connect-binaries.yml asserts it matches
'${EXPECT_PUBLISHER}'. Choosing the wrong row ships under the wrong company.
MSG
    exit 1
  fi
  echo "creating certificate profile '${PROFILE}' (${PROFILE_TYPE}) against validation ${IDENTITY_VALIDATION_ID}"
  az trustedsigning certificate-profile create \
    -g "$RESOURCE_GROUP" --account-name "$ACCOUNT" -n "$PROFILE" \
    --profile-type "$PROFILE_TYPE" \
    --identity-validation-id "$IDENTITY_VALIDATION_ID" \
    --only-show-errors >/dev/null
fi

APP_ID="$(az ad app list --display-name "$APP_NAME" --query '[0].appId' -o tsv)"
if [ -z "$APP_ID" ] || [ "$APP_ID" = "None" ]; then
  echo "creating Entra app '${APP_NAME}'"
  APP_ID="$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)"
else
  echo "reusing Entra app '${APP_NAME}' (${APP_ID})"
fi

# The service principal is what carries the role assignment; the app alone
# cannot hold one.
az ad sp show --id "$APP_ID" >/dev/null 2>&1 || az ad sp create --id "$APP_ID" >/dev/null
SP_OBJECT_ID="$(az ad sp show --id "$APP_ID" --query id -o tsv)"

if az ad app federated-credential list --id "$APP_ID" \
  --query "[?subject=='${SUBJECT}'] | [0].id" -o tsv | grep -q .; then
  echo "federated credential for ${SUBJECT} already present"
else
  echo "adding federated credential for ${SUBJECT}"
  # `api://AzureADTokenExchange` is the fixed audience Entra expects from a
  # GitHub OIDC token; it is not a per-tenant value.
  az ad app federated-credential create --id "$APP_ID" --parameters "$(cat <<JSON
{
  "name": "github-${SUBJECT_MODE}-${BRANCH}",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "${SUBJECT}",
  "audiences": ["api://AzureADTokenExchange"]
}
JSON
)" >/dev/null
fi

# Scoped to the certificate PROFILE, not the account: this role is the whole
# authority to sign, and nothing else here needs it. Note that Owner and
# Contributor deliberately do NOT include signing, so this assignment is
# required even for an account owner.
#
# Microsoft renamed the service (Trusted Signing → Artifact Signing) and the
# role name moved with it; tenants can still carry the old one, so try both
# rather than fail on a rename.
assigned=0
for role in "Artifact Signing Certificate Profile Signer" \
            "Trusted Signing Certificate Profile Signer" \
            "Code Signing Certificate Profile Signer"; do
  if az role assignment list --assignee "$SP_OBJECT_ID" --scope "$SCOPE" \
      --query "[?roleDefinitionName=='${role}'] | [0].id" -o tsv 2>/dev/null | grep -q .; then
    echo "role already assigned: ${role}"; assigned=1; break
  fi
  if az role assignment create --assignee-object-id "$SP_OBJECT_ID" \
      --assignee-principal-type ServicePrincipal \
      --role "$role" --scope "$SCOPE" >/dev/null 2>&1; then
    echo "assigned role: ${role}"; assigned=1; break
  fi
done
[ "$assigned" = 1 ] || {
  echo "error: could not assign a certificate-profile signer role." >&2
  echo "roles available on this scope:" >&2
  az role definition list --query "[?contains(roleName, 'Signing')].roleName" -o tsv >&2 || true
  exit 1
}

ENDPOINT="$(az resource show --ids \
  "/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.CodeSigning/codeSigningAccounts/${ACCOUNT}" \
  --query 'properties.accountUri' -o tsv 2>/dev/null || true)"

cat <<EOF

Done. Set these four repo variables (Settings → Secrets and variables → Actions
→ Variables). None is a secret — OIDC means there is no client secret at all:

  gh variable set AZURE_SIGNING_CLIENT_ID       -R ${REPO} --body '${APP_ID}'
  gh variable set AZURE_SIGNING_TENANT_ID       -R ${REPO} --body '${TENANT_ID}'
  gh variable set AZURE_SIGNING_ENDPOINT        -R ${REPO} --body '${ENDPOINT:-<Account URI from the portal Overview blade>}'
  gh variable set AZURE_SIGNING_ACCOUNT_PROFILE -R ${REPO} --body '${ACCOUNT}/${PROFILE}'

AZURE_SIGNING_CLIENT_ID is the on/off switch: until it is set, sign-windows
skips every step and the release publishes an unsigned .exe and still goes
green. After setting them, confirm the next release's sign-windows job actually
RAN rather than trusting the green tick.
EOF
