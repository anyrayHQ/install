# Optional Anyray attach mode — LiteLLM integration

**Requirements:** Python 3.9+, `httpx` package (`pip install httpx`).

The default Anyray install runs the **Anyray gateway** and developer tools point
at Anyray. Use this optional attach mode only when an existing LiteLLM proxy must
remain the developer-facing gateway.

Drop-in Anyray optimizer integration for that existing LiteLLM proxy gives you:

- Prompt compression, tool pruning, and param tuning before each request.
- Response (output) optimization after each request.
- Per-call traces in the Anyray console — spend, model/provider, latency, and the
  optimizer's before/after — via the optimizer's `/v1/record`. Prompt/response content
  is gated server-side by the optimizer's content mode (default: encrypted at rest).

## Files

| File                  | Purpose                                                                                  |
|-----------------------|------------------------------------------------------------------------------------------|
| `anyray_optimizer.py` | LiteLLM `CustomLogger` subclass — pre-call request transform + post-call response transform. Vendored from the monorepo (`optimizer/adapters/litellm/`); edit upstream, then re-copy. |
| `config.yaml`         | LiteLLM config snippet; merge into yours                                                 |

## Installation

1. Generate the Anyray secrets:

   ```
   ./setup.sh --host <anyray-host>
   ```

   `setup.sh` writes `.env`, including `ANYRAY_ADMIN_TOKEN`,
   `ANYRAY_OPTIMIZER_TOKEN`, observability backend keys, and the content-encryption
   key. It is safe to re-run; it does not overwrite existing secrets.

2. Run the Anyray attach stack:

   ```
   docker compose -f docker-compose.attach.yml up -d
   ```

   By default the optimizer is published on `127.0.0.1:8088`, which is correct
   when LiteLLM runs on the same host. If LiteLLM runs on another machine, set
   `ANYRAY_OPTIMIZER_BIND=0.0.0.0` in `.env`, keep `:8088` reachable only over a
   private network or VPN, and restart the stack.

3. Copy `anyray_optimizer.py` next to your LiteLLM `config.yaml`.

4. Add to your LiteLLM `config.yaml` (merge with `config.yaml` in this directory):

   ```yaml
   litellm_settings:
     callbacks:
       - anyray_optimizer.proxy_handler_instance
   ```

5. Set these env vars in your LiteLLM process (or add to its Docker environment):

   ```
   ANYRAY_OPTIMIZER_URL=http://<anyray-host>:8088
   ANYRAY_OPTIMIZER_TOKEN=<ANYRAY_OPTIMIZER_TOKEN from .env>
   ```

   That's all LiteLLM needs. Traces are written by the **optimizer**, not LiteLLM
   (see [Traces & spend](#traces--spend)), so no `LANGFUSE_*` vars belong here — and
   you should **not** add a native `success_callback: langfuse`, which would record
   every call twice.

6. Open the console at http://<anyray-host>:3000, sign in with `ANYRAY_ADMIN_TOKEN`.

Do not run `anyray-connect` for attach mode. `anyray-connect` points developer
tools at the Anyray gateway (`:8787`), and attach mode intentionally does not run
that gateway. Developers keep using your existing LiteLLM endpoint.

## What you see in the console

Working in attach mode:

- Traces page — every LiteLLM request appears as a trace (spend, model/provider, latency, optimizer before/after; prompt/response content per the optimizer's content mode).
- Sessions page — requests grouped by LiteLLM session.
- Dashboard — daily token/cost charts.
- Optimizer page — toggle strategies, tune parameters.

Not available (gateway-dependent):

- Spend page — requires the Anyray gateway's spend store.
- Providers page — requires the Anyray gateway's provider-key store.
- Routing page — requires the Anyray gateway's routing config.
- Users page — requires the Anyray gateway's user-caps config.
- Playground — requires the Anyray gateway.
- Pricing page — requires the Anyray gateway's pricing config.
- Content privacy page — requires the Anyray gateway's settings API; attach mode
  privacy is controlled by `ANYRAY_CONTENT_MODE` on the optimizer service.
- Invite developers / connect links — require the Anyray gateway; developers keep
  pointing at your existing LiteLLM endpoint.
These pages show "Unable to load: request failed" — expected in attach mode.

## Traces & spend

Traces are produced by the **optimizer**, not LiteLLM. The adapter's log hooks POST
every call — streaming, embeddings, and errors included — to the optimizer's
`/v1/record`, which writes the same trace the Anyray gateway writes
in-process. So BYO traffic shows the same spend, model/provider, cost, and the
optimizer's before/after.

The attach stack enables this for you: `docker-compose.attach.yml` sets
`ANYRAY_OBSERVABILITY_*` on the optimizer service and `setup.sh` seeds the keys into
`.env`. The optimizer then ships traces to the in-network trace backend at `web:3000` — your
LiteLLM proxy never needs trace-backend access.

- **Opt-out:** leave `ANYRAY_OBSERVABILITY_PUBLIC_KEY` / `ANYRAY_OBSERVABILITY_SECRET_KEY`
  empty in `.env` and `/v1/record` returns `404` — recording is disabled and the adapter
  fails open silently.
- **Never set these on the optimizer when an Anyray gateway is in the path** — the gateway
  already records in-process, so both writing would record every call twice. This is a
  full-gateway concern only; attach mode has no gateway.

## Privacy

Prompt/response content is gated **server-side by the optimizer**, controlled by
`ANYRAY_CONTENT_MODE` on the optimizer service (default `encrypted`):

| Mode | Stored content |
|------|----------------|
| `off`       | Metadata only — no prompt/response content persisted. |
| `encrypted` | Content persisted **AES-256-GCM encrypted at rest** (needs `ANYRAY_CONTENT_KEY`; degrades to `off` if unset). **Default.** |
| `plaintext` | Content persisted in the clear — deploy-gated, only when `ANYRAY_ALLOW_PLAINTEXT=true`. |

The adapter sends content raw to the optimizer over the `/v1/record` call (loopback-bound
and `ANYRAY_OPTIMIZER_TOKEN`-authed by default); the optimizer applies the mode before
anything is written to the trace backend. For metadata-only traces, set
`ANYRAY_CONTENT_MODE=off` in `.env` and restart the optimizer.

## Caching

Semantic-cache hits cannot be served in attach mode — LiteLLM's pre-call hook
cannot short-circuit the provider request, so the adapter advertises
`canShortCircuit: false` and the optimizer skips its cache strategy entirely.
Use LiteLLM's built-in cache (`cache: true`) for response caching.

## Streaming

Streaming requests still get the pre-call request transform; response
optimization runs in `async_post_call_success_hook` and applies to
non-streaming chat completions only.
