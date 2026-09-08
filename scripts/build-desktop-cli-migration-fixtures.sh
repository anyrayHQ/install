#!/usr/bin/env bash
# Synthetic legacy CLI packages built from the released package spec (ci/nfpm.yaml)
# with the pinned nfpm, so the migration fixture cannot drift from a real install.
# Only for disposable installer CI; these fixtures are never release artifacts.
set -euo pipefail
fixture_root="$1"
fixture_engine="$2"
test -x "$fixture_engine"
mkdir -p "$fixture_root/pkgs"

source ci/nfpm-tool.env
curl -fsSL --proto '=https' -o "$fixture_root/nfpm.tgz" \
  "https://github.com/goreleaser/nfpm/releases/download/v${NFPM_TOOL_VERSION}/nfpm_${NFPM_TOOL_VERSION}_Linux_x86_64.tar.gz"
echo "${NFPM_LINUX_X64_SHA256}  ${fixture_root}/nfpm.tgz" | sha256sum -c -
tar -xzf "$fixture_root/nfpm.tgz" -C "$fixture_root" nfpm

# A version every real candidate upgrades over; nfpm reads ci/ relative to the repo root.
export NFPM_VERSION=0.0.1 NFPM_ARCH=amd64 NFPM_BIN="$fixture_engine"
"$fixture_root/nfpm" package -f ci/nfpm.yaml -p deb -t "$fixture_root/pkgs/"
"$fixture_root/nfpm" package -f ci/nfpm.yaml -p rpm -t "$fixture_root/pkgs/"
