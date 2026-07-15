# Anyray on AKS (one-click)

Deploy the full Anyray stack — gateway, optimizer, console, and Postgres — to a
managed **Azure Kubernetes Service (AKS)** cluster. This is the Azure analog of the
AWS CloudFormation / GKE Autopilot quick-launches: a managed control plane with no
bootstrap server to SSH into. The gateway API (`:8787`) and console (`:3000`) come
up as LoadBalancer Services scoped to a CIDR you provide.

It reuses the same [Helm chart](../helm) as the manual Kubernetes install — the
one-click only adds the cluster provisioning and the AKS-specific exposure.

## One-click (Azure Cloud Shell)

[![Launch Cloud Shell](https://shell.azure.com/images/launchcloudshell.png)](https://shell.azure.com/bash)

Azure Cloud Shell already has `az`, `kubectl`, and `helm`. Clone this repo and run
the deploy script:

```bash
git clone https://github.com/anyrayHQ/install anyray && cd anyray

export ALLOWED_CIDR="203.0.113.0/24"     # your office / VPN range — never 0.0.0.0/0
export DEPLOYMENT_TOKEN="adt_..."        # from app.anyray.ai → Deployments

./azure/deploy.sh
```

(Azure Cloud Shell has no GCP-style pre-clone deep link, so the clone is the first
step rather than something the button does for you.)

## Run it yourself

From any machine with the Azure CLI (`az`), `kubectl`, and `helm` authenticated to
your subscription (`az login`):

```bash
git clone https://github.com/anyrayHQ/install anyray && cd anyray

export SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"
export ALLOWED_CIDR="203.0.113.0/24"     # your office / VPN range — never 0.0.0.0/0
export DEPLOYMENT_TOKEN="adt_..."        # from app.anyray.ai → Deployments

./azure/deploy.sh
```

### Inputs

| Variable | Required | Default | What it is |
|---|---|---|---|
| `ALLOWED_CIDR` | yes | — | CIDR allowed to reach the console/gateway LBs. Scope to office/VPN; `0.0.0.0/0` is rejected. |
| `DEPLOYMENT_TOKEN` | yes | — | Anyray Cloud deployment token (`adt_…`) for usage metering. |
| `SUBSCRIPTION_ID` | no | az's active subscription | Azure subscription to deploy into. |
| `LOCATION` | no | `eastus` | Azure region. |
| `RESOURCE_GROUP` | no | `anyray` | Resource group (created if missing, reused if present). |
| `CLUSTER` | no | `anyray` | AKS cluster name (reused if it already exists). |
| `NAMESPACE` | no | `anyray` | Kubernetes namespace. |
| `NODE_VM_SIZE` | no | `Standard_D2s_v5` | Node pool VM size. |
| `NODE_COUNT` | no | `2` | Node pool size. |
| `IMAGE_TAG` | no | template default | One-click accepts only the chart's coordinated release pin or `policy-stable`. |
| `DEFAULT_MODEL` | no | `anthropic/claude-sonnet-4-5` | Target for the `anyray-default` model alias. |

## What you get

| Service | Exposure | What it is |
|---|---|---|
| gateway | LoadBalancer `:8787` (CIDR-scoped) | OpenAI-compatible multi-provider API |
| proxy (console) | LoadBalancer `:3000` (CIDR-scoped) | Admin console (Spend, Traces, Optimizer, Privacy) |
| optimizer | ClusterIP (internal) | Request/response optimization hook |
| postgres | ClusterIP + PVC (internal) | Spend store (content-free) + trace store (content per `ANYRAY_CONTENT_MODE`) |

The bundled Postgres and the gateway/optimizer `/data` PVCs bind AKS's
default-annotated `default` StorageClass (Azure Disk CSI) — nothing to pre-create.
Secrets (admin token, content key, pseudonym salt) are generated locally by
`setup.sh` and stored as the `anyray-secrets` Kubernetes Secret; a re-run keeps an
existing Secret rather than rotating the content key.

## After it's up

`deploy.sh` prints the **Console URL**, **Gateway URL**, and **admin key**. Open the
console, add a provider key, and enroll developers — see the
[AKS install page](https://docs.anyray.ai/get-started/install/azure).

## Upgrade

Re-run `./azure/deploy.sh` (it is `helm upgrade --install`). The one-click path
rejects any other immutable tag before provisioning; to select one, verify both
runtime capability labels and run the chart directly:

When the template follows `policy-stable`, the deploy script explicitly
restarts and waits for the app Deployments so Kubernetes resolves the promoted
digest with `imagePullPolicy: Always`.

The first rerun with a capability-aware chart backfills one
`persistentTranscriptPolicyActivateAt` value an hour in the future into
`my-values.yaml`; later reruns preserve it. Confirm gateway and optimizer finish
rolling before that instant, and roll back before it if either is unhealthy.

```bash
helm upgrade anyray ./helm -f my-values.yaml \
  --namespace "$NAMESPACE" --reuse-values \
  --set image.tag=vX.Y.Z \
  --set persistentTranscriptPolicyImageCapabilityConfirmed=true
```

Use the confirmation only after both pinned gateway and optimizer image configs
have been verified to carry
`ai.anyray.capability.persistent-transcript-policy-v1=true`.
