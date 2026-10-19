#!/bin/bash
# The CI artifacts bucket is writable by any job holding the role, including the
# build account that runs after signing on the persistent Mac host. Consumers of
# signed artifacts trust only digests reported as the signing job's outputs:
# only that job itself can set them.
set -euo pipefail
export LC_ALL=C

fail() { printf '::error::%s\n' "$1" >&2; exit 1; }
usage() { printf 'usage: artifact-digest.sh manifest <file>... | emit <output-name> <file>... | verify <label> <dir> <expected-manifest>\n' >&2; exit 2; }

manifest() (
  [ "$#" -gt 0 ] || fail 'manifest: file count check failed'
  entries=''
  names=','
  for path in "$@"; do
    [ -f "$path" ] && [ ! -L "$path" ] || fail 'manifest: regular file check failed'
    name="${path##*/}"
    [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || fail 'manifest: basename check failed'
    case "$names" in *",$name,"*) fail 'manifest: unique basename check failed' ;; esac
    names="${names}${name},"
    if command -v sha256sum >/dev/null 2>&1; then
      digest="$(sha256sum 2>/dev/null < "$path")" || fail 'manifest: hash check failed'
    else
      digest="$(shasum -a 256 2>/dev/null < "$path")" || fail 'manifest: hash check failed'
    fi
    digest="${digest%% *}"
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || fail 'manifest: hash format check failed'
    entries="${entries}${entries:+$'\n'}${name}=${digest}"
  done
  printf '%s\n' "$entries" | sort | paste -s -d ',' -
)

verify() (
  label="$1" dir="$2" expected="$3"
  [[ "$label" =~ ^[A-Za-z0-9._\ -]+$ ]] || fail 'verify: label check failed'
  [ -n "$expected" ] || fail "$label: no digests from the signing job; refusing the downloaded files"
  [[ "$expected" =~ ^[A-Za-z0-9._-]+=[0-9a-f]{64}(,[A-Za-z0-9._-]+=[0-9a-f]{64})*$ ]] || fail "$label: expected manifest format check failed"
  [ -d "$dir" ] && [ ! -L "$dir" ] || fail "$label: directory check failed"
  expected_count="$(printf '%s\n' "$expected" | awk -F, '{print NF}')"
  count=0
  set --
  shopt -s nullglob dotglob
  for path in "$dir"/*; do
    [ -f "$path" ] && [ ! -L "$path" ] || fail "$label: direct regular files check failed"
    count=$((count + 1))
    set -- "$@" "$path"
  done
  actual=''
  if [ "$count" -gt 0 ]; then
    actual="$(manifest "$@" 2>/dev/null)" || actual=''
  fi
  [ "$actual" = "$expected" ] || fail "$label: downloaded files do not match the digests the signing job reported (expected $expected_count files; downloaded $count files)"
)

[ "$#" -gt 0 ] || usage
action="$1"
shift
case "$action" in
  manifest) manifest "$@" ;;
  emit)
    [ "$#" -ge 2 ] || usage
    output_name="$1"
    shift
    [[ "$output_name" =~ ^[a-z_]+$ ]] || fail 'emit: output name check failed'
    [ -n "${GITHUB_OUTPUT:-}" ] || fail 'emit: GITHUB_OUTPUT check failed'
    value="$(manifest "$@")" || exit 1
    printf '%s=%s\n' "$output_name" "$value" >> "$GITHUB_OUTPUT"
    printf '::notice::%s: recorded digests for %s files\n' "$output_name" "$#"
    ;;
  verify) [ "$#" -eq 3 ] || usage; verify "$@" ;;
  *) usage ;;
esac
