# Releasing `anyray-connect` binaries

`.github/workflows/release-connect-binaries.yml` compiles the published
`anyray-connect` npm package into standalone executables and attaches them to a
GitHub Release on this repo. The monorepo's `publish-connect.yml` dispatches it
after every npm publish; it can also be run by hand (Actions → *Release
anyray-connect binaries* → `version` = the npm version, or `latest`).

## Signing (RFC 0010 §6)

Signing is **strictly conditional on the secrets below being configured**.
With none of them set, the workflow publishes the same unsigned binaries as it
always has, byte for byte — provisioning a platform's secrets is the only
switch that turns its signing on. The `.deb`/`.rpm` packages are built either
way as additive assets; their GPG signatures appear once the release key
exists.

**Build provenance is the exception**: `actions/attest-build-provenance` is
*not* secret-gated. It signs through the workflow's own OIDC identity, so every
release carries verifiable provenance whether or not any signing secret exists.

Three invariants the workflow encodes — keep them if you touch it:

- **`SHA256SUMS` is generated in the `release` job, AFTER the signing jobs.**
  `codesign` and `signtool` rewrite the binaries, so a checksum taken at
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

### Windows — Authenticode

| Secret | What it is | Where to get it |
| --- | --- | --- |
| `WINDOWS_SIGNING_CERT_PFX` | Base64 of a code-signing certificate + private key (`.pfx`/`.p12`) | An Authenticode CA (DigiCert, Sectigo, SSL.com, …), **OV** code-signing certificate exported as `.pfx`, then `base64 -w0 cert.pfx` |
| `WINDOWS_SIGNING_CERT_PASSWORD` | The `.pfx` password | Chosen at export time |

> Reality check: since mid-2023 **EV** Authenticode keys must live on an HSM or
> hardware token and cannot be exported as a `.pfx`. This lane therefore takes
> an OV certificate. If EV (instant SmartScreen reputation) is ever required,
> the step needs reworking against a cloud signer (Azure Trusted Signing /
> DigiCert KeyLocker) instead of `signtool /f`.

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
blocks GitHub-hosted runners). Two persistent Linux/Windows runner projects plus an
**on-demand macOS fleet** created per release:

| Job | Runner | CodeBuild project (eu-central-1) |
| --- | --- | --- |
| build, provision-mac, package-linux, release, teardown-mac | Amazon Linux (`amazonlinux2-x86_64-standard:5.0`) | `anyray-install-runner` |
| sign-windows | Windows Server 2022 | `anyray-install-runner-win` |
| sign-macos | **on-demand** macOS (MAC_ARM, `mac2-m2.metal`) | `anyray-install-runner-mac` (ephemeral) |

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

