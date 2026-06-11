# Vendored from anyrayHQ/monorepo: optimizer/adapters/litellm/anyray_optimizer.py — edit upstream, then re-copy.
"""
Anyray Optimizer adapter for the LiteLLM proxy.

Wires LiteLLM's pre-call hook to the gateway-neutral Optimizer Protocol
(../../PROTOCOL.md): before each LLM call it sends the request to the optimizer
and applies the transformed request (prompt compression, tool pruning, param
tuning).

Hooks used:
  - async_pre_call_hook        -> POST /v1/optimize           (transform request)
  - async_post_call_success_hook -> POST /v1/optimize-response (transform response)

Capability note: LiteLLM's `async_pre_call_hook` can MODIFY the request but
cannot return a response, so this adapter advertises `canShortCircuit: false` and
the optimizer skips semantic-cache lookups. Use LiteLLM's own caching for response
caching. It still gets full INPUT and OUTPUT transformation.

Design contract (see PROTOCOL.md): FAIL OPEN. Any optimizer error/timeout leaves
the original request untouched — the optimizer can never break a call.

Setup:
    pip install httpx
    # config.yaml
    litellm_settings:
      callbacks: anyray_optimizer.proxy_handler_instance

Env:
    ANYRAY_OPTIMIZER_URL          required, e.g. http://optimizer:8088
    ANYRAY_OPTIMIZER_TOKEN        optional bearer token
    ANYRAY_OPTIMIZER_TIMEOUT_MS   optional, default 800
"""

import os

import httpx
import litellm
from litellm import ModelResponse
from litellm.integrations.custom_logger import CustomLogger

# Provider-shaped request fields the protocol cares about. LiteLLM's proxy `data`
# also carries internal objects (UserAPIKeyAuth, …) that are not JSON-serializable
# and must never round-trip through the optimizer.
REQUEST_FIELDS = (
    "model", "messages", "prompt", "input", "temperature", "top_p",
    "max_tokens", "max_completion_tokens", "tools", "tool_choice", "stream",
    "n", "stop", "presence_penalty", "frequency_penalty", "response_format", "user",
)


class AnyrayOptimizer(CustomLogger):
    def __init__(self) -> None:
        base = os.environ.get("ANYRAY_OPTIMIZER_URL", "").rstrip("/")
        self.base_url = base
        self.token = os.environ.get("ANYRAY_OPTIMIZER_TOKEN")
        self.timeout_s = float(os.environ.get("ANYRAY_OPTIMIZER_TIMEOUT_MS", "800")) / 1000.0
        # One shared async client; bounded so the hook can never hang a request.
        self._client = httpx.AsyncClient(timeout=self.timeout_s) if base else None

    def _headers(self) -> dict:
        headers = {"content-type": "application/json"}
        if self.token:
            headers["authorization"] = f"Bearer {self.token}"
        return headers

    @staticmethod
    def _attribution(user_api_key_dict) -> dict:
        # LiteLLM proxy auth context — lets the optimizer attribute spend per user/team.
        if not user_api_key_dict:
            return {}
        src = user_api_key_dict if isinstance(user_api_key_dict, dict) else vars(user_api_key_dict)
        return {k: src[k] for k in ("user_id", "team_id", "key_alias") if src.get(k)}

    @staticmethod
    def _request_view(data: dict) -> dict:
        return {k: data[k] for k in REQUEST_FIELDS if k in data}

    def _metadata(self, data: dict, user_api_key_dict) -> dict:
        # Scalars only — proxy metadata nests non-serializable internals.
        merged = {**self._attribution(user_api_key_dict), **(data.get("metadata") or {})}
        return {k: v for k, v in merged.items() if isinstance(v, (str, int, float, bool)) or v is None}

    @staticmethod
    def _endpoint_for(call_type: str) -> str:
        if call_type in ("completion", "acompletion"):
            return "/v1/chat/completions"
        if call_type in ("text_completion", "atext_completion"):
            return "/v1/completions"
        if call_type in ("embeddings", "aembedding"):
            return "/v1/embeddings"
        return f"/v1/{call_type}"

    async def async_pre_call_hook(self, user_api_key_dict, cache, data: dict, call_type: str):
        # No optimizer configured → no-op passthrough.
        if not self._client:
            return data
        try:
            sent = self._request_view(data)
            resp = await self._client.post(
                f"{self.base_url}/v1/optimize",
                headers=self._headers(),
                json={
                    "endpoint": self._endpoint_for(call_type),
                    "request": sent,
                    "metadata": self._metadata(data, user_api_key_dict),
                    # LiteLLM's hook can't return a response → transform-only.
                    "capabilities": {"canShortCircuit": False},
                },
            )
            resp.raise_for_status()
            body = resp.json()
            optimized = body.get("request")
            if isinstance(optimized, dict):
                # Mutate in place so LiteLLM forwards the transformed request;
                # touch only protocol fields so proxy internals survive intact.
                for key in REQUEST_FIELDS:
                    if key in optimized:
                        data[key] = optimized[key]
                    elif key in sent:
                        data.pop(key, None)
        except Exception as err:  # FAIL OPEN — never block the call
            litellm.print_verbose(f"[anyray-optimizer] request hook skipped: {err}")
        return data

    async def async_post_call_success_hook(self, data: dict, user_api_key_dict, response):
        # OUTPUT control: send the response to the optimizer and apply any output
        # strategy changes. Only rebuilds the response when the optimizer actually
        # changed something, so it's a safe no-op otherwise. FAIL OPEN.
        if not self._client:
            return response
        try:
            as_dict = response.model_dump() if hasattr(response, "model_dump") else dict(response)
            resp = await self._client.post(
                f"{self.base_url}/v1/optimize-response",
                headers=self._headers(),
                json={
                    "endpoint": self._endpoint_for(data.get("call_type", "completion")),
                    "request": self._request_view(data),
                    "response": as_dict,
                    "metadata": self._metadata(data, user_api_key_dict),
                },
            )
            resp.raise_for_status()
            body = resp.json()
            optimized = body.get("response")
            if body.get("decisions") and isinstance(optimized, dict):
                return ModelResponse(**optimized)
        except Exception as err:  # FAIL OPEN — return the original response
            litellm.print_verbose(f"[anyray-optimizer] response hook skipped: {err}")
        return response


# Instance referenced from config.yaml: `callbacks: anyray_optimizer.proxy_handler_instance`
proxy_handler_instance = AnyrayOptimizer()
