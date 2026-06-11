"""
Anyray optimizer callback for LiteLLM.

Duties:
  1. async_pre_call_hook  — call POST /v1/optimize, rewrite the request body
                            in place before LiteLLM forwards to the provider.
  2. async_log_success_event — write the live response back to the optimizer's
                               semantic cache when cacheEligible is set.

Trace emission is handled by LiteLLM's native Langfuse integration
(add "langfuse" to success_callback in your LiteLLM config.yaml) with
turn_off_message_logging=true so no prompt/response content is sent.
This callback never touches the trace backend directly.

Required env vars:
  ANYRAY_OPTIMIZER_URL    e.g. http://optimizer:8088
  ANYRAY_OPTIMIZER_TOKEN  shared secret (set in .env by setup.sh)

Optional:
  ANYRAY_OPTIMIZER_TIMEOUT_SECS  default 0.8  (fail-open timeout)
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

import httpx
from litellm.integrations.custom_logger import CustomLogger

logger = logging.getLogger("anyray")

_OPTIMIZER_URL = os.environ.get("ANYRAY_OPTIMIZER_URL", "http://optimizer:8088").rstrip("/")
_TOKEN = os.environ.get("ANYRAY_OPTIMIZER_TOKEN", "")
_TIMEOUT = float(os.environ.get("ANYRAY_OPTIMIZER_TIMEOUT_SECS", "0.8"))

# Per-request state passed from pre-call to post-call via data["metadata"],
# which LiteLLM surfaces to logging callbacks as litellm_params["metadata"].
# Top-level keys added to `data` are routed into extra_body and sent to the
# provider (verified against litellm 1.82.x) — never stash state there.
_STATE_KEY = "anyray_cache"

# Shared client — created on first use, lives for the process lifetime.
_client: Optional[httpx.AsyncClient] = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=_TIMEOUT)
    return _client


def _auth_headers() -> dict[str, str]:
    if _TOKEN:
        return {"Authorization": f"Bearer {_TOKEN}"}
    return {}


class AnyrayCallback(CustomLogger):
    """Drop-in LiteLLM custom logger that integrates the Anyray optimizer."""

    # `data` is LiteLLM's mutable kwargs dict — in-place mutations reach the
    # outgoing provider call (signature verified against litellm 1.x).
    async def async_pre_call_hook(
        self,
        user_api_key_dict: Any,
        cache: Any,
        data: dict[str, Any],
        call_type: str,
    ) -> dict[str, Any]:
        # Only optimize chat completions.
        if call_type not in ("completion", "acompletion"):
            return data

        endpoint = "/v1/chat/completions"
        request_body: dict[str, Any] = {
            k: data[k]
            for k in ("model", "messages", "temperature", "max_tokens", "tools", "stream")
            if k in data
        }
        # Attach attribution metadata if LiteLLM has it (proxy sets these).
        metadata: dict[str, Any] = {}
        if user_api_key_dict:
            udict = user_api_key_dict if isinstance(user_api_key_dict, dict) else vars(user_api_key_dict)
            for key in ("user_id", "team_id", "key_alias"):
                val = udict.get(key)
                if val:
                    metadata[key] = val

        payload = {
            "endpoint": endpoint,
            "request": request_body,
            "metadata": metadata,
            # LiteLLM's pre-call hook cannot return a cached response to the
            # caller — it can only mutate the outgoing request. Tell the
            # optimizer so it skips the cache lookup (no point producing a
            # response it can't serve).
            "capabilities": {"canShortCircuit": False},
        }

        try:
            resp = await _get_client().post(
                f"{_OPTIMIZER_URL}/v1/optimize",
                json=payload,
                headers=_auth_headers(),
            )
            if resp.status_code != 200:
                logger.debug("anyray optimizer returned %s — skipping", resp.status_code)
                return data

            result = resp.json()
            optimized_request: dict[str, Any] = result.get("request", {})

            # Apply optimizer changes back onto LiteLLM's data dict.
            for key, value in optimized_request.items():
                if key in data:
                    data[key] = value
                else:
                    logger.debug("anyray: optimizer returned key %s not in request, skipping", key)

            # Stash cache metadata for the post-call write-back.
            if result.get("cacheEligible"):
                data.setdefault("metadata", {})[_STATE_KEY] = {
                    "key": result.get("cacheKey"),
                    "ttl": result.get("cacheTtlSeconds", 3600),
                }

        except Exception:
            # Fail open: optimizer is best-effort. Log at debug to avoid noise.
            logger.debug("anyray optimizer unreachable or timed out — proceeding without optimization")

        return data

    async def async_log_success_event(
        self,
        kwargs: dict[str, Any],
        response_obj: Any,
        start_time: Any,
        end_time: Any,
    ) -> None:
        litellm_params = kwargs.get("litellm_params") or {}
        metadata = litellm_params.get("metadata") or {}
        state = metadata.get(_STATE_KEY)
        if not state:
            return

        cache_key = state.get("key")
        ttl = state.get("ttl", 3600)

        # Serialize response to a plain dict for the optimizer's cache store.
        try:
            if hasattr(response_obj, "model_dump"):
                response_dict = response_obj.model_dump()
            elif hasattr(response_obj, "dict"):
                response_dict = response_obj.dict()
            else:
                response_dict = dict(response_obj)
        except Exception:
            logger.debug("anyray: could not serialize response_obj, skipping cache write-back")
            return

        payload: dict[str, Any] = {"response": response_dict, "ttlSeconds": ttl}
        if cache_key:
            payload["cacheKey"] = cache_key

        try:
            await _get_client().post(
                f"{_OPTIMIZER_URL}/v1/cache",
                json=payload,
                headers=_auth_headers(),
            )
        except Exception:
            logger.debug("anyray cache write-back failed — non-fatal")


# Module-level singleton — LiteLLM's get_instance_fn resolves the last dotted
# segment as an attribute of the module, so config.yaml must reference
# anyrayCallback.anyray_callback (the instance), not AnyrayCallback (the class).
anyray_callback = AnyrayCallback()
