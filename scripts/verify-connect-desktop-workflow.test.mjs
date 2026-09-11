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
const macPostinstall = readFileSync(
  new URL('./desktop-pkg/postinstall', import.meta.url),
  'utf8'
);
const macUninstall = readFileSync(
  new URL('./desktop-pkg/uninstall.sh', import.meta.url),
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
    assert.match(build, /sha256sum -c -/);
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
    assert.match(sign, /scripts\/desktop-pkg/);
    assert.match(sign, /ditto "\$app" "\$root\/Applications\/Anyray Connect\.app"/);
    assert.match(sign, /--identifier ai\.anyray\.connect-tray/);
    assert.match(sign, /plutil -replace 0\.BundleIsRelocatable -bool false "\$component_plist"/);
    assert.match(sign, /RootRelativeBundlePath/);
    assert.match(sign, /Developer ID Installer/);
    assert.match(sign, /xar -tf "\$pkg" \| grep -qx 'Distribution'/);
    assert.match(sign, /payload-files "\$pkg"/);
    assert.match(sign, /Applications\/Anyray Connect\\\.app\/Contents\/MacOS\/anyray-connect/);
    assert.match(sign, /spctl -a -vvv -t install "\$pkg"/);
    assert.match(sign, /out\/\*\.pkg out\/\*\.app\.tar\.gz/);
    assert.doesNotMatch(sign, /hdiutil|\.dmg|DMG/);
    const verify = job('verify-macos-signed');
    assert.match(verify, /count\(\/pkg-info\/relocate\/bundle\)' "\$package_info"\)" = 0/);
    assert.match(verify, /= '\.\/Applications\/Anyray Connect\.app'/);
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
    assert.ok(mac.indexOf('smoke-connect-desktop-macos.py') < mac.lastIndexOf('sudo "$uninstall"'));
    const macOwnership = macSmoke.indexOf("profile.get('engineOwner') == 'app'");
    const macStop = macSmoke.indexOf('            stop()', macOwnership);
    assert.ok(macOwnership > 0 && macOwnership < macStop);
    assert.ok(macSmoke.indexOf("if native() != observed:", macStop) > macStop);

    const windows = job('verify-windows-signatures');
    assert.match(windows, /actions\/setup-node@/);
    const firstCheck = windows.indexOf('node scripts/verify-desktop-profile.mjs');
    assert.ok(firstCheck > 0);
    assert.match(windows, /verify-desktop-profile\.mjs \$profileBefore \$state \$installedEngine\.FullName \$installedMain\.DirectoryName/);
    assert.match(windows, /try \{ \$observedProfile = Get-Content -Raw \$state \| ConvertFrom-Json \}/);
    assert.ok(firstCheck < windows.indexOf('Stop-Process -Id $appProcess.Id -Force'));
    assert.ok(windows.indexOf('$stateBefore = (Get-FileHash') > firstCheck);
  });

  test('gates assembly on native install/uninstall smoke tests', () => {
    const mac = job('verify-macos-signed');
    assert.match(mac, /plutil -extract LSMinimumSystemVersion raw -o - "\$updater_app\/Contents\/Info\.plist"\)" = '13\.0'/);
    assert.match(mac, /plutil -extract LSMinimumSystemVersion raw -o - "\$app\/Contents\/Info\.plist"\)" = '13\.0'/);
    assert.match(mac, /installer -pkg "\$pkg" -target \//);
    assert.match(mac, /cmp "\$foreign" "\$launcher"/);
    assert.match(mac, /readlink "\$launcher"/);
    assert.match(mac, /smoke-connect-desktop-macos.py/);
    assert.match(mac, /launchctl asuser/);
    assert.match(mac, /sudo "\$uninstall"/);

    const windows = job('verify-windows-signatures');
    assert.match(windows, /MSI install failed/);
    assert.match(windows, /Start-Process -FilePath \$installedMain\.FullName/);
    assert.match(windows, /ai\.anyray\.connect-tray/);
    assert.match(windows, /Stop-Process -Id \$appProcess\.Id -Force/);
    assert.match(windows, /Remove-ItemProperty -Path \$runKey -Name \$runName/);
    assert.match(windows, /MSI uninstall failed/);

    const linux = job('smoke-linux-installers');
    assert.match(linux, /\$SUDO dpkg -i/);
    assert.match(linux, /smoke_installed_tray "\$deb_main"/);
    assert.match(linux, /\$SUDO dpkg -r/);
    assert.match(linux, /\$SUDO rpm --dbpath "\$rpm_database" -i/);
    assert.match(linux, /smoke_installed_tray "\$rpm_main"/);
    assert.match(linux, /\$SUDO rpm --dbpath "\$rpm_database" -e/);
    assert.match(linux, /ai\.anyray\.connect-tray\.desktop/);
    assert.match(linux, /dbus-run-session -- xvfb-run -a "\$main"/);
    assert.match(linux, /kill -KILL -- "-\$tray_pid"/);
    assert.match(linux, /rm -f "\$autostart"/);
    assert.match(
      job('assemble-signed-staging'),
      /- verify-macos-signed[\s\S]*- verify-windows-signatures[\s\S]*- smoke-linux-installers/
    );
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

test('macOS package scripts create, verify, and remove only owned launchers', () => {
  for (const script of [macPostinstall, macUninstall]) {
    assert.match(script, /^#!\/bin\/bash\nset -euo pipefail\n/);
  }
  assert.match(macPostinstall, /refusing to overwrite foreign \$launcher/);
  assert.match(macPostinstall, /refusing to overwrite foreign \$helper/);
  assert.match(macPostinstall, /desktop helper --print/);
  assert.match(macPostinstall, /--wrapper "\$wrapper"/);
  assert.match(macPostinstall, /--bin "\$launcher"/);
  assert.match(macPostinstall, /\/bin\/sh -n "\$helper"/);
  assert.match(macPostinstall, /\$lib_dir\/uninstall\.sh/);
  assert.doesNotMatch(macPostinstall, /ai\.anyray\.connect com\.fleetdm\.orbit\.base\.pkg/);
  assert.doesNotMatch(macPostinstall, /\/Library\/LaunchAgents\/ai\.anyray\.connect\.managed-enroll\.plist/);
  assert.doesNotMatch(macPostinstall, /launchctl print system\/com\.fleetdm\.orbit/);
  assert.match(macUninstall, /launchctl asuser "\$uid"/);
  assert.match(macUninstall, /uninstall --user --json/);
  assert.match(macUninstall, /--help 2>\/dev\/null \| \/usr\/bin\/grep -Eq '\^\[\[:space:\]\]\*uninstall\[\[:space:\]\]'/);
  assert.match(macUninstall, /engine predates the uninstall verb/);
  assert.match(macUninstall, /leaving foreign \$launcher untouched/);
  assert.match(macUninstall, /pkgutil --forget "\$receipt"/);
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
  assert.match(linux, /useradd/);
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

test('Linux package install and uninstall leave pre-existing CLI state byte-identical', () => {
  const linux = job('smoke-linux-installers');
  assert.match(linux, /existing-scheduler-sentinel/);
  assert.match(linux, /existing-cli-sentinel/);
  const checkpoints = linux.match(/^\s*assert_existing_state_untouched$/gm) ?? [];
  assert.equal(checkpoints.length, 6);
  let at = linux.indexOf('build-desktop-cli-migration-fixtures.sh');
  for (const step of [
    '$SUDO dpkg -i "$cli_deb"',
    'apt-get install -y "$PWD/$deb"',
    '$SUDO dpkg -r "$deb_name"',
    'rpm --dbpath "$rpm_database" -i --nodeps "$cli_rpm"',
    'rpm --dbpath "$rpm_database" -U --nodeps "$rpm"',
    'rpm --dbpath "$rpm_database" -e "$rpm_name"',
  ]) {
    at = linux.indexOf(step, at);
    assert.ok(at > 0, step);
    const next = linux.indexOf('\n          assert_existing_state_untouched\n', at);
    assert.ok(next > at && next - at < 400, `no checkpoint after ${step}`);
    at = next;
  }
});


test('macOS smoke uses a dedicated GUI account and native lifecycle assertions', () => {
  const mac = job('verify-macos-signed');
  assert.match(mac, /DESKTOP_MAC_TEST_USER/);
  assert.match(mac, /launchctl asuser/);
  assert.match(mac, /smoke-connect-desktop-macos.py/);
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
  const cliDeb = linux.indexOf('$SUDO dpkg -i "$cli_deb"');
  const deb = linux.indexOf('apt-get install -y "$PWD/$deb"');
  const cliRpm = linux.indexOf('rpm --dbpath "$rpm_database" -i --nodeps "$cli_rpm"');
  const rpm = linux.indexOf('rpm --dbpath "$rpm_database" -U --nodeps "$rpm"');
  assert.ok(fixtures > 0 && fixtures < cliDeb && cliDeb < deb);
  assert.ok(deb < cliRpm && cliRpm < rpm);
  const bootstrapGone = 'test ! -e /etc/xdg/autostart/anyray-connect-managed-enroll.desktop';
  assert.ok(linux.indexOf(bootstrapGone, deb) < cliRpm);
  assert.ok(linux.indexOf(bootstrapGone, rpm) > rpm);
});
