#!/usr/bin/env bash

# Staple and validate an already-notarized file, retrying each until a deadline. Notarization has
# accepted the file by now; stapling fetches its ticket from Apple's CloudKit service, and
# validating checks it there again. On the GitHub-hosted macos-15 runners both calls drop
# (NSURLError -1005, stapler Error 68): staple on about a quarter of runs (17 of 63 sign-macos
# jobs, 10-24 to 10-28), and validate on every failed Mac release after staple got its retry
# (0.11.503 to 0.11.505, 10-28 and 10-29). Each drop shipped a desktop release with no macOS
# package. A failed staple leaves the file unchanged and validate writes nothing, so retrying is safe.
#
# usage: staple-notarized.sh <file>                  staple, then validate
#        staple-notarized.sh --validate-only <file>  validate a file stapled earlier
# env: STAPLE_RETRY_SECONDS (300, per step), STAPLE_RETRY_SLEEP (20)

set -euo pipefail

validate_only=false
if [ "${1:-}" = --validate-only ]; then
  validate_only=true
  shift
fi
file="$1"

# retry <verb>: run `xcrun stapler <verb> <file>` until it succeeds or its own deadline passes.
retry() {
  local verb="$1" attempt=1
  local deadline=$(( $(date +%s) + ${STAPLE_RETRY_SECONDS:-300} ))
  until xcrun stapler "$verb" "$file"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "::error::${verb/%e/ing} ${file} still failing after ${attempt} attempts and ${STAPLE_RETRY_SECONDS:-300}s" >&2
      exit 1
    fi
    echo "${verb/%e/ing} ${file} failed; retrying (attempt ${attempt})" >&2
    attempt=$((attempt + 1))
    sleep "${STAPLE_RETRY_SLEEP:-20}"
  done
}

[ "$validate_only" = true ] || retry staple
retry validate
