#!/usr/bin/env bash
# Render the winget manifest set for anyray-connect from the templates in
# winget/templates/ into the winget-pkgs directory layout
# (winget/manifests/a/Anyray/Connect/<version>/).
#
# winget is NOT self-hosted: the rendered files are submitted as a PR to
# microsoft/winget-pkgs (see winget/README.md). This script only renders them —
# it never publishes.
#
# The only substitutions are __VERSION__ and __SHA256__. The SHA256 is the
# checksum of anyray-connect-windows-x64.exe from the release's SHA256SUMS, and
# this script FAILS LOUDLY rather than emit a manifest with an empty or
# placeholder hash: a manifest whose InstallerSha256 does not match the bytes
# winget downloads is rejected by winget's validator, and a wrong-but-well-formed
# hash would point users at bytes nobody signed.
#
# Usage:
#   scripts/gen-winget-manifests.sh --version 0.11.174
#       Fetch SHA256SUMS from the live release connect-v0.11.174 and render.
#
#   scripts/gen-winget-manifests.sh --version 0.11.174 --sha256sums ./SHA256SUMS
#       Read the checksum from a local SHA256SUMS file (offline / air-gapped CI).
#
#   scripts/gen-winget-manifests.sh --version 0.11.174 --sha256 <64-hex>
#       Use an explicit checksum (skips both the release fetch and the file).
#
# Optional:
#   --out-dir <dir>   Root under which manifests/a/Anyray/Connect/<v>/ is written
#                     (default: the winget/ dir next to this script's repo).
set -euo pipefail

die() {
  echo "gen-winget-manifests: error: $*" >&2
  exit 1
}

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
templates_dir="$repo_root/winget/templates"
out_root="$repo_root/winget"

version=""
sha256=""
sha256sums_path=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "--version needs a value"
      version="$2"
      shift 2
      ;;
    --sha256)
      [ "$#" -ge 2 ] || die "--sha256 needs a value"
      sha256="$2"
      shift 2
      ;;
    --sha256sums)
      [ "$#" -ge 2 ] || die "--sha256sums needs a path"
      sha256sums_path="$2"
      shift 2
      ;;
    --out-dir)
      [ "$#" -ge 2 ] || die "--out-dir needs a path"
      out_root="$2"
      shift 2
      ;;
    -h | --help)
      sed -n '1,40p' "$0"
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[ -n "$version" ] || die "missing --version <x.y.z>"
# Anchor the version: it lands in a download URL path and in the output dir name.
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) : ;;
  *) die "invalid --version '$version' — expected x.y.z (e.g. 0.11.174)" ;;
esac
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || die "invalid --version '$version' — expected x.y.z (e.g. 0.11.174)"

asset="anyray-connect-windows-x64.exe"
tag="connect-v$version"

# Resolve the checksum. Precedence: explicit --sha256, then --sha256sums file,
# then the live release. Whichever path we take, we must end with a 64-hex value
# for exactly $asset, or we abort.
extract_from_sums() {
  # $1 = path to a SHA256SUMS file. Prints the hash for $asset, or nothing.
  awk -v a="$asset" '$2 == a { print $1 }' "$1"
}

if [ -n "$sha256" ]; then
  : # explicit — validated below
elif [ -n "$sha256sums_path" ]; then
  [ -f "$sha256sums_path" ] || die "SHA256SUMS file not found: $sha256sums_path"
  sha256="$(extract_from_sums "$sha256sums_path" || true)"
  [ -n "$sha256" ] || die "no line for '$asset' in $sha256sums_path"
else
  command -v curl >/dev/null 2>&1 || die "curl not found — pass --sha256sums <path> or --sha256 <hex> to render offline"
  sums_url="https://github.com/anyrayHQ/install/releases/download/$tag/SHA256SUMS"
  echo "gen-winget-manifests: fetching $sums_url" >&2
  tmp_sums="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '$tmp_sums'" EXIT
  curl -sSfL "$sums_url" -o "$tmp_sums" \
    || die "could not fetch SHA256SUMS for $tag (is the release published?) — or pass --sha256sums / --sha256"
  sha256="$(extract_from_sums "$tmp_sums" || true)"
  [ -n "$sha256" ] || die "no line for '$asset' in the fetched SHA256SUMS ($tag)"
fi

# Never emit a manifest with a malformed hash. winget's InstallerSha256 is
# ^[A-Fa-f0-9]{64}$; a placeholder like __SHA256__ or an empty value must abort.
printf '%s' "$sha256" | grep -Eq '^[A-Fa-f0-9]{64}$' \
  || die "resolved SHA256 for $asset is not 64 hex chars: '$sha256' — refusing to write a manifest winget would reject"

[ -d "$templates_dir" ] || die "templates dir not found: $templates_dir"
for t in \
  "Anyray.Connect.installer.yaml" \
  "Anyray.Connect.locale.en-US.yaml" \
  "Anyray.Connect.yaml"; do
  [ -f "$templates_dir/$t" ] || die "missing template: $templates_dir/$t"
done

dest="$out_root/manifests/a/Anyray/Connect/$version"
mkdir -p "$dest"

render() {
  # $1 = template basename. Drops the @@TEMPLATE-ONLY@@ preamble (its "do not
  # submit" note and placeholder-token names must not leak into a real manifest),
  # then substitutes __VERSION__ and __SHA256__ in what remains.
  sed \
    -e '/@@TEMPLATE-ONLY@@/d' \
    -e "s/__VERSION__/$version/g" \
    -e "s/__SHA256__/$sha256/g" \
    "$templates_dir/$1" > "$dest/$1"
}

render "Anyray.Connect.installer.yaml"
render "Anyray.Connect.locale.en-US.yaml"
render "Anyray.Connect.yaml"

# Belt and braces: no placeholder must survive into a rendered file.
if grep -RlnE '__(VERSION|SHA256)__' "$dest" >/dev/null 2>&1; then
  die "a placeholder survived rendering in $dest — refusing to leave a broken manifest"
fi

echo "gen-winget-manifests: wrote winget manifests for Anyray.Connect $version"
echo "  version:  $version"
echo "  sha256:   $sha256  ($asset)"
echo "  location: $dest"
ls -1 "$dest"
