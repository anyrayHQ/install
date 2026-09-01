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

### Monorepo read app (tray lane only)

| Secret | What it is | Where to get it |
| --- | --- | --- |
| `MONOREPO_READ_APP_ID` | App ID of the **anyray-monorepo-read** GitHub App (4791950) | Org → Settings → Developer settings → GitHub Apps |
| `MONOREPO_READ_APP_PRIVATE_KEY` | The app's PEM private key | Same page → "Generate a private key"; upload with `gh secret set … < key.pem`, then delete the local file |

The `tray-linux` lane (opt-in `build_tray` input) builds the RFC 0010 desktop
tray, whose Rust source lives in the **private monorepo** — the npm package
carries only the CLI. The job mints a one-hour installation token from these
secrets (`contents: read`, installation scoped to `anyrayHQ/monorepo` alone) and
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
**on-demand macOS fleet** created per release:

| Job | Runner | CodeBuild project (eu-central-1) |
| --- | --- | --- |
| build, provision-mac, sign-windows, package-linux, release, teardown-mac | Amazon Linux (`amazonlinux2-x86_64-standard:5.0`) | `anyray-install-runner` |
| sign-macos | **on-demand** macOS (MAC_ARM, `mac2-m2.metal`) | `anyray-install-runner-mac` (ephemeral) |
| tray-linux (opt-in `build_tray`) | Ubuntu 22.04 (`aws/codebuild/standard:7.0`) | `anyray-install-runner-ubuntu` |

**`sign-windows` no longer needs Windows.** jsign is a pure-Java Authenticode
implementation, so signing moved to the Linux runner — no Windows SDK download,
no `signtool`. This is also why the lane does **not** use Microsoft's own signing
integration: that path is SignTool + .NET 8 + the Artifact Signing dlib, all
Windows-only, and would drag the job back onto a Windows fleet to do the same
work. **Keep the `anyray-install-runner-win` project**: this workflow no longer
uses it, but `release-fleetd-installer.yml`'s `build-windows` still does
(fleetctl shells out to WiX `heat`, which needs a real Windows host).

**Why macOS is on-demand.** Bun-compiled binaries can only be Developer-ID-signed by Apple's
own `codesign` (the Linux signers rcodesign and quill both mishandle Bun's x64 Mach-O — proven
by E2E: the signature verifies but the binary won't launch). Apple's codesign needs macOS, and
CodeBuild only offers macOS via a reserved-capacity EC2 Mac fleet that cannot scale below one
instance (24-hour-minimum dedicated-host billing, ~$450/mo if left standing). So the release
allocates a Mac **only for the signing run**: `provision-mac` creates the MAC_ARM fleet + an
ephemeral runner project, `sign-macos` runs on it, and `teardown-mac` (always) deletes both.
Net cost is one 24-hour-minimum Mac charge per release (~$15-16), never a standing bill. The
lifecycle lives in `scripts/mac-fleet.sh` (`up`/`down`); the release workflow drives it via a
scoped GitHub-OIDC role (`AWS_MAC_FLEET_ROLE_ARN` repo variable → `anyray-install-mac-fleet-ci`).

**`anyray-install-runner-ubuntu`** exists for the tray lane alone: Tauri links
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

Both persistent projects and the ephemeral mac project are webhook-driven
(`WORKFLOW_JOB_QUEUED`) and **gated to the maintainer actor** (`ACTOR_ACCOUNT_ID` = 16443050) —
required because the repo is public, so a fork-PR actor can never start a runner. Adding a
release maintainer means extending that id in the webhook filters and `mac-fleet.sh`.

Apple signing secrets (all required): `APPLE_SIGNING_CERT_P12` +
`APPLE_SIGNING_CERT_PASSWORD` for the inner binaries,
`APPLE_INSTALLER_CERT_P12` + `APPLE_INSTALLER_CERT_PASSWORD` for the outer
package, and `APPLE_NOTARY_KEY` (base64 `.p8`) + `APPLE_NOTARY_KEY_ID` +
`APPLE_NOTARY_ISSUER_ID` for notarization. (`APPLE_SIGNING_CERT_PEM` was set for
the abandoned rcodesign path and is unused.)

## Connect desktop installers — isolated staging lane (ANY-250)

`.github/workflows/release-connect-desktop.yml` is a **manual, staging-only**
release lane for the self-contained Tauri desktop app. It is intentionally a
separate workflow from `release-connect-binaries.yml`: the CLI publisher does
not call it, and a desktop failure cannot block an npm or CLI-binary release.
It has no push, tag, `workflow_run`, or repository-dispatch trigger.

The dispatch has exactly three inputs:

| Input | Contract |
| --- | --- |
| `version` | Explicit plain `x.y.z`; `latest` and moving ranges are rejected. |
| `source_sha` | Exact lowercase 40-hex commit in the private `anyrayHQ/monorepo`; it must be reachable from the fetched `origin/main`. The workflow never checks out moving `main`. |
| `dry_run` | Defaults to `true`. A dry run retains signed assets only as a workflow artifact. `false` may create only `connect-desktop-staging-v<version>-<short-sha>`, marked prerelease and `--latest=false`. |

There is deliberately no stable/public selector. Before a staging prerelease is
created, the workflow records `releases/latest`; after publication it requires
that value to be unchanged. The lane never writes `connect-update.json`, a
Tauri updater manifest, `SHA256SUMS` in an existing CLI release, npm, Homebrew,
Winget, `connect.sh`, `connect.ps1`, or any current install path. The signed
manifest explicitly carries `"updater": null` until updater design is a
separate reviewed change.

Invoke it from Actions → **Release Anyray Connect desktop (staging only)**.
The workflow must itself be dispatched from the install repository's `main`
branch; its first job rejects any other workflow ref before preflight reads
secrets or any job fetches private source.
Paste the Connect version and the full private-monorepo commit, leave `dry_run`
checked for the first rehearsal, and inspect the retained
`connect-desktop-staging-assets-<version>-<short-sha>` artifact. Unchecking it
does not make the release public/stable; it only creates the explicit staging
prerelease described above.

The retained/published set contains one signed/notarized universal macOS DMG,
one Authenticode-signed Windows x64 MSI, the two signed Windows inner
executables for audit, Linux x64 deb/rpm packages plus the two raw inner
executables, detached GPG signatures and public key, signed `SHA256SUMS`, and a
signed `connect-desktop-staging.json` binding them to `version` and
`source_sha`.

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
- Tauri's `bundle.externalBin` is exactly `binaries/anyray-connect`.

The private checkout is local to that native job and is **never uploaded**.
Only compiled executables and packages cross a job boundary. Provision a GitHub
App installed only on the private monorepo, grant it repository Contents
read-only, and set these install-repository secrets:

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

Only the three native Tauri compilation steps receive
`ANYRAY_CONNECT_DESKTOP_DISTRIBUTION=staging`. Unsigned monorepo CI/local builds
and the Windows bundle-only job do not receive the distribution marker.

### Native build, signing, and verification order

Compilation jobs receive the private-source credential but **no signing
credentials**. Signing jobs download compiled artifacts and receive no private
source or GitHub App credential:

- **macOS:** `provision-mac` allocates the ephemeral CodeBuild Mac right after
  preflight; `build-macos-unsigned` compiles one unsigned universal `.app` on
  it. The artifact-only `sign-macos` job signs the bundled Bun engine (hardened
  runtime + minimal `allow-jit` entitlement), signs the outer app, requires
  Apple Team ID `V53XMA78UF` and bundle identifier
  `ai.anyray.connect-tray`, notarizes and staples it, then creates, signs,
  notarizes, and staples one universal `.dmg`. A credential-free
  `verify-macos-signed` job on the same fleet mounts and exercises the final
  DMG. Teardown follows the signed smoke with `always()`. The Mac host is
  reused inside its paid 24h window, so the signing job deletes its keychain
  and key files in an `always()` step and the build never sees a secret.
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

- macOS copies the app from the DMG into a temporary Applications analogue and
  validates `$HOME/Library/LaunchAgents/ai.anyray.connect-tray.plist`, including
  its `Label` and installed executable path;
- Windows silently installs the MSI into a temporary `INSTALLDIR` and validates
  the `ai.anyray.connect-tray` value under
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;
- Ubuntu installs and tests both the deb and rpm under Xvfb/DBus and validates
  `$HOME/.config/autostart/ai.anyray.connect-tray.desktop`, including its
  `[Desktop Entry]` header and installed executable path.

Each smoke fails if its test-owned autostart artifact pre-exists and removes only
that exact artifact in its trap/finally cleanup; installer uninstall is not
claimed to remove per-user autostart state. Every smoke also pre-creates and
hashes representative Connect profile state plus an existing refresh-scheduler
sentinel, and requires both hashes to remain unchanged after running and
uninstalling the desktop app.

`SHA256SUMS` is generated only after Apple/Azure signing, because those signers
rewrite their artifacts. The staging manifest binds every checksum to the
explicit Connect version and private source commit.

### Required infrastructure and first-run validation

The existing Apple Application certificate/password and notarization trio,
four Azure variables, Linux GPG key/passphrase, and Mac-fleet role listed
earlier in this document are mandatory; preflight fails closed and names
anything absent. (A DMG uses the Application identity, so this lane does not
consume the separate Apple Installer certificate used by `.pkg`.) The lane also
needs the two GitHub App secrets above. Do not turn a missing credential into
an unsigned skip.

Native runner requirements are:

| Platform/job | Runner |
| --- | --- |
| macOS build, signing, signed smoke | Existing on-demand `codebuild-anyray-install-runner-mac-…` MAC_ARM fleet. Signing is artifact-only, with no private source checkout. Rust comes from the image, with a pinned `rustup-init` fallback. |
| Windows build/bundle/native verify | Existing `codebuild-anyray-install-runner-win-…` Windows x64 project. The image is not documented to ship Rust or MSVC, so both compile jobs install a pinned VS 2022 Build Tools (VCTools workload) and a pinned `rustup-init.exe`, each checksum-verified, skipping whatever is already present. |
| Linux build/native smoke | `codebuild-anyray-install-runner-ubuntu-…` (Ubuntu 22.04 `standard:7.0`), for webkit2gtk 4.1, Xvfb/DBus, and native deb/rpm tooling. 22.04 on purpose: the build host's glibc (2.35) is the floor for every machine that runs the shipped binary; 24.04 would drop Ubuntu 22.04 and Debian 12 users. Rust from a pinned `rustup-init`. |
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
the staging prerelease until that dry run is green.

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
