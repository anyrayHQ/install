import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/release-connect-desktop.yml', import.meta.url),
  'utf8'
);
const macSmoke = readFileSync(
  new URL('./smoke-connect-desktop-macos.py', import.meta.url),
  'utf8'
);
const fleetFixture = readFileSync(
  new URL('./build-desktop-fleet-osquery-fixtures.sh', import.meta.url),
  'utf8'
);

const job = (name) => {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow job ${name}`);
  const bodyStart = start + marker.length;
  const next = workflow.slice(bodyStart).search(/^  [a-z0-9-]+:\n/m);
  return next === -1
    ? workflow.slice(bodyStart)
    : workflow.slice(bodyStart, bodyStart + next);
};

describe('desktop staging workflow safety contract', () => {
  test('is manual-only and exposes no production selector', () => {
    const trigger = workflow.slice(0, workflow.indexOf('\npermissions:'));
    assert.match(trigger, /\non:\n  workflow_dispatch:\n/);
    assert.doesNotMatch(trigger, /\n  (push|pull_request|workflow_run|repository_dispatch|schedule):/);
    assert.match(trigger, /\n      version:/);
    assert.match(trigger, /\n      source_sha:/);
    assert.match(trigger, /\n      dry_run:/);
    assert.doesNotMatch(trigger, /\n      (stable|production|public|latest):/);
  });

  test('rejects non-main dispatches before preflight, secrets, or source', () => {
    const guard = job('dispatch-main-only');
    assert.match(guard, /DISPATCH_REF: \$\{\{ github\.ref \}\}/);
    assert.match(guard, /!= 'refs\/heads\/main'/);
    assert.match(guard, /permissions: \{\}/);
    assert.doesNotMatch(guard, /secrets\.|private-source|MONOREPO_READ_APP/);
    assert.match(job('preflight'), /^    needs: dispatch-main-only$/m);
    assert.ok(
      workflow.indexOf('  dispatch-main-only:\n') <
        workflow.indexOf('  preflight:\n')
    );
  });

  test('uses isolated read-only private checkouts and never uploads source', () => {
    assert.equal(
      (workflow.match(/actions\/create-github-app-token@/g) ?? []).length,
      5
    );
    assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 5);
    assert.equal((workflow.match(/fetch-depth: 0/g) ?? []).length, 5);
    assert.doesNotMatch(workflow, /private-monorepo-source|source-candidate/);

    const uploadBlocks = workflow.match(
      /- uses: (?:actions\/upload-artifact@|\.\/\.github\/actions\/s3-artifact-upload)[\s\S]*?(?=\n      - |\n  [a-z0-9-]+:|$)/g
    );
    assert.ok(uploadBlocks && uploadBlocks.length > 0);
    for (const block of uploadBlocks) {
      assert.doesNotMatch(block.slice(block.indexOf("\n") + 1), /private-source|connect-tray\/src|\.git/);
    }
  });

  test('keeps source execution outside every signing job', () => {
    for (const name of [
      'sign-macos',
      'sign-windows-inner',
      'sign-windows-installer',
      'sign-linux-artifacts',
      'assemble-signed-staging',
    ]) {
      assert.doesNotMatch(job(name), /private-source|MONOREPO_READ_APP|monorepo-token/);
    }
    assert.doesNotMatch(job('sign-macos'), /anyray-connect" --version|\$engine" --version/);
  });

  test('passes staging distribution only to the three native compile steps', () => {
    assert.equal(
      (workflow.match(/ANYRAY_CONNECT_DESKTOP_DISTRIBUTION: staging/g) ?? [])
        .length,
      3
    );
    for (const name of [
      'build-macos-unsigned',
      'build-windows-unsigned',
      'build-linux-unsigned',
    ]) {
      assert.match(job(name), /ANYRAY_CONNECT_DESKTOP_DISTRIBUTION: staging/);
    }
    assert.doesNotMatch(
      job('bundle-windows-unsigned'),
      /ANYRAY_CONNECT_DESKTOP_DISTRIBUTION/
    );
  });

  test('runs every job on CodeBuild, never on a GitHub-hosted runner', () => {
    const runners = workflow.match(/runs-on: .+/g) ?? [];
    assert.ok(runners.length > 0);
    for (const runner of runners) {
      assert.match(runner, /^runs-on: codebuild-anyray-install-runner(-mac|-win|-ubuntu)?-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}$/);
    }
    assert.doesNotMatch(workflow, /macos-15|ubuntu-24\.04|ubuntu-latest|windows-2025/);
  });

  test('builds Linux on the Ubuntu 22.04 project with a pinned rustup', () => {
    for (const name of ['build-linux-unsigned', 'smoke-linux-installers']) {
      assert.match(job(name), /runs-on: codebuild-anyray-install-runner-ubuntu-/);
    }
    const build = job('build-linux-unsigned');
    assert.match(build, /rustup-init\.sha256|RUSTUP_INIT_SHA256_LINUX_X64/);
    assert.match(build, /uses: \.\/\.github\/actions\/fetch-pinned/);
    assert.doesNotMatch(build, /curl[^\n]*\| *sh/);
  });

  test('provisions the Mac before the build and releases it after the signed smoke', () => {
    assert.match(job('provision-mac'), /needs: \[preflight, validate-source\]/);
    assert.match(job('build-macos-unsigned'), /needs: \[preflight, provision-mac\]/);
    for (const name of ['build-macos-unsigned', 'sign-macos', 'verify-macos-signed']) {
      assert.match(job(name), /runs-on: codebuild-anyray-install-runner-mac-/);
    }
    assert.match(
      job('sign-macos'),
      /needs: \[preflight, build-macos-unsigned, provision-mac\]/
    );
    assert.match(job('teardown-mac'), /needs: \[provision-mac, build-macos-unsigned, sign-macos, verify-macos-signed\]/);
    assert.match(job('teardown-mac'), /if: \$\{\{ always\(\) && needs\.provision-mac\.result != 'skipped' \}\}/);
  });

  test('bootstraps pinned Rust and MSVC on both Windows compile jobs', () => {
    for (const name of ['build-windows-unsigned', 'bundle-windows-unsigned']) {
      const body = job(name);
      assert.match(body, /Rust toolchain and MSVC build tools \(pinned\)/);
      assert.match(body, /VS_BUILDTOOLS_SHA256/);
      assert.match(body, /RUSTUP_INIT_SHA256_WINDOWS_X64/);
      assert.match(body, /Microsoft\.VisualStudio\.Workload\.VCTools/);
    }
    assert.match(workflow, /VS_BUILDTOOLS_URL: 'https:\/\/download\.visualstudio\.microsoft\.com\//);
    assert.doesNotMatch(workflow, /aka\.ms/);
  });

  test('pins the signed Apple team and bundle identifiers before notarization', () => {
    const sign = job('sign-macos');
    const team = sign.indexOf("grep -Fxq 'TeamIdentifier=V53XMA78UF'");
    const identifier = sign.indexOf(
      "grep -Fxq 'Identifier=ai.anyray.connect-tray'"
    );
    const notarize = sign.indexOf('notarytool submit');
    assert.ok(team > 0 && team < notarize);
    assert.ok(identifier > 0 && identifier < notarize);
  });

  test('builds a non-relocatable signed and notarized desktop PKG', () => {
    const preflight = job('preflight');
    assert.match(preflight, /APPLE_INSTALLER_CERT_P12: \$\{\{ secrets\.APPLE_INSTALLER_CERT_P12 \}\}/);
    assert.match(preflight, /APPLE_INSTALLER_CERT_PASSWORD: \$\{\{ secrets\.APPLE_INSTALLER_CERT_PASSWORD \}\}/);

    const sign = job('sign-macos');
    assert.match(sign, /unsigned\/preinstall/);
    assert.match(sign, /unsigned\/postinstall/);
    assert.match(sign, /unsigned\/uninstall\.sh/);
    assert.doesNotMatch(sign, /unsigned\/pkg-scripts/);
    assert.match(sign, /ditto "\$app" "\$root\/Applications\/Anyray Connect\.app"/);
    assert.match(sign, /--identifier ai\.anyray\.connect-tray/);
    assert.match(sign, /plutil -replace 0\.BundleIsRelocatable -bool false "\$component_plist"/);
    assert.match(sign, /RootRelativeBundlePath/);
    assert.match(sign, /Developer ID Installer/);
    assert.match(sign, /xar -tf "\$pkg" \| grep -qx 'Distribution'/);
    assert.match(sign, /<readme file="connect-desktop-readme\.html" mime-type="text\/html"\/>/);
    assert.match(
      sign,
      /If any of these deprecated Anyray components are on this Mac, the installer removes them: the anyray-connect command-line package and the Fleet endpoint agent\./
    );
    assert.match(sign, /Anyray Connect CLI package \(ai\.anyray\.connect\)/);
    assert.match(sign, /fleetd \(com\.fleetdm\.orbit\.base\.pkg\)/);
    assert.match(sign, /--distribution "\$distribution_xml"/);
    assert.match(sign, /--resources "\$distribution_resources"/);
    assert.match(sign, /--package-path "\$RUNNER_TEMP"/);
    assert.match(sign, /payload-files "\$pkg"/);
    assert.match(sign, /Applications\/Anyray Connect\\\.app\/Contents\/MacOS\/anyray-connect/);
    assert.match(sign, /spctl -a -vvv -t install "\$pkg"/);
    assert.match(sign, /out\/\*\.pkg out\/\*\.app\.tar\.gz/);
    assert.doesNotMatch(sign, /hdiutil|\.dmg|DMG/);
    const verify = job('verify-macos-signed');
    assert.match(verify, /count\(\/pkg-info\/relocate\/bundle\)' "\$package_info"\)" = 0/);
    assert.match(verify, /= '\.\/Applications\/Anyray Connect\.app'/);
    assert.match(verify, /connect-desktop-readme\.html/);
    assert.match(verify, /PKG contains no Installer readme/);
    assert.match(
      verify,
      /If any of these deprecated Anyray components are on this Mac, the installer removes them: the anyray-connect command-line package and the Fleet endpoint agent\./
    );
  });

  test('prepares MSI metadata before signing and verifies the installed signed payload', () => {
    const build = job('build-windows-unsigned');
    assert.ok(build.indexOf('node scripts/prepare-desktop-msi.mjs $main --prepare') > 0);
    assert.ok(build.indexOf('--prepare') < build.indexOf('Copy-Item $main out/'));
    const bundle = job('bundle-windows-unsigned');
    assert.ok(bundle.indexOf('node scripts/prepare-desktop-msi.mjs $main --check') > 0);
    assert.ok(bundle.indexOf('--check') < bundle.indexOf('tauri.js" bundle'));
    assert.match(job('verify-windows-signatures'), /MSI changed signed payload/);
  });

  test('exercises Windows foreign-engine refusal, managed layout, and uninstall cleanup', () => {
    const windows = job('verify-windows-signatures');
    assert.match(windows, /\$installDir = Join-Path \$env:ProgramFiles 'Anyray'/);
    assert.doesNotMatch(windows, /INSTALLDIR=/);

    assert.match(windows, /Set-Content -NoNewline -LiteralPath \$installedEnginePath -Value 'foreign-engine-sentinel'/);
    assert.match(windows, /Get-AuthenticodeSignature -LiteralPath \$installedEnginePath/);
    assert.match(windows, /SignatureStatus\]::Valid/);
    assert.match(windows, /\$foreignInstallArgs = @\(/);
    assert.match(windows, /-ArgumentList \$foreignInstallArgs/);
    assert.match(windows, /\$foreignInstall\.ExitCode -ne 1603/);
    assert.match(windows, /MSI foreign-engine refusal removed the foreign engine/);
    assert.match(windows, /MSI foreign-engine refusal changed the foreign engine/);

    const refusalCheck = windows.indexOf('$foreignInstall.ExitCode -ne 1603');
    const engineRemoved = windows.indexOf('Remove-Item -LiteralPath $installedEnginePath');
    const staleShim = windows.indexOf("'echo stale-helper-sentinel'");
    const cleanInstall = windows.indexOf('$installArgs = @(');
    assert.ok(refusalCheck > 0 && refusalCheck < engineRemoved);
    assert.ok(engineRemoved > 0 && engineRemoved < staleShim);
    assert.ok(staleShim > 0 && staleShim < cleanInstall);
    assert.match(windows, /anyray-credential-helper\.cmd/);
    assert.match(windows, /anyray-bootstrap-headers-helper\.cmd/);
    assert.match(windows, /Managed by anyray-connect desktop helper; do not edit\./);
    assert.match(windows, /'desktop', 'helper', '--print', '--platform', 'windows',/);
    // --bin must reach the engine as one argument despite the space in Program Files.
    assert.match(windows, /'--wrapper', \$wrapperKind, '--bin', \('"' \+ \$installedEnginePath \+ '"'\)/);
    // Cleanup removes the install directory only when this smoke created it.
    assert.match(windows, /\$createdInstallDir = \$false/);
    assert.match(windows, /\$createdInstallDir = \$true/);
    assert.match(windows, /elseif \(\$createdInstallDir -and \(Test-Path -LiteralPath \$installDir\)\)/);
    assert.match(windows, /-RedirectStandardOutput \$expectedShimPath -NoNewWindow -Wait -PassThru/);
    assert.match(windows, /installed engine failed to print the \$wrapperKind wrapper/);
    assert.match(windows, /installed helper shim does not match desktop helper --print output/);
    assert.match(windows, /\$installedEngine = Get-Item -LiteralPath \$installedEnginePath/);
    assert.match(windows, /verify-authenticode-windows\.ps1 -Path \$installedEngine\.FullName/);
    assert.match(windows, /\[System\.EnvironmentVariableTarget\]::Machine/);
    assert.match(windows, /Test-MachinePathEntry -ExpectedPath \$installDir/);
    assert.match(windows, /installed MSI has no uninstall script/);

    assert.match(windows, /\$uninstallArgs = @\(/);
    assert.match(windows, /-ArgumentList \$uninstallArgs/);
    assert.match(windows, /MSI uninstall left a managed helper shim behind/);
    assert.match(windows, /MSI uninstall left the uninstall script behind/);
    assert.match(windows, /MSI uninstall left the install directory in machine PATH/);
    assert.doesNotMatch(windows, /Invoke-Expression/);
  });

  test('signs Windows inner executables before MSI packaging and the MSI after', () => {
    assert.match(job('bundle-windows-unsigned'), /needs: \[preflight, sign-windows-inner\]/);
    assert.match(job('bundle-windows-unsigned'), /tauri\.js" bundle .*--bundles msi/);
    assert.match(job('sign-windows-installer'), /needs: \[preflight, bundle-windows-unsigned\]/);
    assert.match(job('verify-windows-signatures'), /msiexec\.exe/);
  });

  test('signed smoke checks ownership before stopping and preserves post-startup state', () => {
    const mac = job('verify-macos-signed');
    assert.match(mac, /actions\/setup-node@/);
    assert.match(mac, /sparse-checkout: \|\n            .github\/actions\n            scripts/);
    // The CodeBuild Mac is headless: the engine version check runs as root and the
    // native login-item lifecycle is a manual acceptance check, never a CI smoke.
    assert.doesNotMatch(mac, /smoke-connect-desktop-macos\.py|launchctl asuser|DESKTOP_MAC_TEST_USER|\/dev\/console/);
    assert.match(mac, /test "\$\("\$engine" --version \| head -1\)" = "anyray-connect \$VERSION"/);
    // An ordinary user must be able to run the engine, the launcher and read the shims.
    assert.match(mac, /sysadminctl -addUser "\$smoke_user"/);
    assert.match(mac, /sudo -H -u "\$smoke_user" "\$engine" --version/);
    assert.match(mac, /sudo -H -u "\$smoke_user" "\$launcher" --version/);
    assert.match(mac, /sudo -H -u "\$smoke_user" \/bin\/sh -n "\$helper"/);
    assert.match(mac, /sysadminctl -deleteUser "\$smoke_user"/);
    assert.ok(mac.indexOf('sysadminctl -deleteUser "$smoke_user"') < mac.indexOf('trap cleanup EXIT'));
    const macOwnership = macSmoke.indexOf("profile.get('engineOwner') == 'app'");
    const macStop = macSmoke.indexOf('            stop()', macOwnership);
    assert.ok(macOwnership > 0 && macOwnership < macStop);
    assert.ok(macSmoke.indexOf("if native() != observed:", macStop) > macStop);

    const windows = job('verify-windows-signatures');
    assert.match(windows, /actions\/setup-node@/);
    const firstCheck = windows.indexOf('node scripts/verify-desktop-profile.mjs');
    assert.ok(firstCheck > 0);
    assert.match(windows, /verify-desktop-profile\.mjs \$profileBefore \$state \$installedEngine\.FullName \$installedMain\.DirectoryName/);
    assert.match(windows, /try \{ \$observedProfile = Get-Content -Raw -LiteralPath \$state \| ConvertFrom-Json \}/);
    assert.ok(firstCheck < windows.indexOf('Stop-Process -Id $appProcess.Id -Force'));
    assert.ok(windows.indexOf('$stateBefore = (Get-FileHash') > firstCheck);
  });

  test('gates assembly on native install/uninstall smoke tests', () => {
    const mac = job('verify-macos-signed');
    assert.match(mac, /plutil -extract LSMinimumSystemVersion raw -o - "\$updater_app\/Contents\/Info\.plist"\)" = '13\.0'/);
    assert.match(mac, /plutil -extract LSMinimumSystemVersion raw -o - "\$app\/Contents\/Info\.plist"\)" = '13\.0'/);
    assert.match(mac, /installer -pkg "\$pkg" -target \//);
    assert.match(mac, /cmp "\$foreign" "\$launcher"/);
    assert.match(
      mac,
      /cmp "\$foreign" "\$launcher"\s*\n\s*#[^\n]*\n\s*sudo test ! -e "\$installed_app"/
    );
    assert.match(mac, /readlink "\$launcher"/);
    // Anchor the legacy assertions to the install that follows both retired-package plants.
    const foreignInstall = mac.indexOf('if sudo installer -pkg "$pkg" -target /; then');
    const retiredInstall = mac.indexOf('sudo installer -pkg "$retired_pkg" -target /');
    const ownedFleetInstall = mac.indexOf(
      'sudo installer -pkg "$owned_fleet_pkg" -target /',
      retiredInstall
    );
    const ownedFleetBootstrap = mac.indexOf(
      'sudo /bin/launchctl bootstrap system "$fleet_plist"',
      ownedFleetInstall
    );
    const realInstall = mac.indexOf(
      'sudo installer -pkg "$pkg" -target /',
      ownedFleetBootstrap
    );
    assert.ok(
      foreignInstall > 0 &&
        foreignInstall < retiredInstall &&
        retiredInstall < ownedFleetInstall &&
        ownedFleetInstall < ownedFleetBootstrap &&
        ownedFleetBootstrap < realInstall
    );
    assert.match(mac, /--identifier ai\.anyray\.connect/);
    assert.match(
      mac,
      /cp "\$updater_app\/Contents\/MacOS\/anyray-connect" "\$retired_stub"/
    );
    assert.match(mac, /usr\/local\/bin\/anyray-connect/);
    assert.match(mac, /Library\/LaunchAgents\/ai\.anyray\.connect\.managed-enroll\.plist/);
    assert.match(mac, /desktop PKG left the retired CLI receipt behind/);
    // these same checks appear earlier as the retired-pkg plant's own sanity checks; require the real-install copies
    const receiptGoneCheck = mac.indexOf(
      'if pkgutil --pkg-info ai.anyray.connect >/dev/null 2>&1; then',
      realInstall
    );
    const plistGoneCheck = mac.indexOf('sudo test ! -e "$retired_plist"', realInstall);
    const launcherSymlinkCheck = mac.indexOf('sudo test -L "$launcher"', realInstall);
    const fleetdGoneCheck = mac.indexOf(
      'if sudo /bin/launchctl print system/com.fleetdm.orbit >/dev/null 2>&1; then',
      realInstall
    );
    // Bound every real-install assertion above by the uninstall that exercises this
    // case, or a foreign-block copy of the same line would satisfy these checks too.
    const ownedRealUninstall = mac.indexOf('sudo "$uninstall"', realInstall);
    assert.ok(ownedRealUninstall > realInstall);
    assert.ok(receiptGoneCheck > realInstall && receiptGoneCheck < ownedRealUninstall);
    assert.ok(plistGoneCheck > realInstall && plistGoneCheck < ownedRealUninstall);
    assert.ok(launcherSymlinkCheck > realInstall && launcherSymlinkCheck < ownedRealUninstall);
    assert.ok(fleetdGoneCheck > realInstall && fleetdGoneCheck < ownedRealUninstall);
    assert.match(mac, /--identifier "\$fleet_receipt"/);
    assert.match(mac, /sudo "\$uninstall"/);

    const windows = job('verify-windows-signatures');
    assert.match(windows, /MSI install failed/);
    assert.match(windows, /Start-Process -FilePath \$installedMain\.FullName/);
    assert.match(windows, /ai\.anyray\.connect-tray/);
    assert.match(windows, /Stop-Process -Id \$appProcess\.Id -Force/);
    assert.match(windows, /Remove-ItemProperty -LiteralPath \$runKey -Name \$runName/);
    assert.match(windows, /MSI uninstall failed/);

    const linux = job('smoke-linux-installers');
    assert.match(linux, /as_root dpkg -i/);
    assert.match(linux, /smoke_installed_tray "\$deb_main"/);
    assert.match(linux, /"\$uninstall"/);
    assert.match(linux, /as_root rpm --dbpath "\$rpm_database" -i/);
    assert.match(linux, /smoke_installed_tray "\$rpm_main"/);
    assert.match(linux, /as_root rpm --dbpath "\$rpm_database" -e/);
    assert.match(linux, /ai\.anyray\.connect-tray\.desktop/);
    assert.match(linux, /dbus-run-session -- xvfb-run -a "\$main"/);
    assert.match(linux, /kill -KILL -- "-\$tray_pid"/);
    assert.match(linux, /rm -f "\$autostart"/);
    assert.match(
      job('assemble-signed-staging'),
      /- verify-macos-signed[\s\S]*- verify-windows-signatures[\s\S]*- smoke-linux-installers/
    );
  });

  test('exercises owned and foreign fleetd branches after planting real receipts', () => {
    const mac = job('verify-macos-signed');
    const after = (needle, anchor) => {
      const index = mac.indexOf(needle, anchor);
      assert.ok(index > anchor, `missing after anchored install: ${needle}`);
      return index;
    };

    assert.match(
      mac,
      /build_fleet_pkg\(\)[\s\S]*<string>\$fleet_secret_argument<\/string>/
    );
    const retiredPlant = mac.indexOf('sudo installer -pkg "$retired_pkg" -target /');
    const ownedSecret = mac.indexOf(
      "'/opt/orbit/anyray-enroll-secret.txt'",
      retiredPlant
    );
    const foreignSecret = mac.indexOf(
      "'/opt/orbit/foreign-enroll-secret.txt'",
      ownedSecret
    );
    const ownedBuild = mac.lastIndexOf('build_fleet_pkg', ownedSecret);
    const foreignBuild = mac.lastIndexOf('build_fleet_pkg', foreignSecret);
    assert.ok(ownedBuild > 0);
    assert.ok(foreignBuild > ownedBuild);
    assert.doesNotMatch(
      mac.slice(
        foreignBuild,
        mac.indexOf('sudo installer -pkg "$foreign_fleet_pkg"', foreignBuild)
      ),
      /anyray-enroll-secret/
    );

    const ownedPlant = after(
      'sudo installer -pkg "$owned_fleet_pkg" -target /',
      ownedBuild
    );
    const ownedBootstrap = after(
      'sudo /bin/launchctl bootstrap system "$fleet_plist"',
      ownedPlant
    );
    const ownedInstall = after(
      'sudo installer -pkg "$pkg" -target /',
      ownedBootstrap
    );
    // Bound below AND above by the install/uninstall pair for this case, or a
    // foreign-block copy of the same line (or a later case's) would pass too.
    const exercisedUninstall = after('sudo "$uninstall"', ownedInstall);
    const between = (needle, lower, upper) => {
      const index = mac.indexOf(needle, lower);
      assert.ok(
        index > lower && index < upper,
        `missing between anchors: ${needle}`
      );
      return index;
    };
    for (const assertion of [
      'if pkgutil --pkg-info "$fleet_receipt" >/dev/null 2>&1; then',
      'if sudo /bin/launchctl print system/com.fleetdm.orbit >/dev/null 2>&1; then',
      'sudo test ! -e "$fleet_plist"',
      'sudo test ! -e "$fleet_root/bin"',
      'sudo test ! -e "$fleet_secret"',
      'sudo test ! -e /usr/local/bin/orbit',
      'sudo test ! -L /usr/local/bin/orbit',
      'sudo test -f "$fleet_osquery_log"',
      'sudo test -f "$fleet_var_log"',
      'sudo test -d /usr/local/bin',
      "usr_local_bin_after=\"$(stat -f '%i %u %g %Lp' /usr/local/bin)\"",
      "test \"$usr_local_bin_after\" = \"$usr_local_bin_before\" || {",
      'sudo test -f "$locked_cli_file"',
      'sudo grep -Fqx -- "$locked_cli_file" "$residue_marker"',
    ]) {
      between(assertion, ownedInstall, exercisedUninstall);
    }
    // The /usr/local/bin gate: snapshot before the install, snapshot after, and a
    // mismatch that names both values and fails, in that order.
    const binBefore = mac.indexOf("usr_local_bin_before=\"$(stat -f '%i %u %g %Lp' /usr/local/bin)\"");
    const binAfter = mac.indexOf("usr_local_bin_after=\"$(stat -f '%i %u %g %Lp' /usr/local/bin)\"");
    const binCompare = mac.indexOf('test "$usr_local_bin_after" = "$usr_local_bin_before" || {');
    const binDiag = mac.indexOf("echo \"::error::/usr/local/bin changed across the install (inode uid gid mode): before '$usr_local_bin_before', after '$usr_local_bin_after'\"");
    const binExit = mac.indexOf('exit 1', binDiag);
    assert.ok(binBefore > 0 && binBefore < ownedInstall, 'snapshot must precede the owned real install');
    assert.ok(binAfter > ownedInstall && binCompare > binAfter && binDiag > binCompare && binExit > binDiag);
    assert.ok(binExit - binDiag < 200, 'the mismatch must exit 1 right after the diagnostic');

    const plistBuild = after('build_fleet_pkg', exercisedUninstall);
    const plistPlant = after(
      'sudo installer -pkg "$plist_fleet_pkg" -target /',
      plistBuild
    );
    const plistBootstrap = after(
      'sudo /bin/launchctl bootstrap system "$fleet_plist"',
      plistPlant
    );
    const plistInstall = after(
      'sudo installer -pkg "$pkg" -target /',
      plistBootstrap
    );
    const plistUninstall = after('sudo "$uninstall"', plistInstall);
    for (const assertion of [
      'if pkgutil --pkg-info "$fleet_receipt" >/dev/null 2>&1; then',
      'if sudo /bin/launchctl print system/com.fleetdm.orbit >/dev/null 2>&1; then',
      'sudo test ! -e "$fleet_plist"',
      'sudo test ! -e "$fleet_root/bin"',
      'sudo test ! -e "$fleet_secret"',
      'sudo test ! -e /usr/local/bin/orbit',
      'sudo test ! -L /usr/local/bin/orbit',
      'sudo test -f "$fleet_osquery_log"',
      'sudo test -f "$fleet_var_log"',
    ]) {
      between(assertion, plistInstall, plistUninstall);
    }

    const foreignPlant = after(
      'sudo installer -pkg "$foreign_fleet_pkg" -target /',
      plistUninstall
    );
    const foreignBootstrap = after(
      'sudo /bin/launchctl bootstrap system "$fleet_plist"',
      foreignPlant
    );
    const foreignInstall = after(
      'sudo installer -pkg "$pkg" -target /',
      foreignBootstrap
    );
    for (const assertion of [
      'pkgutil --pkg-info ai.anyray.connect-tray >/dev/null',
      'pkgutil --pkg-info "$fleet_receipt" >/dev/null',
      'sudo /bin/launchctl print system/com.fleetdm.orbit >/dev/null',
      'sudo test -f "$fleet_plist"',
      'sudo test -d "$fleet_root/bin"',
      String.raw`sudo cmp \
            "$foreign_fleet_root/opt/orbit/bin/orbit/macos/stable/orbit" \
            "$fleet_binary"`,
      'sudo cmp "$foreign_fleet_root$fleet_plist" "$fleet_plist"',
      'sudo test ! -e "$fleet_secret"',
      'sudo test -f "$fleet_osquery_log"',
      'sudo test -f "$fleet_var_log"',
      'sudo test -d /var/lib/orbit',
      'sudo test -L /usr/local/bin/orbit',
      'test "$(sudo readlink /usr/local/bin/orbit)" = /opt/orbit',
      'sudo test -L "$launcher"',
      String.raw`test "$(sudo readlink "$launcher")" \
            = '/Applications/Anyray Connect.app/Contents/MacOS/anyray-connect'`,
    ]) {
      after(assertion, foreignInstall);
    }

    const trapInstall = mac.indexOf('trap cleanup EXIT');
    const firstPlant = mac.indexOf('sudo install -m 0755 "$foreign" "$launcher"');
    const cleanupStart = mac.indexOf('cleanup() {');
    assert.ok(trapInstall > 0 && trapInstall < firstPlant);
    for (const cleanup of [
      'sudo /bin/launchctl bootout system/com.fleetdm.orbit',
      'sudo "$uninstall"',
      'sudo /usr/bin/chflags noschg "$locked_cli_file"',
      'sudo pkgutil --forget ai.anyray.connect',
      'sudo pkgutil --forget "$fleet_receipt"',
      'sudo pkgutil --forget ai.anyray.connect-tray',
      '"$fleet_plist"',
      '/usr/local/bin/orbit',
      '/usr/local/lib/anyray-connect-retired',
      '"$retired_plist"',
      '"$fleet_root"',
      '/var/lib/orbit',
      '/var/log/orbit',
      '"$residue_marker"',
    ]) {
      const cleanupIndex = mac.indexOf(cleanup, cleanupStart);
      assert.ok(cleanupIndex > cleanupStart && cleanupIndex < trapInstall);
    }
  });

  test('passes validator outputs through quoted step environments', () => {
    assert.equal(
      (workflow.match(/EXPECTED_VERSION: \$\{\{ needs\.preflight\.outputs\.version \}\}/g) ?? [])
        .length,
      5
    );
    assert.equal(
      (workflow.match(/EXPECTED_SOURCE_SHA: \$\{\{ needs\.preflight\.outputs\.source_sha \}\}/g) ?? [])
        .length,
      5
    );
    const validators = workflow.match(
      /- name: Gate source SHA,[\s\S]*?(?=\n      - )/g
    );
    assert.equal(validators?.length, 5);
    for (const validator of validators ?? []) {
      assert.doesNotMatch(validator, /run:[\s\S]*needs\.preflight\.outputs/);
    }
  });

  test('can publish only a prerelease while preserving releases/latest', () => {
    const publish = job('publish-staging-prerelease');
    assert.match(publish, /if: \$\{\{ !inputs\.dry_run \}\}/);
    assert.match(publish, /connect-desktop-staging-v/);
    assert.match(publish, /--prerelease/);
    assert.match(publish, /--latest=false/);
    assert.match(publish, /latest_before/);
    assert.match(publish, /latest_after/);
    assert.doesNotMatch(publish, /release delete|--clobber|echo 0/);
    assert.match(publish, /node scripts\/publish-desktop-feed\.mjs/);
    assert.doesNotMatch(workflow, /connect-update\.json|npm publish|gen-winget|gen-homebrew/);
  });
});

test('macOS pkg scripts ride the unsigned artifact from the monorepo source checkout', () => {
  const build = job('build-macos-unsigned');
  for (const script of ['preinstall', 'postinstall', 'uninstall.sh']) {
    assert.match(
      build,
      new RegExp(
        `test -f private-source/connect-tray/src-tauri/macos/${script.replace('.', '\\.')}`
      )
    );
    assert.match(
      build,
      new RegExp(
        `cp private-source/connect-tray/src-tauri/macos/${script.replace('.', '\\.')} out/pkg-scripts/${script.replace('.', '\\.')}`
      )
    );
  }
  assert.match(
    build,
    /path: out\/connect-desktop-unsigned\.zip out\/pkg-scripts\/preinstall out\/pkg-scripts\/postinstall out\/pkg-scripts\/uninstall\.sh/
  );

  const sign = job('sign-macos');
  assert.match(sign, /test -f unsigned\/preinstall/);
  assert.match(sign, /test -f unsigned\/postinstall/);
  assert.match(sign, /test -f unsigned\/uninstall\.sh/);
  assert.doesNotMatch(workflow, /unsigned\/pkg-scripts/);
  assert.doesNotMatch(sign, /sparse-checkout:[\s\S]*scripts\/desktop-pkg/);

  assert.doesNotMatch(workflow, /scripts\/desktop-pkg/);
});

test('desktop staging assets contain one PKG, one updater tarball, and no DMG', () => {
  const assemble = job('assemble-signed-staging');
  assert.match(assemble, /cp platform\/macos\/\*\.pkg assets\//);
  assert.match(assemble, /cp platform\/macos\/\*\.app\.tar\.gz assets\//);
  assert.match(assemble, /-name '\*\.pkg'[\s\S]*-eq 1/);
  assert.match(assemble, /-name '\*\.dmg'[\s\S]*-eq 0/);
});

test('all Mac fleet owners serialize the full workflow, including cleanup', () => {
  for (const file of ['release-connect-desktop.yml', 'release-connect-binaries.yml', 'release-fleetd-installer.yml']) {
    const text = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
    assert.match(text, /^concurrency:\n(?:  #[^\n]*\n)*  group: anyray-install-mac-release\n  cancel-in-progress: false/m);
  }
});

test('native builds use the source-pinned pnpm before any packaging command', () => {
  assert.doesNotMatch(workflow, /corepack pnpm -C|corepack enable|cargo install tauri-cli/);
  for (const name of ['build-macos-unsigned', 'build-linux-unsigned', 'build-windows-unsigned']) {
    const body = job(name);
    assert.match(body, /(?:cd|Push-Location) private-source\n(?:            #[^\n]*\n|          try \{\n)?\s*corepack pnpm --filter/);
    assert.match(body, /--filter 'anyray-vscode\.\.\.'/);
    assert.match(body, /--config.node-linker=isolated/);
  }
  assert.match(job('build-windows-unsigned'), /\$PSNativeCommandUseErrorActionPreference = \$true/);
  assert.match(job('bundle-windows-unsigned'), /\$PSNativeCommandUseErrorActionPreference = \$true/);
});

test('MSI verification uses Windows trust rather than the PE-only parser', () => {
  assert.doesNotMatch(job('sign-windows-installer'), /verify-authenticode\.py/);
  assert.match(job('verify-windows-signatures'), /\$installers \| ForEach-Object \{\s*\.\/scripts\/verify-authenticode-windows\.ps1/);
  assert.match(job('assemble-signed-staging'), /- verify-windows-signatures/);
});

test('universal builds stage a validated engine for both compile targets and bundling', () => {
  const body = job('build-macos-unsigned');
  assert.match(body, /for sidecar_target in aarch64-apple-darwin x86_64-apple-darwin universal-apple-darwin; do/);
  assert.match(body, /stage-connect-tray-engine\.mjs \\\n\s*"\$sidecar_target" \\\n\s*"\$GITHUB_WORKSPACE\/engine\/anyray-connect-universal"/);
});

test('every native build and bundle uses the pinned child-process toolchain launcher', () => {
  const commands = workflow.split('\n').filter((line) => /node .*tauri\.js" (build|bundle)/.test(line));
  assert.equal(commands.length, 5);
  for (const command of commands) assert.match(command, /scripts\/run-desktop-tauri\.mjs/);
});


test('Linux adoption smoke uses a real dedicated account and checks owner state', () => {
  const linux = job('smoke-linux-installers');
  assert.match(linux, /account=tester\n\s*existing_home=\/home\/tester/);
  assert.match(linux, /useradd --create-home/);
  assert.match(linux, /runuser -u/);
  assert.match(linux, /runuser -u "\$account" -- env \\\n+              HOME="\$existing_home" \\\n+              XDG_CONFIG_HOME="\$existing_home\/\.config" \\\n+              XDG_DATA_HOME="\$existing_home\/\.local\/share" \\\n+              XDG_RUNTIME_DIR="\$existing_home\/\.runtime"/);
  assert.match(linux, /engineOwner/);
  assert.match(linux, /trayAppPath/);
  assert.match(linux, /loginRegistrationObservedAt/);
});

test('every smoke allows exactly the verifier\'s ownership fields to change', () => {
  const verifier = readFileSync(new URL('./verify-desktop-profile.mjs', import.meta.url), 'utf8');
  const fields = [...verifier.matchAll(/^  '([A-Za-z]+)',$/gm)].map((m) => m[1]);
  assert.ok(fields.length >= 11);
  const python = [...macSmoke.matchAll(/^    '([A-Za-z]+)',$/gm)].map((m) => m[1]);
  assert.deepEqual(python, fields);
  const linux = job('smoke-linux-installers').match(/owner_fields=([A-Za-z,]+)$/m)?.[1].split(',');
  assert.deepEqual(linux, fields);
});

test('Linux package replacement and native rpm removal leave pre-existing CLI state byte-identical', () => {
  const linux = job('smoke-linux-installers');
  assert.match(linux, /existing-scheduler-sentinel/);
  assert.match(linux, /existing-cli-sentinel/);
  const checkpoints = linux.match(/^\s*assert_existing_state_untouched$/gm) ?? [];
  assert.equal(checkpoints.length, 5);
  let at = linux.indexOf('build-desktop-cli-migration-fixtures.sh');
  for (const step of [
    'as_root dpkg -i "$cli_deb"',
    'apt-get install -y "$PWD/$deb"',
    'as_root rpm --dbpath "$rpm_database" -i --nodeps "$cli_rpm"',
    'as_root rpm --dbpath "$rpm_database" -U --nodeps "$rpm"',
    'as_root rpm --dbpath "$rpm_database" -e "$rpm_name"',
  ]) {
    at = linux.indexOf(step, at);
    assert.ok(at > 0, step);
    const next = linux.indexOf('\n          assert_existing_state_untouched\n', at);
    assert.ok(next > at && next - at < 400, `no checkpoint after ${step}`);
    at = next;
  }
});


test('Windows signing fetches go through the shared fetch-pinned action (retry policy lives there)', () => {
  const inner = job('sign-windows-inner');
  assert.equal((inner.match(/uses: \.\/\.github\/actions\/fetch-pinned/g) ?? []).length, 2);
  assert.match(inner, /jsign-\$\{\{ env\.JSIGN_VERSION \}\}\.jar/);
  assert.match(inner, /ms-root\.crt/);
  const installer = job('sign-windows-installer');
  assert.match(installer, /uses: \.\/\.github\/actions\/fetch-pinned/);
  assert.match(installer, /jsign-\$\{\{ env\.JSIGN_VERSION \}\}\.jar/);
});

test('macOS native login-item smoke stays a manual acceptance script, not a CI step', () => {
  const mac = job('verify-macos-signed');
  assert.doesNotMatch(mac, /DESKTOP_MAC_TEST_USER|launchctl asuser|smoke-connect-desktop-macos.py/);
  assert.doesNotMatch(mac, /HOME="\$existing_home"|did not create its LaunchAgent/);
  assert.match(macSmoke, /existing-scheduler-sentinel/);
  assert.match(macSmoke, /check_adopted_profile\(profile, app, expected\)/);
  assert.ok(macSmoke.indexOf('foreign_before = ') < macSmoke.indexOf("for scenario in ("));
  assert.ok(macSmoke.indexOf('!= foreign_before') > macSmoke.indexOf("native('unregister')"));
  assert.match(macSmoke, /created a refresh scheduler/);
});


test('Linux upgrades exercise an installed CLI package before the desktop replacement', () => {
  const linux = job('smoke-linux-installers');
  const fixtures = linux.indexOf('build-desktop-cli-migration-fixtures.sh');
  const cliDeb = linux.indexOf('as_root dpkg -i "$cli_deb"');
  const deb = linux.indexOf('apt-get install -y "$PWD/$deb"');
  const cliRpm = linux.indexOf('as_root rpm --dbpath "$rpm_database" -i --nodeps "$cli_rpm"');
  const rpm = linux.indexOf('as_root rpm --dbpath "$rpm_database" -U --nodeps "$rpm"');
  assert.ok(fixtures > 0 && fixtures < cliDeb && cliDeb < deb);
  assert.ok(deb < cliRpm && cliRpm < rpm);
  const bootstrapGone = 'test ! -e /etc/xdg/autostart/anyray-connect-managed-enroll.desktop';
  assert.ok(linux.indexOf(bootstrapGone, deb) < cliRpm);
  assert.ok(linux.indexOf(bootstrapGone, rpm) > rpm);
});

test('Linux fleet fixture builds deb and rpm from one nfpm YAML with no removal script', () => {
  assert.match(fleetFixture, /^set -euo pipefail$/m);
  assert.match(fleetFixture, /source ci\/nfpm-tool\.env/);
  assert.match(fleetFixture, /NFPM_TOOL_VERSION/);
  assert.match(fleetFixture, /NFPM_LINUX_X64_SHA256.*sha256sum -c -/s);
  assert.match(fleetFixture, /name: fleet-osquery/);
  assert.match(fleetFixture, /opt\/orbit\/bin\/orbit/);
  assert.match(fleetFixture, /usr\/lib\/systemd\/system\/orbit\.service/);
  assert.match(fleetFixture, /ExecStart=\/bin\/sleep infinity/);
  assert.match(fleetFixture, /opt\/orbit\/osquery_log\/x\.log/);
  assert.equal((fleetFixture.match(/NFPM_VERSION=0\.0\.1/g) ?? []).length, 1);
  assert.equal((fleetFixture.match(/"\$fixture_root\/nfpm\.yaml"/g) ?? []).length, 3);
  assert.match(fleetFixture, /nfpm" package -f "\$fixture_root\/nfpm\.yaml" -p deb -t/);
  assert.match(fleetFixture, /nfpm" package -f "\$fixture_root\/nfpm\.yaml" -p rpm -t/);
  assert.doesNotMatch(fleetFixture, /rpmbuild/);
  assert.doesNotMatch(fleetFixture, /^\s*(preun|prerm):/m);
});

test('Linux smoke replaces planted fleet-osquery deb and rpm packages', () => {
  const linux = job('smoke-linux-installers');
  const fixture = linux.indexOf('build-desktop-fleet-osquery-fixtures.sh');
  const fleetDeb = linux.indexOf('as_root dpkg -i "$fleet_deb"');
  const desktopDeb = linux.indexOf('apt-get install -y "$PWD/$deb"');
  const fleetRpm = linux.indexOf('as_root rpm --dbpath "$rpm_database" -i --nodeps "$fleet_rpm"');
  const desktopRpm = linux.indexOf('as_root rpm --dbpath "$rpm_database" -U --nodeps "$rpm"');
  assert.ok(fixture > 0 && fixture < fleetDeb && fleetDeb < desktopDeb);
  assert.ok(desktopDeb < fleetRpm && fleetRpm < desktopRpm);
  assert.match(linux, /systemctl enable --now orbit\.service/);
  assert.match(linux, /systemd is unavailable; skipping the running\/enabled orbit\.service assertions/);
  assert.match(linux, /wants_link=\/etc\/systemd\/system\/multi-user\.target\.wants\/orbit\.service/);
  assert.match(linux, /if \[ -e "\$wants_link" \] \|\| \[ -L "\$wants_link" \]; then/);
  assert.match(linux, /desktop package left an orbit\.service wants-target symlink behind: \$wants_link/);
  assert.match(linux, /orbit_enabled_state="\$\(as_root systemctl is-enabled orbit\.service 2>&1\)" \|\| true/);
  assert.match(linux, /desktop package left orbit\.service enabled: \$orbit_enabled_state/);
  assert.match(linux, /dpkg-query -W -f='\$\{db:Status-Status\}\\n' fleet-osquery/);
  assert.match(linux, /rpm --dbpath "\$rpm_database" -q fleet-osquery/);
  assert.equal((linux.match(/assert_orbit_removed/g) ?? []).length, 3);
  assert.match(linux, /test -x "\$uninstall"/);
  assert.match(linux, /dpkg -S \/usr\/bin\/anyray-connect/);
  assert.match(linux, /rpm --dbpath "\$rpm_database" -qf --queryformat '%\{NAME\}' \/usr\/bin\/anyray-connect/);
});

test('Linux smoke runs uninstall.sh user cleanup before package removal', () => {
  const linux = job('smoke-linux-installers');
  assert.match(linux, /existing_home=\/home\/tester/);
  assert.match(linux, /engine_help=.*"\$deb_engine" --help/);
  // Verbatim against the verb regexes uninstall.sh itself uses, so the smoke's
  // expectation cannot disagree with the script it validates.
  assert.match(linux, /grep -Eq '\^\[\[:space:\]\]\*uninstall\[\[:space:\]\]'/);
  assert.match(linux, /grep -Eq '\^\[\[:space:\]\]\*offboard\[\[:space:\]\]'/);
  assert.match(linux, /expected_user_verb=uninstall/);
  assert.match(linux, /expected_user_verb=offboard/);
  assert.match(linux, /any-391-user-layer-marker/);
  assert.doesNotMatch(linux, /strace/);
  assert.match(linux, /uninstall_stdout="\$\(as_root "\$uninstall"\)"/);
  assert.match(linux, /Linux uninstall helper left the desktop deb installed/);
  const uninstallBranch = linux.indexOf('if [ "$expected_user_verb" = uninstall ]; then');
  assert.ok(uninstallBranch > 0);
  const uninstallGrep = linux.indexOf('grep -Fq \'"user":"complete"\'', uninstallBranch);
  const anyrayGone = linux.indexOf('test ! -e "$existing_home/.anyray"', uninstallBranch);
  assert.ok(uninstallGrep > uninstallBranch && uninstallGrep < anyrayGone);
  const offboardGrep = linux.indexOf('grep -Fq \'"verb":"offboard"\'', anyrayGone);
  const markerSurvives = linux.indexOf('test -f "$user_layer_marker"', anyrayGone);
  assert.ok(offboardGrep > anyrayGone && offboardGrep < markerSurvives);
  assert.match(linux, /test ! -e "\$uninstall"/);
});
