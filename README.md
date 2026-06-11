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
- Developers connect with: `npx anyray-connect http://<your-host>:8787`

`--connect` only sends the deployment token to Anyray Cloud and pulls back the
license public key. Metering reports are content-free rollups; the pseudonym
salt that masks employee identifiers is generated locally and never leaves the
machine. Useful extras: `--gateway-url <url>` to override the gateway URL shown
to developers in the portal, `--control-plane <url>` for non-default control
planes. Re-run `./setup.sh --connect <token>` any time to reconnect — it only
rewrites the connect vars, never your secrets.

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
