# Vendored from anyrayHQ/monorepo: optimizer/adapters/litellm/anyray_optimizer.py — edit upstream, then re-copy.
"""
Anyray Optimizer adapter for the LiteLLM proxy.

Wires LiteLLM's hooks to the gateway-neutral Optimizer Protocol (../../PROTOCOL.md):
before each LLM call it sends the request to the optimizer and applies the
transformed request (prompt compression, tool pruning, param tuning); after each
call it records a content-free-by-default trace to the optimizer so BYO-gateway
traffic shows the same spend + before/after value-proof the Anyray gateway shows.

Hooks used:
  - async_pre_call_hook          -> POST /v1/optimize           (transform request)
  - async_post_call_success_hook -> POST /v1/optimize-response  (transform response)
  - async_log_success_event      -> POST /v1/record             (persist trace)
  - async_log_failure_event      -> POST /v1/record             (persist error trace)

The log events fire for EVERY call (streaming, embeddings, errors) — unlike
async_post_call_success_hook, which structurally misses them — so recording lives
there. Decisions are produced in the pre-call hook and stashed by litellm_call_id
until the matching log event consumes them.

Capability note: LiteLLM's `async_pre_call_hook` can MODIFY the request but cannot
return a response, so this adapter advertises `canShortCircuit: false` and the
optimizer skips semantic-cache lookups. It still gets full INPUT/OUTPUT transform.

Design contract (see PROTOCOL.md): FAIL OPEN. Any optimizer error/timeout leaves
the call untouched — the optimizer can never break or block a call. Recording is
best-effort: /v1/record returns 404 when the optimizer isn't configured to persist
(non-BYO), which the adapter ignores.

Setup:
    pip install httpx
    # config.yaml
    litellm_settings:
      callbacks: anyray_optimizer.proxy_handler_instance

Env:
    ANYRAY_OPTIMIZER_URL          required, e.g. http://optimizer:8088
    ANYRAY_OPTIMIZER_TOKEN        optional bearer token
    ANYRAY_OPTIMIZER_TIMEOUT_MS   optional, default 800
Recording is enabled by configuring the OPTIMIZER (not the adapter) with
ANYRAY_OBSERVABILITY_* + ANYRAY_CONTENT_* (see the optimizer's PROTOCOL.md §/v1/record).
"""

import os
import time

import httpx
import litellm
from litellm import ModelResponse
from litellm.integrations.custom_logger import CustomLogger

# Provider-shaped request fields the protocol cares about. LiteLLM's proxy `data`
# also carries internal objects (UserAPIKeyAuth, …) that are not JSON-serializable
# and must never round-trip through the optimizer.
# Canonical list: PROTOCOL.md "Request fields" — keep in sync when it grows.
REQUEST_FIELDS = (
    "model", "messages", "prompt", "input", "temperature", "top_p",
    "max_tokens", "max_completion_tokens", "tools", "tool_choice", "stream",
    "n", "stop", "presence_penalty", "frequency_penalty", "response_format", "user",
)

# Decisions are produced in the pre-call hook but recorded in the log event (which
# fires for every call). Stash them by call_id between the two, bounded + TTL'd so
# a dropped log event (restart, error) can never leak memory.
_STASH_TTL_S = 900
_STASH_MAX = 10_000


class AnyrayOptimizer(CustomLogger):
    def __init__(self) -> None:
        base = os.environ.get("ANYRAY_OPTIMIZER_URL", "").rstrip("/")
        self.base_url = base
        self.token = os.environ.get("ANYRAY_OPTIMIZER_TOKEN")
        self.timeout_s = float(os.environ.get("ANYRAY_OPTIMIZER_TIMEOUT_MS", "800")) / 1000.0
        # One shared async client; bounded so the hook can never hang a request.
        self._client = httpx.AsyncClient(timeout=self.timeout_s) if base else None
        # call_id -> (decisions, expires_at_monotonic)
        self._decisions: dict = {}

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
        # Attribution comes LAST: it derives from the authenticated key, and a
        # client-supplied metadata.user_id must never re-attribute spend.
        merged = {**(data.get("metadata") or {}), **self._attribution(user_api_key_dict)}
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

    def _stash_decisions(
        self, call_id, decisions, latency_ms=None, optimization_id=None
    ) -> None:
        if not call_id or (
            not decisions and latency_ms is None and optimization_id is None
        ):
            return
        now = time.monotonic()
        if len(self._decisions) > _STASH_MAX:
            # Drop expired first; if still at the cap (all live), evict oldest by
            # insertion order so memory is bounded even with no expiries.
            self._decisions = {k: v for k, v in self._decisions.items() if v[3] > now}
            while len(self._decisions) >= _STASH_MAX:
                self._decisions.pop(next(iter(self._decisions)))
        self._decisions[call_id] = (
            decisions or [],
            latency_ms,
            optimization_id,
            now + _STASH_TTL_S,
        )

    def _take_decisions(self, call_id):
        item = self._decisions.pop(call_id, None)
        if not item:
            return [], None, None
        decisions, latency_ms, optimization_id, expires_at = item
        if expires_at < time.monotonic():
            return [], None, None
        return decisions, latency_ms, optimization_id

    async def async_pre_call_hook(self, user_api_key_dict, cache, data: dict, call_type: str):
        # No optimizer configured → no-op passthrough.
        if not self._client:
            return data
        try:
            sent = self._request_view(data)
            started = time.monotonic()
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
            # Stash decisions + latency + optimizationId for the log event (fires every call).
            self._stash_decisions(
                data.get("litellm_call_id"),
                body.get("decisions"),
                int((time.monotonic() - started) * 1000),
                body.get("optimizationId"),
            )
            optimized = body.get("request")
            if isinstance(optimized, dict):
                # Mutate in place so LiteLLM forwards the transformed request;
                # touch only protocol fields so proxy internals survive intact.
                # Omission means deletion (tool pruning) only for a full request
                # body — a sparse one (optimizer version skew) must never pop
                # load-bearing fields like `messages`.
                full = "model" in optimized and any(
                    k in optimized for k in ("messages", "prompt", "input")
                )
                for key in REQUEST_FIELDS:
                    if key in optimized:
                        data[key] = optimized[key]
                    elif full and key in sent:
                        data.pop(key, None)
        except Exception as err:  # FAIL OPEN — never block the call
            litellm.print_verbose(f"[anyray-optimizer] request hook skipped: {err}")
        return data

    async def async_post_call_success_hook(self, data: dict, user_api_key_dict, response):
        # OUTPUT control: send the response to the optimizer and apply any output
        # strategy changes. Only rebuilds the response when the optimizer actually
        # changed something, so it's a safe no-op otherwise. FAIL OPEN.
        # Chat completions only: `data` carries no call_type at post-call time,
        # and rebuilding a non-chat body as ModelResponse would corrupt the reply.
        # Recording is NOT done here (this hook misses streaming/embeddings/errors)
        # — it lives in the log events below.
        if not self._client or not isinstance(response, ModelResponse):
            return response
        try:
            resp = await self._client.post(
                f"{self.base_url}/v1/optimize-response",
                headers=self._headers(),
                json={
                    "endpoint": "/v1/chat/completions",
                    "request": self._request_view(data),
                    "response": response.model_dump(),
                    "metadata": self._metadata(data, user_api_key_dict),
                },
            )
            resp.raise_for_status()
            body = resp.json()
            optimized = body.get("response")
            if body.get("decisions") and isinstance(optimized, dict):
                rebuilt = ModelResponse(**optimized)
                # model_dump() drops private attrs; the proxy forwards provider
                # rate-limit/cost headers from _hidden_params — carry them over.
                rebuilt._hidden_params = response._hidden_params
                return rebuilt
        except Exception as err:  # FAIL OPEN — return the original response
            litellm.print_verbose(f"[anyray-optimizer] response hook skipped: {err}")
        return response

    # --- recording (fires for EVERY call; POSTs /v1/record, best-effort) ---

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        await self._record(kwargs, response_obj, start_time, end_time, 200)

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        await self._record(kwargs, response_obj, start_time, end_time, 500)

    async def _record(self, kwargs, response_obj, start_time, end_time, status) -> None:
        if not self._client:
            return
        try:
            record = self._build_record(kwargs, response_obj, start_time, end_time, status)
            if not record.get("id"):
                return  # no call_id to key the (idempotent) trace on — skip
            resp = await self._client.post(
                f"{self.base_url}/v1/record",
                headers=self._headers(),
                json=record,
            )
            # 404 = optimizer not configured to persist (non-BYO) — expected, ignore.
            # Other 4xx/5xx (e.g. a 400 from a schema regression) shouldn't be silent.
            if resp.status_code >= 400 and resp.status_code != 404:
                litellm.print_verbose(
                    f"[anyray-optimizer] record rejected: HTTP {resp.status_code}"
                )
        except Exception as err:  # FAIL OPEN — recording never affects the call
            litellm.print_verbose(f"[anyray-optimizer] record skipped: {err}")

    def _build_record(self, kwargs, response_obj, start_time, end_time, status) -> dict:
        call_id = kwargs.get("litellm_call_id") or (
            kwargs.get("litellm_params") or {}
        ).get("litellm_call_id")
        call_type = kwargs.get("call_type") or "completion"
        is_embedding = call_type in ("embeddings", "aembedding")
        # Streaming: response_obj is a stream wrapper with no usage; the reassembled
        # response (with usage) is in kwargs["complete_streaming_response"]. Prefer it.
        completed = kwargs.get("complete_streaming_response")
        response_for_record = completed if completed is not None else response_obj
        usage = self._usage_of(response_for_record)
        decisions, optimize_latency_ms, optimization_id = self._take_decisions(call_id)
        record = {
            "id": call_id,
            "ts": self._epoch_ms(start_time),
            "endpoint": self._endpoint_for(call_type),
            "method": "POST",
            "status": status,
            "model": kwargs.get("model"),
            "provider": kwargs.get("custom_llm_provider"),
            "promptTokens": usage.get("prompt_tokens"),
            "completionTokens": usage.get("completion_tokens"),
            "totalTokens": usage.get("total_tokens"),
            "durationMs": self._duration_ms(start_time, end_time),
            "optimizationLatencyMs": optimize_latency_ms,
            "attribution": self._attribution_from_kwargs(kwargs),
            "decisions": decisions,
            # RAW content — the optimizer gates/encrypts it per content mode. Embedding
            # outputs (vectors) are huge and never crossed the wire before, so skip them.
            "content": {
                "input": kwargs.get("messages"),
                "output": None if is_embedding else self._output_of(response_for_record),
            },
        }
        # Only when the optimizer ran (id present), and as keys — never JSON null: these
        # fields are .optional() (reject null) server-side, and a null would drop the trace.
        if optimization_id:
            record["optimizationId"] = optimization_id
            record["optimizationStatus"] = "applied" if decisions else "skipped"
        return record

    @staticmethod
    def _usage_of(response_obj) -> dict:
        usage = getattr(response_obj, "usage", None)
        if usage is None and isinstance(response_obj, dict):
            usage = response_obj.get("usage")
        if usage is None:
            return {}

        def g(key):
            return usage.get(key) if isinstance(usage, dict) else getattr(usage, key, None)

        return {
            "prompt_tokens": g("prompt_tokens"),
            "completion_tokens": g("completion_tokens"),
            "total_tokens": g("total_tokens"),
        }

    @staticmethod
    def _output_of(response_obj):
        try:
            data = response_obj.model_dump() if hasattr(response_obj, "model_dump") else response_obj
        except Exception:
            data = response_obj
        if isinstance(data, dict):
            choices = data.get("choices")
            if isinstance(choices, list) and choices and isinstance(choices[0], dict):
                return choices[0].get("message") or choices
            return data.get("content") or data
        return None

    @staticmethod
    def _attribution_from_kwargs(kwargs) -> dict:
        meta = (kwargs.get("litellm_params") or {}).get("metadata") or kwargs.get("metadata") or {}
        out = {}
        user = meta.get("user_api_key_user_id") or meta.get("user_id") or meta.get("user")
        team = meta.get("user_api_key_team_id") or meta.get("team_id") or meta.get("team")
        session = meta.get("session_id") or meta.get("sessionId")
        intent = meta.get("intent")
        intent_label = meta.get("intentLabel") or meta.get("intent_label")
        if user:
            out["user"] = str(user)
        if team:
            out["team"] = str(team)
        if session:
            out["sessionId"] = str(session)
        if intent:
            out["intent"] = str(intent)
        if intent_label:
            out["intentLabel"] = str(intent_label)
        return out

    @staticmethod
    def _epoch_ms(dt):
        try:
            return int(dt.timestamp() * 1000)
        except Exception:
            return None

    @staticmethod
    def _duration_ms(start, end):
        try:
            return max(0, int((end - start).total_seconds() * 1000))
        except Exception:
            return 0


# Instance referenced from config.yaml: `callbacks: anyray_optimizer.proxy_handler_instance`
proxy_handler_instance = AnyrayOptimizer()
