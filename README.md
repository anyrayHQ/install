# Anyray — install

Self-host [Anyray](https://docs.anyray.ai) (the AI-spend optimizer gateway) from
published images. Full docs and platform-specific recipes: https://docs.anyray.ai

## Quick start (any machine with Docker)

Grab a deployment token (`adt_…`) from [app.anyray.ai](https://app.anyray.ai)
(Deployments → Connect a deployment), then:

    git clone https://github.com/anyrayHQ/install anyray && cd anyray
    ./setup.sh --connect adt_XXXX
    docker compose up -d

- Your deployment shows up as **Connected** at app.anyray.ai within a minute.
- Console → http://<your-host>:3000 — sign in with the admin key `setup.sh` printed,
  then follow the in-console setup steps (~3 min).
- **Add your LLM provider key** (required before the gateway can serve requests):
  either in the console's provider-keys settings, or in `.env`
  (`ANYRAY_PROVIDER_KEY_OPENAI=…` / `ANYRAY_PROVIDER_KEY_ANTHROPIC=…` /
  `ANYRAY_PROVIDER_KEY_AZURE_OPENAI=…`) followed by `docker compose up -d`.
  Developers never see this key — their tools use a placeholder.
- Gateway → point AI tools/SDKs at http://<your-host>:8787/v1/...
- Developers connect with **one line, nothing to install** (see below).

## Developers connect — zero install

A developer points their local AI tools (Claude Code, Codex, …) at the gateway
with a single line. Nothing to install — no Node, no npm, no global package. The
installer downloads a standalone `anyray-connect` binary for their OS, verifies
its checksum, and runs it. Grab the **shareable setup link** (`https://app.anyray.ai/setup/dvl_…`)
from the portal and hand it to your team:

**macOS / Linux**

    curl -fsSL https://app.anyray.ai/connect.sh | sh -s -- <setup-link>

**Windows (PowerShell)**

    & ([scriptblock]::Create((irm https://app.anyray.ai/connect.ps1))) "<setup-link>"

Flags pass straight through (e.g. `--subscription` for seat/subscription auth —
the setup link sets this automatically for subscription orgs). A subscription
org's link turns on pass-through auth with no flag at all.

> Prefer a package manager? `npx anyray-connect <setup-link>` still works (needs
> Node). The one-liners above need only `curl`/PowerShell.

`--connect` only sends the deployment token to Anyray Cloud. The control-plane
host (`app.anyray.ai`) and the Ed25519 lease-verify key are **pinned in the
gateway image**, so the signed billing kill-switch can't be bypassed by
re-pointing the URL — nothing about the trust anchor is configured on your box.
Metering reports are content-free rollups; the pseudonym salt that masks
employee identifiers is generated locally and never leaves the machine. Re-run
`./setup.sh --connect <token>` any time to reconnect — it only rewrites the
connect vars, never your secrets.

Useful extras: `--gateway-url <url>` overrides the gateway URL shown to
developers in the portal. `--control-plane <url>` points at a non-default
control plane — this is for **internal/dev gateway builds only**: it sets
`ANYRAY_DEV_UNSAFE_CONTROL_PLANE=1` and a stock image will still refuse to meter
against a non-pinned host.

### Standalone (no Anyray Cloud)

    ./setup.sh
    docker compose up -d

Everything runs fully self-hosted with no outbound connection to Anyray Cloud;
connect later by re-running `./setup.sh --connect adt_XXXX`.

## Remote Docker host (EC2 / GCP / any VM with SSH + Docker)

    ./setup.sh --host <vm-ip-or-hostname> [--connect adt_XXXX]
    DOCKER_HOST=ssh://user@<vm> docker compose up -d

Open ports 3000 and 8787 to your org network only — never publicly.

## Public exposure (remote devs / Cursor / Copilot BYOK)

To expose the gateway API over TLS, set in `.env`: `ANYRAY_PUBLIC_DOMAIN`
(a DNS A record pointing at the host), `ANYRAY_GATEWAY_BIND=127.0.0.1`,
`ANYRAY_TRUST_PROXY=true`, and `ANYRAY_REQUIRE_CLIENT_KEYS=true`, then:

    docker compose --profile public up -d

Caddy terminates HTTPS on 443 with automatic Let's Encrypt certs and 403s the
admin surface — the console and `/admin` stay in-network only.

## More ways to deploy

Docker Compose (above) is the default. The repo also ships:

**Kubernetes (Helm)** — the full stack as a self-contained chart (no external chart
dependencies):

    ./setup.sh --k8s --host <hostname-or-ip>   # emits anyray-secrets.yaml + my-values.yaml
    kubectl apply -f anyray-secrets.yaml
    helm install anyray ./helm -f my-values.yaml

See [`helm/README.md`](./helm/README.md).

**Railway** — one-click deploy; Railway auto-generates every secret. The authoritative
spec is [`railway/railway.template.json`](./railway); see [`railway/README.md`](./railway/README.md).

**Attach mode (keep your existing gateway)** — already running LiteLLM / Kong / Envoy?
Run only Anyray's optimizer + console and call it as a before/after-request hook, so you
keep your gateway and still get prompt/tool/param optimization plus content-free traces:

    docker compose -f docker-compose.attach.yml up -d

See [`attach/litellm/README.md`](./attach/litellm/README.md).

## Install with your AI agent

Paste [AGENT.md](./AGENT.md) into Claude Code / Codex on the machine with your
infra access and it will drive this install for you.

## Upgrade

    git pull && docker compose pull && docker compose up -d

## Repair / status

    docker compose ps          # service health
    docker compose logs <svc>  # diagnose a failing service
    ./setup.sh                 # safe to re-run; never overwrites .env
                               # (--connect rewrites only the connect vars)

## Security notes

- `setup.sh` generates every secret locally; nothing leaves your machine.
- Prompt/response content is encrypted at rest (AES-256-GCM) by default.
- The single admin key (`ANYRAY_ADMIN_TOKEN` in `.env`) gates the console and
  all admin APIs. Rotate by editing `.env` and `docker compose up -d`.
