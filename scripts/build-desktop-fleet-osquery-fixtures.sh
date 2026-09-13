#!/usr/bin/env bash
# Synthetic fleet-osquery replacement fixtures, built with the same pinned
# nfpm as build-desktop-cli-migration-fixtures.sh from one YAML, so the deb
# and rpm variants can never drift from each other.
# Only for disposable installer CI; these fixtures are never release artifacts.
set -euo pipefail
fixture_root="$1"
mkdir -p "$fixture_root/pkgs"

source ci/nfpm-tool.env
curl -fsSL --proto '=https' -o "$fixture_root/nfpm.tgz" \
  "https://github.com/goreleaser/nfpm/releases/download/v${NFPM_TOOL_VERSION}/nfpm_${NFPM_TOOL_VERSION}_Linux_x86_64.tar.gz"
echo "${NFPM_LINUX_X64_SHA256}  ${fixture_root}/nfpm.tgz" | sha256sum -c -
tar -xzf "$fixture_root/nfpm.tgz" -C "$fixture_root" nfpm

orbit_bin="$fixture_root/orbit"
cat > "$orbit_bin" <<'EOF'
#!/bin/sh
exec /bin/sleep infinity
EOF
chmod 0755 "$orbit_bin"

orbit_service="$fixture_root/orbit.service"
cat > "$orbit_service" <<'EOF'
[Unit]
Description=Synthetic Orbit service for Anyray desktop installer CI

[Service]
ExecStart=/bin/sleep infinity

[Install]
WantedBy=multi-user.target
EOF

postinstall="$fixture_root/postinstall"
cat > "$postinstall" <<'EOF'
#!/bin/sh
set -eu
mkdir -p /opt/orbit/osquery_log
printf '%s\n' 'fleet-osquery-runtime-sentinel' > /opt/orbit/osquery_log/x.log
EOF
chmod 0755 "$postinstall"

# No prerm/%preun: the desktop package's own postinst stops/disables orbit.service, and the smoke asserts that.
cat > "$fixture_root/nfpm.yaml" <<EOF
name: fleet-osquery
arch: \${NFPM_ARCH}
platform: linux
version: \${NFPM_VERSION}
section: admin
priority: optional
maintainer: Anyray CI <support@anyray.ai>
homepage: https://docs.anyray.ai
license: MIT
description: Synthetic fleet-osquery replacement fixture for desktop installer CI
contents:
  - src: $orbit_bin
    dst: /opt/orbit/bin/orbit
    file_info:
      mode: 0755
  - src: $orbit_service
    dst: /usr/lib/systemd/system/orbit.service
    file_info:
      mode: 0644
scripts:
  postinstall: $postinstall
EOF

# A version every real candidate upgrades over.
export NFPM_VERSION=0.0.1 NFPM_ARCH=amd64
"$fixture_root/nfpm" package -f "$fixture_root/nfpm.yaml" -p deb -t "$fixture_root/pkgs/"
"$fixture_root/nfpm" package -f "$fixture_root/nfpm.yaml" -p rpm -t "$fixture_root/pkgs/"
