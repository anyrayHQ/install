# Anyray Railway Template

Deploy Anyray to Railway with one click. Railway generates the stack secrets;
you provide the required Billing deployment token.

Note: Railway has no repo-hosted template format — templates are composed in
the Railway dashboard (Template Composer). `railway.template.json` here is the
authoritative spec to compose from: service names, images, variables (including
cross-service references), start commands, and volume mount paths.

## Deploy

1. Get a deployment token (`adt_…`) from <https://app.anyray.ai> →
   Deployments → Connect a deployment.
2. Click "Deploy on Railway" on the Anyray docs page, or open the published
   template URL directly: <https://railway.com/deploy/anyray>.
3. Create the project and enter the deployment token when prompted. Railway
   generates the other secrets.
4. Wait for all services to deploy (~3 min).
5. Open the `proxy` service → "Settings" → "Public Networking" → Generate domain
   (target port 80 — nginx listens there, not on $PORT).
   This is your console URL.
6. Open the `gateway` service → "Settings" → "Public Networking" → Generate domain.
   This is your gateway API URL (use this in the developer connect one-liner (see the main README)).

The gateway persists content-free traces to Postgres (`anyray_traces` /
`anyray_observations`, auto-created) and reads them back in-process for the
console — no separate observability datastores are needed.

## Billing

The template always enables content-free usage metering and generates the local
pseudonym salt. Enter your `adt_…` token as `ANYRAY_DEPLOYMENT_TOKEN` during
deployment. The deployment should show as **Connected** at
<https://app.anyray.ai> about 10 seconds after the gateway starts.

## Variables reference

| Variable                       | Source                          | Notes                                                                       |
|--------------------------------|---------------------------------|-----------------------------------------------------------------------------|
| `ANYRAY_DEPLOYMENT_TOKEN`      | Operator                        | Required `adt_…` token from app.anyray.ai.                                  |
| `ANYRAY_ADMIN_TOKEN`           | `${{secret()}}` on gateway      | Printed in Railway after deploy. Gates console.                             |
| `ANYRAY_CONTENT_KEY`           | `${{secret(64, "0123456789abcdef")}}` on gateway | 32-byte hex AES-256-GCM at-rest encryption key.                             |
| `ANYRAY_OBSERVABILITY_DB_URL`  | `${{Postgres.*}}` refs          | Postgres URL for the content-free trace store (falls back to spend DB URL). |
| `POSTGRES_PASSWORD`            | `${{secret()}}` on Postgres     | Never leaves Railway's environment.                                         |
| `ANYRAY_CONTENT_MODE`          | `encrypted` on gateway          | Read by the OPTIMIZER (which inherits it); the gateway ignores it. See "Content privacy". A default, not a lock. |
| `ANYRAY_ALLOW_PLAINTEXT`       | `false` on gateway              | Deploy gate for `plaintext`. The optimizer inherits it.                     |

### Content privacy

The **gateway's** content mode is set in the console (**Privacy** page) and stored
in the shared database — there is no environment variable for it, so a change
applies to every replica and there is one place to audit it. New deployments start
on `encrypted`.

`ANYRAY_CONTENT_MODE` governs only the paths that run without a gateway in the
loop: BYO `/v1/record` writes and attach-style use, both of which execute in the
optimizer process. The template sets it on the **gateway** service and the
optimizer inherits it by reference, so there is one place to edit — the gateway
itself no longer reads it. The template ships `encrypted` as the default; it is an
ordinary editable variable, not a fixed value.

To capture content in plaintext (debugging only — it stores raw prompts and
responses), BOTH are required, because plaintext is deliberately deploy-gated:

```bash
# both on the gateway service; the optimizer inherits both
ANYRAY_ALLOW_PLAINTEXT=true
ANYRAY_CONTENT_MODE=plaintext        # the optimizer's gateway-less paths
# and for the gateway itself: set the mode to plaintext on the console Privacy page
```

Without the gate, a `plaintext` mode degrades to `encrypted` (or to `off` when no
content key is set) rather than storing raw content — the effective mode only ever
degrades, never escalates.

After generating public domains, redeploy or restart the gateway so Railway
resolves the template's public-domain references. `ANYRAY_TRUST_PROXY` and
`ANYRAY_HSTS` are already set by the template.

`/v1/*` is always restricted to verified developers (a minted client key) —
secure-by-default, no toggle; enroll developers before sending traffic. Optional
traffic controls:

```bash
ANYRAY_RATE_LIMIT_RPM=600
ANYRAY_RATE_LIMIT_IP_RPM=1200
ANYRAY_RATE_LIMIT_UNAUTH_RPM=60
ANYRAY_MAX_CONCURRENT_REQUESTS=20
ANYRAY_MAX_BODY_BYTES=10485760
```

## Manual verification (required after template is first published)

The template can only be verified by deploying it. After composing it in the
dashboard from `railway/railway.template.json`:

1. Log in to Railway: <https://railway.com>
2. "New Project" → "Deploy a template" → search "Anyray" (or use the direct
   template URL from the Railway dashboard after submission).
3. Verify all 4 services (`gateway`, `optimizer`, `proxy`, `Postgres`) start
   without errors.
4. Probe: `curl https://<gateway-domain>/` → expect `AI Gateway` response.
5. Probe: `curl -fso /dev/null -w "%{http_code}" https://<proxy-domain>/anyray-login`
   → expect `200`.
6. If any variable reference fails (e.g. `${{Postgres.POSTGRES_PASSWORD}}`
   not resolving), adjust the reference and redeploy. Railway's cross-service
   variable references are verified only during live deploy.
7. Railway's private network is IPv6-only. The `proxy` start command rewrites
   nginx upstreams to `*.railway.internal`; if any service is unreachable over
   the private network, check that it binds `::` (all interfaces), not only
   `0.0.0.0`.

## Publishing the template to Railway's marketplace

`railway.template.json` is the **single source of truth**. Re-publishing is a
dashboard task, not a headless one — Railway's API can't set a template's
variable values for us (publish input carries no `serializedConfig`,
generate-from-project strips literal defaults, and reading a published template
is "Not Authorized"). So the literal defaults can only be restored in the
dashboard's per-service **Raw Editor**.

**The marketplace template is retired** (2026-08-07). Those API limits are exactly
why: republishing was an irreducible dashboard paste, so the published template
drifted to 56 releases behind v1.10.224 while `railway.template.json` stayed
current, and the docs quietly promised a lag of "a version or two". A path that
can only be kept correct by remembering to do it by hand is not one to keep
offering. Installs now go through the IaC path (`IAC.md`), which reads
`.railway/railway.ts`, is bumped by CI every release, and cannot drift.

`railway.template.json` STAYS, and is still the spec for the four services. It is
load-bearing beyond the marketplace: `deploy-prod.yml` reads its gateway tag as
the current-version source for the release bump, and
`ci/check-gateway-env-coverage.sh` validates every gateway env var against it.

`build-publish.sh` also stays as its validator (called by `validate-artifacts.yml`
to prove the deployment-token field is still required). It reads
`railway.template.json` and writes, into the gitignored `railway/.publish/`:

- `RUNBOOK.md` — the ordered procedure and publish metadata.
- `<service>.vars` — the `KEY=VALUE` block per service.

`publish-template.sh` and `check-template-drift.sh` were removed with the
template, along with the nightly drift workflow that could only ever have gone
red once nothing was published.

**Re-run `build-publish.sh` after every `railway.template.json` change** so the
artifacts stay in sync.

The template is **published** (Othentic workspace, category "AI / ML"). The
"Deploy on Railway" button URL is `https://railway.com/deploy/anyray` — when
verifying after a publish, append `?v=N` (bump `N`) because the plain URL is
CDN-cached and shows the old render.
