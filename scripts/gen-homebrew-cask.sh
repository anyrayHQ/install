#!/usr/bin/env bash

# Render the Homebrew cask for anyray-connect from its template, pinning the
# version and the pkg's SHA-256. A cask MUST carry the exact sha256 of the
# artifact it installs — Homebrew refuses to install on a mismatch — so this
# reads the hash from the release's own SHA256SUMS (the same file connect.sh
# verifies against) rather than ever inventing one. Fails loudly if the pkg
# line is missing: a cask with an empty or placeholder hash is worse than no
# cask at all.
#
# Usage:
#   scripts/gen-homebrew-cask.sh --version 0.11.174
#       fetch SHA256SUMS from the live connect-v0.11.174 release
#   scripts/gen-homebrew-cask.sh --version 0.11.174 --sha256sums out/SHA256SUMS
#       read the hash from a local SHA256SUMS (e.g. during the release build)
#
# Options:
#   --version <v>        release version, without the leading `connect-v` (required)
#   --sha256sums <path>  local SHA256SUMS to read instead of the live release
#   --template <path>    cask template (default: homebrew/anyray-connect.rb.tmpl)
#   --output <path>      rendered cask (default: Casks/anyray-connect.rb)
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
version=""
sha256sums_path=""
template="${repo_root}/homebrew/anyray-connect.rb.tmpl"
output="${repo_root}/Casks/anyray-connect.rb"
pkg_asset="anyray-connect.pkg"

die() {
  echo "gen-homebrew-cask: $*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)    version="${2:?--version needs a value}"; shift 2 ;;
    --sha256sums) sha256sums_path="${2:?--sha256sums needs a value}"; shift 2 ;;
    --template)   template="${2:?--template needs a value}"; shift 2 ;;
    --output)     output="${2:?--output needs a value}"; shift 2 ;;
    -h|--help)
      sed -n '3,25p' "$0"
      exit 0
      ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[ -n "$version" ] || die "missing required --version (see --help)"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "invalid version '${version}': expected X.Y.Z without the leading connect-v"
fi
[ -f "$template" ] || die "cask template not found: ${template}"

tag="connect-v${version}"

# Pull the SHA256SUMS line for the pkg. Anchor on an exact second-field match so
# a hypothetical `anyray-connect.pkg.asc` can never be mistaken for the pkg.
if [ -n "$sha256sums_path" ]; then
  [ -f "$sha256sums_path" ] || die "SHA256SUMS not found: ${sha256sums_path}"
  sums="$(cat "$sha256sums_path")"
else
  sums_url="https://github.com/anyrayHQ/install/releases/download/${tag}/SHA256SUMS"
  echo "gen-homebrew-cask: fetching ${sums_url}" >&2
  sums="$(curl -fsSL "$sums_url")" \
    || die "could not fetch SHA256SUMS for ${tag} (${sums_url}) — is the release published?"
fi

sha256="$(printf '%s\n' "$sums" | awk -v f="$pkg_asset" '$2 == f { print $1; exit }')"
[ -n "$sha256" ] || die "no ${pkg_asset} entry in SHA256SUMS for ${tag} — refusing to emit a cask with no hash"
if [[ ! "$sha256" =~ ^[0-9a-f]{64}$ ]]; then
  die "malformed SHA-256 for ${pkg_asset} in ${tag}: '${sha256}'"
fi

# Render. The substituted values are a validated X.Y.Z and a 64-char hex digest,
# so plain string replacement is safe (no regex metacharacters reach sed/awk).
rendered="$(cat "$template")"
rendered="${rendered//__VERSION__/$version}"
rendered="${rendered//__SHA256__/$sha256}"

if printf '%s' "$rendered" | grep -q '__VERSION__\|__SHA256__'; then
  die "template still has unresolved placeholders after render — check ${template}"
fi

mkdir -p "$(dirname "$output")"
tmp="$(mktemp "${output}.tmp.XXXXXX")"
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT
printf '%s\n' "$rendered" > "$tmp"
chmod 0644 "$tmp"
mv "$tmp" "$output"
trap - EXIT

echo "gen-homebrew-cask: wrote ${output} (version ${version}, sha256 ${sha256})" >&2
