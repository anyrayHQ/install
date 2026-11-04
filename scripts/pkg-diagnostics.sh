#!/bin/bash
# pkg-diagnostics.sh <install-log> <start-byte> <users-dir>
#
# Run by the macOS desktop verify step when it fails. Installer writes a pkg script's
# output to its own log, never to the installer CLI's stdout, so a failing preinstall
# or postinstall reaches the job log only as "An error occurred while running scripts
# from the package" (Connect 0.11.565 and 0.11.575 at the self-serve uninstaller).
# This prints what the scripts logged since <start-byte>, each account's last per-user
# uninstall result, and the Anyray processes still running. Diagnostics only: it
# always exits 0 so it never replaces the failure it explains.
set -uo pipefail

log=${1:-}
start=${2:-0}
users_dir=${3:-/Users}
case "$start" in
  '' | *[!0-9]*) start=0 ;;
esac

echo "::group::pkg script output since this step began ($log)"
if [ -n "$log" ] && [ -r "$log" ]; then
  size="$(wc -c < "$log" | tr -d ' ')"
  # A log shorter than the recorded start was rotated: read all of it.
  if [ "$start" -gt "$size" ]; then
    start=0
  fi
  appended="$(tail -c "+$((start + 1))" "$log")"
  scripts="$(printf '%s\n' "$appended" \
    | grep -E 'installer\[[0-9]+\]: Product archive |package_script_service\[[0-9]+\]|PackageKit: .*([Ff]ail|[Ee]rror)' \
    | cut -c1-600 | tail -n 150)"
  if [ -n "$scripts" ]; then
    printf '%s\n' "$scripts"
  else
    echo 'No pkg script line was logged; the last 40 lines instead:'
    printf '%s\n' "$appended" | cut -c1-600 | tail -n 40
  fi
else
  echo "install log $log is not readable"
fi
echo '::endgroup::'

echo '::group::Per-account state the uninstaller acts on'
for home in "$users_dir"/*/; do
  [ -d "$home" ] || continue
  account="$(basename "$home")"
  anyray=absent
  [ -e "${home}.anyray" ] && anyray=present
  receipt="${home}Library/Application Support/Anyray Connect/uninstall.json"
  result=none
  if [ -f "$receipt" ]; then
    result="$(head -c 4096 "$receipt" | tr -d '\r\n')"
  fi
  echo "$account: ~/.anyray $anyray; last uninstall result: $result"
done
echo '::endgroup::'

echo '::group::Anyray processes still running (pid ppid uid elapsed command)'
# The bracketed first letters keep this filter from matching its own command line.
# shellcheck disable=SC2009 # pgrep cannot print the ppid and elapsed-time columns
ps -axo pid=,ppid=,uid=,etime=,command= \
  | grep -E '[A]nyray Connect\.app/|[a]nyray-connect|[a]nyray-engine\.|[c]onnect-tray' \
  | cut -c1-300 || echo 'none'
echo '::endgroup::'
exit 0
