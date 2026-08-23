# Releasing `anyray-connect` binaries

`.github/workflows/release-connect-binaries.yml` compiles the published
`anyray-connect` npm package into standalone executables and attaches them to a
GitHub Release on this repo. The monorepo's `publish-connect.yml` dispatches it
after every npm publish; it can also be run by hand (Actions → *Release
anyray-connect binaries* → `version` = the npm version, or `latest`).

## Signing (RFC 0010 §6)

Signing is **strictly conditional on the settings below being configured**.
With none of them set, the workflow publishes the same unsigned binaries as it
always has, byte for byte — provisioning a platform's settings is the only
switch that turns its signing on. The `.deb`/`.rpm` packages are built either
way as additive assets; their GPG signatures appear once the release key
exists.

Each platform gates on a different thing, and the gate is always a *presence*
check on one value: macOS on `APPLE_SIGNING_CERT_P12`, Windows on
`AZURE_SIGNING_CLIENT_ID`, Linux on `LINUX_SIGNING_GPG_KEY`. **The gate makes an
unconfigured lane silent, not loud** — a release with the Windows variables unset
publishes an unsigned `.exe` and goes green. That is deliberate (a half-provisioned
lane must not block a release), but it means "the release passed" is not evidence
the binary is signed. Check the `sign-windows` job actually ran.

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
- **A bare mach-o binary cannot be stapled.** `xcrun stapler staple` only
  applies to bundles/dmg/pkg, so the notarized CLI binaries ship as-is and
  Gatekeeper fetches the notarization ticket online. When the desktop tray
  ships as a `.app` bundle, its lane is sign → notarize → staple (seam comment
  in the `sign-macos` job).

## Secrets to provision (repo → Settings → Secrets and variables → Actions)

### macOS — Developer ID signing + notarization

| Secret | What it is | Where to get it |
| --- | --- | --- |
| `APPLE_SIGNING_CERT_P12` | Base64 of the **Developer ID Application** certificate + private key (`.p12`) | [Apple Developer Program](https://developer.apple.com/account) ($99/yr) → Certificates → create *Developer ID Application*; import into Keychain Access, export as `.p12` with a password, then `base64 -i cert.p12` |
| `APPLE_SIGNING_CERT_PASSWORD` | The `.p12` export password | Chosen at export time |
| `APPLE_NOTARY_KEY_ID` | App Store Connect API key ID | [App Store Connect](https://appstoreconnect.apple.com) → Users and Access → Integrations → App Store Connect API → create a **Team key** (Developer role suffices) |
| `APPLE_NOTARY_ISSUER_ID` | Issuer ID (UUID) shown on the same page | Same page as the key |
| `APPLE_NOTARY_KEY` | Base64 of the `.p8` private key (`base64 -i AuthKey_XXXX.p8`) | Downloadable **once** at key creation — store the original safely |

### Windows — Authenticode (Azure Artifact Signing + jsign)

All four are **variables, not secrets**: OIDC federation means there is no client
secret to store. `AZURE_SIGNING_CLIENT_ID` is also the on/off switch for the
whole lane — unset, every step skips and an unsigned binary passes through.

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
   valid to 2028-11-14). This step is **portal-only**; the Azure CLI cannot do
   it, and it needs the *Artifact Signing Identity Verifier* role.
2. **Certificate profile** → type **Public Trust**, created against that
   validation. `PublicTrustTest` chains to a root Windows does **not** trust —
   rehearsal only, never a release.
3. **Entra app + federated credential** for this repo, then grant its service
   principal **Artifact Signing Certificate Profile Signer**, scoped to the
   certificate profile. That role is what permits signing; Owner and Contributor
   deliberately do **not** include it. Run
   `PROFILE=<profile-name> scripts/azure-signing-setup.sh` — it does all three
   idempotently and prints the `gh variable set` lines for step 4.
4. Set the four variables above.

Steps 1 and 2 are portal-only and step 3 is scripted, which is not an
arbitrary split: Microsoft does not expose identity validation to the CLI, and
the profile decides the publisher name baked into every certificate it issues,
so it is worth choosing in front of the validation list rather than passing as
an argument.

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
- **`fleetd.msi` is still unsigned** (see below).
>
> **Decommissioning AWS.** KMS key `alias/anyray-codesign-windows` (eu-central-1)
> and the `AWS_SIGNING_*` variables are now unused. The key holds no certificate
> and signed nothing, so deleting it loses nothing — schedule its deletion and
> remove the stale variables once a release has signed green through Azure.

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
- [ ] Retire the `AWS_SIGNING_*` variables and schedule the KMS key deletion.
- [ ] Record the publisher string users will actually see on the UAC prompt, so
      support can answer "is this really you?" without guessing.

**`fleetd.msi` is still unsigned** and is out of scope here: it is built by
`release-fleetd-installer.yml` on a Windows runner and is a separate lane. It
would be signed the same way — jsign against the same certificate profile, no
Windows dependency — but the gateway re-serves those bytes to enrolled machines,
so that change needs its own verification that re-serving preserves the
signature rather than being bolted on here.

### Linux — GPG-signed `.deb`/`.rpm` **and `SHA256SUMS`**

| Secret | What it is | Where to get it |
| --- | --- | --- |
| `LINUX_SIGNING_GPG_KEY` | ASCII-armored **secret** signing key | `gpg --full-generate-key` (RSA 4096 or Ed25519, e.g. `Anyray Release Signing <support@anyray.ai>`), then `gpg --armor --export-secret-keys <keyid>` |
| `LINUX_SIGNING_GPG_PASSPHRASE` | Its passphrase | Chosen at key generation |

One key, two consumers. `package-linux` publishes the **public** key as the
release asset `anyray-connect-signing-key.asc` plus a detached `.asc` next to
each package; the `release` job additionally detach-signs the checksum file to
`SHA256SUMS.asc`.

**After provisioning the key, record its fingerprint below.** The release job
prints `signing key fingerprint: <40 hex>` in its log, and the release notes
tell users to compare what they import against this file — a fingerprint nobody
publishes out-of-band is a fingerprint nobody can check.

> Current fingerprint: **not yet provisioned.** No release to date carries a
> `.asc` asset, so the key does not exist yet and its fingerprint cannot be
> derived from anything public. Fill this in from the release log the first time
> the workflow runs with `LINUX_SIGNING_GPG_KEY` set.

## Verifying a download

Two independent paths, both available from the first release cut after this
landed. Release notes link back here for the key fingerprint.

**The checksums are signed** (once the release key above exists). Verify the
checksum file first, then the binary against it — checking a binary against an
unsigned checksum file from the same release only proves the download was not
corrupted, not that the release is genuine:

```bash
gpg --import anyray-connect-signing-key.asc   # compare against the fingerprint above
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum --ignore-missing --check SHA256SUMS
gpg --verify anyray-connect_<version>_amd64.deb.asc anyray-connect_<version>_amd64.deb
```

**Every binary and package carries build provenance**, signed through Sigstore
from the workflow's OIDC identity. This needs no key distribution at all, and
unlike the GPG path it does not wait on a secret being provisioned — it covers
every release cut from this workflow onwards. Releases published before this
change have no attestation and cannot retroactively gain one:

```bash
gh attestation verify anyray-connect-linux-x64 --repo anyrayHQ/install
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

Both persistent projects and the ephemeral mac project are webhook-driven
(`WORKFLOW_JOB_QUEUED`) and **gated to the maintainer actor** (`ACTOR_ACCOUNT_ID` = 16443050) —
required because the repo is public, so a fork-PR actor can never start a runner. Adding a
release maintainer means extending that id in the webhook filters and `mac-fleet.sh`.

Apple signing secrets (codesign path, all set): `APPLE_SIGNING_CERT_P12` +
`APPLE_SIGNING_CERT_PASSWORD`, `APPLE_NOTARY_KEY` (base64 `.p8`), `APPLE_NOTARY_KEY_ID`,
`APPLE_NOTARY_ISSUER_ID`. (`APPLE_SIGNING_CERT_PEM` was set for the abandoned rcodesign path and
is unused.)

