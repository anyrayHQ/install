#!/bin/bash
# Signed payload smoke. Runs only after signing secrets have been destroyed.
set -euo pipefail
: "${VERSION:?}" "${SMOKE_RUN_ID:?}" "${SMOKE_RUN_ATTEMPT:?}"
[[ "$SMOKE_RUN_ID" =~ ^[0-9]+$ && "$SMOKE_RUN_ATTEMPT" =~ ^[0-9]+$ ]]
smoke_user="anyray-${SMOKE_RUN_ID}-${SMOKE_RUN_ATTEMPT}"
smoke_home="/Users/$smoke_user"
smoke_user_created=false
mountpoint="$(mktemp -d /tmp/anyray-dmg.XXXXXX)"
chmod 755 "$mountpoint"
mounted=false
# The Mac host is reused for 24h and sysadminctl can fail silently, so removal is verified.
remove_smoke_user() {
  /usr/bin/id -u "$smoke_user" >/dev/null 2>&1 || return 0
  sudo /usr/sbin/sysadminctl -deleteUser "$smoke_user" -keepHome 2>&1 | sed 's/^/sysadminctl: /' || true
  if /usr/bin/id -u "$smoke_user" >/dev/null 2>&1; then
    sudo /usr/bin/dscl . -delete "/Users/$smoke_user" 2>&1 | sed 's/^/dscl: /' || true
  fi
  sudo /bin/rm -rf "$smoke_home"
  if /usr/bin/id -u "$smoke_user" >/dev/null 2>&1; then
    echo "::error::could not remove the $smoke_user account"
    return 1
  fi
}
cleanup() {
  if [ "$mounted" = true ]; then hdiutil detach "$mountpoint" >/dev/null || true; fi
  rmdir "$mountpoint" 2>/dev/null || true
  if [ "$smoke_user_created" = true ]; then
    remove_smoke_user || true
  fi
}
trap cleanup EXIT
if /usr/bin/id -u "$smoke_user" >/dev/null 2>&1; then
  echo '::error::this run-specific smoke account already exists; refusing to reuse or delete it'
  exit 1
fi
sudo /usr/sbin/sysadminctl -addUser "$smoke_user" -password "$(/usr/bin/uuidgen)" \
  -home "$smoke_home" -shell /bin/sh >/dev/null 2>&1
smoke_user_created=true
smoke_uid="$(/usr/bin/id -u "$smoke_user")"
test "$smoke_uid" -ne 0
as_user() { sudo -H -u "$smoke_user" "$@"; }

dmg="signed/anyray-connect-desktop-${VERSION}-macos-universal.dmg"
tarball="signed/anyray-connect-desktop-${VERSION}-macos-universal.app.tar.gz"
test "$(find signed -maxdepth 1 -name '*.dmg' | wc -l | tr -d ' ')" -eq 1
test "$(find signed -maxdepth 1 -name '*-managed.pkg' | wc -l | tr -d ' ')" -eq 1
test -s "$tarball"
xcrun stapler validate "$dmg"
spctl -a -vvv -t open --context context:primary-signature "$dmg"
hdiutil attach -nobrowse -readonly -owners off -mountpoint "$mountpoint" "$dmg" >/dev/null
mounted=true
test -L "$mountpoint/Applications"
test "$(readlink "$mountpoint/Applications")" = /Applications
source_app="$mountpoint/Anyray Connect.app"
codesign --verify --deep --strict "$source_app"
test "$(plutil -extract CFBundleShortVersionString raw -o - "$source_app/Contents/Info.plist")" = "$VERSION"
test "$(plutil -extract LSMinimumSystemVersion raw -o - "$source_app/Contents/Info.plist")" = '13.0'

# A copy operation as the employee owns all files, including the bundled engine.
as_user mkdir -p "$smoke_home/Applications"
app="$smoke_home/Applications/Anyray Connect.app"
as_user /usr/bin/ditto "$source_app" "$app"
test -z "$(sudo find "$app" ! -user "$smoke_user" -print -quit)"
engine="$app/Contents/MacOS/anyray-connect"
main="$app/Contents/MacOS/connect-tray"
test -x "$main"
test "$(as_user "$engine" --version --local | head -1)" = "anyray-connect $VERSION"
for wrapper in credential bootstrap-headers; do
  as_user "$engine" desktop helper --print --platform posix --wrapper "$wrapper" \
    --bin /usr/local/bin/anyray-connect >/dev/null
done
sudo test ! -e "$smoke_home/.anyray"

# Unlike a root-owned fixture, this bundle is removable by the test user. Only
# the app's trust gate can prevent Trash from moving a group-writable bundle.
as_user chmod 775 "$app"
codesign --verify --deep --strict "$app"
set +e
as_user "$main" uninstall-residue --json > "$RUNNER_TEMP/desktop-writable-removal.json"
result=$?
set -e
test "$result" -eq 4
test -d "$app"
jq -e '.status == "needs_admin"' "$RUNNER_TEMP/desktop-writable-removal.json" >/dev/null
as_user chmod 755 "$app"

# A legacy root-owned bundle must be rejected without being moved or elevated.
sudo chown root:wheel "$app"
set +e
as_user "$main" uninstall-residue --json > "$RUNNER_TEMP/desktop-root-removal.json"
result=$?
set -e
test "$result" -eq 4
test -d "$app"
jq -e '.status == "needs_admin"' "$RUNNER_TEMP/desktop-root-removal.json" >/dev/null
# A root-owned MDM bundle is allowed to start, but never to self-update/remove.
as_user "$main" installation-check --json > "$RUNNER_TEMP/desktop-managed-start.json"
jq -e '.status == "ready" and .userOwned == false' "$RUNNER_TEMP/desktop-managed-start.json" >/dev/null
sudo chown "$smoke_user":staff "$app"

# Check the updater distribution too; installation uses the same signed bundle.
updater_root="$smoke_home/updater"
as_user mkdir "$updater_root"
sudo cp "$tarball" "$smoke_home/updater.tar.gz"
sudo chmod 644 "$smoke_home/updater.tar.gz"
as_user tar -xzf "$smoke_home/updater.tar.gz" -C "$updater_root"
updater_app="$(sudo find "$updater_root" -maxdepth 1 -name '*.app' -print -quit)"
codesign --verify --deep --strict "$updater_app"
test "$(plutil -extract CFBundleShortVersionString raw -o - "$updater_app/Contents/Info.plist")" = "$VERSION"
test "$(plutil -extract LSMinimumSystemVersion raw -o - "$updater_app/Contents/Info.plist")" = '13.0'
cmp "$engine" "$updater_app/Contents/MacOS/anyray-connect"
cmp "$main" "$updater_app/Contents/MacOS/connect-tray"

# Managed PKG carries the same sealed app and static helpers, without executable
# Installer scripts or a privileged uninstaller. Expand it without changing host paths.
pkg="signed/anyray-connect-desktop-${VERSION}-macos-universal-managed.pkg"
pkgutil --check-signature "$pkg"
xcrun stapler validate "$pkg"
spctl -a -vvv -t install "$pkg"
managed_expanded="$RUNNER_TEMP/managed-expanded-${SMOKE_RUN_ID}-${SMOKE_RUN_ATTEMPT}"
pkgutil --expand-full "$pkg" "$managed_expanded"
test -z "$(find "$managed_expanded" -type f \( -name preinstall -o -name postinstall -o -name uninstall.sh \) -print -quit)"
managed_payload="$(find "$managed_expanded" -type d -name Payload -print -quit)"
test -n "$managed_payload"
for wrapper in credential bootstrap-headers; do
  as_user "$engine" desktop helper --print --platform posix --wrapper "$wrapper" \
    --bin '/Applications/Anyray Connect.app/Contents/MacOS/anyray-connect' > "$RUNNER_TEMP/expected-$wrapper"
  cmp "$RUNNER_TEMP/expected-$wrapper" "$managed_payload/usr/local/bin/anyray-$wrapper-helper"
done
codesign --verify --deep --strict "$managed_payload/Applications/Anyray Connect.app"

# Exercise the engine's real offboard -> unregister -> state removal -> Trash.
# Native browser/login registration still requires interactive acceptance.
as_user "$engine" uninstall --json --tray-path "$main" > "$RUNNER_TEMP/desktop-uninstall.json"
jq -e '.uninstall.user == "complete" and .uninstall.residue == "removed" and .uninstall.loginItem == "unregistered"' \
  "$RUNNER_TEMP/desktop-uninstall.json" >/dev/null
test ! -e "$app"
sudo test ! -e "$smoke_home/.anyray"
test -d "$updater_app"
echo 'Signed DMG ownership, helper rendering, legacy refusal and actual uninstall passed.'
