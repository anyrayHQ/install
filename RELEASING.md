# Releasing `anyray-connect` binaries

`.github/workflows/release-connect-binaries.yml` compiles the published
`anyray-connect` npm package into standalone executables and a universal macOS
MDM installer, then attaches them to a GitHub Release on this repo. The
monorepo's `publish-connect.yml` dispatches it after every npm publish; it can
also be run by hand (Actions → *Release anyray-connect binaries* → `version` =
the npm version, or `latest`).

Production releases compare their version with the current `connect-v*` latest
release before publishing. A newer version, or a re-cut of the current version,
becomes latest. A re-cut of an older version is published with
`--latest=false`, so `connect.sh`, `connect.ps1`, and managed self-update do not
downgrade clients. Prerelease package versions belong in the staging lane.

## Releasing the desktop app in the same run

Pass `source_sha` (the exact 40-hex monorepo commit, reachable from `origin/main`)
with an explicit `x.y.z` `version` and the run also builds, signs and publishes the
Connect desktop app on the stable channel. Empty `source_sha` is the CLI-only
release above, unchanged. `staging: true` stays CLI-only and ignores `source_sha`.
Dispatch from `main`. Bad desktop inputs fail in `signing-preflight`, before the CLI
ships.

The app's jobs live only in `release-connect-desktop.yml`. The `desktop` job here
calls it (`workflow_call`, `secrets: inherit`) once `release` and `teardown-mac`
are done, so the app ships after the CLI and a desktop failure never touches the
CLI release.

- **One engine.** A called run shares this run's id, so it reads the engines
  `build` uploaded through the usual S3 artifact keys (`reuse_engines`). The macOS
  universal and Linux x64 bundles embed those bytes as the sidecar (macOS re-signs
  it inside the app). The MSI bundles the Authenticode-signed `.exe` the CLI lane
  signed, so the desktop lane signs only `connect-tray.exe`. Run by hand, the
  desktop workflow still compiles its own engines.
- **Its own Mac.** The called workflow provisions and tears down a Mac of its own;
  `mac-fleet.sh up` reuses a live fleet. With `INSTALL_MAC_RUNNER=ec2`, both
  workflows use the persistent host and nothing is provisioned.
- **Per-OS publication.** One `publish` job runs a leg per OS in parallel, each only
  uploading its signed files to the versioned
  `connect-desktop[-staging]-v<version>-<sha12>` release (created if missing; an asset
  already published is never replaced, see "Releasing a build";
  `scripts/publish-desktop-release.sh --upload-only`). An OS whose chain failed is skipped
  and its clients stay on their version. Nothing publishes unless source validation succeeded.
  `reconcile-feed`, gated the same way, then writes the signed manifest and the channel feed
  once from every asset on that release and fails naming any OS still missing. `minVersion` is written only when all three OSes are on the release,
  because a floor in a feed that lacks an OS would strand it. This applies to manual
  desktop runs too, staging included.
- **No staging-first gate.** Stable no longer requires the same version and commit to
  have published on staging first. `channel: staging` still works for manual runs.
- `dry_run` builds, signs and verifies everything, publishes nothing, and keeps the
  consolidated checksums and signed manifest as a workflow artifact.
- **Windows installs MSVC once.** Signing sits between the two Windows jobs on
  purpose (the Azure token must never share a job with the private source's
  `build.rs`), so the build and the MSI bundle stay separate jobs. Only the
  build job installs the VS Build Tools; the bundle job runs `tauri bundle`,
  which links nothing, with just rustup.

### Prepare now, publish later (`mode`)

`mode` splits one release into a build half and a publish half. Both need
`version` as plain `x.y.z` and a `source_sha`, and neither takes `staging`. The
`desktop` job passes the mode to `release-connect-desktop.yml`.

| `mode` | What runs |
| --- | --- |
| `release` (default) | Build, sign and publish in one run, as above. |
| `prepare` | Compiles the CLI from `connect-sets/<set_key>/npm/anyray-connect-<version>.tgz` in the CI artifacts bucket (not npm), signs and verifies the CLI and every desktop OS, and publishes nothing. `store-set` stores the signed CLI set under `connect-sets/<set_key>/` (`set_key` defaults to the version) as soon as the CLI is signed, without waiting for the desktop; the CLI set must be complete or nothing is stored. `store-desktop` then stores the desktop under `connect-sets/<set_key>/desktop/` with its own `SHA256SUMS` and `connect-set-desktop` notice. Its `MISSING` is always written, empty when every desktop OS verified, otherwise one OS name per line. Both sets carry `PACKAGE_SHA256`, the hash of the `.tgz` that was compiled: the caller must match it to the one it uploaded. |
| `publish` | Builds nothing. Refuses the set unless the hash of its `SHA256SUMS` equals `set_sums_sha256`, and fetches only the files that file lists, each checked against it. With `desktop_sums_sha256` it does the same for `desktop/`, which may only carry `connect-desktop-*` artifacts; without it a split set publishes no desktop. Each set records the `VERSION` and `SOURCE_SHA` it was prepared for; a different `version` or `source_sha` is refused. Publishes the CLI release (a no-op when `connect-v<version>` already exists with every set file uploaded, rebuilt when assets are missing, refused when older than the published one), then calls the desktop workflow to publish each OS present and reconcile the feed. |

A partial publication from a `publish` run can be completed by dispatching `mode=publish`
again with the same `version` and `set_sums_sha256`: it loads the same stored set, so
files already on the release carry identical bytes and are skipped, and only the missing
ones upload. (A `release` run cannot be completed this way, because rebuilding re-signs.)

The signed set sits in the CI artifacts bucket, which any job in this repo or the
monorepo can write, so the only trust anchors are `set_sums_sha256` and
`desktop_sums_sha256` coming from records only `main` can write. Build provenance is attested at `publish`, not
`prepare`: it is a public, permanent record and a prepared set may never ship.
`publish` runs in its own concurrency group (it needs no Mac), so a queued build
cannot replace it.

## Signing (RFC 0010 §6)

Signing is **mandatory on every platform**, and the `signing-preflight` job
enforces it before anything is built: a missing secret or variable fails the run
with the names of what is absent, rather than downgrading the release to unsigned
output. The macOS `.pkg` is Developer ID Installer-signed, notarized, and
stapled. The `.deb`/`.rpm` packages are built as additive assets and carry
detached GPG signatures.

Each platform still gates its own steps on a *presence* check of one value —
macOS on `APPLE_SIGNING_CERT_P12`, Windows on `AZURE_SIGNING_CLIENT_ID`, Linux on
`LINUX_SIGNING_GPG_KEY` — but those gates can no longer be false on a real
release. They are kept so an unconfigured fork fails legibly at the preflight
instead of deep inside jsign or `codesign`.

> **Why this changed.** The gate used to make an unconfigured lane **silent, not
> loud**: a release with the Windows variables unset published an unsigned `.exe`
> and went green. The intent was that a half-provisioned lane must not block a
> release. The result was that `AWS_SIGNING_ROLE_ARN` was never set, the
> `sign-windows` job skipped on every run, and **every connect release for a year
> shipped an unsigned binary** with nothing surfacing it — a skipped step and a
> successful one are indistinguishable from outside the run. "The release passed"
> was never evidence the binary was signed. Now it is. Do not restore the old
> posture; if a lane is genuinely retired, remove it from the preflight list in
> the same commit rather than leaving it listed and unset.

Both `release-connect-binaries.yml` and the endpoint-package workflow
`release-fleetd-installer.yml` fail closed unless the macOS application and
installer certificates, notarization credentials, Azure Artifact Signing
configuration, and Linux GPG release key are all present. Neither workflow may
publish a partly signed asset set.

**Build provenance is the exception**: `actions/attest-build-provenance` is
*not* secret-gated. It signs through the workflow's own OIDC identity, so every
release carries verifiable provenance whether or not any signing secret exists.

Three invariants the workflow encodes — keep them if you touch it:

- **`SHA256SUMS` is generated in the `release` job, AFTER the signing jobs.**
  `codesign` and `jsign` rewrite the binaries, so a checksum taken at
  compile time would not match the released bytes. `connect-update.json` (the
  mandatory-release marker) is still written after `SHA256SUMS` and never
  appears in it.
- **`SHA256SUMS` is GPG-signed in the `release` job too, not in
  `package-linux`.** The checksum file is created in `release`, so that is the
  only job that can sign it, and jobs share no GNUPGHOME — the release key is
  imported a second time there on purpose. Both import steps use the identical
  mechanism (isolated `GNUPGHOME` under `$RUNNER_TEMP`, loopback pinentry,
  passphrase over fd 0, `always()` cleanup); if you change one, change both.
- **A bare mach-o binary cannot be stapled, but a `.pkg` can.** The notarized
  standalone CLI binaries ship as-is and Gatekeeper fetches their ticket online.
  `anyray-connect.pkg` is notarized and stapled after its two universal inner
  binaries and outer package have been signed, so MDM installation can validate
  it without a live Apple lookup.

## Secrets to provision (repo → Settings → Secrets and variables → Actions)

### Monorepo read app (desktop app)

| Secret | What it is | Where to get it |
| --- | --- | --- |
| `MONOREPO_READ_APP_ID` | App ID of the **anyray-monorepo-read** GitHub App (4791950) | Org → Settings → Developer settings → GitHub Apps |
| `MONOREPO_READ_APP_PRIVATE_KEY` | The app's PEM private key | Same page → "Generate a private key"; upload with `gh secret set … < key.pem`, then delete the local file |

`release-connect-desktop.yml` builds the desktop app, whose Rust source lives in
the **private monorepo** — the npm package carries only the CLI. Each job that
reads the source mints a one-hour installation token from these secrets (`contents: read`, installation scoped to `anyrayHQ/monorepo` alone) and
clones with it. Blast radius of a leaked token is a read-only clone for at most
an hour; rotating the key is "Generate a private key" plus re-uploading the
secret. Provisioned 2026-09-01.

### macOS — Developer ID signing + notarization

| Secret | What it is | Where to get it |
| --- | --- | --- |
| `APPLE_SIGNING_CERT_P12` | Base64 of the **Developer ID Application** certificate + private key (`.p12`) | [Apple Developer Program](https://developer.apple.com/account) ($99/yr) → Certificates → create *Developer ID Application*; import into Keychain Access, export as `.p12` with a password, then `base64 -i cert.p12` |
| `APPLE_SIGNING_CERT_PASSWORD` | The `.p12` export password | Chosen at export time |
| `APPLE_INSTALLER_CERT_P12` | Base64 of the separate **Developer ID Installer** certificate + private key (`.p12`) | Apple Developer Program → Certificates → create *Developer ID Installer*; import and export it with its private key |
| `APPLE_INSTALLER_CERT_PASSWORD` | The Installer `.p12` export password | Chosen at export time |
| `APPLE_NOTARY_KEY_ID` | App Store Connect API key ID | [App Store Connect](https://appstoreconnect.apple.com) → Users and Access → Integrations → App Store Connect API → create a **Team key** (Developer role suffices) |
| `APPLE_NOTARY_ISSUER_ID` | Issuer ID (UUID) shown on the same page | Same page as the key |
| `APPLE_NOTARY_KEY` | Base64 of the `.p8` private key (`base64 -i AuthKey_XXXX.p8`) | Downloadable **once** at key creation — store the original safely |

The two Apple certificates are different types and are both required. The
Developer ID Application identity signs the universal `anyray-connect` Mach-O
file inside the package. `pkgbuild --ownership recommended` creates the
component package, and the Developer ID Installer identity signs that outer
package with `productsign`. The workflow then submits the final `.pkg` to
Apple, staples the ticket, and checks it with both `pkgutil --check-signature`
and `spctl -t install`.

The package carries no enrollment token. Besides the binary it installs the
two Claude Desktop / Codex fleet helpers, `/usr/local/bin/anyray-credential-helper`
and `/usr/local/bin/anyray-bootstrap-headers-helper` (the same wrappers
`anyray-connect desktop helper --write` produces, owner-marked so a later
`--write` still replaces them), so a console-generated Claude Desktop
`.mobileconfig` works on a Mac that only ever received the package. It also
installs a LaunchAgent that handles either MDM ordering safely:

- **Profile before package:** `postinstall` bootstraps and kickstarts the agent
  for the current desktop user; `RunAtLoad` performs enrollment immediately.
- **Package before profile:** the first run exits cleanly while the managed
  preference is absent. `WatchPaths` starts it when MDM creates
  `/Library/Managed Preferences/ai.anyray.connect.plist`.
- A temporary enrollment failure gets four bounded attempts: immediately, then
  after 1, 5, and 15 minutes. A permanent failure (connect exit 3: revoked or
  expired link, email outside the allowed domains) stops at once. Either way it
  stays stopped until the profile changes or the user logs in again. Output is kept in the signed-in user's
  `~/Library/Logs/Anyray Connect/managed-enroll.log`, rotated at 1 MiB, instead
  of being discarded to `/dev/null`. A new login gets `RunAtLoad`
  automatically from `/Library/LaunchAgents`; that login run rechecks cached
  state so an expired certificate or rotated profile can recover. A full local `anyray-connect --revert` records an opt-out and stays
  reverted until the user explicitly applies Connect again.

### Windows — Authenticode (Azure Artifact Signing + jsign)

All four are **variables, not secrets**: OIDC federation means there is no client
secret to store. `AZURE_SIGNING_CLIENT_ID` still gates each step of the lane, but
it is **no longer an on/off switch**: `signing-preflight` fails the release when
any of the four is absent, so leaving them unset produces a failed run, never an
unsigned `.exe`.

| Setting | Kind | What it is | Where to get it |
| --- | --- | --- | --- |
| `AZURE_SIGNING_CLIENT_ID` | **variable** | Application (client) ID of the Entra app the job federates as | Entra ID → App registrations → your app → Overview |
| `AZURE_SIGNING_TENANT_ID` | **variable** | Directory (tenant) ID | Same Overview blade |
| `AZURE_SIGNING_ENDPOINT` | **variable** | Regional **data-plane** URI, e.g. `https://neu.codesigning.azure.net/` | Signing account → Overview → **Account URI**. Not the ARM endpoint |
| `AZURE_SIGNING_ACCOUNT_PROFILE` | **variable** | `<account>/<certificate-profile>`, e.g. `anyray-signing/anyray-connect` | The account name and the profile you created below |

Current Azure coordinates: account **`anyray-signing`**, resource group
`anyray-signing`, region **North Europe** (`https://neu.codesigning.azure.net/`),
SKU Basic. The subscription and tenant IDs are deliberately **not** written down
here — this repo is public, and `scripts/mac-fleet.sh` keeps the AWS account id
out for the same reason. Read them from the account's Overview blade.

**Setup, in order** — the certificate subject comes from the identity validation,
not from anything in the workflow:

1. **Identity validation** must be *Completed* for the legal entity that should
   appear as the Windows publisher. Anyray's is **`Othentic Labs LTD`** (Israel,
   valid to 2028-11-14). This step is **genuinely portal-only** — it needs the
   *Artifact Signing Identity Verifier* role, and `identityValidations` appears
   in **no** api-version of the `Microsoft.CodeSigning` ARM surface (checked
   against the published specs), so it can be neither created *nor listed* from
   the CLI. Copy the validation id from the portal.
2. **Everything else is one command.** From the account's *Identity validation*
   blade, take the id of the Completed `Othentic Labs LTD` row, then:

   ```bash
   IDENTITY_VALIDATION_ID=<guid> scripts/azure-signing-setup.sh
   ```

   It creates the certificate profile (type **Public Trust** — `PublicTrustTest`
   chains to a root Windows does **not** trust, rehearsal only), the Entra app,
   the federated credential for this repo, and the **Artifact Signing Certificate
   Profile Signer** role scoped to that profile — the role that permits signing,
   which Owner and Contributor deliberately do *not* include. Idempotent, and it
   prints the `gh variable set` lines for step 3.
3. Set the four variables above.

The script refuses to guess the validation id rather than defaulting to one,
because that choice is baked into every certificate the profile ever issues and
cannot be corrected without redoing validation.

> **If `az login` fails with AADSTS530035** ("You don't have access to this",
> *Device state: Unregistered*), the tenant's Conditional Access policy blocks
> the Azure CLI from unregistered devices. That is a deliberate control — don't
> work around it. Run the script from **Azure Cloud Shell** (portal → the `>_`
> icon), where `az` is preinstalled and the session is already compliant.

> **Why not a `.pfx`.** Since June 2023 the CA/Browser Forum requires code-signing
> private keys — **OV and EV alike**, not just EV — to live on FIPS 140-2 Level 2
> hardware, so no CA issues an exportable `.pfx` any more. The old
> `signtool /f cert.pfx /p pass` shape could not be fed by a certificate bought
> today; it was written against a model that no longer exists.
>
> **Why Azure, having previously chosen AWS KMS.** The KMS lane was right in shape
> and never ran. KMS stores only a private key, so it still needed an OV/EV
> certificate (~$200-600/yr) bought against a CSR from that key — and that
> certificate was never purchased. `AWS_SIGNING_ROLE_ARN` stayed unset and **every
> release to date shipped an unsigned `.exe`**. Azure *is* the CA: ~$120/yr covers
> key custody and the certificate together, and the organization validation is the
> same vetting a commercial CA would have charged for. The second cloud is the
> price; a lane with an actual certificate behind it is what it buys.
>
> **The certificates live 3 days**, so timestamping is load-bearing rather than
> good practice: an un-timestamped signature would go invalid the same week, on
> machines that already installed it. jsign enables timestamping automatically for
> this storetype; the workflow asserts the countersignature independently anyway.
>
> **No new Actions.** The token exchange is hand-rolled `curl` + `jq` rather than
> `azure/login` or `azure/trusted-signing-action`. connect 0.11.140-142 published
> to npm with **no binaries** because a merged PR introduced Azure signing actions
> the org allow-list did not carry: the run died at startup and the dispatching job
> went green. Adding a third-party action to this job re-arms that exact trap.
>
> **SmartScreen.** Azure Public Trust certificates are OV-class, so reputation
> accrues with download volume rather than arriving on day one. Expect SmartScreen
> warnings on early downloads; they fade. Nothing in the workflow changes.
>
> **Verification runs on python3 + openssl, not osslsigncode**
> (`scripts/verify-authenticode.py`). The previous step ran
> `sudo apt-get install osslsigncode` on a runner that is **Amazon Linux 2023** —
> no apt, and osslsigncode is not in the AL2023 repositories either, so an
> apt→dnf swap would not have fixed it. It never failed only because the lane was
> gated on a variable nobody had set, so the job skipped on every release. **A
> verification step that cannot execute is worse than none**: it reads like a
> guarantee. The replacement needs no package install and asserts five things —
> signature present, recomputed digest matches the attested digest (so a
> signature lifted from another file cannot pass), chain to the pinned Microsoft
> root, timestamped, and the expected publisher (matched on the `O=` RDN, not a
> substring of the DN).
>
> **What that check does NOT prove, and the trap in "fixing" it.** It does not
> verify the RSA signature over the SignerInfo, so a structurally valid but
> cryptographically broken PKCS#7 would pass. The obvious remedy —
> `openssl smime -verify` — is worse than the gap: measured on OpenSSL 3.6.3 it
> prints "Verification successful" and exits **0** on an Authenticode blob whose
> `encryptedDigest` has been deliberately corrupted, because the eContentType is
> `SpcIndirectDataContent` rather than `pkcs7-data`, so it validates the
> certificate path and never the signature math. Adding it would make the script
> *look* like it verifies signatures while proving no more than it does now. The
> script's header records this; don't "fix" it with another openssl flag.

**Two deliberate gaps, both worth closing on purpose rather than by accident:**

- **The federated credential is scoped to a branch, not a workflow.**
  `repo:anyrayHQ/install:ref:refs/heads/main` means any job in this repo running
  on `main` with `id-token: write` can mint the token and Authenticode-sign
  arbitrary bytes as Othentic Labs LTD — several workflows here already request
  that permission for unrelated AWS OIDC. The hardening is an environment
  subject plus required reviewers, which also adds a human approval per signing
  run: create a `release-signing` environment, add `environment: release-signing`
  to `sign-windows`, and re-run the setup script with `SUBJECT_MODE=environment`.
>
> **Decommissioning AWS — done 2026-08-24.** The `AWS_SIGNING_*` repo variables
> are deleted, and KMS key `alias/anyray-codesign-windows` (eu-central-1,
> `a671d4b6-4407-446a-97b7-f3b5b8db3c7d`) is **scheduled for deletion on
> 2026-09-23** with the maximum 30-day window. It is already disabled.
>
> Before scheduling, CloudTrail was checked over the key's entire lifetime
> (created 2026-08-13): every event against it is a read-only metadata call
> (`DescribeKey`, `GetKeyPolicy`, `GetKeyRotationStatus`, `ListResourceTags`).
> There is **no `Sign` and no `GetPublicKey` event, no grant, and no CloudWatch
> `NumberOfOperations` datapoint** — so the key never signed anything, which is
> what makes deleting it lossless. It held a key but never a certificate.
>
> **Cancel with `aws kms cancel-key-deletion --key-id
> a671d4b6-4407-446a-97b7-f3b5b8db3c7d --region eu-central-1`** any time before
> that date. After it, the key material is unrecoverable. Nothing should need it:
> the Windows lane has signed through Azure since #357, and a KMS-signed artifact
> was never published, so no released binary depends on this key for
> verification.

**When the first signed release ships, these go stale in the same hour** — they
are true only while the lane is inert, which is exactly why they are easy to
forget:

- [ ] `docs/docs/operate/key-refresh-daemon.md` in the **monorepo** states
      "Windows binaries are not yet code-signed, so SmartScreen shows an
      unknown-publisher warning… MDM delivery avoids that prompt entirely, which
      makes it the better route on Windows today". Accurate today, wrong once a
      signed `.exe` ships — and it is steering customers' rollout decisions, so
      it is a correctness bug, not a tidy-up. Note that the SmartScreen warning
      does **not** vanish on day one: Public Trust is OV-class, so reputation
      accrues with download volume.
- [x] Retire the `AWS_SIGNING_*` variables and schedule the KMS key deletion —
      **both done 2026-08-24**. `AWS_SIGNING_KMS_KEY_ID` is deleted from the repo
      variables; it was the last one, and it was worth deleting rather than
      leaving inert, because a stale variable named like a live lane is what
      invites someone to re-wire against it. The KMS key is disabled and
      scheduled for deletion on **2026-09-23** (30-day window, cancellable until
      then). Evidence that it signed nothing, and the cancel command, are in the
      "Decommissioning AWS" note above.
- [x] Record the publisher string users will actually see on the UAC prompt —
      **`Othentic Labs LTD`**. Verified on the shipped
      `anyray-connect-windows-x64.exe` from `connect-v0.11.158`: subject
      `CN=Othentic Labs LTD, O=Othentic Labs LTD, L=Tel Aviv, C=IL`, issued by
      `Microsoft ID Verified CS AOC CA 04`, timestamped. Support can quote that
      name when a user asks "is this really you?" — it is the legal entity behind
      Anyray, not the brand, and Azure bakes the validated entity name into every
      certificate the profile issues.

`fleetd.msi` is signed by `release-fleetd-installer.yml` through the same Azure
Artifact Signing profile. The workflow then verifies the final MSI with Windows'
native `Get-AuthenticodeSignature` before a release can consume it. That matters
because the gateway re-serves this artifact to enrolled machines: the exact MSI
verified on Windows is the one uploaded as the release asset.

### Linux — GPG-signed `.deb`/`.rpm` **and `SHA256SUMS`**

| Secret | What it is | Where to get it |
| --- | --- | --- |
| `LINUX_SIGNING_GPG_KEY` | ASCII-armored **secret** signing key | `gpg --full-generate-key` (RSA 4096 or Ed25519, e.g. `Anyray Release Signing <support@anyray.ai>`), then `gpg --armor --export-secret-keys <keyid>` |
| `LINUX_SIGNING_GPG_PASSPHRASE` | Its passphrase | Chosen at key generation |

One key, two consumers. `package-linux` publishes the **public** key as the
release asset `anyray-connect-signing-key.asc` plus a detached `.asc` next to
each package; the `release` job additionally detach-signs the checksum file to
`SHA256SUMS.asc`. The Fleet endpoint-package lane uses the same key as a hard
release prerequisite, and also signs its `endpoint-release.json` manifest plus
each `.deb`/`.rpm` asset.

**After provisioning the key, record its fingerprint below.** The release job
prints `signing key fingerprint: <40 hex>` in its log, and the release notes
tell users to compare what they import against this file — a fingerprint nobody
publishes out-of-band is a fingerprint nobody can check.

> **Current fingerprint:**
>
> ```
> 9712 9EA5 63BF B3FC D731  1D45 FDC8 3EAF C93E 4DD8
> ```
>
> Uid `Anyray Release Signing (Othentic Labs LTD) <security@anyray.ai>`, RSA 4096,
> created 2026-08-24, **no expiry**. Both secrets are set on this repository, so
> the lane is live from the next release onward.

**Key parameters, and why.** RSA 4096 rather than Ed25519: these signatures are
verified by customers on enterprise Linux, and GnuPG only gained Ed25519 in 2.1
(RHEL 7 shipped 2.0.22). A signature a customer cannot check is worth nothing,
and the size difference costs us nothing. **No expiry**, because the compromise
response for a release key is revocation, not waiting: an expiry date is a
release-breaking landmine that fires at the worst possible moment, and now that
signing is mandatory an expired key would block the release outright. A
revocation certificate was generated with the key and is stored alongside it.

> **The private key exists in exactly two places: this repository's secrets
> (write-only, unreadable even to an admin) and whatever backup was taken at
> generation time.** If both are lost the key cannot be recovered. Already
> published signatures keep verifying (the public key ships in each release), but
> no future release can be signed by the same key, and every user who pinned the
> fingerprint above sees it change. Confirm the backup exists before relying on
> this lane.

## Verifying a download

Two independent paths, both available from the first release cut after this
landed. Release notes link back here for the key fingerprint.

**The checksums are signed.** Verify the
checksum file first, then the binary against it — checking a binary against an
unsigned checksum file from the same release only proves the download was not
corrupted, not that the release is genuine:

```bash
gpg --import anyray-connect-signing-key.asc   # compare against the fingerprint above
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum --ignore-missing --check SHA256SUMS
gpg --verify anyray-connect_<version>_amd64.deb.asc anyray-connect_<version>_amd64.deb
pkgutil --check-signature anyray-connect.pkg
spctl -a -vvv -t install anyray-connect.pkg
```

**Every binary and package carries build provenance**, signed through Sigstore
from the workflow's OIDC identity. This needs no key distribution at all, and
unlike the GPG path it does not wait on a secret being provisioned — it covers
every release cut from this workflow onwards. Releases published before this
change have no attestation and cannot retroactively gain one:

```bash
gh attestation verify anyray-connect-linux-x64 --repo anyrayHQ/install
gh attestation verify anyray-connect.pkg --repo anyrayHQ/install
```

That confirms the file was produced by this workflow, in this repository, at a
specific commit. Note it authenticates the *build*, not the release page: it
answers "did our CI make this file", which is exactly the question a swapped
release asset would otherwise leave open.

**Installer enforcement is a separate, later step.** `connect.sh` and
`connect.ps1` verify checksums fail-closed today but do **not** yet require
`SHA256SUMS.asc` or an attestation. Making either mandatory can only land after
a real release has actually published them — flipping it earlier breaks every
install immediately.

## Mandatory releases

The optional `min_version` dispatch input publishes `connect-update.json`
(`{"minVersion": …}`) which overrides developers' auto-update opt-out — a lever
for security/correctness fixes only. See the comment on the *Mark the release
mandatory* step.

## CI runners

The release workflow runs on **self-hosted AWS CodeBuild runners** (org GitHub billing
blocks GitHub-hosted runners). One persistent Linux runner project plus an
**on-demand macOS fleet** created per release by default, or the persistent Mac host below:

| Job | Runner | CodeBuild project (eu-central-1) |
| --- | --- | --- |
| build, provision-mac, sign-windows, package-linux, release, teardown-mac | Amazon Linux (`amazonlinux2-x86_64-standard:5.0`) | `anyray-install-runner` |
| sign-macos | **on-demand** macOS (MAC_ARM, `mac2-m2.metal`) | `anyray-install-runner-mac` (ephemeral) |
| Mac jobs with `INSTALL_MAC_RUNNER=ec2` | self-hosted `anyray-install-mac` (EC2 `mac2.metal` Dedicated Host, us-east-2) | none |
| desktop Linux build and smoke jobs | Ubuntu 22.04 (`aws/codebuild/standard:7.0`) | `anyray-install-runner-ubuntu` |

**`sign-windows` no longer needs Windows.** jsign is a pure-Java Authenticode
implementation, so signing moved to the Linux runner — no Windows SDK download,
no `signtool`. This is also why the lane does **not** use Microsoft's own signing
integration: that path is SignTool + .NET 8 + the Artifact Signing dlib, all
Windows-only, and would drag the job back onto a Windows fleet to do the same
work. **Keep the `anyray-install-runner-win` project**: this workflow no longer
uses it, but `release-fleetd-installer.yml`'s `build-windows` still does
(fleetctl shells out to WiX `heat`, which needs a real Windows host).

**Why macOS is on-demand.** Apple signing requires a Mac. EC2 Mac hosts have a
24-hour minimum charge; leaving a fleet ACTIVE continues billing beyond it.
`mac-fleet.sh down` deletes the runner project and requests fleet deletion on
success or failure. `up` accepts a fleet still usable in PENDING_DELETION, so
releases may reuse the remaining paid window. It fails if readiness takes more
than 20 minutes. Cleanup must never be replaced with simply leaving the fleet active.
This is the default; the persistent host below replaces it once proven.

The Connect CLI, desktop, and fleetd release workflows share the
`anyray-install-mac-release` concurrency group for their entire runs. This keeps
one release's teardown from deleting another release's runner. GitHub retains
one running and one pending run per group; a new dispatch replaces an older
pending run. Dispatch releases deliberately and do not overlap multiple requests.

**`anyray-install-runner-ubuntu`** exists for the desktop Linux jobs alone: Tauri links
against `webkit2gtk-4.1`, which Amazon Linux 2 does not package, and the AL2
runners have no Docker daemon to containerize around it. Ubuntu **22.04, not
24.04**, on purpose — the build host's glibc (2.35) is the floor for every
machine that runs the shipped binary; 24.04's 2.39 would drop Ubuntu 22.04 and
Debian 12 users. A trap that cost the first build on each new project: the
shared `anyray-gha-runner-codebuild` role enumerates its CloudWatch log groups
by ARN with no wildcard, so a new runner project dies in `QUEUED` with
`ACCESS_DENIED` on `logs:CreateLogStream` (a bare "Build failed" with no log —
the failure IS the inability to write logs) until its group is granted in a
per-addition inline policy.

The persistent runner projects (`anyray-install-runner`, `anyray-install-runner-ubuntu`,
`anyray-install-runner-win`) and the ephemeral mac project are webhook-driven
(`WORKFLOW_JOB_QUEUED`) and **gated to the release maintainers' GitHub account ids** —
required because the repo is public, so a fork-PR actor can never start a runner. A dispatch by
anyone outside a project's filter leaves that project's jobs queued with no runner until the
watchdog cancels them.

To add a release maintainer (`gh api users/<login> --jq .id` gives the id), update these project filters:

1. **Ephemeral mac project:** append the id to `MAINTAINER_ACCOUNT_IDS` in `scripts/mac-fleet.sh`
   (today `0xtechdean` and `Dima-Othentic`). `mac-fleet.sh up` rewrites this webhook on every
   release, so it takes effect on the next release after the change merges.
2. **Persistent projects:** their filters live in AWS, not in this repo. Read them, then add the
   id to each project's `ACTOR_ACCOUNT_ID` pattern with `aws codebuild update-webhook
   --project-name <project> --filter-groups '<the read groups, pattern extended>'`:

   ```bash
   aws codebuild batch-get-projects --region eu-central-1 \
     --names anyray-install-runner anyray-install-runner-ubuntu anyray-install-runner-win \
     --query 'projects[].{name:name,filters:webhook.filterGroups}'
   ```

Also update `MAINTAINER_ACCOUNT_IDS` and `MAINTAINER_LOGINS` in
`scripts/mac-runner-hook.sh` to match the ids and canonical logins in
`mac-fleet.sh`, and reinstall the persistent host's hooks as described below.

Apple signing secrets (all required): `APPLE_SIGNING_CERT_P12` +
`APPLE_SIGNING_CERT_PASSWORD` for the inner binaries,
`APPLE_INSTALLER_CERT_P12` + `APPLE_INSTALLER_CERT_PASSWORD` for the outer
package, and `APPLE_NOTARY_KEY` (base64 `.p8`) + `APPLE_NOTARY_KEY_ID` +
`APPLE_NOTARY_ISSUER_ID` for notarization. (`APPLE_SIGNING_CERT_PEM` was set for
the abandoned rcodesign path and is unused.)

### The persistent macOS signing host (ANY-1405)

**What and why.** `provision-mac` saves the Mac runner choice once per run. The
binaries and fleetd workflows read the repository variable `INSTALL_MAC_RUNNER`.
A called desktop workflow takes the caller's saved choice through `mac_runner`.
Only a desktop run dispatched by hand reads the variable itself. Every Mac job
and teardown reads the saved output, so changing the variable during a run leaves
that run's choice intact.

| Value | Mac jobs run on | provision-mac / teardown-mac |
| --- | --- | --- |
| unset or empty (default) | `codebuild-anyray-install-runner-mac-<run_id>-<run_attempt>` | create and delete the fleet |
| `codebuild` | same as unset | same as unset |
| `ec2` | `anyray-install-mac` for signing, `anyray-install-mac-build` for build and verify (both self-hosted macOS ARM64) | provision reports the choice; teardown is skipped |
| anything else | nothing; provision fails loudly | teardown still runs idempotent `down` |

Measured over 30 days: about 20 fleet allocations, each with a 24-hour minimum
at $1.44/h, cost about $697 for roughly 9 minutes of Mac work per release. One
always-on `mac2.metal` host costs $0.65/h, or $468 per 30 days on demand and about
$393 on a 1-year no-upfront EC2 Instance Savings Plan. `mac2.metal` is not offered
in eu-central-1; that region offers `mac2-m2.metal` at $1.052/h, about the fleet's
cost. The signing host lives in us-east-2; the S3 handoff stays in eu-central-1.
This host serves release jobs only and is never shared with the monorepo's
PR Mac runner.

**Security posture.**

- Signed macOS outputs are pinned by digest from the signing job to every consumer, so the
  build account cannot swap them after signing; the Windows and Linux signed outputs share the same bucket and are not pinned yet (follow-up).

Two non-admin accounts share one host. Neither has sudo; the admin operator
account is separate. One runner process per account runs one job at a time per
role. The workflows also share the `anyray-install-mac-release` concurrency group;
a called desktop workflow already holds its caller's group.

| Role | macOS account | Runner label | Jobs |
| --- | --- | --- | --- |
| sign | `anyray-sign` | `anyray-install-mac` | desktop `sign-macos`, binaries `sign-macos`, fleetd `build-macos` |
| build | `anyray-build` | `anyray-install-mac-build` | desktop `build-macos-unsigned`, desktop `verify-macos-signed`, binaries `verify-macos-launch` |

The signing account `anyray-sign` (no admin, no sudo) runs only workflow code
from install main, pinned actions, Apple's tools and the pinned fleetctl.
It never runs build output. It holds Apple material only inside a signing job,
decoded into `$RUNNER_TEMP` and a throwaway keychain, then deleted by the job.
The runner wipes `$RUNNER_TEMP` around every job, and both hooks reset the keychain
search list. No certificate stays in a login keychain and no
`notarytool store-credentials` is used.

The build account `anyray-build` (no admin, no sudo) runs build-time code from the
released monorepo commit and its dependencies; cargo build scripts and proc macros always run.
It runs build output in the two verify jobs. It cannot read the signing
account's home (both homes are mode 0700) and cannot become root without a
local privilege-escalation exploit.

Residual risk: the build account persists across jobs, including its HOME
toolchains, runner install and readable registration credentials. A dependency
that runs code at build time can tamper with later builds, which are then signed,
and can copy the build runner's credentials to receive later build jobs and their
secrets (the monorepo read App key and the S3 artifact role). The CodeBuild fleet
bounded this to about a day; here it lasts until the build account is reset.
Reset it weekly and after any dependency incident using the procedure below.
The follow-up that removes this is an ephemeral build account and runner per job.

The root install, sweep and uninstall smoke does not run on this host: it would
give build output root on the box holding the signing account. The security choice
stays: no CI code as root. Persistent-host verification keeps the signature,
notarization staple, Gatekeeper assessment,
pkg structure, payload and uninstaller structure checks, then launches the signed
engine once as the build account. On ec2, staging proceeds with a warning;
stable FAILS the macOS desktop leg on ec2 unless the repository variable
`INSTALL_MAC_ROOT_SMOKE_ACCEPTED` holds the Jira key or the GitHub comment URL of
Dean's written acceptance. To set it, use
`gh variable set INSTALL_MAC_ROOT_SMOKE_ACCEPTED -R anyrayHQ/install --body <ANY-key or comment URL>`.
Remove it with `gh variable delete INSTALL_MAC_ROOT_SMOKE_ACCEPTED -R anyrayHQ/install`.
Without it, stable macOS keeps running on the CodeBuild fleet:
unset `INSTALL_MAC_RUNNER` for that release. The CodeBuild fleet path still runs the full
root smoke. A scheduled root-volume reset was rejected: root can copy the runner registration credentials,
and a reset does not revoke them. The follow-up is a disposable macOS VM per smoke.

The organization runner group restricted to this repo and the three release
workflows at main is the gate against fork pull requests. The hooks are a second
layer: before any step, job-started requires a `workflow_dispatch` at
`refs/heads/main` in `anyrayHQ/install`, an allowed workflow ref, a maintainer's
original actor id and canonical triggering login, the role's job and its non-admin
account without sudo. GitHub supplies these `GITHUB_*` contexts and a workflow
cannot overwrite them. `provision-mac` also refuses `ec2` outside a main dispatch.
The canary turns a host whose hooks were removed or never configured into a red job
instead of an ungated one. It is not a defense against an account that is already compromised:
that account could write the file itself.

The instance profile is SSM-only. The security group has no inbound rule and
there is no key pair. Operators use Session Manager and the admin `ec2-user`, which runs no runner.

**Allocate and launch.** Use region us-east-2 and profile `team6`. Discover ids
from command output or resource names; do not put them in this public repository.

```bash
aws ec2 allocate-hosts --region us-east-2 --profile team6 \
  --availability-zone us-east-2a --instance-type mac2.metal --quantity 1 \
  --auto-placement off --host-recovery on \
  --tag-specifications 'ResourceType=dedicated-host,Tags=[{Key=Name,Value=anyray-install-mac-signing}]'
```

`InsufficientHostCapacity` is common: try another zone, but only one where the
`anyray-mac-runner` group's VPC has a public subnet (the subnet lookup below
prints `None` otherwise). The 24-hour minimum starts at allocation. `--auto-placement off` allows only an
instance launched onto that host id to land there. Set `HOST` from that output
and `HOST_AZ` to the zone that succeeded, then launch:

```bash
HOST='<host id from allocate-hosts>'
HOST_AZ='<the host availability zone>'
AMI=$(aws ec2 describe-images --region us-east-2 --profile team6 --owners amazon \
  --filters 'Name=name,Values=amzn-ec2-macos-15.*-arm64' \
  --query 'reverse(sort_by(Images,&CreationDate))[0].ImageId' --output text)
SG=$(aws ec2 describe-security-groups --region us-east-2 --profile team6 \
  --filters Name=group-name,Values=anyray-mac-runner --query 'SecurityGroups[0].GroupId' --output text)
SUBNET=$(aws ec2 describe-subnets --region us-east-2 --profile team6 \
  --filters "Name=vpc-id,Values=$(aws ec2 describe-security-groups --region us-east-2 --profile team6 --group-ids "$SG" --query 'SecurityGroups[0].VpcId' --output text)" \
            "Name=availability-zone,Values=$HOST_AZ" Name=map-public-ip-on-launch,Values=true \
  --query 'Subnets[0].SubnetId' --output text)
aws ec2 run-instances --region us-east-2 --profile team6 \
  --instance-type mac2.metal --image-id "$AMI" \
  --placement "Tenancy=host,HostId=$HOST" \
  --subnet-id "$SUBNET" --security-group-ids "$SG" \
  --iam-instance-profile Name=anyray-mac-runner-ssm \
  --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=200,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=anyray-install-mac-signing}]'
```

`anyray-mac-runner` is the existing egress-only group: ports 443 and 80 out,
nothing in. `anyray-mac-runner-ssm` is the existing instance profile holding only
`AmazonSSMManagedInstanceCore`; reusing these resources shares no host.
The instance takes 10 to 20 minutes to reach SSM. Find it by name and shell in:

```bash
INSTANCE=$(aws ec2 describe-instances --region us-east-2 --profile team6 \
  --filters Name=tag:Name,Values=anyray-install-mac-signing Name=instance-state-name,Values=running \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
aws ssm start-session --target "$INSTANCE" --region us-east-2 --profile team6
```

Grow APFS into the 200 GB volume with AWS's documented steps on the host:

```bash
PDISK=$(diskutil list physical external | head -n1 | cut -d" " -f1)
APFSCONT=$(diskutil list physical external | grep "Apple_APFS" | tr -s " " | cut -d" " -f8)
yes | sudo diskutil repairDisk "$PDISK"
sudo diskutil apfs resizeContainer "$APFSCONT" 0
```

**Host setup.** As root over Session Manager, confirm passwordless sudo for
`ec2-user` and the signing tools, and install jq as `ec2-user`:

```bash
sudo -iu ec2-user sudo -n true
xcrun notarytool --version
xcrun stapler --help
codesign --version
productsign --help
xmllint --version
aws --version
python3 --version                                   # safe-unzip.sh and fleetd's build use it
test -x /usr/bin/zipinfo && test -x /usr/bin/sandbox-exec && test -x /usr/bin/ditto   # safe-unzip.sh
sudo -iu ec2-user brew install jq
touch /System/Volumes/Data/.fseventsd/no_log && killall fseventsd
```

Every install and workspace delete journals millions of FSEvents that this host
never purges; they filled the monorepo's Mac host's disk, so repeat the `no_log`
step whenever the host is rebuilt.

Create both accounts as root, non-admin and hidden, with homes mode 0700.
The membership checks must say "no", and neither sudo check may print FAIL:

```bash
for user in anyray-sign anyray-build; do
  sudo sysadminctl -addUser "$user" -fullName "$user" -password "$(uuidgen)" -home "/Users/$user" -shell /bin/bash
  sudo createhomedir -c -u "$user"
  sudo dscl . create "/Users/$user" IsHidden 1
  sudo chmod 0700 "/Users/$user"
  dseditgroup -o checkmember -m "$user" admin   # must say "no"
  sudo -u "$user" sudo -n true && echo "FAIL: $user can sudo"
done
sudo chmod 0700 /Users/ec2-user
stat -f '%Su %Lp %N' /usr/local/bin /opt/homebrew/bin   # neither writable by the two accounts
```

The organization runner group is REQUIRED before `INSTALL_MAC_RUNNER=ec2`. An org
owner must create it restricted to this repository, with public repositories
allowed because this repo is public, and restricted to the three release
workflows at main. Create it and read it back from the operator machine:

```bash
repo_id=$(gh api repos/anyrayHQ/install --jq .id)
gh api -X POST orgs/anyrayHQ/actions/runner-groups -f name=anyray-install-mac \
  -f visibility=selected -F "selected_repository_ids[]=$repo_id" \
  -F allows_public_repositories=true -F restricted_to_workflows=true \
  -f 'selected_workflows[]=anyrayHQ/install/.github/workflows/release-connect-binaries.yml@main' \
  -f 'selected_workflows[]=anyrayHQ/install/.github/workflows/release-connect-desktop.yml@main' \
  -f 'selected_workflows[]=anyrayHQ/install/.github/workflows/release-fleetd-installer.yml@main'
gh api orgs/anyrayHQ/actions/runner-groups --jq '.runner_groups[] | select(.name=="anyray-install-mac") | {id, restricted_to_workflows, selected_workflows, allows_public_repositories}'
```

If the plan does not accept `restricted_to_workflows`, or the read-back does not
show it and all three selected workflows, stop and do not set the variable.
The desktop workflow is listed because the restriction applies to "jobs directly defined within the selected workflows".
If a legitimate dry run queues with no runner, the workflow entry format did not
match: try `@refs/heads/main` instead of `@main`, then read back and probe again.

**Runners.** Download and verify the macOS arm64 runner for each account into
`/Users/<user>/actions-runner`. Take the version and its macOS arm64 SHA-256 from
the [GitHub runner release page](https://github.com/actions/runner/releases),
then verify before extracting. Run this on the host for each account:

```bash
for user in anyray-sign anyray-build; do
  sudo -u "$user" -H /bin/bash -e -o pipefail <<'RUNNER'
mkdir -p ~/actions-runner/_diag ~/actions-runner/_work
cd ~/actions-runner
runner_version='<version from the runner release page>'
runner_sha256='<macOS arm64 SHA-256 from the same release>'
runner_archive="actions-runner-osx-arm64-${runner_version}.tar.gz"
curl -fsSL "https://github.com/actions/runner/releases/download/v${runner_version}/${runner_archive}" -o "$runner_archive"
printf '%s  %s\n' "$runner_sha256" "$runner_archive" | shasum -a 256 -c
tar -xzf "$runner_archive"
RUNNER
done
```

Mint an organization registration token on the operator machine; it is valid for
one hour:

```bash
token=$(gh api -X POST orgs/anyrayHQ/actions/runners/registration-token --jq .token)  # operator machine
```

On the host, set `token` to that token, then register each runner as its account
into the required group. Run one runner process per account:

```bash
for user in anyray-sign anyray-build; do
  case "$user" in
    anyray-sign) label=anyray-install-mac ;;
    anyray-build) label=anyray-install-mac-build ;;
  esac
  sudo -u "$user" -H bash -c 'cd ~/actions-runner && ./config.sh --unattended --url https://github.com/anyrayHQ \
    --token "$0" --name "$1" --labels "$1" --runnergroup anyray-install-mac --work _work' "$token" "$label"
done
```

Each install stays owned by its account, under its mode 0700 home. A root-owned
install does not start: `run.sh` copies `run-helper.sh.template` over
`run-helper.sh` in the install directory on every start, and the runner writes
its migrated credential files there. The registration credentials are readable by
the account because the runner needs them; that is the credential-copying
residual risk above. The runners update themselves from GitHub.

Install the hooks root-owned from a reviewed main commit, with four role-specific
symlinks. The hook paths go in each root-owned LaunchDaemon below, not in the
account's `.env`:

```bash
sha='<install main commit that carries scripts/mac-runner-hook.sh>'
curl -fsSL "https://raw.githubusercontent.com/anyrayHQ/install/$sha/scripts/mac-runner-hook.sh" -o /tmp/mac-runner-hook.sh
sudo install -d -o root -g wheel -m 0755 /usr/local/libexec/anyray-install-runner
sudo install -o root -g wheel -m 0755 /tmp/mac-runner-hook.sh /usr/local/libexec/anyray-install-runner/mac-runner-hook.sh
sudo ln -sf mac-runner-hook.sh /usr/local/libexec/anyray-install-runner/sign-job-started.sh
sudo ln -sf mac-runner-hook.sh /usr/local/libexec/anyray-install-runner/sign-job-completed.sh
sudo ln -sf mac-runner-hook.sh /usr/local/libexec/anyray-install-runner/build-job-started.sh
sudo ln -sf mac-runner-hook.sh /usr/local/libexec/anyray-install-runner/build-job-completed.sh
```

The runner loads the account's `.env` over the daemon's environment, so an account
that is already compromised can still drop its own hooks, or run its own listener
with its credentials. The runner group is what keeps fork pull requests off this
host; the hooks and the canary catch a host that was never set up right.

Install two LaunchDaemons as root:wheel, mode 0644. The sign daemon is:

```bash
sudo tee /Library/LaunchDaemons/com.anyray.install-actions-runner.sign.plist >/dev/null <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.anyray.install-actions-runner.sign</string>
  <key>UserName</key>
  <string>anyray-sign</string>
  <key>WorkingDirectory</key>
  <string>/Users/anyray-sign/actions-runner</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/anyray-sign/actions-runner/run.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>/Users/anyray-sign</string>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin</string>
    <key>ACTIONS_RUNNER_HOOK_JOB_STARTED</key>
    <string>/usr/local/libexec/anyray-install-runner/sign-job-started.sh</string>
    <key>ACTIONS_RUNNER_HOOK_JOB_COMPLETED</key>
    <string>/usr/local/libexec/anyray-install-runner/sign-job-completed.sh</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/anyray-sign/actions-runner/_diag/launchd.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/anyray-sign/actions-runner/_diag/launchd.stderr.log</string>
</dict>
</plist>
PLIST
```

Jobs get this `PATH`: the daemon starts `run.sh`, which does not read the `.path`
file `config.sh` writes (only the `svc.sh` service wrapper does), so a user
directory captured at registration never lands ahead of the system ones.

Derive the build daemon from it, so the two differ only in label, account, paths
and hooks, then check both and bootstrap them:

```bash
sudo sed -e 's/anyray-sign/anyray-build/g' \
  -e 's/install-actions-runner\.sign/install-actions-runner.build/' \
  -e 's/sign-job-/build-job-/g' \
  /Library/LaunchDaemons/com.anyray.install-actions-runner.sign.plist \
  | sudo tee /Library/LaunchDaemons/com.anyray.install-actions-runner.build.plist >/dev/null
plutil -lint /Library/LaunchDaemons/com.anyray.install-actions-runner.sign.plist /Library/LaunchDaemons/com.anyray.install-actions-runner.build.plist
grep -c 'anyray-build\|build-job-' /Library/LaunchDaemons/com.anyray.install-actions-runner.build.plist   # 8
grep -c 'anyray-sign\|sign-job-' /Library/LaunchDaemons/com.anyray.install-actions-runner.build.plist     # 0
sudo chown root:wheel /Library/LaunchDaemons/com.anyray.install-actions-runner.sign.plist /Library/LaunchDaemons/com.anyray.install-actions-runner.build.plist
sudo chmod 0644 /Library/LaunchDaemons/com.anyray.install-actions-runner.sign.plist /Library/LaunchDaemons/com.anyray.install-actions-runner.build.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.anyray.install-actions-runner.sign.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.anyray.install-actions-runner.build.plist
```

The build job adds its own `$HOME/.cargo/bin` to PATH when it finds or installs
rustup. Check that both runners are online from the operator machine:

```bash
gh api orgs/anyrayHQ/actions/runners --jq '.runners[] | select(.name|startswith("anyray-install-mac")) | {name, status, busy}'
```

**GitHub settings.** A repo admin must require approval for every outside
contributor's workflow runs; today only first-time contributors require it:

```bash
gh api -X PUT repos/anyrayHQ/install/actions/permissions/fork-pr-contributor-approval \
  -f approval_policy=all_external_contributors
```

**Switch over and prove it.** Before setting the variable, run this required probe
from the non-main branch `probe/any-1405-hook`, file
`.github/workflows/probe-mac-hook.yml`, twice:

```yaml
name: Probe the Mac host trust gate (delete after use)
on:
  push:
    branches: [probe/any-1405-hook]
permissions:
  contents: read
env:
  BASH_ENV: '$(/usr/bin/touch /tmp/hook-env-probe)'
  GITHUB_EVENT_NAME: workflow_dispatch
  GITHUB_REF: refs/heads/main
jobs:
  sign-macos:
    runs-on: [self-hosted, macOS, ARM64, anyray-install-mac]
    timeout-minutes: 5
    steps:
      - run: /usr/bin/touch /tmp/hook-env-probe-step
  build-macos-unsigned:
    runs-on: [self-hosted, macOS, ARM64, anyray-install-mac-build]
    timeout-minutes: 5
    steps:
      - run: /usr/bin/touch /tmp/hook-env-probe-step
```

First round, open the runner group to all workflows of this repo and push the
probe branch. This proves the hook. Both jobs must fail at "job started hook"
with `::error::GITHUB_EVENT_NAME check failed`: the real event is `push`, and
workflow env, including the spoofed `GITHUB_*` and `BASH_ENV`, never reaches the hook.
Over Session Manager, confirm neither `/tmp/hook-env-probe` nor `/tmp/hook-env-probe-step` exists:
`ls -l /tmp/hook-env-probe*` prints nothing on the host.

A refusal from the hook proves that the runner invokes it through the symlink:
invoked by its real name `mac-runner-hook.sh` with no arguments, it exits with the
usage error instead. The job log line "A job started hook has been configured by the self-hosted runner administrator"
shows that a hook ran.

Second round, restrict the group to the three release workflows at main again
and push the probe branch again. This proves the group. Both jobs must stay
queued with no runner; cancel the run, then delete the branch.

Third round, on a branch `probe/any-1405-ref`, REPLACE the whole content of
`.github/workflows/release-fleetd-installer.yml` (a listed workflow path) with this
single probe job, so nothing else in that workflow runs:

```yaml
name: Probe the runner group's ref pinning (delete after use)
on:
  push:
    branches: [probe/any-1405-ref]
permissions:
  contents: read
jobs:
  build-macos:
    runs-on: [self-hosted, macOS, ARM64, anyray-install-mac]
    timeout-minutes: 5
    steps:
      - run: /usr/bin/touch /tmp/hook-env-probe-ref
```

Expected: the job stays queued with no runner (the group admits that file only at
main); cancel the run, confirm `ls -l /tmp/hook-env-probe-ref` prints nothing on
the host, then delete the branch. If the job instead fails at "job started hook",
the group's workflow entry matched a non-main ref: stop, fix the entry
(`@refs/heads/main` vs `@main`), and repeat rounds two and three.

Only after all three rounds pass, set the repository variable:

```bash
gh variable set INSTALL_MAC_RUNNER -R anyrayHQ/install --body ec2
```

The staging dry run after the switch proves the entry still admits main.
Dispatch a staging desktop dry run from main with an explicit version and
monorepo SHA. It passes when provision-mac chooses `ec2`, with
`build-macos-unsigned` and `verify-macos-signed` on
`anyray-install-mac-build`, and `sign-macos` on `anyray-install-mac`. Each job log
must show the hook's `trust gate passed (<role> job-started)` notice for its role.
`verify-macos-signed` must show the staging warning:
`root install, sweep and uninstall smoke skipped on the persistent Mac host (staging)`.
On that run, teardown-mac is skipped.
After a week of releases, CloudTrail must show no `CreateFleet` for
`anyray-install-mac-fleet`.

**Rollback.** Delete the variable:

```bash
gh variable delete INSTALL_MAC_RUNNER -R anyrayHQ/install
```

The next run's provision-mac returns to the fleet and `mac-fleet.sh up` recreates
it. Nothing else needs restoring. A run already past provision-mac keeps its choice.

**Operating it.** If the host is down or the runner offline, Mac jobs queue.
The monorepo's stuck-run watchdog cancels runs queued past 40 minutes; it never
requeues a job waiting on a self-hosted label. Roll back the variable and fix
the host. The started hook refuses under 20 GB free: check
`~/.runner-trash/cleanup.log`, then the FSEvents journal. Both hooks set the
workspace aside, keeping only `.git`, and delete the moved contents detached at
background priority. The started hook also covers a cancelled job, runner crash,
or reboot that prevented the completed hook from running.

**Reset the build account.** Do this weekly and after any dependency incident.
On the host, stop its daemon:

```bash
sudo launchctl bootout system/com.anyray.install-actions-runner.build
```

Find its id with the online-check API above, adding `id` to the output, or use
this on the operator machine:

```bash
gh api orgs/anyrayHQ/actions/runners --jq '.runners[] | select(.name=="anyray-install-mac-build") | {id, name, status, busy}'
```

Delete its registration from GitHub on the operator machine, substituting that
id in the path. This revokes the credentials before the account is removed:

```bash
gh api -X DELETE orgs/anyrayHQ/actions/runners/<id>
```

Then delete the account on the host and repeat the account, runner, hook and daemon steps for it:

```bash
sudo sysadminctl -deleteUser anyray-build
```

To update the hooks, reinstall from the newer reviewed main commit using the
Runners commands above. The runner reads them per job, so no restart is needed.

To release the host, discover the instance and host by the instance's name,
terminate the instance, wait for `terminated`, then release the host:

```bash
INSTANCE=$(aws ec2 describe-instances --region us-east-2 --profile team6 \
  --filters Name=tag:Name,Values=anyray-install-mac-signing Name=instance-state-name,Values=running,stopped \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
HOST=$(aws ec2 describe-instances --region us-east-2 --profile team6 --instance-ids "$INSTANCE" \
  --query 'Reservations[0].Instances[0].Placement.HostId' --output text)
aws ec2 terminate-instances --region us-east-2 --profile team6 --instance-ids "$INSTANCE"
aws ec2 wait instance-terminated --region us-east-2 --profile team6 --instance-ids "$INSTANCE"
aws ec2 release-hosts --region us-east-2 --profile team6 --host-ids "$HOST"
```

A host released inside its first 24 hours is still billed for all 24.

**Retiring the fleet.** In a later change, after the host has carried releases
for a while, delete `scripts/mac-fleet.sh`, its test, provision-mac and
teardown-mac, the `AWS_MAC_FLEET_ROLE_ARN` variable, and its role.

## Connect desktop installers: staging and stable lanes (ANY-250, ANY-337)

`.github/workflows/release-connect-desktop.yml` is the release lane for the
self-contained Tauri desktop app. `release-connect-binaries.yml` calls it
(`workflow_call`, see "Releasing the desktop app in the same run") after the CLI
release, so a desktop failure cannot block an npm or CLI-binary release; run by
hand it is the lane for staging builds and for retrying the app alone. It has no
push, tag, `workflow_run`, or repository-dispatch trigger.

The manual dispatch has exactly five inputs (a call adds `reuse_engines`, `mode`
and `present`):

| Input | Contract |
| --- | --- |
| `channel` | `staging` (default) or `stable`. Staging compiles with `ANYRAY_CONNECT_DESKTOP_DISTRIBUTION=staging` (app-staging, the `connect-desktop-staging` feed). Stable compiles with `production` (app.anyray.ai, the `connect-desktop` feed); it needs no staging release first. |
| `version` | Explicit plain `x.y.z`; `latest` and moving ranges are rejected. |
| `source_sha` | Exact lowercase 40-hex commit in the private `anyrayHQ/monorepo`; it must be reachable from the fetched `origin/main`. The workflow never checks out moving `main`. |
| `min_version` | Optional numeric dotted version with two to four components. Installs older than this floor update without asking; empty omits `minVersion`. It is written only once all three OSes are on the release. |
| `dry_run` | Defaults to `true`. A dry run retains the signed assets, consolidated checksums and signed channel manifest only as workflow artifacts. `false` publishes each finished OS to the versioned release and re-points the channel's feed release; neither becomes latest. |

| | staging | stable |
| --- | --- | --- |
| Versioned release | `connect-desktop-staging-v<version>-<short-sha>`, prerelease | `connect-desktop-v<version>-<short-sha>`, full release |
| Feed release (moving, prerelease) | `connect-desktop-staging` | `connect-desktop` |
| Feed contents | `connect-desktop-staging.json` + `.asc` | `connect-desktop.json` + `.asc`, plus unversioned `anyray-connect-desktop-{macos-universal.pkg,windows-x64.msi,linux-x64.deb,linux-x64.rpm}` |
| Manifest `artifact` | `anyray-connect-desktop-staging` | `anyray-connect-desktop` |

The channel names mirror the engine's lane table
(`connect/src/util/desktopUpdate.ts` in the monorepo) through
`scripts/desktop-channel.mjs`; an app rejects a feed whose `artifact` or tag
prefix is not its own, so a staging app never installs a stable build or the
reverse. Both channels publish with `--latest=false`: `releases/latest` belongs
to the CLI. The workflow records it before publication and requires it
unchanged after. The lane never writes `connect-update.json`, `SHA256SUMS` in
an existing CLI release, npm, Homebrew, Winget, `connect.sh`, `connect.ps1`, or
any current install path.

The stable feed's unversioned installers are the public download links the
docs download page and the console's enrollment page point at:
`https://github.com/anyrayHQ/install/releases/download/connect-desktop/anyray-connect-desktop-macos-universal.pkg`,
and likewise for the MSI, deb and rpm. They are byte-identical to the
versioned release's files, and they move with the feed in one switch.

### Releasing a build

There is no mandatory staging step: dispatching `channel: stable` with a `version`
and `source_sha` builds, signs and publishes the production app directly, and the
combined CLI release does the same. Staging stays available for manual testing:
dispatch `channel: staging` with `dry_run` unchecked, install that build on each OS
and confirm sign-in, update and uninstall. A stable build is always rebuilt from
source with the production marker; it never copies staging bytes.

Published versioned assets are never replaced. `scripts/publish-desktop-release.sh`
uploads a file only when the release lacks it, skips it when the release already
holds the same sha256, and fails naming it when the bytes differ, because clients
hold the earlier checksums. An asset an interrupted attempt left half-uploaded is
deleted and sent again. Signing a rebuild produces new bytes (timestamped GPG
signatures, notarized pkg, Authenticode), so a build run cannot be completed by
dispatching the same version again: it stops at the first file already published.
The derived `SHA256SUMS`, signed manifest and public key are rewritten from whatever
is on the release each time.

Recovery for a `release` run: if only the feed switch failed, run
`node scripts/publish-desktop-feed.mjs` with `REPO`, `VERSION`, `SOURCE_SHA`,
`CHANNEL` and `GH_TOKEN` set, from a directory containing `assets/` with the
manifest, signature and (stable) installers downloaded from that release; do not
regenerate them. If an installer is missing, release a new version. "Re-run failed
jobs" cannot help either way: artifact keys include the run attempt, so the re-run
consumer finds no artifacts from the earlier attempt.

Feed publication aborts on lookup errors, malformed versions, and backward
version changes. Both replacement assets upload as `.pending` before any live
asset is renamed. Old assets are retained as `.previous` until publication
succeeds; a failed switch attempts to restore their original names. GitHub asset
renames are not atomic: clients may see a brief missing asset or mismatched pair
during the switch and should retry later.

A failed upload, interrupted runner, failed rollback, or failed backup cleanup
can leave `.pending`/`.previous` assets. Further publication then stops for
operator recovery. Inspect asset IDs and manifests first. For rollback, rename
any new canonical assets to `.pending`, restore the old `.previous` assets to
their canonical names, verify the manifest/signature pair, then remove only the
abandoned `.pending` assets. If the new canonical pair is already valid and the
switch succeeded, remove only the old `.previous` backups. Never delete or
rebuild the versioned release to repair a feed.

The desktop app fetches its channel's manifest (`connect-desktop-staging.json`
or `connect-desktop.json`) from the feed release. It downloads the artifact named there from
the versioned prerelease. It verifies its sha256 from the manifest and its Apple
or Microsoft signature before installing; no updater key exists.

Invoke it from Actions → **Release Anyray Connect desktop**.
The workflow must itself be dispatched from the install repository's `main`
branch; its first job rejects any other workflow ref before preflight reads
secrets or any job fetches private source.
Paste the Connect version and the full private-monorepo commit, leave `dry_run`
checked for the first rehearsal, optionally set `min_version`, and inspect the
retained
`<feed>-assets-<version>-<short-sha>` artifact. Unchecking it publishes each
finished OS to the versioned release (a prerelease on staging) and re-points the
channel's feed; only `channel: stable` publishes anything customers download.

The retained/published set contains one signed/notarized universal macOS
`.pkg`, one universal `.app.tar.gz` containing the signed and stapled app, one
Authenticode-signed Windows x64 MSI, the two signed Windows inner executables
for audit, Linux x64 deb/rpm packages plus the two raw inner executables,
detached GPG signatures and public key, signed `SHA256SUMS`, and a signed
channel manifest binding them to `version` and `source_sha`.

### Build time and early failure checks

Before starting native runners, a Linux job checks the source SHA/version and
publication eligibility: a newer feed or a feed awaiting recovery fails the run
before any publication. `min_version` must not exceed `version`, and the release
version must fit MSI's `255.255.65535` limits. Dry runs skip remote publication
checks but still validate the source and version inputs. Nothing publishes, and the
feed is never rewritten, unless that check succeeded. The combined CLI release runs
the same check (`gate-private-source`) before it builds anything, and also requires
the npm package's `gitHead` to equal `source_sha`, so the reused engines come from
the commit being released.

Run Corepack from inside `private-source` so it uses the source's pinned pnpm.
The dependency install selects Connect and the VS Code extension that Connect
packages, with an isolated node linker so other workspace packages are omitted.
It keeps the frozen lockfile and disables install scripts. The CLI itself is
still built from the exact private source commit.

Native jobs download `@tauri-apps/cli@2.11.4` (including its exact-version native
binary) instead of compiling tauri-cli from Rust four times. Application Rust
builds use toolchain 1.98.0 and the checked-in Cargo lockfile. The Tauri launcher
resolves Cargo through rustup, prepends that toolchain directory to the child
PATH, and checks Cargo/rustc versions before building or bundling; changing the
rustup default alone does not override a runner-installed standalone Cargo.
Source and Cargo build output are not cached or uploaded in this public repository. Intermediate
artifacts last seven days to allow delayed jobs and retries; the final rehearsal
artifact lasts 14 days.
Artifact uploads skip redundant compression of installers and binary archives.

Windows steps stop immediately on failed native commands. MSI signatures are
verified on Windows with `Get-AuthenticodeSignature`, including publisher and
timestamp, before installation and before release assembly. The Python verifier
is used only for PE executables, not MSI compound documents.

### Private source and version contract

Each native job that needs source mints its own short-lived GitHub App token,
restricted to `contents: read` on **only** `anyrayHQ/monorepo`. Checkout uses
the explicit SHA, `fetch-depth: 0` (so ancestry can be proven), and
`persist-credentials: false`. `scripts/verify-connect-desktop-source.mjs` then
requires all of the following before source-controlled build code executes:

- checked-out `HEAD` equals `source_sha`;
- that commit is an ancestor of the fetched `refs/remotes/origin/main`;
- `connect/package.json`, the tray's `Cargo.toml`, `Cargo.lock`, and
  `tauri.conf.json` all equal `version`;
- Tauri's `bundle.externalBin` is exactly `binaries/anyray-connect`;
- Tauri's macOS minimum is `13.0`. Signed pkg and updater bundle verification
  also checks the generated `LSMinimumSystemVersion`.

The private checkout is local to that native job and is **never uploaded** as
source. The one exception is the three macOS pkg maintainer scripts
(`preinstall`, `postinstall`, `uninstall.sh`): they are plain POSIX shell, not
compiled, and the unsigned build job copies them byte-identical from the
reviewed source SHA into the unsigned macOS artifact so `sign-macos` can build
the installer from them. They carry the same bucket, access, and retention as
the compiled app in that artifact. No TypeScript or Rust source ever crosses a
job boundary. Provision a GitHub App installed only on the private monorepo,
grant it repository Contents read-only, and set these install-repository
secrets:

| Secret | Value |
| --- | --- |
| `MONOREPO_READ_APP_ID` | The read-only GitHub App id. |
| `MONOREPO_READ_APP_PRIVATE_KEY` | Its PEM private key. GitHub exchanges it for a short-lived installation token and revokes that token in the action post-step. |

The private commit must already contain
`scripts/stage-connect-tray-engine.mjs`. The workflow builds the CLI engine from
that same checkout and lets the script enforce the app/engine version contract
while staging the Tauri external binary:

| Desktop target | Required staged engine |
| --- | --- |
| macOS universal | `connect-tray/src-tauri/binaries/anyray-connect-universal-apple-darwin` (Bun arm64 + x64 joined with `lipo`) |
| Windows x64 | `connect-tray/src-tauri/binaries/anyray-connect-x86_64-pc-windows-msvc.exe` |
| Linux x64 | `connect-tray/src-tauri/binaries/anyray-connect-x86_64-unknown-linux-gnu` |

The universal macOS build stages its validated universal engine under all three
externalBin target names: `aarch64-apple-darwin`, `x86_64-apple-darwin`, and
`universal-apple-darwin`. Tauri checks each architecture during compilation and
the universal name during bundling. Reusing the universal engine for all three
also avoids needing Rosetta to validate an x64-only sidecar on the ARM runner.

Only the three native Tauri compilation steps receive
`ANYRAY_CONNECT_DESKTOP_DISTRIBUTION=staging`. Unsigned monorepo CI/local builds
and the Windows bundle-only job do not receive the distribution marker.

### Native build, signing, and verification order

Compilation jobs receive the private-source credential but **no signing
credentials**. Signing jobs download compiled artifacts and receive no private
source or GitHub App credential:

- **macOS:** `provision-mac` allocates the ephemeral CodeBuild Mac right after
  preflight; `build-macos-unsigned` compiles one unsigned universal `.app` on
  it, then copies `preinstall`, `postinstall`, and `uninstall.sh` from the
  reviewed `private-source/connect-tray/src-tauri/macos/` checkout alongside
  the unsigned app in the same artifact — those scripts are product behaviour
  and live in the monorepo next to their Windows and Linux installer twins,
  so this lane only carries them along, byte-identical, from the same source
  SHA as the app. The artifact-only `sign-macos` job signs the bundled Bun
  engine (hardened runtime + minimal `allow-jit` entitlement), signs the
  outer app, requires Apple Team ID `V53XMA78UF` and bundle identifier
  `ai.anyray.connect-tray`, notarizes and staples it, packs the stapled app as
  a space-free `.app.tar.gz` for the updater. It then builds the uninstaller:
  a payload-free distribution pkg from the monorepo's `macos/uninstaller/`
  sources whose postinstall runs the same `uninstall.sh`, signed, notarized and
  stapled on its own (one extra notarization round trip per release) because it
  ships inside the installer's payload at
  `/usr/local/lib/anyray-connect/Uninstall Anyray Connect.pkg` (root-owned,
  0644: the engine opens it only when nobody but root can write it). It is the
  self-serve removal route (Apple's Installer asks for the password; the app
  never elevates) and the route for an MDM that can only deploy packages. It
  never lands in `out/`, so the published set keeps exactly one `.pkg`. The job
  then builds a non-relocatable
  installer `.pkg` from the downloaded scripts (preinstall refuses foreign
  launchers/shims before Installer writes the payload, postinstall creates the
  `/usr/local/bin` symlink and shims and installs `uninstall.sh`), signs it
  with the Developer ID Installer certificate, and notarizes and staples it. A
  static Installer readme tells interactive users that the deprecated Anyray
  Connect CLI package and fleetd are removed when present. The credential-free
  `verify-macos-signed` job proves the final pkg refuses a foreign launcher,
  then sweeps a retired CLI receipt whose launcher is a copy of the signed
  engine while reporting locked residue. It plants an installed and loaded
  Anyray-owned fleetd receipt/runtime (secret file present) and asserts the
  receipt, daemon, plist, secret, and `/usr/local/bin/orbit` symlink are all
  gone while the audit logs and `/usr/local/bin` itself (birth time unchanged)
  are retained. It then plants fleetd ownership via a plist reference alone,
  with no secret file, and asserts that case is swept the same way; that case
  leaves through the installed uninstaller pkg (`installer -pkg` on its
  installed path, whose script deletes the directory it sits in) instead of
  the script, after the payload copy's signature, staple, Gatekeeper verdict,
  root authorization and byte-identical `uninstall.sh` are checked. Finally it
  leaves a separately installed and loaded foreign Fleet agent, receipt, and
  `/usr/local/bin/orbit` symlink untouched; it then exercises the real desktop
  install, GUI migration smoke, symlink/helpers, and uninstall. Teardown
  follows the signed smoke with `always()`.
  The Mac host is reused inside its paid 24h window, so the signing job
  deletes its keychain and key files in an `always()` step and the build
  never sees a secret.
- **Windows x64:** compile the raw Tauri main executable and bundled engine on
  Windows; sign and verify both through the existing Azure Artifact Signing
  script on Linux; restore those signed bytes on Windows and create the MSI
  from the already-built files (with a before/after hash guard); sign the outer
  MSI through Azure; finally verify the two inner executables and MSI with
  Windows' `Get-AuthenticodeSignature` trust stack, including publisher and
  timestamp.
- **Linux x64:** compile the raw Tauri main executable and engine, then build
  native `.deb` and `.rpm` packages from those already-built files (with the
  same before/after hash guard). A separate artifact-only signing job uses the
  existing release GPG key to detach-sign both inner executables and both outer
  packages and exports the public key. Final assembly uses the same key and
  checked-in signer to sign `SHA256SUMS` plus
  `connect-desktop-staging.json`.

After signing, credential-free native jobs exercise the actual install/remove
path before assembly can run. In addition to checking the bundled engine
version, every platform launches the **installed Tauri main executable**, waits
up to 30 seconds for its exact stable autostart artifact, validates that artifact
points at the installed main executable, force-kills the tray, and then performs
the real uninstall:

- macOS installs the pkg with `installer -pkg` as root and checks the bundle,
  engine, launcher, helpers, receipts and the sweep cases. The CodeBuild Mac is
  headless (no console session), so the native login-item lifecycle is not
  exercised in CI. Run `scripts/smoke-connect-desktop-macos.py` by hand on a
  Mac with a real GUI login, in a dedicated non-root account that holds no
  Anyray profile, process, or login registration, and record the result in the
  monorepo's `connect-tray/ACCEPTANCE.md` against the exact candidate. Changing
  `HOME` is not isolation for Service Management, so never run it on a
  developer account. The same manual pass covers the UI Quit action, a real
  logout/login, enrollment, key renewal, and an EDR policy;
- Windows first plants an unsigned foreign engine at
  `C:\Program Files\Anyray\anyray-connect.exe`, requires the MSI to refuse it
  with exit 1603 and a failed `SweepMachineState` action without changing it,
  then plants a stale managed credential
  shim and installs cleanly into that fixed directory. The smoke verifies the
  installed engine's Authenticode signature, both regenerated managed shims and
  their engine target, the machine `PATH` entry, `uninstall.ps1`, and the
  `ai.anyray.connect-tray` value under
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`; MSI uninstall must
  remove both shims and the machine `PATH` entry. On failure, the job prints
  context around MSI failure markers. Full refusal, install, and uninstall
  logs (whichever were created) are uploaded even when the smoke fails as
  `connect-desktop-windows-msi-logs`. The job summary links the S3 URI; download
  them with `aws s3 cp <uri>/ ./msi-logs/ --recursive` before the bucket's
  seven-day retention expires. A generic 1603 is not proof that the refusal
  action ran. The refusal *cause* is only checked against engines that print the
  `ANYRAY-CA-ERROR` stdout marker (monorepo #2839); an older engine warns instead,
  because a redirected PowerShell error stream reaches the MSI log as a bare
  CLIXML header and never carries the message;
- Ubuntu runs as a fixed `tester` account it creates and removes each run. It
  installs synthetic legacy CLI (from `ci/nfpm.yaml`) and `fleet-osquery`
  (from its own YAML) deb/rpm packages, both built with the same pinned nfpm
  (test inputs, never release artifacts), around the candidate engine,
  replaces both with the desktop package through the package manager, and
  validates that their records, the `orbit.service` unit, and `/opt/orbit`
  are gone, `/usr/bin/anyray-connect` belongs to the desktop package, and
  `$HOME/.config/autostart/ai.anyray.connect-tray.desktop` (header and
  installed executable path) plus the CLI bootstrap files are as expected.
  It then exercises the fleet uninstall helper
  (`/usr/lib/anyray-connect/uninstall.sh`) end to end: the helper's own
  `--json` output on stdout proves whether it ran the engine's `uninstall` or
  `offboard` user-layer verb, and the desktop deb is gone afterward. The host
  is Ubuntu (deb only), so this never exercises the rpm branch of
  `uninstall.sh` (`dnf remove`).

`npm run test:desktop-release` covers the workflow-shape and account-isolation
regressions for these smokes.

Each smoke fails if its test-owned autostart artifact pre-exists and removes only
that exact artifact in its trap/finally cleanup; installer uninstall is not
claimed to remove per-user autostart state. Every smoke also pre-creates and
checks representative Connect profile state plus an existing refresh-scheduler
sentinel. Startup may update only the ownership fields (`engineOwner`,
`engineOwnerPath`, `engineOwnerObservedAt`, `persistenceOwner`, `trayAppPath`,
and the login-registration fields): verification requires app ownership, an
engine path and tray app path that resolve to the installed app, and valid
RFC 3339 timestamps, while preserving every other profile field. It waits up to
30 seconds for ownership adoption before stopping the tray. Scheduler state must
remain byte-identical everywhere. Package install, and a package-manager-only
uninstall (Windows `msiexec /x`, Linux `rpm -e`), must leave the pre-existing
profile byte-identical; the Linux fleet uninstall helper's own `uninstall`
user-layer verb is the deliberate exception, removing `~/.anyray` (the profile
included), while its `offboard` verb leaves it in place. Path checks compare
canonical paths to accept runner symlinks.

`SHA256SUMS` is generated only after Apple/Azure signing, because those signers
rewrite their artifacts. The staging manifest binds every checksum to the
explicit Connect version and private source commit and names the versioned
prerelease tag that holds the artifacts.

### Required infrastructure and first-run validation

The existing Apple Application certificate/password, the Apple Installer
certificate/password, the notarization trio, four Azure variables, Linux GPG
key/passphrase, and Mac-fleet role listed earlier in this document are
mandatory; preflight fails closed and names anything absent. The pkg is signed
with the Installer identity, separate from the Application identity used for
the app and engine. The lane also needs only the two GitHub App secrets above.

Do not turn a missing credential into an unsigned skip.

Native runner requirements are:

| Platform/job | Runner |
| --- | --- |
| macOS build, signing, signed smoke | Existing on-demand `codebuild-anyray-install-runner-mac-…` MAC_ARM fleet. Signing is artifact-only, with no private source checkout. Rust comes from the image, with a pinned `rustup-init` fallback. |
| Windows build/bundle/native verify | Existing `codebuild-anyray-install-runner-win-…` Windows x64 project. The image is not documented to ship Rust or MSVC, so the build job installs a pinned VS 2022 Build Tools (only the x64 compiler and a Windows SDK) and both compile jobs a pinned `rustup-init.exe` (the bundle job links nothing, so it needs no MSVC), each checksum-verified, skipping whatever is already present. |
| Linux build/native smoke | `codebuild-anyray-install-runner-ubuntu-…` (Ubuntu 22.04 `standard:7.0`), for webkit2gtk 4.1, Xvfb/DBus, and native deb/rpm tooling. `apt-get update` reads only `/etc/apt/sources.list`: the image's third-party sources (Chrome's times out for four minutes) are never installed from. 22.04 on purpose: the build host's glibc (2.35) is the floor for every machine that runs the shipped binary; 24.04 would drop Ubuntu 22.04 and Debian 12 users. Rust from a pinned `rustup-init`. |
| Azure/GPG/assembly/publish | Existing `codebuild-anyray-install-runner-…` Linux project. |

The two GitHub App secret names above now exist in the install repository. The
first dry run must still validate the external side of that trust boundary: the
App is installed on `anyrayHQ/monorepo` and its installation grant is repository
Contents read-only.

No job uses a GitHub-hosted runner, so the lane does not depend on the org's
Actions billing. The persistent install runner is Amazon Linux and cannot
substitute for the Ubuntu or Mac build environments; the Ubuntu project and the
Mac fleet are the replacements.

The Mac universal build, Windows MSI bundling, and final signing sequence also
need one full credentialed dry-run rehearsal on the real runners. Local static
checks cannot emulate Developer ID notarization, Azure-issued signatures,
Windows native trust verification, or Tauri's platform bundlers; do not publish
the staging prerelease until that dry run is green. This lane has never run with
credentials, so the first credentialed dry run is the real integration test.

## Trusted-channel packages (winget · Homebrew)

Alongside the raw binaries and the MDM `.pkg`/`.deb`/`.rpm`, each production
release renders package-manager manifests that install the **already signed**
asset through a channel endpoint security allowlists — so a Windows user runs
`winget install Anyray.Connect` and a macOS user `brew install --cask
anyray-connect` instead of piping `connect.ps1`/`connect.sh` into an
interpreter. The `Regenerate the trusted-channel package manifests` step pins
each manifest to the exact SHA-256 in `SHA256SUMS`, so a manifest can never
point at bytes a release does not contain.

Rendering is automatic; **delivery is a manual external step** each carries its
own README for, because neither channel is self-hosted:
- **winget** (`winget/README.md`): the manifests under
  `winget/manifests/a/Anyray/Connect/<version>/` are submitted as a PR to
  `microsoft/winget-pkgs`; the first submission's `Publisher` (`Othentic Labs
  LTD`) must match the `.exe`'s Authenticode identity.
- **Homebrew** (`Casks/README.md`): the tap repo `anyrayHQ/homebrew-tap`
  already exists. When the `HOMEBREW_TAP_TOKEN` secret is set — a fine-grained
  PAT (or GitHub App token) with `contents: write` on that tap repo ONLY — the
  `Publish the Homebrew cask to the tap` step pushes the rendered cask there
  automatically on every release that becomes `latest` (an older re-cut never
  rolls the tap back). Until the token is set the step skips silently, and the
  cask can be updated by hand: run `scripts/gen-homebrew-cask.sh` and push
  `Casks/anyray-connect.rb`, or `brew bump-cask-pr`.

Windows MSI packaging sets Tauri's bundle-type marker to MSI before Authenticode
signing. The pinned bundler normally patches that marker while packaging and
restores its input afterward, which can hide a broken signature inside the MSI
from a before/after input hash check. The preparation helper requires exactly one
known marker and rejects already-signed input; the bundle job checks the prepared
marker without changing the signed file. Tauri may warn that the original UNK
marker is absent because it is already MSI. Native verification also compares
both installed executables byte-for-byte with the signed handoff artifacts and
checks their Authenticode signatures. Revalidate this contract when upgrading Tauri.
