# Install Anyray with your AI agent

Copy everything below the line into Claude Code / Codex / your coding agent,
running on a machine that has access to your infrastructure.

---

You are installing Anyray, a self-hosted AI-spend optimizer (gateway +
optimizer + observability console). Docs: https://docs.anyray.ai

## Step 1 — Ask the operator (do not guess)

1. Where should Anyray run? (this machine / a remote VM with SSH — EC2, GCP,
   Hetzner, etc. / Kubernetes / somewhere else)
2. What hostname or IP will users reach it on? For Kubernetes, this must be the
   external Ingress/LoadBalancer hostname, not a node IP.
3. If Kubernetes: which namespace should Anyray run in? Use an existing
   namespace unless the operator explicitly asks you to create one. If they want
   the current kubectl/Helm namespace, confirm that explicitly and omit
   `--namespace`.
4. Their Anyray Cloud deployment token (starts with `adt_`) — they get it at
   https://app.anyray.ai (Deployments → Connect a deployment). If they don't
   want to connect to Anyray Cloud, install standalone (omit `--connect`).

## Step 2 — Platform preparation (your job)

- For Docker/VM installs, ensure the target machine has Docker Engine + Compose
  v2 and ~8 GB RAM free.
- For Kubernetes installs, ensure Kubernetes 1.24+, Helm 3.10+, a default
  StorageClass or explicit chart storage classes, and access to the target
  namespace. Do not create a namespace unless the operator approved it.
- Ensure ports 3000 (console) and 8787 (gateway API) are reachable from the
  org's network ONLY — e.g. a security group scoped to the office/VPN CIDR.
  NEVER open them to 0.0.0.0/0.
- If a DNS record is wanted, create it before installing and use it as <host>.

## Step 3 — Install (run exactly this; do not improvise)

On the target machine (or with DOCKER_HOST=ssh://user@<vm> from here):

    git clone https://github.com/anyrayHQ/install anyray && cd anyray
    ./setup.sh --host <host> --connect <adt_token>
    docker compose up -d

(Standalone install: drop `--connect <adt_token>`. If the gateway will be
reached at a URL other than http://<host>:8787 — e.g. behind TLS or a
load balancer — add `--gateway-url <url>` so the portal shows developers
the right connect URL.)

Do NOT hand-assemble compose files, edit image tags, or generate secrets
yourself — `setup.sh` and the pinned artifacts are the only install path.

For Kubernetes/Helm:

    git clone https://github.com/anyrayHQ/install anyray && cd anyray
    ./setup.sh --k8s --host <gateway-ingress-hostname> --namespace <existing-namespace> --connect <adt_token>
    kubectl apply -n <existing-namespace> -f anyray-secrets.yaml
    helm install anyray ./helm -f my-values.yaml --namespace <existing-namespace>

(Standalone install: drop `--connect <adt_token>`. If the operator explicitly
chooses the current kubectl/Helm namespace, omit `--namespace` and the `-n` /
`--namespace` flags. Never assume `default`; ask.)

## Step 4 — Verify and hand off

For Docker/VM:

    docker compose ps                      # all services healthy/running
    curl -fs http://<host>:8787/           # gateway answers
    curl -fso /dev/null http://<host>:3000/anyray-login && echo console-ok

For Kubernetes:

    kubectl rollout status -n <namespace> deployment/anyray-gateway
    kubectl rollout status -n <namespace> deployment/anyray-web
    curl -fsI https://<gateway-ingress-hostname>/ && echo console-ok

Report to the operator: the console URL (http://<host>:3000), where the admin
key lives (`ANYRAY_ADMIN_TOKEN` in `.env`, or in `anyray-secrets.yaml` for
Kubernetes — `setup.sh` printed it once), and that the next step is the
in-console setup (~3 min): connect a provider key, send a test request, invite
developers. If `--connect` was used, also tell them the deployment will appear
as Connected at https://app.anyray.ai within a minute.

## Hard rules

- NEVER ask for, read, or handle provider API keys (OpenAI/Anthropic/etc.) —
  the operator enters them in the console themselves.
- NEVER expose ports 3000/8787 publicly.
- NEVER set ANYRAY_CONTENT_MODE to `plaintext` or ANYRAY_ALLOW_PLAINTEXT=true.
- NEVER print the contents of `.env` or `anyray-secrets.yaml` into your
  conversation beyond confirming it exists. In particular
  ANYRAY_PSEUDONYM_SALT is privacy-critical and must never leave the machine —
  `setup.sh --connect` generates it locally.
