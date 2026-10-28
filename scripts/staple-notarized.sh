#!/usr/bin/env bash

# Staple and validate an already-notarized file, retrying until a deadline. Notarization has
# accepted the file by now; stapling only fetches its ticket from Apple's CloudKit service. On the
# GitHub-hosted macos-15 runners that fetch drops (NSURLError -1005, stapler Error 68) on about a
# quarter of runs (17 of 63 sign-macos jobs, 10-24 to 10-28), and each drop shipped a desktop
# release with no macOS package. A failed staple leaves the file unchanged, so retrying is safe.
#
# usage: staple-notarized.sh <file>      env: STAPLE_RETRY_SECONDS (300), STAPLE_RETRY_SLEEP (20)

set -euo pipefail

file="$1"
deadline=$(( $(date +%s) + ${STAPLE_RETRY_SECONDS:-300} ))
attempt=1
until xcrun stapler staple "$file"; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::stapling ${file} still failing after ${attempt} attempts and ${STAPLE_RETRY_SECONDS:-300}s" >&2
    exit 1
  fi
  echo "stapling ${file} failed; retrying (attempt ${attempt})" >&2
  attempt=$((attempt + 1))
  sleep "${STAPLE_RETRY_SLEEP:-20}"
done
xcrun stapler validate "$file"
