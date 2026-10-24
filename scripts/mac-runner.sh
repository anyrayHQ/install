#!/usr/bin/env bash
# Mac jobs run on GitHub-hosted macos-15 by default: this repository is public, so
# they cost nothing, while each CodeBuild Mac fleet allocation bills a 24-hour
# minimum (Dean, 2026-10-24). `codebuild` keeps the fleet as the fallback and `ec2`
# the persistent host. Choose once per workflow run so a variable changed mid-run
# cannot split jobs between hosts or strand a fleet. RELEASING.md, CI runners.
set -euo pipefail

if [ "$#" -ne 1 ] || [ "${1:-}" != select ]; then
  echo 'Usage: mac-runner.sh select' >&2
  exit 2
fi

if [ -z "${GITHUB_OUTPUT:-}" ]; then
  echo '::error::GITHUB_OUTPUT must be set and nonempty' >&2
  exit 1
fi

case "${INSTALL_MAC_RUNNER:-}" in
  ''|github)
    echo 'mac_runner=github' >> "$GITHUB_OUTPUT"
    echo '::notice::Mac jobs use GitHub-hosted macos-15 runners'
    ;;
  codebuild)
    echo 'mac_runner=codebuild' >> "$GITHUB_OUTPUT"
    echo '::notice::Mac jobs use the CodeBuild Mac fleet'
    ;;
  ec2)
    if [ "${GITHUB_REPOSITORY:-}" != anyrayHQ/install ]; then
      echo '::error::GITHUB_REPOSITORY check failed for the persistent Mac runner' >&2
      exit 1
    fi
    if [ "${GITHUB_EVENT_NAME:-}" != workflow_dispatch ]; then
      echo '::error::GITHUB_EVENT_NAME check failed for the persistent Mac runner' >&2
      exit 1
    fi
    if [ "${GITHUB_REF:-}" != refs/heads/main ]; then
      echo '::error::GITHUB_REF check failed for the persistent Mac runner' >&2
      exit 1
    fi
    echo 'mac_runner=ec2' >> "$GITHUB_OUTPUT"
    echo '::notice::Mac jobs use anyray-install-mac (the persistent EC2 signing host)'
    ;;
  *)
    echo '::error::INSTALL_MAC_RUNNER must be unset, github, codebuild or ec2' >&2
    exit 1
    ;;
esac
