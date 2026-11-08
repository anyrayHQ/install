#!/usr/bin/env bash

# Run a signing command that needs Apple's timestamp server (`codesign --timestamp`, `productsign`),
# retrying only when that server did not answer. connect 0.11.602 lost its macOS desktop to one
# such answer ("The timestamp service is not available. (-67885)"): the OS that fails at prepare
# time is never stored, so a single unanswered request costs the whole version. Any other failure
# (a missing identity, a bad keychain) fails at once with the command's own status.
#
# usage: apple-timestamp-retry.sh [--remove <path>] <command...>
#        --remove names the file the command writes. A failed attempt can leave a partial one
#        there, so it is removed before each retry.
# env:   APPLE_TIMESTAMP_RETRY_SLEEP (seconds before the first retry, doubled after; default 20)

set -euo pipefail

remove=''
if [ "${1:-}" = --remove ]; then
  remove="${2:?--remove needs a path}"
  shift 2
fi
[ "$#" -gt 0 ] || { echo "usage: apple-timestamp-retry.sh [--remove <path>] <command...>" >&2; exit 2; }

tries=4
delay="${APPLE_TIMESTAMP_RETRY_SLEEP:-20}"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

attempt=1
while :; do
  if [ -n "$remove" ] && [ "$attempt" -gt 1 ]; then rm -f -- "$remove"; fi
  rc=0
  "$@" >"$log" 2>&1 || rc=$?
  cat "$log"
  [ "$rc" -eq 0 ] && exit 0
  grep -qi 'timestamp service is not available' "$log" || exit "$rc"
  if [ "$attempt" -ge "$tries" ]; then
    echo "::error::Apple's timestamp service did not answer '$1' ${tries} times; giving up."
    exit "$rc"
  fi
  echo "::warning::Apple's timestamp service did not answer '$1' (try ${attempt} of ${tries}); retrying in ${delay}s."
  sleep "$delay"
  delay=$((delay * 2))
  attempt=$((attempt + 1))
done
