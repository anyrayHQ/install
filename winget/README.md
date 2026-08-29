# winget manifests for `anyray-connect`

This directory publishes `anyray-connect` to the **Windows Package Manager**
(winget) so Windows users install the already-signed `.exe` through a trusted,
allowlisted channel:

```powershell
winget install Anyray.Connect
```

instead of the `irm https://app.anyray.ai/connect.ps1 | iex` PowerShell cradle.
winget fetches a published, hash-pinned artifact and is an allowlisted installer,
which reduces AV / SmartScreen friction. The cradle (`connect.ps1`) stays as the
zero-install path; winget is the trusted-channel alternative for it.

## What's here

```
winget/
  templates/                         # placeholder templates (__VERSION__, __SHA256__)
    Anyray.Connect.installer.yaml
    Anyray.Connect.locale.en-US.yaml
    Anyray.Connect.yaml
  manifests/a/Anyray/Connect/<ver>/  # rendered example, winget-pkgs path convention
    Anyray.Connect.installer.yaml
    Anyray.Connect.locale.en-US.yaml
    Anyray.Connect.yaml
```

The rendered set under `manifests/` is a real, schema-valid example for the
current release so a reviewer can see a complete manifest. It is **not** what
ships — winget is not self-hosted (see below). The generator re-renders it for
each new release.

## Package facts (why the manifest looks the way it does)

- **PackageIdentifier: `Anyray.Connect`.** `Publisher.Package`, the winget
  convention.
- **Publisher: `Othentic Labs LTD`.** This is the legal entity on the
  Authenticode certificate `anyray-connect-windows-x64.exe` is signed with
  (subject `CN=Othentic Labs LTD, O=Othentic Labs LTD, L=Tel Aviv, C=IL`; see
  `scripts/verify-authenticode.py` and `RELEASING.md`). On a **new** package's
  first submission, winget-pkgs moderators check the declared Publisher against
  the installer's signing identity, so it must be the cert subject, not the
  "Anyray" brand. The Anyray brand still surfaces via `Author`, `PackageName`
  (`Anyray Connect`), `Moniker` (`anyray-connect`), and `PublisherUrl`.
- **InstallerType: `portable`.** The asset is a **bare Bun-compiled console
  executable**, not an MSI / Inno / NSIS self-installer — it has no install UI
  and no silent-install switches, so declaring it `exe` with `/S`-style switches
  would be wrong. winget drops a `portable` exe into its Links directory and
  shims it onto PATH, tracking it for clean upgrade/uninstall.
- **`Commands: [anyray-connect]`.** This is the PATH alias winget's shim exposes.
  A **bare** portable exe uses the root-level `Commands` field for the alias;
  `PortableCommandAlias` exists **only** for a portable nested inside a `.zip`
  (`NestedInstallerFiles`), which this is not. Without `Commands`, winget would
  name the shim after the URL file (`anyray-connect-windows-x64`).
- **x64 only.** Bun compiles a single `windows-x64` target; there is no arm64
  Windows asset in the release, so the manifest declares one x64 installer.
- **`InstallerSha256`** is the checksum of `anyray-connect-windows-x64.exe` from
  the release's `SHA256SUMS`. winget re-hashes the download and rejects a
  mismatch, so this is load-bearing — the generator never emits a placeholder.

## Cut a release / update the manifest

Run the generator; it fetches `SHA256SUMS` from the live release, substitutes
the version and the windows-exe hash, and writes the rendered set under
`manifests/a/Anyray/Connect/<version>/`:

```bash
scripts/gen-winget-manifests.sh --version 0.11.174
```

Offline / air-gapped CI (no release fetch):

```bash
scripts/gen-winget-manifests.sh --version 0.11.174 --sha256sums ./SHA256SUMS
# or, with the hash already in hand:
scripts/gen-winget-manifests.sh --version 0.11.174 --sha256 <64-hex>
```

The generator **fails loudly** — non-zero exit, no files written — if the
windows-exe line is missing from `SHA256SUMS`, if the resolved hash is not 64
hex chars, or if the version is malformed. It never emits a manifest with an
empty or placeholder hash (which winget would reject, or worse would point users
at the wrong bytes).

## Submit to winget-pkgs (this part is NOT self-hosted)

winget's community repository is **`microsoft/winget-pkgs`**. Manifests are
merged there by a pull request and validated by Microsoft's CI (a schema/lint
pass plus an install/uninstall sandbox run). There is **no way to host our own
manifests**; every version, including the first, lands as an external PR to that
repo. Be clear-eyed about what is automatable:

### Validate locally first (Windows only)

winget and wingetcreate run on Windows, not macOS/Linux, so these are for a
Windows box or a Windows CI runner:

```powershell
# Static + sandbox validation of the rendered manifest directory:
winget validate --manifest winget\manifests\a\Anyray\Connect\0.11.174

# Optional: install straight from the local manifest to smoke-test the shim:
winget install --manifest winget\manifests\a\Anyray\Connect\0.11.174
anyray-connect --help
```

`wingetcreate` (`winget install Microsoft.WingetCreate`) can also validate and,
crucially, submit:

```powershell
wingetcreate submit --token <gh-pat> winget\manifests\a\Anyray\Connect\0.11.174
```

Off Windows you cannot run `winget validate`; the fallback is the JSON-schema
check the generator's output is written against
(`https://aka.ms/winget-manifest.installer.1.6.0.schema.json` and the locale /
version siblings) — schema-valid is necessary but not sufficient, since it does
not run the install sandbox.

### First submission (one-time, per new package)

The first PR for `Anyray.Connect` gets extra moderator scrutiny:

1. The declared **Publisher** (`Othentic Labs LTD`) must match the installer's
   **Authenticode** signing identity. This is exactly why the exe being signed
   as Othentic Labs LTD matters — an unsigned or mismatched installer stalls a
   new-package PR in moderation. Our release already signs and independently
   verifies the exe (`scripts/verify-authenticode.py`, `RELEASING.md`).
2. Open the PR against `microsoft/winget-pkgs` adding
   `manifests/a/Anyray/Connect/<version>/` (three files). `wingetcreate submit`
   does this for you, or open it by hand from a fork.
3. Microsoft's automated validation runs (schema + install/uninstall sandbox). A
   human moderator then approves; new packages are not auto-merged.
4. After merge, `winget install Anyray.Connect` works for everyone, usually
   within a few hours of index propagation.

### Every subsequent release (update)

Each new connect release is a new **version** PR to the same package path — add
`manifests/a/Anyray/Connect/<new-version>/`, don't edit old versions.
`wingetcreate update Anyray.Connect --version <v> --urls <exe-url>` can regenerate
and submit in one step on a Windows runner; our generator produces the same three
files for a hand-opened PR. Updates clear moderation far faster than the first
submission.

## Honest limitations

- **The submit step is an external PR**, gated by Microsoft's CI and a human
  moderator. It cannot be fully automated from this repo the way our GitHub
  release is; the most we automate here is *rendering* the manifests and, on a
  Windows runner, *opening* the PR via `wingetcreate`.
- **SmartScreen reputation still accrues with download volume.** winget delivers
  a signed, hash-pinned binary through an allowlisted installer, which helps, but
  our OV-class certificate earns reputation over time (see `RELEASING.md`);
  winget does not grant instant reputation.
- **`winget validate` cannot run on macOS/Linux.** The manifests in this repo are
  schema-validated in CI; the full winget sandbox validation happens on a Windows
  box or in the winget-pkgs PR.
