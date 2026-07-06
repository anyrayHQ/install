# Anyray — install

Self-host [Anyray](https://docs.anyray.ai), the AI-spend optimizer gateway, from
published images. This repo is the install path for every target: Docker, Kubernetes,
AWS, Google Cloud, and Railway.

> Full docs and platform recipes: **https://docs.anyray.ai**

## Quick start (Docker)

Grab a deployment token (`adt_…`) from [app.anyray.ai](https://app.anyray.ai)
→ *Deployments → Connect a deployment*, then:

```bash
git clone https://github.com/anyrayHQ/install anyray && cd anyray
./setup.sh --connect adt_XXXX
docker compose up -d
```

That's it. Within a minute the deployment shows as **Connected** at app.anyray.ai.

| What | Where |
| --- | --- |
| **Console** | `http://<host>:3000` — sign in with the admin key `setup.sh` printed, then run the ~3-min in-console setup |
| **Gateway** | `http://<host>:8787/v1/…` — point AI tools and SDKs here |

> Keep ports 3000 and 8787 reachable from your org network only — never public.

## Add a provider key (required)

The gateway can't serve requests until it has an LLM provider key. Add it in the
console (*provider-keys settings*), or in `.env` then re-run `docker compose up -d`:

```bash
ANYRAY_PROVIDER_KEY_OPENAI=…      # or _ANTHROPIC / _AZURE_OPENAI
```

Developers never see this key — their tools use a placeholder.

## Connect developers — zero install

Hand your team the **setup link** (`https://app.anyray.ai/setup/dvl_…`) from the
portal. They run one line — no Node, no npm, nothing to install. The installer
fetches a checksum-verified `anyray-connect` binary for their OS and points their
AI tools (Claude Code, Codex, …) at the gateway.

```bash
# macOS / Linux
curl -fsSL https://app.anyray.ai/connect.sh | sh -s -- <setup-link>
```
```powershell
# Windows (PowerShell)
& ([scriptblock]::Create((irm https://app.anyray.ai/connect.ps1))) "<setup-link>"
```

Flags pass straight through (e.g. `--subscription`; subscription-org links set it
automatically). Prefer a package manager? `npx anyray-connect <setup-link>` still
works (needs Node).

## Deployment options

Docker Compose (above) is the default. Each target has its own recipe:

| Target | Command / artifact | Docs |
| --- | --- | --- |
| **Kubernetes (Helm / ArgoCD)** | GitOps-native OCI chart: `oci://public.ecr.aws/h4e6s7a8/anyray` (or `./setup.sh --k8s …` + `helm install` from source) | [`helm/README.md`](./helm/README.md) |
| **AWS (CloudFormation)** | One-click ECS/Fargate + RDS + EFS stack; secrets via Secrets Manager | [`aws/`](./aws/) |
| **Google Cloud (GKE Autopilot)** | One-click Cloud Shell deploy of the bundled Helm chart | [`gcp/README.md`](./gcp/README.md) |
| **Google Cloud (Compute Engine VM)** | One-click Cloud Shell deploy; docker compose on one VM (no Kubernetes, no managed DB) | [`gcp/gce/README.md`](./gcp/gce/README.md) |
| **Railway** | One-click; Railway generates every secret | [`railway/README.md`](./railway/README.md) |
| **LiteLLM attach** | Runs only the optimizer + console as a LiteLLM hook (no Anyray gateway) | [`attach/litellm/README.md`](./attach/litellm/README.md) |

For Helm, use an existing namespace unless your cluster policy says otherwise.

## Other setups

**Remote Docker host** (EC2 / GCP / any VM with SSH + Docker):

```bash
./setup.sh --host <vm-ip-or-hostname> --connect adt_XXXX
DOCKER_HOST=ssh://user@<vm> docker compose up -d
```

**Front an existing gateway** (LiteLLM / OpenRouter / any OpenAI-compatible) — run
Anyray on top with `--upstream`. Tools point at the Anyray gateway and send normal
requests; no per-request `x-anyray-config` header needed.

```bash
./setup.sh --connect adt_XXXX --upstream http://host.docker.internal:4000
docker compose up -d
```

> Inside Docker, `localhost` is the gateway container — use `host.docker.internal`
> (or the host LAN IP) for an upstream on the host. Re-run `./setup.sh --upstream <url>`
> to change it later. `--upstream` also clears the proxy allowlist for that host.

**Public exposure** (remote devs / Cursor / Copilot BYOK) — terminate TLS with the
bundled Caddy. In `.env` set `ANYRAY_PUBLIC_DOMAIN` (DNS A record → host),
`ANYRAY_GATEWAY_BIND=127.0.0.1`, and `ANYRAY_TRUST_PROXY=true`, then:

```bash
docker compose --profile public up -d
```

Caddy serves HTTPS on 443 with automatic Let's Encrypt certs and 403s the admin
surface, so the console and `/admin` stay in-network only. This HTTPS URL is what
editor BYOK endpoints (Copilot Chat, Cursor) point at —
`anyray-connect --tools copilot` prints the exact VS Code steps.

The gateway is **always** restricted to enrolled developers — secure-by-default,
no toggle. Passwordless, offline hardening: only devices whose `anyray-connect`
run enrolled a per-device key against the gateway's pinned trust anchor get through;
everyone else gets a 403. Enroll developers (`anyray-connect --enroll` / `--sso`)
before sending traffic.

## Upgrade

```bash
git pull && docker compose pull && docker compose up -d
```

New optimizer default profiles ship in the image but seed config only on first run,
so an existing deployment keeps its saved config. To adopt new defaults, update the
optimizer config from the console — your `.env` and secrets are untouched.

## Repair / status

```bash
docker compose ps           # service health
docker compose logs <svc>   # diagnose a failing service
./setup.sh                  # safe to re-run; never overwrites .env
                            # (--connect rewrites only the connect vars)
```

## Security

- `setup.sh` generates every secret locally — nothing leaves your machine.
- Prompt/response content is encrypted at rest (AES-256-GCM) by default.
- The admin key (`ANYRAY_ADMIN_TOKEN` in `.env`) gates the console and all admin
  APIs. Rotate by editing `.env` and running `docker compose up -d`.
- The control-plane host and lease-verify key are pinned in the gateway image, so
  the billing kill-switch can't be bypassed by re-pointing the URL. Metering reports
  are content-free rollups; the pseudonym salt never leaves the machine.

## Install with an AI agent

Paste [AGENT.md](./AGENT.md) into Claude Code / Codex on a machine with your infra
access and it will drive the install for you.
