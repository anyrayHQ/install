#!/usr/bin/env bash
# Functional guard for the resumable download in connect.sh / connect.ps1.
#
# The shipped installers fetch a ~100 MB binary over one connection. When a
# proxy, VPN or flaky link cut that connection mid-transfer, enrollment died
# outright ("The request was aborted: The connection was closed unexpectedly" on
# Windows, curl error 18 on POSIX) and none of what had arrived was reused. A
# parse or lint check cannot see that, so this drives each installer's download
# helper - lifted out of the shipped file, so the test cannot drift from what
# customers run - against a server that deliberately drops transfers.
#
# Three ways the old shape, or an over-eager resume, breaks:
#   1. two mid-transfer drops, Range honored -> resumes, bytes verify
#   2. server IGNORES Range                  -> restarts, never splices copies
#   3. transfer never completes              -> fails, never a partial "success"
# Plus, for PowerShell, a 4th: an already-complete file (range past the end,
# HTTP 416) is accepted rather than retried to exhaustion.
#
# Then the release hosts (ANY-2024): Anyray's mirror (app.anyray.ai) first,
# GitHub only when the mirror does not answer. Driven through the same lifted
# helpers, with the stub standing in for both hosts and logging every request:
#   pointer  read the tag from the mirror's latest.json; an unreachable or
#            missing pointer means GitHub's latest; a malformed one stops
#   order    a known tag is tried on the mirror, then GitHub
#   mirror   both files from the mirror, GitHub never asked
#   down     the mirror refuses the connection: both files from GitHub
#   partial  the mirror serves SHA256SUMS but not the asset: BOTH files come
#            from GitHub, never a mix of hosts
#   tamper   the mirror answers with altered bytes: no fallback, so the
#            unchanged checksum step refuses them
#   none     neither host answers: fails
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
server_pid=""
cleanup() {
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null
  rm -rf "$work"
  return 0
}
trap cleanup EXIT
cd "$work"

# connect.sh passes --proto '=https', so the stub must speak TLS for the sh
# cases; the ps1 helper takes the URI as given, so it uses the plain port.
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 1 \
  -subj '/CN=127.0.0.1' -addext 'subjectAltName=IP:127.0.0.1' 2>/dev/null

http_port=$((20000 + RANDOM % 20000))
https_port=$((http_port + 1))

python3 - "$http_port" "$https_port" <<'PY' &
import hashlib, http.server, os, socketserver, ssl, sys, threading

BODY = os.urandom(3_000_000)
open('expected.sha', 'w').write(hashlib.sha256(BODY).hexdigest())
# Per-listener attempt counters: each scheme runs the same three cases.
state = {}

# Two release hosts on one stub: /m is the mirror, /g is GitHub, /t a mirror
# serving altered bytes, /n a mirror missing the asset, /up and /bad pointers.
RELEASE_ASSET = b'synthetic-connect-binary\n'
RELEASE_SUMS = (hashlib.sha256(RELEASE_ASSET).hexdigest() + '  anyray-connect-test\n').encode()
RELEASE = {
    '/up/latest.json': b'{"schemaVersion":1,"version":"1.2.3","tag":"connect-v1.2.3","sumsSha256":"' + hashlib.sha256(RELEASE_SUMS).hexdigest().encode() + b'"}',
    '/bad/latest.json': b'{"schemaVersion":1,"version":"1.2.3","tag":"connect-v1.2.3/../evil"}',
    '/m/connect-v1.2.3/SHA256SUMS': RELEASE_SUMS,
    '/m/connect-v1.2.3/anyray-connect-test': RELEASE_ASSET,
    '/g/connect-v1.2.3/SHA256SUMS': RELEASE_SUMS,
    '/g/connect-v1.2.3/anyray-connect-test': RELEASE_ASSET,
    '/t/connect-v1.2.3/SHA256SUMS': RELEASE_SUMS,
    '/t/connect-v1.2.3/anyray-connect-test': b'tampered-connect-binary\n',
    '/n/connect-v1.2.3/SHA256SUMS': RELEASE_SUMS,
}
open('release.sha', 'w').write(hashlib.sha256(RELEASE_ASSET).hexdigest())


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def _key(self, name):
        return (self.server.server_address[1], name)

    def _send(self, payload, cut):
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload[:cut])
            self.wfile.flush()
        except Exception:
            pass
        if cut < len(payload):
            self.close_connection = True
            try:
                self.connection.close()
            except Exception:
                pass

    def do_GET(self):
        with open('requests.log', 'a') as log:
            log.write('%s\n' % self.path)
        if self.path in RELEASE or self.path.startswith(('/missing/', '/n/')):
            payload = RELEASE.get(self.path)
            self.send_response(200 if payload is not None else 404)
            self._send(payload or b'', len(payload or b''))
        elif self.path == '/ranged':
            # Honors Range; dies at 40% on the first two attempts, then completes.
            start = 0
            rng = self.headers.get('Range')
            if rng and rng.startswith('bytes='):
                start = int(rng.split('=')[1].split('-')[0])
            if start >= len(BODY):
                self.send_response(416)
                self.send_header('Content-Range', 'bytes */%d' % len(BODY))
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            key = self._key('ranged')
            state[key] = state.get(key, 0) + 1
            body = BODY[start:]
            if start:
                self.send_response(206)
                self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, len(BODY) - 1, len(BODY)))
            else:
                self.send_response(200)
            self.send_header('Accept-Ranges', 'bytes')
            self._send(body, len(body) if state[key] >= 3 else int(len(body) * 0.4))
        elif self.path == '/norange':
            # Ignores Range entirely: always the whole body, dies once at 50%.
            key = self._key('norange')
            state[key] = state.get(key, 0) + 1
            self.send_response(200)
            self._send(BODY, len(BODY) if state[key] >= 2 else int(len(BODY) * 0.5))
        else:  # /dead - never completes
            self.send_response(200)
            self._send(BODY, 1000)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, request, client_address):
        # Every case here ends by resetting a connection on purpose; the
        # tracebacks that produces are the test working, not a failure.
        pass


plain = Server(('127.0.0.1', int(sys.argv[1])), Handler)
secure = Server(('127.0.0.1', int(sys.argv[2])), Handler)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain('cert.pem', 'key.pem')
secure.socket = ctx.wrap_socket(secure.socket, server_side=True)
threading.Thread(target=plain.serve_forever, daemon=True).start()
open('ready', 'w').close()
secure.serve_forever()
PY
server_pid=$!

for _ in $(seq 1 60); do [ -f ready ] && break; sleep 0.2; done
[ -f ready ] || { echo "connect-download: stub server never started" >&2; exit 1; }
want="$(cat expected.sha)"

# The `||` must guard the hash tool, not the pipeline: `tool | cut` succeeds
# whenever cut does, so a fallback written as `tool | cut || other | cut` never
# fires and silently compares against an empty string.
if command -v sha256sum >/dev/null 2>&1; then
  sha() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  echo "connect-download: no sha256sum or shasum available" >&2
  exit 1
fi
fail() { echo "connect-download: $*" >&2; exit 1; }

# --- connect.sh -------------------------------------------------------------
eval "$(awk '/^download_resumable\(\) \{/,/^\}$/' "$root/connect.sh")"
# Trust the stub's self-signed cert without touching the installer's own flags.
# shellcheck disable=SC2329  # invoked indirectly, from the eval'd helper above
curl() { command curl --cacert "$work/cert.pem" "$@"; }
base="https://127.0.0.1:${https_port}"

download_resumable "${base}/ranged" a.bin 4 >/dev/null 2>&1 || fail "sh case 1: resume failed"
[ "$(sha a.bin)" = "$want" ] || fail "sh case 1: resumed bytes do not verify"

download_resumable "${base}/norange" b.bin 4 >/dev/null 2>&1 || fail "sh case 2: restart failed"
[ "$(sha b.bin)" = "$want" ] || fail "sh case 2: spliced two copies together"

if download_resumable "${base}/dead" c.bin 2 >/dev/null 2>&1; then
  fail "sh case 3: reported success on a transfer that never completed"
fi
echo "connect.sh download: 3/3 cases OK"

# --- connect.sh release hosts (ANY-2024) -------------------------------------
eval "$(grep '^_digits_only() ' "$root/connect.sh")"
for fn in tag_ok pointer_tag release_bases fetch_from fetch_release; do
  body="$(awk -v head="${fn}() {" 'index($0, head) == 1 {on=1} on {print} on && /^\}$/ {exit}' "$root/connect.sh")"
  [ -n "$body" ] || fail "hosts: ${fn} not found in connect.sh"
  eval "$body"
done
h="https://127.0.0.1:${https_port}"
closed="https://127.0.0.1:1"
release_want="$(cat release.sha)"
# shellcheck disable=SC2034  # ASSET, REPO and BASE belong to the lifted helpers
ASSET=anyray-connect-test
tmp="$work/hosts"
mkdir -p "$tmp"
dl="${tmp}/anyray-connect"
asked() { grep -c "^$1" requests.log || true; }

MIRROR="$h/up"
[ "$(pointer_tag 2>/dev/null)" = "connect-v1.2.3" ] || fail "hosts pointer: the mirror's latest.json was not read"
for MIRROR in "$closed" "$h/missing"; do
  out="$(pointer_tag 2>/dev/null)" || fail "hosts pointer: an unanswered pointer (${MIRROR}) stopped the install"
  [ -z "$out" ] || fail "hosts pointer: an unanswered pointer (${MIRROR}) named a release"
done
MIRROR="$h/bad"
if pointer_tag >/dev/null 2>&1; then fail "hosts pointer: a malformed pointer was accepted"; fi

MIRROR="https://mirror.invalid/dl"
GITHUB_DOWNLOAD="https://github.invalid/releases/download"
# shellcheck disable=SC2034  # read by the lifted release_bases
REPO="owner/repo"
[ "$(release_bases connect-v1.2.3 2>/dev/null)" = "${MIRROR}/connect-v1.2.3 ${GITHUB_DOWNLOAD}/connect-v1.2.3" ] \
  || fail "hosts order: a known tag is not tried on the mirror first, then GitHub"
[ "$(release_bases '' 2>/dev/null)" = "https://github.com/owner/repo/releases/latest/download" ] \
  || fail "hosts order: an unanswered pointer does not leave GitHub's latest"

: > requests.log
MIRROR="$h/m"
fetch_release "$h/m/connect-v1.2.3 $h/g/connect-v1.2.3" 2>/dev/null || fail "hosts mirror: download failed"
# shellcheck disable=SC2153  # BASE is set by the lifted fetch_release
[ "$BASE" = "$h/m/connect-v1.2.3" ] || fail "hosts mirror: installed from ${BASE}"
[ "$(sha "$dl")" = "$release_want" ] || fail "hosts mirror: wrong bytes"
[ "$(asked /g/)" = 0 ] || fail "hosts mirror: GitHub was asked while the mirror answered"

: > requests.log
MIRROR="$closed"
fetch_release "$closed/connect-v1.2.3 $h/g/connect-v1.2.3" 2>/dev/null || fail "hosts down: no fallback"
[ "$BASE" = "$h/g/connect-v1.2.3" ] || fail "hosts down: installed from ${BASE}"
[ "$(sha "$dl")" = "$release_want" ] || fail "hosts down: wrong bytes"

: > requests.log
MIRROR="$h/n"
fetch_release "$h/n/connect-v1.2.3 $h/g/connect-v1.2.3" 2>/dev/null || fail "hosts partial: no fallback"
[ "$BASE" = "$h/g/connect-v1.2.3" ] || fail "hosts partial: installed from ${BASE}"
[ "$(asked /g/connect-v1.2.3/SHA256SUMS)" = 1 ] || fail "hosts partial: the asset and its checksum came from different hosts"
grep -qx "anyray-connect-test" <(awk '{print $2}' "${tmp}/SHA256SUMS") || fail "hosts partial: no SHA256SUMS beside the asset"

: > requests.log
MIRROR="$h/t"
fetch_release "$h/t/connect-v1.2.3 $h/g/connect-v1.2.3" 2>/dev/null || fail "hosts tamper: download failed"
[ "$BASE" = "$h/t/connect-v1.2.3" ] || fail "hosts tamper: fell back to ${BASE}"
[ "$(asked /g/)" = 0 ] || fail "hosts tamper: altered bytes sent the installer to GitHub"
[ "$(sha "$dl")" != "$(awk '$2=="anyray-connect-test" {print $1}' "${tmp}/SHA256SUMS")" ] \
  || fail "hosts tamper: the stub did not alter the bytes"

MIRROR="$closed"
if fetch_release "$closed/connect-v1.2.3 $closed/github" 2>/dev/null; then
  fail "hosts none: reported success with no host answering"
fi
unset -f curl
echo "connect.sh release hosts: 7/7 cases OK"

# --- connect.ps1 ------------------------------------------------------------
if ! command -v pwsh >/dev/null 2>&1; then
  fail "pwsh is required to cover connect.ps1"
fi
: > requests.log
ANYRAY_TEST_BASE="http://127.0.0.1:${http_port}" ANYRAY_TEST_WANT="$want" \
  ANYRAY_TEST_RELEASE_WANT="$(cat release.sha)" ANYRAY_TEST_LOG="$work/requests.log" \
  pwsh -NoProfile -File "$root/ci/test-connect-download.ps1" "$root/connect.ps1"
