#!/bin/bash
# The persistent Mac host runs no CI code as root. Stable needs Dean's recorded
# acceptance of the missing root install smoke before macOS can count as verified.
set -euo pipefail
export LC_ALL=C

case "${CHANNEL:-}" in
  staging)
    printf '%s\n' '::warning::root install, sweep and uninstall smoke skipped on the persistent Mac host (staging)'
    ;;
  stable)
    acceptance_pattern='^(ANY-[0-9]+|https://github\.com/anyrayHQ/[A-Za-z0-9._-]+/(issues|pull)/[0-9]+#issuecomment-[0-9]+)$'
    if [[ "${ROOT_SMOKE_ACCEPTED:-}" =~ $acceptance_pattern ]]; then
      printf '::warning::stable macOS ships without the root install smoke under the recorded acceptance %s\n' "$ROOT_SMOKE_ACCEPTED"
    else
      printf '%s\n' "::error::the stable lane needs the root install smoke, which does not run on the persistent Mac host; set INSTALL_MAC_ROOT_SMOKE_ACCEPTED to Dean's written acceptance (RELEASING.md) or run stable on GitHub-hosted macOS (unset INSTALL_MAC_RUNNER)" >&2
      exit 1
    fi
    ;;
  *) printf '%s\n' '::error::root smoke channel check failed' >&2; exit 1 ;;
esac
