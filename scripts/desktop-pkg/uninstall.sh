#!/bin/bash
set -euo pipefail

if [ "$(/usr/bin/id -u)" -ne 0 ]; then
  echo 'Anyray Connect uninstall must run as root' >&2
  exit 1
fi

engine='/Applications/Anyray Connect.app/Contents/MacOS/anyray-connect'
launcher='/usr/local/bin/anyray-connect'
receipt='ai.anyray.connect-tray'

# An older bundled engine may not have the uninstall verb yet; an unknown verb
# falls through to the apply flow instead of rejecting --user.
engine_supports_uninstall=false
if [ -x "$engine" ] \
  && "$engine" --help 2>/dev/null | /usr/bin/grep -Eq '^[[:space:]]*uninstall[[:space:]]'; then
  engine_supports_uninstall=true
fi

if [ -x "$engine" ]; then
  if [ "$engine_supports_uninstall" = true ]; then
    /usr/bin/dscl . -list /Users UniqueID | while read -r user uid; do
      case "$uid" in
        ''|*[!0-9]*) continue ;;
      esac
      [ "$uid" -ne 0 ] || continue
      home="$(/usr/bin/dscl . -read "/Users/$user" NFSHomeDirectory 2>/dev/null \
        | /usr/bin/sed 's/^NFSHomeDirectory: //')"
      [ -n "$home" ] || continue
      [ -d "$home/.anyray" ] || continue
      if ! /bin/launchctl asuser "$uid" /usr/bin/sudo -H -u "$user" \
        "$engine" uninstall --user --json; then
        echo "Anyray Connect user cleanup failed for $user; continuing with machine cleanup" >&2
      fi
    done
  else
    echo 'Anyray Connect engine predates the uninstall verb; only the residue layer ran' >&2
  fi
fi

if [ -L "$launcher" ] && [ "$(/usr/bin/readlink "$launcher")" = "$engine" ]; then
  /bin/rm -f "$launcher"
elif [ -e "$launcher" ] || [ -L "$launcher" ]; then
  echo "leaving foreign $launcher untouched" >&2
fi

for helper in \
  /usr/local/bin/anyray-credential-helper \
  /usr/local/bin/anyray-bootstrap-headers-helper; do
  if [ -f "$helper" ] \
    && /usr/bin/grep -q 'Managed by anyray-connect desktop helper' "$helper"; then
    /bin/rm -f "$helper"
  elif [ -e "$helper" ] || [ -L "$helper" ]; then
    echo "leaving foreign $helper untouched" >&2
  fi
done

/bin/rm -rf '/Applications/Anyray Connect.app'
/bin/rm -rf '/usr/local/lib/anyray-connect'
/usr/sbin/pkgutil --forget "$receipt" >/dev/null 2>&1 || true
