"""
Minimal HTTP server that stands in for the Anyray optimizer during verification.
Returns a canned /v1/optimize response that sets max_tokens=99 and flags
cacheEligible, then records /v1/cache write-backs for the test to assert on.
"""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os

cache_writes: list = []


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/cache-writes":
            body = json.dumps(cache_writes).encode()
        else:
            body = json.dumps({"ok": True}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        req_body = json.loads(self.rfile.read(length))
        if self.path == "/v1/optimize":
            request = req_body.get("request", {})
            request["max_tokens"] = 99
            resp = json.dumps({
                "protocolVersion": 1,
                "optimizationId": "x",
                "request": request,
                "decisions": [],
                "estimatedTokensSaved": 0,
                "estimatedSavingsUsd": 0,
                "cacheHit": False,
                "cacheEligible": True,
                "cacheKey": "verify-cache-key",
                "cacheTtlSeconds": 60,
            }).encode()
        elif self.path == "/v1/cache":
            cache_writes.append(req_body)
            resp = json.dumps({"ok": True}).encode()
        else:
            resp = b"{}"
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)

    def log_message(self, *args): pass


port = int(os.environ.get("PORT", "8088"))
server = HTTPServer(("0.0.0.0", port), Handler)
print(f"mock optimizer listening on :{port}", flush=True)
server.serve_forever()
