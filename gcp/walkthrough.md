# Deploy Anyray on GKE Autopilot

<walkthrough-tutorial-duration duration="12"></walkthrough-tutorial-duration>

This walkthrough stands up the full Anyray stack — gateway, optimizer, console,
and Postgres — on a **GKE Autopilot** cluster: a managed control plane with no
nodes to size and no server to SSH into. The gateway API (`:8787`) and console
(`:3000`) come up as LoadBalancer Services scoped to a CIDR you choose.

Content stays **encrypted at rest**; only metadata is logged.

## Pick a project

<walkthrough-project-setup></walkthrough-project-setup>

Anyray needs the **Kubernetes Engine** and **Compute Engine** APIs — `deploy.sh`
enables them for you.

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

Export your two required values (optionally override the region/cluster), then
run the deploy script:

```bash
export ALLOWED_CIDR="203.0.113.0/24"     # ← your office / VPN range
export DEPLOYMENT_TOKEN="adt_..."        # ← from app.anyray.ai
# Optional overrides:
# export REGION="us-central1"
# export CLUSTER="anyray"
# export NAMESPACE="anyray"
# export IMAGE_TAG="latest"              # or pin vX.Y.Z

./gcp/deploy.sh
```

<walkthrough-editor-open-file filePath="gcp/deploy.sh">Open deploy.sh</walkthrough-editor-open-file>
to read exactly what it does first.

The script:
1. Enables the required APIs and creates the **Autopilot** cluster (a few minutes).
2. Generates every secret locally (content key, admin token, pseudonym salt).
3. Installs the Helm chart with the gateway + console as **CIDR-scoped
   LoadBalancers** and bundled Postgres.
4. Waits for the load balancer IPs and prints your **Console URL**, **Gateway
   URL**, and **admin key**.

## You're done

<walkthrough-conclusion-trophy></walkthrough-conclusion-trophy>

Open the **Console URL** the script printed and sign in with the **admin key**,
then:

- **Add a provider key** on the **Providers** page (kept server-side).
- **Enroll your developers** from **Invite developers** — each runs
  `npx anyray-connect --gateway <GatewayURL>` to point their tools at Anyray.

The deployment shows as **Connected** at
[app.anyray.ai](https://app.anyray.ai) within a minute. Full docs:
[docs.anyray.ai](https://docs.anyray.ai/get-started/install/gcp).
