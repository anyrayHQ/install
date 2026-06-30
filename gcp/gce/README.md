# Anyray on a Compute Engine VM (one-click)

Deploy the full Anyray stack — gateway, optimizer, console, and Postgres — with
**docker compose on a single Compute Engine VM**. The lightweight, single-box
counterpart to the [GKE Autopilot one-click](../README.md): no Kubernetes, no
managed database, no load balancer — the cheapest way to run Anyray managed on
Google Cloud. The console (`:3000`) and gateway (`:8787`) are reachable only from
a CIDR you provide.

It reuses the same images and [`setup.sh`](../../setup.sh) +
[`docker-compose.yml`](../../docker-compose.yml) as the [Local / VM](../../README.md)
install — the one-click only adds the VM provisioning, the persistent data disk,
and the CIDR-scoped firewall.

## Why a VM and not Cloud Run

The gateway keeps **provider keys** and **developer enrollments** (minted client
keys) as files on a persistent `/data` volume and runs as a single instance. It
wants durable local disk, not an ephemeral serverless filesystem — so a VM with a
persistent disk is the right managed shape, and Cloud Run is not. Teams already
on Kubernetes should use the [GKE one-click](../README.md) instead.

## One-click (Cloud Shell)

[![Open in Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.svg)](https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/anyrayHQ/install&cloudshell_workspace=.&cloudshell_tutorial=gcp/gce/walkthrough.md)

The button clones this repo into Cloud Shell and opens an interactive
walkthrough ([`walkthrough.md`](./walkthrough.md)) that collects your inputs and
runs [`deploy.sh`](./deploy.sh). Cloud Shell already has `gcloud`.

## Run it yourself

From any machine with the gcloud SDK authenticated to your project:

```bash
git clone https://github.com/anyrayHQ/install anyray && cd anyray

export PROJECT_ID="my-gcp-project"
export ALLOWED_CIDR="203.0.113.0/24"     # your office / VPN range — never 0.0.0.0/0
export DEPLOYMENT_TOKEN="adt_..."        # from app.anyray.ai → Deployments

./gcp/gce/deploy.sh
```

### Inputs

| Variable | Required | Default | What it is |
|---|---|---|---|
| `PROJECT_ID` | yes | gcloud's active project | GCP project to deploy into. |
| `ALLOWED_CIDR` | yes | — | CIDR allowed to reach the console/gateway. Scope to office/VPN; `0.0.0.0/0` is rejected. |
| `DEPLOYMENT_TOKEN` | yes | — | Anyray Cloud deployment token (`adt_…`) for usage metering. |
| `ZONE` | no | `us-central1-a` | VM zone. |
| `INSTANCE` | no | `anyray` | VM name (reused if it already exists). |
| `MACHINE_TYPE` | no | `e2-standard-2` | VM size (2 vCPU / 8 GB). |
| `DISK_SIZE` | no | `20GB` | Persistent data-disk size. |
| `IMAGE_TAG` | no | `latest` | Anyray image tag; pin `vX.Y.Z` for a reproducible deploy. |
| `DEFAULT_MODEL` | no | `anthropic/claude-sonnet-4-5` | Target for the `anyray-default` model alias. |
| `NETWORK` | no | `default` | VPC network for the VM + firewall rules. |

## What you get

| Service | Exposure | What it is |
|---|---|---|
| gateway | host `:8787` (firewall-scoped to your CIDR) | OpenAI-compatible multi-provider API |
| proxy (console) | host `:3000` (firewall-scoped to your CIDR) | Admin console (Spend, Traces, Optimizer, Privacy) |
| optimizer | in-VM only | Request/response optimization hook |
| postgres | in-VM only | Spend store (content-free) + trace store (content per `ANYRAY_CONTENT_MODE`) |

All container state — the gateway/optimizer `/data` volumes **and** Postgres —
lives on a dedicated persistent disk (Docker's `data-root`) that is **not**
auto-deleted with the VM, so provider keys and developer enrollments survive a VM
rebuild. Every secret (admin token, content key, Postgres password, pseudonym
salt) is generated **on the VM** by `setup.sh` and never leaves it; only the
`adt_` deployment token (a metering credential, not an admin key) is passed via
instance metadata.

## After it's up

`deploy.sh` prints the **Console URL**, **Gateway URL**, and **admin key** (read
back over IAP SSH). Open the console, add a provider key, and enroll developers —
see the [GCE install page](https://docs.anyray.ai/get-started/install/gce).

## Operate

```bash
# SSH in (IAP — no public SSH port):
gcloud compute ssh anyray --zone us-central1-a --tunnel-through-iap

# On the VM, the stack lives in /opt/anyray:
cd /opt/anyray
sudo docker compose ps
sudo docker compose logs -f gateway
```

## Upgrade

The default `IMAGE_TAG=latest` follows the moving release channel. The console's
one-click **Update now** button pulls the latest images. To converge manually, or
to pin a tag:

```bash
gcloud compute ssh anyray --zone us-central1-a --tunnel-through-iap
cd /opt/anyray
# (optional) pin a tag: edit ANYRAY_IMAGE_TAG=vX.Y.Z in .env
sudo docker compose pull && sudo docker compose up -d
```
