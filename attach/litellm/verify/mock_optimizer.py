"""
Minimal HTTP server that stands in for the Anyray optimizer during verification.
/v1/optimize returns the request with max_tokens=99 (and, mirroring the real
optimizer, NO cacheEligible/cacheKey — the adapter advertises canShortCircuit:false,
which drops the semantic_cache strategy). /v1/optimize-response returns the
response with a marker content string and a non-empty decisions list, and records
the call for the test to assert on.
"""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os

optimize_response_calls: list = []


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/optimize-response-calls":
            body = json.dumps(optimize_response_calls).encode()
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
                "cacheEligible": False,
            }).encode()
        elif self.path == "/v1/optimize-response":
            optimize_response_calls.append(req_body)
            response = req_body.get("response", {})
            for choice in response.get("choices", []):
                if isinstance(choice.get("message"), dict):
                    choice["message"]["content"] = "optimized-ok"
            resp = json.dumps({
                "protocolVersion": 1,
                "response": response,
                "decisions": [{"kind": "output_test", "applied": True}],
            }).encode()
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
