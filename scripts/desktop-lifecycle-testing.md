# Desktop lifecycle testing

`release-connect-desktop.yml` verifies signed staging packages before assembling the feed.
It does not publish a production release or establish EDR compatibility.

The macOS job needs the repository variable `DESKTOP_MAC_TEST_USER` to name a dedicated
non-root account with a real GUI login session on the Mac runner. Provision that account
and log it in before the job; the workflow fails if it owns no console session. The account
must have no existing Anyray profile, app process, or login registration. Changing `HOME`
is not isolation for Service Management.

The signed smoke checks fresh native registration, migration from the actual legacy tray
plist shape, preserved disabled consent, Quit/restart, and unregister. It cleans only its
own profile and registration. It does not emulate a real logout/login, customer enrollment,
key renewal, or an EDR policy. Record those separately in the monorepo's
`connect-tray/ACCEPTANCE.md` against the exact candidate.

Linux smoke creates and removes a dedicated Unix account. Synthetic deb/rpm CLI packages
carry the released CLI ownership paths and a real candidate engine, then the desktop
package replaces them through the package manager. The smoke checks native autostart,
recorded app ownership, preserved enrollment opt-out, and removed CLI bootstrap files.
These fixtures are test inputs, never release artifacts.

Run `npm run test:desktop-release` for workflow and account-isolation regressions.
Do not run the native smoke scripts on a developer account.
