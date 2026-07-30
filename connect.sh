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
dl="${tmp}/anyray-connect"

echo "anyray-connect: downloading ${ASSET}…" >&2
curl -fSL --proto '=https' "${BASE}/${ASSET}" -o "$dl" \
  || err "download failed (${BASE}/${ASSET}) — check your connection or use: npx anyray-connect <url>"

# Verify the checksum from the same release (best-effort: skip only if absent).
if curl -fsSL --proto '=https' "${BASE}/SHA256SUMS" -o "${tmp}/SHA256SUMS" 2>/dev/null; then
  want="$(awk -v a="$ASSET" '$2==a || $2=="*"a {print $1}' "${tmp}/SHA256SUMS" | head -n1)"
  if [ -n "$want" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      got="$(sha256sum "$dl" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
      got="$(shasum -a 256 "$dl" | awk '{print $1}')"
    else
      got=""
    fi
    [ -z "$got" ] || [ "$got" = "$want" ] || err "checksum mismatch for ${ASSET} — refusing to run"
  fi
fi

# Install to a PERSISTENT location, then run from there. anyray-connect installs
# a Claude Code PostToolUse hook that references this binary by absolute path on
# every tool call — so it must survive after the OS reaps /tmp. Running straight
# from the mktemp dir would leave that hook pointing at a deleted file. The
# verified download sits in $tmp; move it into place.
INSTALL_DIR="${ANYRAY_HOME:-$HOME/.anyray}/bin"
bin="${INSTALL_DIR}/anyray-connect"
mkdir -p "$INSTALL_DIR" || err "could not create ${INSTALL_DIR}"
mv -f "$dl" "$bin" || err "could not install anyray-connect to ${bin}"
chmod +x "$bin"

# Reconnect stdin: this script arrived over a pipe (curl | sh), so the prompts
# would otherwise see EOF. Not `< /dev/tty` — the compiled binary's readline
# never receives input on the clone device, and the prompt then eats every
# keystroke, Ctrl+C included. Not a bare dup either: a terminal can be open
# write-only (`… > log 2>/dev/tty`), which /dev/fd rejects and a dup doesn't.
# Probing a copy keeps the probe's own `2>/dev/null` off the fd it tests.
tty_fd=
if [ -t 1 ]; then
  exec 8>&1
  if (exec 0</dev/fd/8) 2>/dev/null; then tty_fd=8; fi
fi
if [ -z "$tty_fd" ] && [ -t 2 ]; then
  exec 9>&2
  if (exec 0</dev/fd/9) 2>/dev/null; then tty_fd=9; fi
fi

if [ -n "$tty_fd" ]; then
  exec "$bin" "$@" 0</dev/fd/"$tty_fd"
else
  exec "$bin" "$@" --yes
fi
