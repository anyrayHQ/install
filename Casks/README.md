# Homebrew cask — `anyray-connect`

A [Homebrew cask](https://docs.brew.sh/Cask-Cookbook) that installs the
`anyray-connect` on-ramp CLI on macOS from the signed, notarized
`anyray-connect.pkg` release asset — so users install through a trusted,
allowlisted channel instead of piping `curl … | sh`:

```bash
brew tap anyrayHQ/tap
brew install --cask anyray-connect
```

Homebrew downloads the exact published `.pkg`, verifies its SHA-256 against the
`sha256` stanza, checks the Developer ID Installer signature + notarization, and
records a receipt so `brew uninstall --cask anyray-connect` fully removes it.
That replaces the "unmanaged process downloading and running a binary" shape
that endpoint tooling flags.

## Files

| File | What |
| --- | --- |
| [`Casks/anyray-connect.rb`](anyray-connect.rb) | The rendered cask for the current release — pinned `version` + `sha256`. This is what a tap serves. |
| [`../homebrew/anyray-connect.rb.tmpl`](../homebrew/anyray-connect.rb.tmpl) | The template, with `__VERSION__` / `__SHA256__` placeholders. |
| [`../scripts/gen-homebrew-cask.sh`](../scripts/gen-homebrew-cask.sh) | Renders the template → `Casks/anyray-connect.rb`, reading the pkg's SHA-256 from the release `SHA256SUMS`. |

## The tap repo — a one-time external step (does not exist yet)

Homebrew serves a cask from a **tap**: a separate GitHub repo named
`homebrew-<tap>` under the org. `brew tap anyrayHQ/tap` clones
**`github.com/anyrayHQ/homebrew-tap`**, and Homebrew looks for casks in that
repo's `Casks/` directory. **That repo does not exist yet — someone with org
admin has to create it once:**

1. Create a public repo `anyrayHQ/homebrew-tap` (the `homebrew-` prefix is
   required; `brew tap anyrayHQ/tap` maps to it).
2. Add a `Casks/` directory and copy this repo's rendered
   `Casks/anyray-connect.rb` into it.
3. Commit and push. `brew tap anyrayHQ/tap && brew install --cask anyray-connect`
   now works for everyone.

This `install` repo is where the cask is **generated and validated**; the
`homebrew-tap` repo is the **distribution channel**. Keeping them separate means
the tap stays a thin, auditable directory of `.rb` files.

## How a release updates the cask

Each `connect-v<version>` release publishes `anyray-connect.pkg` and a
`SHA256SUMS` line for it. To cut a new cask version:

```bash
# From this repo, after the release is published:
scripts/gen-homebrew-cask.sh --version 0.11.174
# (or, during the release build, point it at the local sums file:)
scripts/gen-homebrew-cask.sh --version 0.11.174 --sha256sums out/SHA256SUMS
```

The generator fails loudly if the `anyray-connect.pkg` hash is missing — it will
never emit a cask with a placeholder or empty `sha256`.

Then get the updated `Casks/anyray-connect.rb` into the tap repo, either:

- **Push the rendered `.rb`** into `anyrayHQ/homebrew-tap`'s `Casks/` (simplest;
  a CI step can commit it on release), or
- **`brew bump-cask-pr`** against the tap, which opens a PR bumping `version` +
  `sha256`. The cask's `livecheck` block points at the GitHub releases so
  `brew bump-cask-pr` / `brew livecheck` can discover new versions automatically.

> Automating the push from the release workflow is a follow-up. The workflow
> that builds the pkg (`.github/workflows/release-connect-binaries.yml`) is the
> natural place to run `gen-homebrew-cask.sh` and push into the tap.

## Local validation

`brew` runs these against the cask; all must pass before it ships. Against a
loose file, use the path; against a tap, use the token.

```bash
# Ruby-parse and lint.
ruby -c ./Casks/anyray-connect.rb
brew style ./Casks/anyray-connect.rb

# Full audit for a third-party tap (downloads the pkg, verifies signing +
# checksum + the uninstall stanza). Run this from within the tap:
brew audit --cask --strict --online anyrayHQ/tap/anyray-connect
```

> `brew audit --cask --new` adds the checks Homebrew applies to submissions into
> the **core** `homebrew/cask` repo — notably a GitHub star/fork/watcher
> notability gate. Those do **not** apply to a self-hosted third-party tap, so
> `--new` is not the bar here; `--strict` is.

### Local test install

Install straight from the rendered file without a tap:

```bash
brew install --cask ./Casks/anyray-connect.rb
which anyray-connect          # -> /usr/local/bin/anyray-connect
anyray-connect --version

# Full removal (the uninstall stanza unloads the LaunchAgent, forgets the
# pkgutil receipt, and deletes the helper dir):
brew uninstall --cask ./Casks/anyray-connect.rb
brew uninstall --zap --cask ./Casks/anyray-connect.rb   # also clears user logs
```

## What the cask installs / removes

The pkg payload (universal binary via `lipo`, so no per-arch URL) lays down:

- `/usr/local/bin/anyray-connect` — the CLI
- `/usr/local/lib/anyray-connect/managed-enroll-runner` — managed-enrollment helper
- `/Library/LaunchAgents/ai.anyray.connect.managed-enroll.plist` — the enrollment agent

The `uninstall` stanza mirrors that exactly: `launchctl` unloads
`ai.anyray.connect.managed-enroll`, `pkgutil: ai.anyray.connect` forgets the
receipt (removing the payload files), and `delete` sweeps the helper directory.
`zap` additionally trashes the per-user log directory `~/Library/Logs/Anyray
Connect` (enrollment diagnostics only — never prompt/response content). The
MDM-managed preference under `/Library/Managed Preferences` is left untouched:
MDM owns it.

`auto_updates true` is set because `anyray-connect` keeps itself current through
its own signed self-update path — Homebrew only bootstraps the trusted install
and must not fight the app's updater.
