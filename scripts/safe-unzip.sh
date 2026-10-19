#!/bin/bash
# The unsigned app zip comes from the build account. On the persistent host the
# sign account must not let it write outside the destination or leave a link that
# a later codesign, install or copy would follow.
set -euo pipefail
export LC_ALL=C

fail() { printf '::error::%s\n' "$1" >&2; exit 1; }
usage() { printf 'usage: safe-unzip.sh check <zip> | verify-tree <dir> | extract <zip> <dest>\n' >&2; exit 2; }

check() (
  zip="$1"
  names="$(zipinfo -1 "$zip" 2>/dev/null)" || fail 'archive names listing check failed'
  trailer="$(zipinfo -t "$zip" 2>/dev/null)" || fail 'archive entry count check failed'
  count="${trailer%% *}"
  [[ "$count" =~ ^[0-9]+$ ]] && [ "$count" -gt 0 ] || fail 'archive nonempty entry count check failed'
  lines="$(printf '%s\n' "$names" | wc -l | tr -d ' ')"
  [ "$lines" -eq "$count" ] || fail 'archive name line count check failed'
  while IFS= read -r name; do
    case "$name" in
      ''|/*|*\\*|..|../*|*/../*|*/..) fail 'archive entry path check failed' ;;
    esac
    [[ ! "$name" =~ [[:cntrl:]] ]] || fail 'archive control character check failed'
  done <<< "$names"
  # zipinfo can render control bytes as printable escapes; also check the raw names.
  python3 -I -c '
import sys, zipfile
try:
    with zipfile.ZipFile(sys.argv[1]) as archive:
        for entry in archive.infolist():
            name = entry.orig_filename
            if (not name or name.startswith("/") or ".." in name.split("/")
                    or "\\" in name or any(ord(c) < 32 or ord(c) == 127 for c in name)):
                raise ValueError()
except Exception:
    sys.exit(1)
' "$zip" >/dev/null 2>&1 || fail 'archive raw entry path and control character check failed'
  listing="$(zipinfo "$zip" 2>/dev/null)" || fail 'archive metadata listing check failed'
  # Drop the two headers and the trailer without interpreting any entry names.
  entries="$(printf '%s\n' "$listing" | awk 'NR > 2 { if (have) print previous; previous=$0; have=1 }')"
  lines="$(printf '%s\n' "$entries" | wc -l | tr -d ' ')"
  [ "$lines" -eq "$count" ] || fail 'archive metadata line count check failed'
  printf '%s\n' "$entries" | awk '
    $3 != "unx" || $1 !~ /^[-d][-r][-w][-x][-r][-w][-x][-r][-w][-x]$/ { bad=1 }
    END { exit bad }
  ' || fail 'archive Unix regular file and directory mode check failed'
)

verify_tree() (
  dir="$1"
  [ -d "$dir" ] && [ ! -L "$dir" ] || fail 'tree root directory check failed'
  special="$(find "$dir" ! -type f ! -type d -print 2>/dev/null)" || fail 'tree file type scan check failed'
  [ -z "$special" ] || fail 'tree regular file and directory check failed'
  links="$(find "$dir" -type f -links +1 -print 2>/dev/null)" || fail 'tree link scan check failed'
  [ -z "$links" ] || fail 'tree single link check failed'
)

extract() (
  zip="$1" dest="$2"
  [ "$(uname -s)" = Darwin ] && [ -x /usr/bin/ditto ] && [ -x /usr/bin/sandbox-exec ] || fail 'extract macOS tools check failed'
  [ ! -e "$dest" ] && [ ! -L "$dest" ] || fail 'extract destination absence check failed'
  check "$zip"
  mkdir "$dest" 2>/dev/null || fail 'extract destination creation check failed'
  physical="$(cd "$dest" && pwd -P)" || fail 'extract physical destination check failed'
  [[ ! "$physical" =~ [[:cntrl:]] ]] || fail 'extract destination control character check failed'
  escaped="${physical//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  profile="(version 1)(allow default)(deny file-write* (require-not (subpath \"$escaped\")))(allow file-write* (literal \"/dev/null\"))"
  /usr/bin/sandbox-exec -p "$profile" /usr/bin/ditto -x -k "$zip" "$dest" >/dev/null 2>&1 || fail 'sandboxed extraction check failed'
  verify_tree "$dest"
)

[ "$#" -gt 0 ] || usage
action="$1"
shift
case "$action" in
  check) [ "$#" -eq 1 ] || usage; check "$@" ;;
  verify-tree) [ "$#" -eq 1 ] || usage; verify_tree "$@" ;;
  extract) [ "$#" -eq 2 ] || usage; extract "$@" ;;
  *) usage ;;
esac
