import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const helper = fileURLToPath(new URL('./msi-diagnostics.ps1', import.meta.url));
const pwshProbe = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' });
assert.equal(pwshProbe.status, 0, 'MSI diagnostic tests require working PowerShell (pwsh) on PATH; refusing to skip coverage.');
// A failing custom action as it reaches a verbose MSI log.
const refusal = 'WixQuietExec64:  ANYRAY-CA-ERROR: A foreign, unsigned binary occupies C:\\Program Files\\Anyray\\anyray-connect.exe. Remove it, then re-run the install.';
const failedAction = 'Action ended 19:06:10: SweepMachineState. Return value 3.';

function run(t, text, action, encoding = 'utf8') {
  const dir = mkdtempSync(join(tmpdir(), 'msi-diagnostics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'install.log');
  if (text !== null) writeFileSync(log, text, encoding);
  return spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference = 'Stop'; . $env:MSI_TEST_HELPER; ${action} -Path $env:MSI_TEST_LOG`,
  ], { encoding: 'utf8', env: { ...process.env, MSI_TEST_HELPER: helper, MSI_TEST_LOG: log } });
}

test('shows the original failure before a long property dump, with bounded output', (t) => {
  const log = ['Action start 19:06:10: SweepMachineState.', refusal, failedAction,
    ...Array.from({ length: 150 }, (_, i) => `Property(S): filler${i} = ${'x'.repeat(2000)}`),
    'MainEngineThread is returning 1603'].join('\n');
  const result = run(t, log, 'Show-MsiFailureContext');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1: Action start/);
  assert.match(result.stdout, /foreign, unsigned binary/);
  assert.match(result.stdout, /see full MSI log/);
  assert.ok(result.stdout.length < 8000);
  assert.equal(result.stdout.match(/3: Action ended/g)?.length, 1);
});

test('reports a missing log without obscuring the original smoke failure', (t) => {
  const result = run(t, null, 'Show-MsiFailureContext');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MSI log was not created/);
});

test('falls back to the tail when no failure marker exists', (t) => {
  const result = run(t, Array.from({ length: 100 }, (_, i) => `entry-${i}`).join('\n'), 'Show-MsiFailureContext');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /61: entry-60/);
  assert.match(result.stdout, /100: entry-99/);
  assert.doesNotMatch(result.stdout, /entry-59/);
});

// Execute the workflow's actual catch/finally with a mocked uninstall process.
// This checks error precedence without requiring an installed MSI or registry.
const workflow = readFileSync(new URL('../.github/workflows/release-connect-desktop.yml', import.meta.url), 'utf8');
const smoke = workflow.slice(workflow.indexOf('        id: windows-msi-smoke'));
const cleanupStart = smoke.indexOf('          catch {\n            $smokeFailure = $_');
const cleanupEnd = smoke.indexOf('          if (Test-Path -LiteralPath $installedMainPath', cleanupStart);
const cleanupHandling = smoke.slice(cleanupStart, cleanupEnd);

for (const [name, primaryFails, cleanupFails, expected] of [
  ['both fail: original error survives and cleanup is reported', true, true, 'primary smoke failure'],
  ['only cleanup fails: the smoke still fails', false, true, 'MSI uninstall failed with exit 1603'],
  ['only smoke fails: original error survives', true, false, 'primary smoke failure'],
  ['both succeed: smoke succeeds', false, false, null],
]) {
  test(`workflow cleanup: ${name}`, () => {
    assert.ok(cleanupStart > 0 && cleanupEnd > cleanupStart);
    const command = `
      $ErrorActionPreference = 'Stop'
      $smokeFailure = $null
      $appProcess = $null
      $createdRunKey = $false
      $installed = $true
      $runKey = 'unused'
      $runName = 'unused'
      $msi = 'fixture.msi'
      $uninstallLog = 'fixture.log'
      function Remove-ItemProperty { }
      function Start-Process {
        Write-Host 'UNINSTALL_ATTEMPTED'
        return [pscustomobject]@{ ExitCode = ${cleanupFails ? 1603 : 0} }
      }
      try {
        try { ${primaryFails ? "throw 'primary smoke failure'" : "Write-Host 'SMOKE_OK'"} }
        ${cleanupHandling}
      }
      catch {
        Write-Host "FINAL_ERROR: $($_.Exception.Message)"
        exit 1
      }
    `;
    const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
    assert.match(result.stdout, /UNINSTALL_ATTEMPTED/);
    assert.equal(result.status, expected === null ? 0 : 1, result.stderr);
    if (expected !== null) assert.ok(result.stdout.includes(`FINAL_ERROR: ${expected}`), result.stdout);
    if (primaryFails && cleanupFails) {
      assert.match(result.stdout, /Windows MSI cleanup also failed: MSI uninstall failed with exit 1603/);
    } else {
      assert.doesNotMatch(result.stdout, /Windows MSI cleanup also failed/);
    }
  });
}

// The install-log check, run exactly as the workflow writes it, against logs shaped like a
// real /L*v log: UTF-16LE with a byte-order mark, which is how Windows Installer writes them.
const logCheckStart = smoke.indexOf('            $msiLines = @(Get-Content -LiteralPath $log)');
const logCheckEnd = smoke.indexOf('            if (-not (Test-Path -LiteralPath $bootstrapShim -PathType Leaf)', logCheckStart);
const logCheck = smoke.slice(logCheckStart, logCheckEnd);

// Lines from a real install of the no-PowerShell MSI (monorepo #5342's Windows E2E).
const nativeLog = [
  '=== Verbose logging started: 11/3/2026  22:35:28  Build type: SHIP UNICODE 5.00.10011.00  Calling process: C:\\Windows\\system32\\msiexec.exe ===',
  'MSI (s) (84:54) [22:35:28:799]: RESTART MANAGER: Session opened.',
  'Action start 22:35:28: WixRemoveFoldersEx.',
  'WixRemoveFoldersEx:  Recursing path: C:\\Program Files\\Orbit\\ for row: RemoveOrbitLeftovers.',
  'Action ended 22:35:28: WixRemoveFoldersEx. Return value 1.',
  'Action start 22:35:29: WriteDesktopHelpers.',
  'Action ended 22:35:29: WriteDesktopHelpers. Return value 1.',
  'Property(S): INSTALLDIR = C:\\Program Files\\Anyray\\',
  'MSI (s) (84:54) [22:35:31:002]: Product: Anyray Connect -- Installation completed successfully.',
];
// One line per alternative of the workflow's pattern, each naming only that one, in the
// shape the retired sweep and finish actions left in the log.
const retiredLines = {
  powershell: 'Property(S): CleanupCommand = "C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile',
  encoded: 'Property(S): CleanupArgs = -NonInteractive -ExecutionPolicy Bypass -EncodedCommand WwBDAG0A',
  quietexec: 'MSI (s) (84:54) [19:06:10:100]: Invoking remote custom action. DLL: C:\\Windows\\Installer\\MSI1.tmp, Entrypoint: WixQuietExec64',
  sweep: 'Action start 19:06:10: SweepMachineState.',
  finish: 'Action ended 19:06:12: FinishInstall. Return value 3.',
  marker: 'CleanupAction:  ANYRAY-CA-ERROR: the engine could not be staged.',
  rollbackstaging: 'MSI (s) (84:54) [19:06:11:000]: Folder: C:\\Program Files\\Anyray\\.anyray-rollback-staging\\',
  staleengines: 'MSI (s) (84:54) [19:06:11:000]: Folder: C:\\Program Files\\Anyray\\.anyray-stale-engines\\',
};

const msiLog = (lines) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf16le')]);

// Writes each named log, runs the check once per log in one pwsh, and returns name -> outcome.
function runLogCheck(t, logs, stagingFolder = null) {
  assert.ok(logCheckStart > 0 && logCheckEnd > logCheckStart, 'install-log check not found in the workflow');
  const dir = mkdtempSync(join(tmpdir(), 'msi-log-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, lines] of Object.entries(logs)) writeFileSync(join(dir, `case-${name}.log`), msiLog(lines));
  if (stagingFolder !== null) mkdirSync(join(dir, 'Anyray', stagingFolder), { recursive: true });
  const command = `
    $ErrorActionPreference = 'Stop'
    $installDir = Join-Path $env:MSI_TEST_DIR 'Anyray'
    foreach ($case in @(Get-ChildItem -LiteralPath $env:MSI_TEST_DIR -Filter 'case-*.log' -File)) {
      $log = $case.FullName
      try {
${logCheck}
        Write-Host "RESULT $($case.BaseName) pass"
      }
      catch { Write-Host "RESULT $($case.BaseName) throw: $($_.Exception.Message)" }
    }
  `;
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', env: { ...process.env, MSI_TEST_DIR: dir },
  });
  assert.equal(result.status, 0, result.stderr);
  const outcomes = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^RESULT case-(\S+) (.*)$/.exec(line);
    if (match) outcomes[match[1]] = match[2];
  }
  assert.deepEqual(Object.keys(outcomes).sort(), Object.keys(logs).sort(), result.stdout);
  return outcomes;
}

test('install log check: the native MSI passes, every retired scripted action fails, an unreadable log fails', (t) => {
  const logs = { native: nativeLog, unreadable: nativeLog.filter((line) => !line.includes('WriteDesktopHelpers')) };
  for (const [name, line] of Object.entries(retiredLines)) logs[name] = [...nativeLog, line];
  const outcomes = runLogCheck(t, logs);
  assert.equal(outcomes.native, 'pass');
  assert.equal(outcomes.unreadable, 'throw: MSI log does not show the native WriteDesktopHelpers action');
  for (const name of Object.keys(retiredLines)) {
    assert.match(outcomes[name], /^throw: MSI log names a retired scripted custom action \(line 10, 1 matching lines\)$/, name);
  }
});

test('install log check: a retired staging folder left in the install directory fails', (t) => {
  const outcomes = runLogCheck(t, { native: nativeLog }, '.anyray-stale-engines');
  assert.match(outcomes.native, /^throw: MSI left the retired staging folder \.anyray-stale-engines in /);
});

// The foreign-helper fixture's cleanup, run through the workflow's real finally block after a
// successful uninstall: the smoke removes its own fixture, then the install directory only when
// the smoke created it and nothing else is left in it.
for (const [name, uninstallKeptFixture, otherLeftover, dirRemains] of [
  ['uninstall kept the fixture: fixture and emptied directory removed', true, false, false],
  ['another leftover: fixture removed, directory kept for the leftover checks', true, true, true],
  ['uninstall removed the fixture: nothing to clean', false, false, false],
]) {
  test(`workflow cleanup, foreign helper: ${name}`, (t) => {
    assert.ok(cleanupStart > 0 && cleanupEnd > cleanupStart);
    const dir = mkdtempSync(join(tmpdir(), 'msi-foreign-helper-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const installDir = join(dir, 'Anyray');
    if (uninstallKeptFixture) {
      mkdirSync(installDir);
      writeFileSync(join(installDir, 'anyray-bootstrap-headers-helper.cmd'), '@echo off\r\necho foreign-helper-sentinel\r\n');
    }
    if (otherLeftover) writeFileSync(join(installDir, 'leftover.txt'), 'left by uninstall');
    const command = `
      $ErrorActionPreference = 'Stop'
      $smokeFailure = $null
      $appProcess = $null
      $createdRunKey = $false
      $installed = $true
      $runKey = 'unused'
      $runName = 'unused'
      $msi = 'fixture.msi'
      $uninstallLog = 'fixture.log'
      $createdInstallDir = $true
      $plantedForeignHelper = $true
      $installDir = Join-Path $env:MSI_TEST_DIR 'Anyray'
      $bootstrapShim = Join-Path $installDir 'anyray-bootstrap-headers-helper.cmd'
      function Remove-ItemProperty { }
      function Start-Process { return [pscustomobject]@{ ExitCode = 0 } }
      try {
        try { Write-Host 'SMOKE_OK' }
        ${cleanupHandling}
      }
      catch {
        Write-Host "FINAL_ERROR: $($_.Exception.Message)"
        exit 1
      }
    `;
    const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', env: { ...process.env, MSI_TEST_DIR: dir },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const present = `Foreign helper fixture after MSI uninstall: present=${uninstallKeptFixture ? 'True' : 'False'}`;
    assert.ok(result.stdout.includes(present), result.stdout);
    assert.equal(existsSync(join(installDir, 'anyray-bootstrap-headers-helper.cmd')), false);
    assert.equal(existsSync(installDir), dirRemains);
  });
}
