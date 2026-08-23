#!/usr/bin/env bash
# One-time provisioning for the Windows Authenticode lane (Azure Artifact
# Signing, formerly Trusted Signing). Companion to the `sign-windows` job in
# .github/workflows/release-connect-binaries.yml and the Windows section of
# RELEASING.md.
#
# WHAT THIS DOES AND DOES NOT DO. It creates the CI identity: an Entra app, a
# federated credential trusting this repo's OIDC token, and the role assignment
# that permits signing. It does NOT create the signing account, the identity
# validation, or the certificate profile:
#
#   - identity validation is **portal-only** (Microsoft does not expose it to
#     the CLI at all) and takes days to clear;
#   - the certificate profile depends on a Completed validation, and picking
#     which validation it hangs off decides the publisher name baked into every
#     certificate — a decision that should be made deliberately, in front of the
#     list, not by a script argument.
#
# So: do those two in the portal, then run this.
#
# Idempotent — re-running reuses an existing app, credential and role
# assignment rather than duplicating them.
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

if [ -z "$PROFILE" ]; then
  echo "usage: PROFILE=<certificate-profile-name> $0" >&2
  echo "  (create the profile in the portal first — type Public Trust, against" >&2
  echo "   the Completed 'Othentic Labs LTD' identity validation)" >&2
  exit 2
fi

command -v az >/dev/null || { echo "az CLI not found: https://aka.ms/azure-cli" >&2; exit 1; }

# Never hardcode subscription or tenant: this repo is PUBLIC, same reason
# scripts/mac-fleet.sh derives the AWS account id instead of literalising it.
SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
TENANT_ID="$(az account show --query tenantId -o tsv)"

SCOPE="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.CodeSigning/codeSigningAccounts/${ACCOUNT}/certificateProfiles/${PROFILE}"

# Fail here rather than after creating an identity that would have nothing to
# sign with. A wrong profile name otherwise surfaces much later as a 403 from
# the signing API, which reads like a permissions problem.
az resource show --ids "$SCOPE" >/dev/null 2>&1 || {
  echo "error: no certificate profile '${PROFILE}' on account '${ACCOUNT}' (rg '${RESOURCE_GROUP}')." >&2
  echo "existing profiles:" >&2
  az resource list \
    --resource-type Microsoft.CodeSigning/codeSigningAccounts/certificateProfiles \
    --query "[].name" -o tsv >&2 || true
  exit 1
}

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
