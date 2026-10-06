#!/usr/bin/env bash

# Run an npm command until it succeeds or the registry-propagation budget is spent. A
# just-published version reaches npm's read CDN minutes late (v1.10.401: about 7), so one
# `npm view` or `npm pack` right after a publish can 404. Ten minutes is ~1.4x that worst case.
# The budget is a wall-clock deadline, not an attempt count: a hanging registry read costs time
# a count cannot see. Output of the successful attempt is the command's output.
#
# usage: retry-npm.sh <npm command...>      env: NPM_RETRY_SECONDS (600), NPM_RETRY_SLEEP (10)

set -euo pipefail

deadline=$(( $(date +%s) + ${NPM_RETRY_SECONDS:-600} ))
attempt=0
until "$@"; do
  attempt=$((attempt + 1))
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::'$*' still failing after ${attempt} attempts and ${NPM_RETRY_SECONDS:-600}s" >&2
    exit 1
  fi
  echo "npm does not serve that yet; retrying (attempt ${attempt})" >&2
  sleep "${NPM_RETRY_SLEEP:-10}"
done
