# Deploy Anyray on a Compute Engine VM

<walkthrough-tutorial-duration duration="10"></walkthrough-tutorial-duration>

This walkthrough stands up the full Anyray stack — gateway, optimizer, console,
and Postgres — with **docker compose on a single Compute Engine VM**. The
lightweight, single-box alternative to the GKE Autopilot one-click: no
Kubernetes, no managed database, no load balancer. The console (`:3000`) and
gateway (`:8787`) are reachable only from a CIDR you choose.

All container state lives on a **dedicated persistent disk**, so provider keys
and developer enrollments survive a VM rebuild. Content stays **encrypted at
rest**; only metadata is logged.

## Pick a project

<walkthrough-project-setup></walkthrough-project-setup>

Anyray needs the **Compute Engine** and **IAP** APIs — `deploy.sh` enables them
for you. IAP is used for the secure SSH that reads back your admin key (no SSH
port is exposed to the internet).

## Gather two values

You'll set these as environment variables in the next step:

1. **`ALLOWED_CIDR`** — the network range allowed to reach the console and
   gateway. Scope it to your **office or VPN** range. For a single workstation,
   run `curl -fsS https://api.ipify.org` and append `/32`.
   **Never use `0.0.0.0/0`** — these endpoints carry spend data and admin access.

2. **`DEPLOYMENT_TOKEN`** — your Anyray Cloud deployment token (`adt_…`). Get one
   at [app.anyray.ai](https://app.anyray.ai) → **Deployments → Connect a
   deployment**. It connects this deployment to Anyray Portal for content-free
   usage metering.

## Set your inputs and deploy

Export your two required values (optionally override the zone/machine type), then
run the deploy script:

```bash
export ALLOWED_CIDR="203.0.113.0/24"     # ← your office / VPN range
export DEPLOYMENT_TOKEN="adt_..."        # ← from app.anyray.ai
# Optional overrides:
# export ZONE="us-central1-a"
# export INSTANCE="anyray"
# export MACHINE_TYPE="e2-standard-2"    # 2 vCPU / 8 GB
# export IMAGE_TAG="latest"              # or pin vX.Y.Z

./gcp/gce/deploy.sh
```

<walkthrough-editor-open-file filePath="gcp/gce/deploy.sh">Open deploy.sh</walkthrough-editor-open-file>
to read exactly what it does first.

The script:
1. Enables the required APIs and creates two firewall rules — the console +
   gateway scoped to your `ALLOWED_CIDR`, and SSH **only** via Google IAP.
2. Creates the VM (Ubuntu 24.04 LTS) with a persistent data disk. A first-boot
   script installs Docker, generates every secret locally, connects to Anyray
   Portal, and starts the stack.
3. Waits for first boot, then reads back and prints your **Console URL**,
   **Gateway URL**, and **admin key**.

## You're done

<walkthrough-conclusion-trophy></walkthrough-conclusion-trophy>

Open the **Console URL** the script printed and sign in with the **admin key**,
then:

- **Add a provider key** on the **Providers** page (kept server-side).
- **Enroll your developers** from **Invite developers** — each runs
  `npx anyray-connect --gateway <GatewayURL>` to point their tools at Anyray.

The deployment shows as **Connected** at
[app.anyray.ai](https://app.anyray.ai) within a minute. Full docs:
[docs.anyray.ai](https://docs.anyray.ai/get-started/install/gce).
