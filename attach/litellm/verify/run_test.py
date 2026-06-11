"""
Verification test: asserts that the AnyrayCallback pre-call hook ran (the
optimizer mutation max_tokens=99 reached the mock provider) and that the
post-call hook wrote the response back to the optimizer's /v1/cache —
proving the _anyray_* keys stashed in `data` survive into the success
hook's kwargs.
"""
import urllib.request, json, sys, time

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

# Check the mock provider received max_tokens=99 (set by the mock optimizer).
last = json.loads(urllib.request.urlopen("http://mock-provider:9999/last", timeout=5).read())
assert last.get("max_tokens") == 99, (
    f"Expected max_tokens=99, got: {last.get('max_tokens')} "
    "— async_pre_call_hook did not apply the optimizer mutation"
)
assert "anyray" not in json.dumps(last), (
    "Anyray per-request state leaked into the provider request body "
    "— it must travel via data['metadata'], not top-level data keys"
)
print("PASS: async_pre_call_hook ran and mutations reached the provider")

# async_log_success_event fires asynchronously after the response — poll.
writes = []
for _ in range(20):
    writes = json.loads(urllib.request.urlopen("http://mock-optimizer:8088/cache-writes", timeout=5).read())
    if writes:
        break
    time.sleep(1)

assert writes, (
    "No /v1/cache write-back received — _anyray_* keys set in async_pre_call_hook "
    "did not reach async_log_success_event's kwargs, or the hook did not run"
)
assert writes[0].get("cacheKey") == "verify-cache-key", f"Unexpected cacheKey: {writes[0].get('cacheKey')}"
assert writes[0].get("ttlSeconds") == 60, f"Unexpected ttlSeconds: {writes[0].get('ttlSeconds')}"
assert writes[0].get("response", {}).get("choices"), "Cache write-back is missing the response body"
print("PASS: async_log_success_event wrote the response back to /v1/cache")

sys.exit(0)
