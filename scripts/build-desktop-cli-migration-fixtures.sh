#!/usr/bin/env bash
# Synthetic packages with the released CLI package's exact ownership footprint.
# Only for disposable installer CI; these fixtures are never release artifacts.
set -euo pipefail
fixture_root="$1"
fixture_engine="$2"
test -x "$fixture_engine"
mkdir -p "$fixture_root/deb/DEBIAN" "$fixture_root/deb/usr/bin" \
  "$fixture_root/deb/usr/lib/systemd/user" "$fixture_root/deb/etc/xdg/autostart"
cat > "$fixture_root/deb/DEBIAN/control" <<'CONTROL'
Package: anyray-connect
Version: 0.0.1
Architecture: amd64
Maintainer: Synthetic Fixture <dev@example.com>
Description: Synthetic CLI package for desktop migration testing
CONTROL
install -m 0755 "$fixture_engine" "$fixture_root/deb/usr/bin/anyray-connect"
install -m 0644 ci/anyray-connect-managed-enroll.service "$fixture_root/deb/usr/lib/systemd/user/"
install -m 0644 ci/anyray-connect-managed-enroll.desktop "$fixture_root/deb/etc/xdg/autostart/"
dpkg-deb --root-owner-group --build "$fixture_root/deb" "$fixture_root/cli.deb"

mkdir -p "$fixture_root/rpm/"{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS}
cp -R "$fixture_root/deb/usr" "$fixture_root/deb/etc" "$fixture_root/rpm/SOURCES/"
cat > "$fixture_root/rpm/SPECS/cli.spec" <<'SPEC'
Name: anyray-connect
Version: 0.0.1
Release: 1
Summary: Synthetic CLI package for desktop migration testing
License: MIT
BuildArch: x86_64
AutoReqProv: no
%description
Synthetic fixture; never publish.
%install
mkdir -p %{buildroot}
cp -a %{_sourcedir}/usr %{_sourcedir}/etc %{buildroot}/
%files
/usr/bin/anyray-connect
/usr/lib/systemd/user/anyray-connect-managed-enroll.service
/etc/xdg/autostart/anyray-connect-managed-enroll.desktop
SPEC
# Preserve the already-built engine bytes; do not strip a Bun executable.
rpmbuild --define "_topdir $fixture_root/rpm" --define '__os_install_post %{nil}' \
  -bb "$fixture_root/rpm/SPECS/cli.spec"
