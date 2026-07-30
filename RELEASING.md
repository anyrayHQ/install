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

Two invariants the workflow encodes — keep them if you touch it:

- **`SHA256SUMS` is generated in the `release` job, AFTER the signing jobs.**
  `codesign` and `signtool` rewrite the binaries, so a checksum taken at
  compile time would not match the released bytes. `connect-update.json` (the
  mandatory-release marker) is still written after `SHA256SUMS` and never
  appears in it.
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

### Linux — GPG-signed `.deb`/`.rpm`

| Secret | What it is | Where to get it |
| --- | --- | --- |
| `LINUX_SIGNING_GPG_KEY` | ASCII-armored **secret** signing key | `gpg --full-generate-key` (RSA 4096 or Ed25519, e.g. `Anyray Release Signing <support@anyray.ai>`), then `gpg --armor --export-secret-keys <keyid>` |
| `LINUX_SIGNING_GPG_PASSPHRASE` | Its passphrase | Chosen at key generation |

The workflow publishes the **public** key as the release asset
`anyray-connect-signing-key.asc` and a detached `.asc` signature next to each
package. Verify with:

```bash
gpg --import anyray-connect-signing-key.asc
gpg --verify anyray-connect_<version>_amd64.deb.asc anyray-connect_<version>_amd64.deb
```

## Mandatory releases

The optional `min_version` dispatch input publishes `connect-update.json`
(`{"minVersion": …}`) which overrides developers' auto-update opt-out — a lever
for security/correctness fixes only. See the comment on the *Mark the release
mandatory* step.

## CI runners

The release workflow runs on **self-hosted AWS CodeBuild runners** (same pattern as the
monorepo's CI), not GitHub-hosted ones — created 2026-07-30 because org-level GitHub billing
blocks hosted runners:

| Job | Runner | CodeBuild project (eu-central-1) |
| --- | --- | --- |
| build, package-linux, release | Amazon Linux (`amazonlinux2-x86_64-standard:5.0`, MEDIUM) | `anyray-install-runner` |
| sign-windows | Windows Server 2022 (`windows-base:2022-1.0`, MEDIUM) | `anyray-install-runner-win` |
| sign-macos | **GitHub-hosted `macos-latest`** — the one exception | — |

Both projects are webhook-driven (`WORKFLOW_JOB_QUEUED`), authenticate through the account's
CodeConnections GitHub connection, and share the `anyray-gha-runner-codebuild` service role.
macOS cannot run on CodeBuild without a reserved EC2 Mac fleet (24-hour-minimum billing per
host under Apple's licensing) — a standing cost decision, deliberately not taken. Until org
GitHub billing is restored, dispatch releases with `skip_macos_signing: true` to publish
unsigned darwin binaries (the pre-signing status quo); signed darwin releases resume the
moment hosted macOS runners can start again.
