#!/usr/bin/env bash
# GitHub-hosted macos-15 carries several Xcodes and moves its default between image
# releases, so the Mac release jobs select one on purpose. Bump it only after a
# release dry run on the new version (RELEASING.md, CI runners).
set -euo pipefail

XCODE_VERSION='16.4'
developer_dir="/Applications/Xcode_${XCODE_VERSION}.app/Contents/Developer"

if ! sudo xcode-select --switch "$developer_dir"; then
  echo "::error::Xcode ${XCODE_VERSION} is not on this runner image (${developer_dir}); pick an installed one in .github/actions/hosted-macos-xcode/pin-xcode.sh after a dry run" >&2
  exit 1
fi
selected="$(xcodebuild -version)"
if [ "$(printf '%s\n' "$selected" | head -1)" != "Xcode ${XCODE_VERSION}" ]; then
  echo "::error::xcode-select did not select Xcode ${XCODE_VERSION}" >&2
  exit 1
fi
for tool in notarytool stapler; do
  if ! xcrun --find "$tool" >/dev/null; then
    echo "::error::xcrun cannot find ${tool} in Xcode ${XCODE_VERSION}" >&2
    exit 1
  fi
done
echo "::notice::Mac job uses Xcode ${XCODE_VERSION} ($(printf '%s\n' "$selected" | tail -1)) on macOS $(sw_vers -productVersion)"
