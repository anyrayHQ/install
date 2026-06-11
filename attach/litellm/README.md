# Anyray attach mode — LiteLLM integration

**Requirements:** Python 3.9+, `httpx` package (`pip install httpx`).

Drop-in Anyray optimizer integration for an existing LiteLLM proxy. Gives you:

- Prompt compression, tool pruning, and param tuning before each request.
- Content-free traces (metadata only) in the Anyray console — no prompt/response content.

## Files

| File                | Purpose                                                                      |
|---------------------|------------------------------------------------------------------------------|
| `anyrayCallback.py` | LiteLLM `CustomLogger` subclass — pre-call optimizer hook + cache write-back |
| `config.yaml`       | LiteLLM config snippet; merge into yours                                     |

## Installation

1. Run the Anyray attach stack:

   ```
   docker compose -f docker-compose.attach.yml up -d
   ```

2. Copy `anyrayCallback.py` next to your LiteLLM `config.yaml`.

3. Add to your LiteLLM `config.yaml` (merge with `config.yaml` in this directory):

   ```yaml
   litellm_settings:
     callbacks:
       - anyrayCallback.anyray_callback
     success_callback:
       - langfuse
   ```

4. Set these env vars in your LiteLLM process (or add to its Docker environment):

   ```
   ANYRAY_OPTIMIZER_URL=http://<anyray-host>:8088
   ANYRAY_OPTIMIZER_TOKEN=<ANYRAY_OPTIMIZER_TOKEN from .env>
   LANGFUSE_PUBLIC_KEY=<ANYRAY_OBSERVABILITY_PUBLIC_KEY from .env>
   LANGFUSE_SECRET_KEY=<ANYRAY_OBSERVABILITY_SECRET_KEY from .env>
   LANGFUSE_HOST=http://<anyray-host>:3000
   LANGFUSE_TRACING_ENVIRONMENT=production
   TURN_OFF_MESSAGE_LOGGING=true
   LANGFUSE_REDACT_ALL_INPUTS=true
   LANGFUSE_REDACT_ALL_OUTPUTS=true
   ```

   **The `TURN_OFF_MESSAGE_LOGGING`, `LANGFUSE_REDACT_ALL_INPUTS`, and `LANGFUSE_REDACT_ALL_OUTPUTS` vars are required.** Without them, LiteLLM sends prompt/response content to Langfuse, violating the Anyray privacy model.

5. Open the console at http://<anyray-host>:3000, sign in with `ANYRAY_ADMIN_TOKEN`.

## What you see in the console

Working in attach mode:

- Traces page — every LiteLLM request appears as a trace (metadata only).
- Sessions page — requests grouped by LiteLLM session.
- Dashboard — daily token/cost charts.
- Optimizer page — toggle strategies, tune parameters.

Not available (gateway-dependent):

- Spend page — requires the Anyray gateway's spend store.
- Providers page — requires the Anyray gateway's provider-key store.
- Routing page — requires the Anyray gateway's routing config.
- Users page — requires the Anyray gateway's user-caps config.
- Playground — requires the Anyray gateway.
These pages show "Unable to load: request failed" — expected in attach mode.

## Privacy guarantee

`anyrayCallback.py` never logs or persists request/response content. The optimizer
holds content in memory for the duration of the call only. The trace backend
receives metadata only when `TURN_OFF_MESSAGE_LOGGING=true` is set.

## Streaming

The attach-mode adapter does not currently optimize streaming requests — the
callback's `call_type` guard skips them; they pass through unmodified.
Cached responses cannot be served to the caller in attach mode — LiteLLM's
pre-call hook cannot short-circuit the provider request (the callback advertises
`canShortCircuit: false`). Cache write-back still runs, so the semantic cache is
populated for gateway deployments that share the same optimizer.
