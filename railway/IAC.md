# Anyray on Railway — Infrastructure-as-Code

An alternative to the one-click template: deploy the Anyray stack from
`.railway/railway.ts` (Railway [Infrastructure-as-Code](https://docs.railway.com/infrastructure-as-code)).

Use this path when you want a repo-managed deploy instead of the marketplace
template. CI updates the pinned image tag, and `railway config apply` deploys it
without dashboard edits.

## What it provisions

`gateway`, `optimizer`, `proxy`, and a `Postgres` database — the same stack as the
template, pinned to a concrete release tag, with content-free spend/trace storage in
Postgres and content AES-256-GCM encrypted at rest.

## Install

Prerequisites: the [Railway CLI](https://docs.railway.com/guides/cli), Node.js,
`openssl`, and an Anyray deployment token (`adt_…`) from
[app.anyray.ai](https://app.anyray.ai) → Deployments.

```bash
git clone https://github.com/anyrayHQ/install && cd install
npm install                       # pulls the railway IaC SDK (see package.json)

railway login
railway init -n anyray            # or: railway link  (to an existing empty project)
railway config apply              # provisions gateway / optimizer / proxy / Postgres

railway/railway-iac-bootstrap.sh adt_your_deployment_token
                                  # adds Billing, secrets, and public domains
```

`railway config plan` previews the changes before `apply`.

## Why the bootstrap step

Railway IaC cannot generate secrets, accept the Billing token, or create public
domains. The bootstrap completes those steps and is safe to re-run:

1. **Generated secrets** — `ANYRAY_ADMIN_TOKEN`, `ANYRAY_CONTENT_KEY`,
   `ANYRAY_OPTIMIZER_TOKEN`, `ANYRAY_PSEUDONYM_SALT`, `ANYRAY_UPDATER_TOKEN`. They're
   `preserve()`d in `railway.ts`, so `apply` never overwrites them.
2. **Billing token** — the required `adt_…` token supplied to the bootstrap.
3. **Public domains** — the generated URLs for the gateway (`:8787`) and console (`:80`),
   and the `ANYRAY_*_PUBLIC_URL` vars that reference them.

## Upgrades

`git pull && railway config apply` — the tag in `.railway/railway.ts` tracks the latest
release (bumped in CI), so a pull + apply rolls the stack forward. Secrets and domains
are preserved.
