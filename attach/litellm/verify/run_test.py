"""
Verification test: asserts that the AnyrayOptimizer pre-call hook ran (the
optimizer mutation max_tokens=99 reached the mock provider) and that
async_post_call_success_hook sent the response to /v1/optimize-response and
applied the transformed response (marker content reaches the client).
"""
import urllib.request, json, sys

# Fire a completion through LiteLLM.
body = json.dumps({
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "hello"}],
    "max_tokens": 200,
}).encode()

req = urllib.request.Request(
    "http://litellm:4000/v1/chat/completions",
    data=body,
    headers={
        "content-type": "application/json",
        "authorization": "Bearer sk-fake",
    },
)
r = urllib.request.urlopen(req, timeout=15)
assert r.status == 200, f"LiteLLM returned {r.status}"
client_response = json.loads(r.read())

# Check the mock provider received max_tokens=99 (set by the mock optimizer).
last = json.loads(urllib.request.urlopen("http://mock-provider:9999/last", timeout=5).read())
assert last.get("max_tokens") == 99, (
    f"Expected max_tokens=99, got: {last.get('max_tokens')} "
    "— async_pre_call_hook did not apply the optimizer mutation"
)
assert "anyray" not in json.dumps(last), (
    "Anyray adapter state leaked into the provider request body "
    "— only REQUEST_FIELDS may reach the provider"
)
print("PASS: async_pre_call_hook ran and mutations reached the provider")

# async_post_call_success_hook runs in the request path — no polling needed.
calls = json.loads(urllib.request.urlopen("http://mock-optimizer:8088/optimize-response-calls", timeout=5).read())
assert calls, (
    "No /v1/optimize-response call received — async_post_call_success_hook did not run"
)
assert calls[0].get("response", {}).get("choices"), "optimize-response payload is missing the response body"
assert calls[0].get("request"), "optimize-response payload is missing the request"

content = client_response.get("choices", [{}])[0].get("message", {}).get("content")
assert content == "optimized-ok", (
    f"Expected transformed content 'optimized-ok', got: {content!r} "
    "— the optimized response was not applied to the client reply"
)
print("PASS: async_post_call_success_hook called /v1/optimize-response and the transform reached the client")

sys.exit(0)
