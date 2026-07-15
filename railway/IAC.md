# Anyray on Railway — Infrastructure-as-Code

An alternative to the one-click template: deploy the Anyray stack from
`.railway/railway.ts` (Railway [Infrastructure-as-Code](https://docs.railway.com/infrastructure-as-code)).

**Why this exists.** Railway's marketplace template can only be edited by hand in the
dashboard — its API can't update a published template's images (`templatePublish` is
metadata-only; `templateGenerate` mints a new template code), so it drifts out of date.
This IaC path is **repo-owned**: the pinned image tag in `.railway/railway.ts` is bumped by
the monorepo prod promotion on every release, so `railway config apply` always provisions
the current build. No dashboard step, no stale `:stable`.

## What it provisions

`gateway`, `optimizer`, `proxy`, and a `Postgres` database — the same stack as the
template, pinned to a concrete release tag, with content-free spend/trace storage in
Postgres and content AES-256-GCM encrypted at rest.

## Install

Prerequisites: the [Railway CLI](https://docs.railway.com/guides/cli), Node.js, and `openssl`.

```bash
git clone https://github.com/anyrayHQ/install && cd install
npm install                       # pulls the railway IaC SDK (see package.json)

railway login
railway init -n anyray            # or: railway link  (to an existing empty project)
railway config apply              # provisions gateway / optimizer / proxy / Postgres

railway/railway-iac-bootstrap.sh  # seeds generated secrets + public domains
```

`railway config plan` previews the changes before `apply`.

## Why the bootstrap step

Three things Railway IaC can't express declaratively, so the bootstrap seeds them once
(idempotently — safe to re-run):

1. **Generated secrets** — `ANYRAY_ADMIN_TOKEN`, `ANYRAY_CONTENT_KEY`,
   `ANYRAY_OPTIMIZER_TOKEN`, `ANYRAY_PSEUDONYM_SALT`, `ANYRAY_UPDATER_TOKEN`. They're
   `preserve()`d in `railway.ts`, so `apply` never overwrites them.
2. **Public domains** — the generated URLs for the gateway (`:8787`) and console (`:80`),
   and the `ANYRAY_*_PUBLIC_URL` vars that reference them.
3. **Coordinated activation** — when this install revision declares the
   `persistentTranscriptPolicyV1` capability, one future
   `ANYRAY_PERSISTENT_TRANSCRIPT_POLICY_ACTIVATE_AT`, preserved after it is set
   so later applies never move the activation boundary. Older repository
   revisions without the capability marker deliberately leave this unset.

## Connect metering (Billing app)

Every deployment connects to the Anyray Billing app. Provision a deployment token
(`adt_…`) at [app.anyray.ai](https://app.anyray.ai) → Deployments, then:

```bash
railway/railway-iac-bootstrap.sh adt_your_deployment_token
```

## Upgrades

`git pull && railway config apply` — the tag in `.railway/railway.ts` tracks the latest
release (bumped in CI), so a pull + apply rolls the stack forward. Secrets, domains, and
an existing activation instant are preserved.

When moving from an older repository revision to one that declares the install
capability, pull and run `railway config apply` first; this stages the matching
gateway and optimizer with the policy still inactive. Then rerun
`railway/railway-iac-bootstrap.sh`. It reads the persistent repository marker,
creates a fresh instant one hour from that run, and redeploys the gateway without
replacing an existing value. Confirm both services are healthy before that
instant; roll back before it if either is not. Later applies must keep the same
timestamp, even after it is in the past. Image tags remain immutable deployment
pins; they do not toggle this install behavior.
