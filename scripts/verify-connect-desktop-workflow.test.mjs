import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/release-connect-desktop.yml', import.meta.url),
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
      4
    );
    assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 4);
    assert.equal((workflow.match(/fetch-depth: 0/g) ?? []).length, 4);
    assert.doesNotMatch(workflow, /private-monorepo-source|source-candidate/);

    const uploadBlocks = workflow.match(
      /- uses: actions\/upload-artifact@[\s\S]*?(?=\n      - |\n  [a-z0-9-]+:|$)/g
    );
    assert.ok(uploadBlocks && uploadBlocks.length > 0);
    for (const block of uploadBlocks) {
      assert.doesNotMatch(block, /private-source|connect-tray\/src|\.git/);
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

  test('uses hosted macOS for compilation and smoke, and CodeBuild Mac only for signing', () => {
    assert.match(job('build-macos-unsigned'), /runs-on: macos-15/);
    assert.match(job('build-macos-unsigned'), /needs: preflight/);
    assert.match(
      job('provision-mac'),
      /needs: \[preflight, build-macos-unsigned\]/
    );
    assert.match(
      job('sign-macos'),
      /needs: \[preflight, build-macos-unsigned, provision-mac\]/
    );
    assert.match(
      job('sign-macos'),
      /runs-on: codebuild-anyray-install-runner-mac-/
    );
    assert.match(job('verify-macos-signed'), /runs-on: macos-15/);
    assert.match(job('teardown-mac'), /needs: sign-macos/);
    assert.equal(
      (workflow.match(/runs-on: codebuild-anyray-install-runner-mac-/g) ?? [])
        .length,
      1
    );
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

  test('signs Windows inner executables before MSI packaging and the MSI after', () => {
    assert.match(job('bundle-windows-unsigned'), /needs: \[preflight, sign-windows-inner\]/);
    assert.match(job('bundle-windows-unsigned'), /cargo tauri bundle .*--bundles msi/);
    assert.match(job('sign-windows-installer'), /needs: \[preflight, bundle-windows-unsigned\]/);
    assert.match(job('verify-windows-signatures'), /msiexec\.exe/);
  });

  test('gates assembly on native install/uninstall smoke tests', () => {
    const mac = job('verify-macos-signed');
    assert.match(mac, /ditto "\$app" "\$installed_app"/);
    assert.match(mac, /HOME="\$existing_home" "\$installed_main"/);
    assert.match(mac, /ai\.anyray\.connect-tray\.plist/);
    assert.match(mac, /plutil -extract Label/);
    assert.match(mac, /kill -9 "\$app_pid"/);
    assert.match(mac, /rm -f "\$autostart"/);
    assert.match(mac, /rm -rf "\$installed_app"/);

    const windows = job('verify-windows-signatures');
    assert.match(windows, /MSI install failed/);
    assert.match(windows, /Start-Process -FilePath \$installedMain\.FullName/);
    assert.match(windows, /ai\.anyray\.connect-tray/);
    assert.match(windows, /Stop-Process -Id \$appProcess\.Id -Force/);
    assert.match(windows, /Remove-ItemProperty -Path \$runKey -Name \$runName/);
    assert.match(windows, /MSI uninstall failed/);

    const linux = job('smoke-linux-installers');
    assert.match(linux, /sudo dpkg -i/);
    assert.match(linux, /smoke_installed_tray "\$deb_main"/);
    assert.match(linux, /sudo dpkg -r/);
    assert.match(linux, /sudo rpm -i/);
    assert.match(linux, /smoke_installed_tray "\$rpm_main"/);
    assert.match(linux, /sudo rpm -e/);
    assert.match(linux, /ai\.anyray\.connect-tray\.desktop/);
    assert.match(linux, /setsid dbus-run-session -- xvfb-run -a "\$main"/);
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
      4
    );
    assert.equal(
      (workflow.match(/EXPECTED_SOURCE_SHA: \$\{\{ needs\.preflight\.outputs\.source_sha \}\}/g) ?? [])
        .length,
      4
    );
    const validators = workflow.match(
      /- name: Gate source SHA,[\s\S]*?(?=\n      - )/g
    );
    assert.equal(validators?.length, 4);
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
    assert.doesNotMatch(workflow, /connect-update\.json|npm publish|gen-winget|gen-homebrew/);
  });
});
