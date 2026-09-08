# Desktop release workflow audit — 2026-09-08

Reviewed install commit `806a57bb8f9d9a8e7a5695dd1280bc711659e6b7`, all desktop jobs,
the source and publication validators, Apple/Azure/GPG signing helpers, native
smoke tests, and the shared Mac lifecycle used by the CLI and fleetd workflows.
Source candidate: monorepo `66dcf5fbe7860bd4e299bce77dce686fac1dac14`, Connect `0.11.214`.

## Confirmed failures and fixes prepared

| Finding | Evidence and effect | Prepared change |
| --- | --- | --- |
| Corepack selected pnpm 12.3.4 instead of 10.34.5 | All three builds in [run 34205187916](https://github.com/anyrayHQ/install/actions/runs/34205187916) failed at dependency setup. Corepack ran from install, outside the pinned source project. | Change directory before invoking Corepack; retain the source's exact package manager and lockfile. |
| PowerShell continued after native command errors | Windows log shows a second pnpm error, then Bun's missing dist directory, then a missing sidecar. | Enable native-command error propagation in Windows script steps. Requires PowerShell 7.3 or newer. |
| MSI sent to a PE-only verifier | `verify-authenticode.py` requires an `MZ` header. MSI is a compound document and would always fail here. | Keep the Python check for inner EXEs; use the existing native Windows trust/publisher/timestamp check for MSI, which gates assembly. |
| Mac teardown could race another release | Three workflows create/delete the same `anyray-install-runner-mac` project; desktop concurrency previously covered only identical version/SHA inputs. | One workflow-level concurrency group across all three workflows, held through cleanup. |
| Fleet polling could expire and still claim readiness | `mac-fleet.sh up` exited its polling loop without checking whether it ever reached a usable state. | Fail explicitly after 20 minutes; preserve cleanup on provisioning failure. |
| Invalid release candidates consumed native runner time | Source ancestry/version validation first happened in native jobs; duplicate tags and damaged/newer feeds failed only at publication. | Validate source and publication eligibility on Linux before provisioning the Mac or starting Windows/Linux builds. Native source gates remain in place. |
| Smoke profile checks observed an unused file | Tests wrote `.anyray/profiles/default.json`; Connect reads `.anyray/connect.json`. Linux's scheduler filename was also wrong. | Use the real profile path with an inert, enrollment-disabled profile and the correct Linux service filename. |
| Unbounded auxiliary jobs and unnecessary retained artifacts | Several jobs inherited GitHub's six-hour execution timeout; intermediate artifacts lasted seven days. | Explicit 30-minute auxiliary job limits, 15-minute source gate, one-day intermediate retention, 14-day final artifact. |

The original run completed with all native engine jobs failed. Account and source
checks passed, and Mac teardown succeeded. Windows took about eight minutes to
reach runner setup; its ultimate build failure was the same pnpm mismatch.

## Time and cost improvements

- Select only Connect and its packaged VS Code extension dependencies, using
  pnpm's isolated linker for this checkout. With the repository's hoisted linker,
  filtering still installed 2,170 packages. The isolated install used 290 packages
  (about 87% fewer), and the complete Connect build passed from a clean checkout.
  Local warm-cache install time was 1.7 seconds versus 14.9 seconds. This is not a
  prediction of cold CodeBuild timing or a measured AWS cost reduction.
- Use the official pinned `@tauri-apps/cli@2.11.4` prebuilt native package instead
  of compiling tauri-cli four times. It installed locally in about two seconds;
  its build/bundle flags were checked. Application compilation remains native,
  with Rust 1.98.0 and the Cargo lockfile. Previously `stable` could change between
  builds of the same commit.
- Skip redundant GitHub artifact compression for binary archives/installers.
  Shorter intermediate retention reduces storage duration by six days. Uncompressed
  raw executable uploads may be larger; measure that tradeoff in the next run.
- Reject bad candidates before paying for a Mac allocation. Preserve `delete-fleet`
  on teardown: leaving the fleet ACTIVE continues billing beyond the 24-hour minimum.
  Faster builds do not by themselves reduce an already-incurred Mac minimum charge.
- Serialization prevents interference and unnecessary rebuilds, but reduces
  throughput across simultaneous releases. GitHub's concurrency group holds only
  one pending run; a newer dispatch replaces an older pending run. It is not a FIFO.

## Validation performed

- 44 desktop release tests passed, including new publication and fleet lifecycle
  tests. Fleet tests mock AWS; they do not allocate infrastructure.
- `actionlint` passed for all three changed workflows; `shellcheck` passed for the
  Mac lifecycle script; `git diff --check` passed.
- A clean checkout of the exact source candidate completed the optimized frozen
  dependency install and full Connect build (including VS Code packaging checks).
- The pinned prebuilt Tauri CLI installed successfully and exposed the required
  build/bundle options. No signing credentials were used.

## Remaining validation and follow-ups

1. A new signed dry run from Dean's account is still required. This audit cannot
   prove Apple notarization, Azure authorization, Windows GUI/WebView2 availability,
   Linux WebKit sandbox behavior under CodeBuild, or native installer execution.
   Preflight proves signing settings are present, not that credentials are valid.
2. Provision a versioned Windows image with Rust/MSVC and the required desktop
   runtime after checking the live runner configuration. Current jobs may install
   Visual Studio separately for build and bundle; a prepared image could remove
   substantial setup time. The observed eight-minute runner delay needs AWS logs
   to distinguish provisioning from queue/capacity limits; this session has no AWS credentials.
3. The Windows scheduler smoke is still a file sentinel, not a live Task Scheduler
   assertion. The macOS/Linux fixtures verify file preservation, not scheduler
   execution. These checks must not be described as proving scheduler health.
4. A cloud-side TTL alarm/janitor should cover runner loss or forced cancellation
   that prevents cleanup. Workflow `always()` is not an infrastructure cleanup
   guarantee. Existing live alarms and fleet billing were not accessible here.
5. Re-running only failed jobs after successful Mac teardown can reuse a successful
   provisioning result without recreating the runner. After merging these workflow
   fixes, dispatch a **new full run**, not “Re-run failed jobs.” An artifact from
   more than one day ago may also have expired.
6. Further optimization could compile Connect once and cross-compile Bun sidecars
   on Linux, sharing only final binaries with native jobs. That needs a dedicated
   change and parity checks; never upload private JavaScript source or Cargo build
   caches as publicly downloadable Actions artifacts.

These changes require review and merge before a new full desktop dry run. The
audit did not dispatch a workflow, publish a release, or change live runner configuration.
