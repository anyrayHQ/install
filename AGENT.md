# Install Anyray with your AI agent

Copy everything below the line into Claude Code / Codex / your coding agent,
running on a machine that has access to your infrastructure.

---

You are installing Anyray, a self-hosted AI-spend optimizer (gateway +
optimizer + observability console). Docs: https://docs.anyray.ai

## Step 1 — Ask the operator (do not guess)

1. Where should Anyray run? (this machine / a remote VM with SSH — EC2, GCP,
   Hetzner, etc. / somewhere else)
2. What hostname or IP will users reach it on?

## Step 2 — Platform preparation (your job)

- Ensure the target machine has Docker Engine + Compose v2 and ~8 GB RAM free.
- Ensure ports 3000 (console) and 8787 (gateway API) are reachable from the
  org's network ONLY — e.g. a security group scoped to the office/VPN CIDR.
  NEVER open them to 0.0.0.0/0.
- If a DNS record is wanted, create it before installing and use it as <host>.

## Step 3 — Install (run exactly this; do not improvise)

On the target machine (or with DOCKER_HOST=ssh://user@<vm> from here):

    git clone https://github.com/anyrayHQ/install anyray && cd anyray
    ./setup.sh --host <host>
    docker compose up -d

Do NOT hand-assemble compose files, edit image tags, or generate secrets
yourself — `setup.sh` and the pinned artifacts are the only install path.

## Step 4 — Verify and hand off

    docker compose ps                      # all services healthy/running
    curl -fs http://<host>:8787/           # gateway answers
    curl -fso /dev/null http://<host>:3000/anyray-login && echo console-ok

Report to the operator: the console URL (http://<host>:3000), where the admin
key lives (`.env`, `ANYRAY_ADMIN_TOKEN` — `setup.sh` printed it once), and that
the next step is the in-console setup (~3 min): connect a provider key, send a
test request, invite developers.

## Hard rules

- NEVER ask for, read, or handle provider API keys (OpenAI/Anthropic/etc.) —
  the operator enters them in the console themselves.
- NEVER expose ports 3000/8787 publicly.
- NEVER set ANYRAY_CONTENT_MODE to `plaintext` or ANYRAY_ALLOW_PLAINTEXT=true.
- NEVER print the contents of `.env` into your conversation beyond confirming
  it exists.
