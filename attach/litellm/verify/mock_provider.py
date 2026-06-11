"""
Minimal HTTP server that pretends to be an OpenAI-compatible provider.
Records the last request body it received and returns a canned chat response.
"""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, os

last_request: dict = {}

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(length))
        global last_request
        last_request = body
        resp = json.dumps({
            "id": "chatcmpl-mock",
            "object": "chat.completion",
            "choices": [{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop", "index": 0}],
            "model": body.get("model", "gpt-4o"),
            "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12},
        }).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)

    def log_message(self, *args): pass  # suppress access log noise

    def do_GET(self):
        # /last — return the last recorded request body for assertions.
        body = json.dumps(last_request).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

port = int(os.environ.get("PORT", "9999"))
server = HTTPServer(("0.0.0.0", port), Handler)
print(f"mock provider listening on :{port}", flush=True)
server.serve_forever()
