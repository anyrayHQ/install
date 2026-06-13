#!/bin/sh
# Anyray zero-install developer connect (macOS / Linux).
#
#   curl -fsSL https://app.anyray.ai/connect.sh | sh -s -- <setup-link-or-gateway-url> [flags]
#
# Downloads the standalone `anyray-connect` binary (no Node, nothing to install)
# for your OS/arch from the public install repo's latest release, verifies its
# checksum, and runs it — pointing your local AI coding tools (Claude Code,
# Codex, …) at the Anyray gateway. All flags after the URL pass straight through
# to anyray-connect (e.g. --subscription, --user, --dry-run).
set -eu

REPO="anyrayHQ/install"
BASE="https://github.com/${REPO}/releases/latest/download"

err() { echo "anyray-connect: $*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || err "curl is required"

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) OS=darwin ;;
  Linux)  OS=linux ;;
  *) err "unsupported OS '$os' — use the npm fallback: npx anyray-connect <url>" ;;
esac
case "$arch" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=x64 ;;
  *) err "unsupported architecture '$arch' — use the npm fallback: npx anyray-connect <url>" ;;
esac

ASSET="anyray-connect-${OS}-${ARCH}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/anyray-connect.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
bin="${tmp}/anyray-connect"

echo "anyray-connect: downloading ${ASSET}…" >&2
curl -fSL --proto '=https' "${BASE}/${ASSET}" -o "$bin" \
  || err "download failed (${BASE}/${ASSET}) — check your connection or use: npx anyray-connect <url>"

# Verify the checksum from the same release (best-effort: skip only if absent).
if curl -fsSL --proto '=https' "${BASE}/SHA256SUMS" -o "${tmp}/SHA256SUMS" 2>/dev/null; then
  want="$(awk -v a="$ASSET" '$2==a || $2=="*"a {print $1}' "${tmp}/SHA256SUMS" | head -n1)"
  if [ -n "$want" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      got="$(sha256sum "$bin" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
      got="$(shasum -a 256 "$bin" | awk '{print $1}')"
    else
      got=""
    fi
    [ -z "$got" ] || [ "$got" = "$want" ] || err "checksum mismatch for ${ASSET} — refusing to run"
  fi
fi

chmod +x "$bin"

# Reconnect stdin to the terminal: this script arrived over a pipe (curl | sh),
# so without this the binary's confirm prompt would see EOF. Falls back to
# passing nothing special when there's no controlling TTY (CI) — in that case
# pass --yes in your flags.
if [ -e /dev/tty ]; then
  exec "$bin" "$@" </dev/tty
else
  exec "$bin" "$@"
fi
