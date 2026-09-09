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
        if self.path == '/ranged':
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

sha() { shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1 || sha256sum "$1" | cut -d' ' -f1; }
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
unset -f curl
echo "connect.sh download: 3/3 cases OK"

# --- connect.ps1 ------------------------------------------------------------
if ! command -v pwsh >/dev/null 2>&1; then
  fail "pwsh is required to cover connect.ps1"
fi
ANYRAY_TEST_BASE="http://127.0.0.1:${http_port}" ANYRAY_TEST_WANT="$want" \
  pwsh -NoProfile -File "$root/ci/test-connect-download.ps1" "$root/connect.ps1"
