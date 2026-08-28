#!/bin/sh
# Anyray zero-install developer connect (macOS / Linux).
#
#   curl -fsSL https://app.anyray.ai/connect.sh | sh -s -- <setup-link-or-gateway-url> [flags]
#   curl -fsSL https://app.anyray.ai/connect.sh | sh -s -- --managed
#
# Downloads the standalone `anyray-connect` binary (no Node, nothing to install)
# for your OS/arch from the public install repo's latest release, verifies its
# checksum, and runs it — pointing your local AI coding tools (Claude Code,
# Codex, …) at the Anyray gateway. All flags after the URL pass straight through
# to anyray-connect (e.g. --subscription, --user, --dry-run).
set -eu

REPO="anyrayHQ/install"
MANAGED_INSTALL=0
if [ "${1:-}" = "--managed" ]; then
  MANAGED_INSTALL=1
  shift
fi

err() { echo "anyray-connect: $*" >&2; exit 1; }

# Which release to install from. Unset — the only thing a customer ever hits —
# is `latest`, byte-for-byte the behaviour this script has always had.
#
# $ANYRAY_CONNECT_TAG pins a specific release instead, which is what makes a
# staging build reachable through the SAME command a developer really runs:
#
#   export ANYRAY_CONNECT_TAG=connect-staging-v0.11.135
#   curl -fsSL https://<control-plane>/i/<tenant> | sh
#
# Staging releases are deliberately published with --latest=false, so `latest`
# can never resolve to one; without this there is no way to exercise the
# curl|sh path against a pre-release build at all.
#
# THIS SELECTS A RELEASE, IT NEVER RELAXES VERIFICATION. `REPO` stays hardcoded
# — the override cannot redirect the download to another host — and the
# checksum block below is untouched, still fetching SHA256SUMS from whichever
# release was selected and still failing closed. An operator who can set this
# variable can already run any command in the shell they are typing into, so it
# grants no capability they lack; what it must never become is a way to skip the
# hash check, because the installed binary registers a Claude Code PostToolUse
# hook that runs on every subsequent tool call.
#
# The value is validated rather than interpolated as given: it lands in a URL
# path, so `../../` in an unchecked tag would walk out of /releases/download and
# fetch an attacker-chosen object from the same host.
#
# PARSE THE SHAPE; DO NOT PATTERN-MATCH IT. A glob cannot count, so every
# approximation leaks. `connect-v[0-9]*.[0-9]*.[0-9]*` accepts
# `connect-v1.2.3/../../evil`, because `*` matches `/` and the trailing one
# swallows the traversal. Tightening that to `connect-v[0-9]*` plus a character
# filter closes the traversal but still accepts `connect-v1`, `connect-v1foo`
# and `connect-v1.2.3.4` — the leading `[0-9]` only constrains the FIRST
# character. So strip the one legal prefix, require exactly two dots, and
# require every component to be non-empty digits.
_tag_bad() {
  err "invalid ANYRAY_CONNECT_TAG '${ANYRAY_CONNECT_TAG}' — expected connect-v<x.y.z> or connect-staging-v<x.y.z>"
}
_digits_only() { case "${1:-}" in ''|*[!0-9]*) return 1 ;; esac; }
if [ -n "${ANYRAY_CONNECT_TAG:-}" ]; then
  case "$ANYRAY_CONNECT_TAG" in
    connect-staging-v*) _ver="${ANYRAY_CONNECT_TAG#connect-staging-v}" ;;
    connect-v*)         _ver="${ANYRAY_CONNECT_TAG#connect-v}" ;;
    *) _tag_bad ;;
  esac
  # Exactly two dots: `*.*.*` needs at least two, excluding `*.*.*.*` caps it.
  case "$_ver" in
    *.*.*.*) _tag_bad ;;
    *.*.*) ;;
    *) _tag_bad ;;
  esac
  _major="${_ver%%.*}"; _tail="${_ver#*.}"
  _minor="${_tail%%.*}"; _patch="${_tail#*.}"
  for _part in "$_major" "$_minor" "$_patch"; do
    _digits_only "$_part" || _tag_bad
  done
  # Belt and braces. All-digit components make `..`, `/` and shell
  # metacharacters structurally impossible above, so this is redundant TODAY —
  # kept because it is two lines, this string is pasted into a URL that a
  # `curl | sh` then executes from, and the check must survive a future edit
  # that loosens the parse without thinking about traversal.
  case "$ANYRAY_CONNECT_TAG" in *..*|*/*) _tag_bad ;; esac
  BASE="https://github.com/${REPO}/releases/download/${ANYRAY_CONNECT_TAG}"
  echo "anyray-connect: pinned to release ${ANYRAY_CONNECT_TAG} (not latest)" >&2
else
  BASE="https://github.com/${REPO}/releases/latest/download"
fi

command -v curl >/dev/null 2>&1 || err "curl is required"

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) OS=darwin ;;
  Linux)  OS=linux ;;
  *) err "unsupported OS '$os' — use the npm fallback: npx anyray-connect <url>" ;;
esac

if [ "$MANAGED_INSTALL" -eq 1 ]; then
  [ "$OS" = "linux" ] || err "--managed is supported on Linux; deploy anyray-connect.pkg on macOS"
  [ "$(id -u)" -ne 0 ] || err "--managed must run in a signed-in user context"
fi

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

# Verify the checksum from the same release. Every step here fails CLOSED, with
# no bypass flag or env var: the binary below installs a Claude Code PostToolUse
# hook that then runs on every tool call, so an unverified download is a
# persistent code-execution foothold, not a one-off. Skipping verification when
# something is merely *missing* hands that foothold to anyone who can make one
# request fail — dropping just the SHA256SUMS fetch used to disable the check
# entirely. A missing sums file, a missing entry, or a missing hash tool are all
# hard errors; npm (npx) is the fallback, and it verifies via the registry.
curl -fsSL --proto '=https' "${BASE}/SHA256SUMS" -o "${tmp}/SHA256SUMS" \
  || err "could not fetch the checksums (${BASE}/SHA256SUMS) — refusing to run an unverified ${ASSET}; retry, or use: npx anyray-connect <url>"

want="$(awk -v a="$ASSET" '$2==a || $2=="*"a {print $1}' "${tmp}/SHA256SUMS" | head -n1)"
[ -n "$want" ] || err "no SHA256SUMS entry for ${ASSET} — refusing to run an unverified binary; use: npx anyray-connect <url>"

if command -v sha256sum >/dev/null 2>&1; then
  got="$(sha256sum "$dl" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  got="$(shasum -a 256 "$dl" | awk '{print $1}')"
else
  err "no SHA-256 tool found (install coreutils for sha256sum, or perl for shasum) — cannot verify ${ASSET}; use: npx anyray-connect <url>"
fi
[ -n "$got" ] || err "could not compute the SHA-256 of ${ASSET} — refusing to run an unverified binary; use: npx anyray-connect <url>"
[ "$got" = "$want" ] || err "checksum mismatch for ${ASSET} — refusing to run"

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

if [ "$MANAGED_INSTALL" -eq 1 ] && [ "$OS" = "linux" ]; then
  unit_dir="${HOME}/.config/systemd/user"
  unit_name="anyray-connect-managed-enroll.service"
  autostart_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/autostart"
  autostart_file="${autostart_dir}/anyray-connect-managed-enroll.desktop"
  mkdir -p "$unit_dir" "$autostart_dir"
  escaped_bin="$(printf '%s' "$bin" | sed 's/\\/\\\\/g; s/"/\\"/g; s/%/%%/g')"
  {
    printf '%s\n' '[Unit]' 'Description=Anyray managed enrollment'
    printf '%s\n' '[Service]' 'Type=oneshot' "ExecStart=\"${escaped_bin}\" __anyray-managed-enroll"
    printf '%s\n' 'TimeoutStartSec=10min'
  } > "${unit_dir}/${unit_name}"
  {
    printf '%s\n' '[Desktop Entry]' 'Type=Application' 'Name=Anyray Managed Enrollment'
    printf '%s\n' "Exec=/usr/bin/systemctl --user start --no-block ${unit_name}"
    printf '%s\n' 'Terminal=false' 'NoDisplay=true'
  } > "$autostart_file"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
fi

if [ "$MANAGED_INSTALL" -eq 1 ]; then
  "$bin" __anyray-managed-enroll >/dev/null 2>&1 || exit $?
  [ "$#" -eq 0 ] && exit 0
fi

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
