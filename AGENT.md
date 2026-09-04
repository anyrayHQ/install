# Install Anyray with your AI agent

Create a deployment at [app.anyray.ai](https://app.anyray.ai), then copy the
prompt under **Install with your coding agent**. Paste it into Claude Code,
Codex, or another coding agent running where it can reach your infrastructure.

## The prompt

```text
Install Anyray for my organization. Open <install_url>, follow the agent instructions exactly, and continue until that URL reports status `ready`. Do not ask me for a deployment token or provider API keys, and never print, echo, or log credentials.
```

The portal fills in `<install_url>` with a one-hour, single-use `aic_` link. The
durable deployment credential is not part of the prompt. The installer redeems
it on the target machine and writes it directly to `.env` or
`anyray-secrets.yaml` without placing it in stdout, stderr, or command arguments.

## What to expect

The link serves the current runbook and reports progress through:

```text
pending -> claimed -> preflight -> configured -> gateway_connected -> ready
```

The agent may ask where Anyray should run, which host users will reach, and the
existing Kubernetes namespace when applicable. It must not ask for a deployment
token or provider API keys.

`ready` means both checks completed:

- The local verifier passed gateway and admin health checks.
- Billing received a heartbeat from the newly issued deployment credential.

If the link expires or reports `error`, create a fresh install link for the same
deployment in the portal and paste the new prompt.

## Safety rules

- Keep ports 3000 and 8787 private to the organization's network.
- Do not print `.env` or `anyray-secrets.yaml`.
- Enter provider API keys in the Anyray console after the deployment is ready.
- Use `setup.sh` and the published install artifacts. Do not hand-build manifests
  or change image tags during setup.
