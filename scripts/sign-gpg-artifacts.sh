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
# GNUPGHOME MUST BE SHORT. gpg-agent's sockets live inside it, and a unix socket
# path is capped at 108 bytes (sun_path). The longest gpg creates is
# `S.gpg-agent.browser` — 20 chars plus the directory — and on the CodeBuild
# runner $RUNNER_TEMP is already 68 chars:
#
#   /codebuild/output/src<10 digits>/src/actions-runner/_work/_temp
#
# `mktemp -d "$base_dir/anyray-gpg-signing.XXXXXX"` added 27 more, putting that
# socket at exactly 108 and one byte over the limit. gpg does not report a path
# problem: it prints "error running '/usr/bin/gpg-agent': exit status 2" then
# "No agent running", which reads like a missing binary, and the import fails
# with the secret key already parsed ("secret keys read: 1"). It cost the first
# fleetd signing run.
#
# So: a FIXED short subdirectory, not mktemp. Concurrency is handled by the
# per-process suffix rather than mktemp's randomness, which keeps the name
# bounded and predictable. Keep this name short — every character here is a
# character of socket-path budget.
base_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
keyring_dir="$base_dir/gnupg.$$"
rm -rf "$keyring_dir"
mkdir -p "$keyring_dir"
# Fail loudly rather than let gpg do it opaquely 20 lines later.
longest_socket="$keyring_dir/S.gpg-agent.browser"
if [ "${#longest_socket}" -gt 107 ]; then
  echo "GNUPGHOME is too long for a gpg-agent socket (${#longest_socket} > 107): $keyring_dir" >&2
  echo 'Set RUNNER_TEMP (or TMPDIR) to a shorter path.' >&2
  exit 1
fi
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
