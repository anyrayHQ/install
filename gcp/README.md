# Anyray on GKE Autopilot (one-click)

Deploy the full Anyray stack — gateway, optimizer, console, and Postgres — to a
**GKE Autopilot** cluster. This is the Google Cloud analog of the AWS
CloudFormation quick-launch: a managed control plane with no nodes to size and no
bootstrap server to SSH into. The gateway API (`:8787`) and console (`:3000`)
come up as LoadBalancer Services scoped to a CIDR you provide.

It reuses the same [Helm chart](../helm) as the manual Kubernetes install — the
one-click only adds the cluster provisioning and the GKE-specific exposure.

## One-click (Cloud Shell)

[![Open in Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.svg)](https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/anyrayHQ/install&cloudshell_workspace=.&cloudshell_tutorial=gcp/walkthrough.md)

The button clones this repo into Cloud Shell and opens an interactive
walkthrough ([`walkthrough.md`](./walkthrough.md)) that collects your inputs and
runs [`deploy.sh`](./deploy.sh). Cloud Shell already has `gcloud`, `kubectl`, and
`helm`.

## Run it yourself

From any machine with the gcloud SDK, `kubectl`, and `helm` authenticated to your
project:

```bash
git clone https://github.com/anyrayHQ/install anyray && cd anyray

export PROJECT_ID="my-gcp-project"
export ALLOWED_CIDR="203.0.113.0/24"     # your office / VPN range — never 0.0.0.0/0
export DEPLOYMENT_TOKEN="adt_..."        # from app.anyray.ai → Deployments

./gcp/deploy.sh
```

### Inputs

| Variable | Required | Default | What it is |
|---|---|---|---|
| `PROJECT_ID` | yes | gcloud's active project | GCP project to deploy into. |
| `ALLOWED_CIDR` | yes | — | CIDR allowed to reach the console/gateway LBs. Scope to office/VPN; `0.0.0.0/0` is rejected. |
| `DEPLOYMENT_TOKEN` | yes | — | Anyray Cloud deployment token (`adt_…`) for usage metering. |
| `REGION` | no | `us-central1` | Autopilot region. |
| `CLUSTER` | no | `anyray` | Cluster name (reused if it already exists). |
| `NAMESPACE` | no | `anyray` | Kubernetes namespace. |
| `IMAGE_TAG` | no | `latest` | Anyray image tag; pin `vX.Y.Z` for a reproducible deploy. |
| `DEFAULT_MODEL` | no | `anthropic/claude-sonnet-4-5` | Target for the `anyray-default` model alias. |

## What you get

| Service | Exposure | What it is |
|---|---|---|
| gateway | LoadBalancer `:8787` (CIDR-scoped) | OpenAI-compatible multi-provider API |
| proxy (console) | LoadBalancer `:3000` (CIDR-scoped) | Admin console (Spend, Traces, Optimizer, Privacy) |
| optimizer | ClusterIP (internal) | Request/response optimization hook |
| postgres | ClusterIP + PVC (internal) | Spend store (content-free) + trace store (content per `ANYRAY_CONTENT_MODE`) |

The bundled Postgres and the gateway/optimizer `/data` PVCs bind GKE Autopilot's
default `standard-rwo` StorageClass — nothing to pre-create. Secrets (admin
token, content key, pseudonym salt) are generated locally by `setup.sh` and
stored as the `anyray-secrets` Kubernetes Secret; a re-run keeps an existing
Secret rather than rotating the content key.

## After it's up

`deploy.sh` prints the **Console URL**, **Gateway URL**, and **admin key**. Open
the console, add a provider key, and enroll developers — see the
[GKE install page](https://docs.anyray.ai/get-started/install/gcp).

## Upgrade

Re-run `./gcp/deploy.sh` (it is `helm upgrade --install`), or pin a tag and run
the chart directly:

```bash
helm upgrade anyray ./helm -f my-values.yaml \
  --namespace "$NAMESPACE" --reuse-values --set image.tag=vX.Y.Z
```
