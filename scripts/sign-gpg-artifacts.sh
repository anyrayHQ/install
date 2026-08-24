#!/usr/bin/env bash

# Produce detached GPG signatures for release artifacts and export the matching
# public key. The release workflow invokes this in an isolated temporary
# keyring, so the private key is never left on a persistent CodeBuild runner.

set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <output-directory> <artifact> [artifact...]" >&2
  exit 2
fi

output_dir="$1"
shift

for artifact in "$@"; do
  if [ ! -f "$artifact" ]; then
    echo "artifact is not a regular file: $artifact" >&2
    exit 2
  fi
done

required=(LINUX_SIGNING_GPG_KEY LINUX_SIGNING_GPG_PASSPHRASE)
missing=()
for name in "${required[@]}"; do
  if [ -z "${!name:-}" ]; then
    missing+=("$name")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  printf 'missing required Linux package-signing configuration: %s\n' "${missing[*]}" >&2
  exit 1
fi

mkdir -p "$output_dir"
base_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
keyring_dir="$(mktemp -d "$base_dir/anyray-gpg-signing.XXXXXX")"
cleanup() {
  gpgconf --homedir "$keyring_dir" --kill all 2>/dev/null || true
  rm -rf "$keyring_dir"
}
trap cleanup EXIT

chmod 700 "$keyring_dir"
export GNUPGHOME="$keyring_dir"

printf '%s' "$LINUX_SIGNING_GPG_KEY" | gpg --batch --pinentry-mode loopback --import
mapfile -t fingerprints < <(gpg --batch --with-colons --list-secret-keys \
  | awk -F: '$1 == "sec" { primary = 1; next } primary && $1 == "fpr" { print $10; primary = 0 }')
if [ "${#fingerprints[@]}" -ne 1 ]; then
  echo "expected exactly one Linux release signing key, found ${#fingerprints[@]}" >&2
  exit 1
fi
fingerprint="${fingerprints[0]}"

gpg --batch --armor --export "$fingerprint" > "$output_dir/anyray-endpoint-signing-key.asc"
for artifact in "$@"; do
  signature="${artifact}.asc"
  printf '%s' "$LINUX_SIGNING_GPG_PASSPHRASE" \
    | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 \
      --local-user "$fingerprint" --armor --detach-sign --output "$signature" "$artifact"
  gpg --batch --verify "$signature" "$artifact"
done

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "fingerprint=$fingerprint" >> "$GITHUB_OUTPUT"
fi
echo "Linux package signing key fingerprint: $fingerprint"
