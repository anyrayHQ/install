import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const helper = fileURLToPath(new URL('./msi-diagnostics.ps1', import.meta.url));
const hasPwsh = !spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).error;
const refusal = 'WixQuietExec64: A foreign, unsigned binary occupies C:\\Program Files\\Anyray\\anyray-connect.exe. Remove it, then re-run the install.';
const failedAction = 'Action ended 19:06:10: SweepMachineState. Return value 3.';

function run(t, text, action = 'Assert-MsiForeignEngineRefusal', encoding = 'utf8') {
  const dir = mkdtempSync(join(tmpdir(), 'msi-diagnostics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'install.log');
  if (text !== null) writeFileSync(log, text, encoding);
  return spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference = 'Stop'; . $env:MSI_TEST_HELPER; ${action} -Path $env:MSI_TEST_LOG`,
  ], { encoding: 'utf8', env: { ...process.env, MSI_TEST_HELPER: helper, MSI_TEST_LOG: log } });
}

for (const encoding of ['utf8', 'utf16le']) {
  test(`accepts the specific refusal and failed action in ${encoding}`, { skip: !hasPwsh }, (t) => {
    const result = run(t, `\uFEFF${refusal}\r\n${failedAction}\r\n`, undefined, encoding);
    assert.equal(result.status, 0, result.stderr);
  });
}

for (const [name, log] of [
  ['generic 1603', 'MainEngineThread is returning 1603'],
  ['unrelated action failure', `${refusal}\nAction ended 19:06:10: InstallFiles. Return value 3.`],
  ['missing refusal diagnostic', `WixQuietExec64: Error: unable to launch PowerShell\n${failedAction}`],
  ['script text in property dump', `Property(S): Script = ${refusal.slice('WixQuietExec64: '.length)}\n${failedAction}`],
  ['missing log', null],
]) {
  test(`rejects ${name}`, { skip: !hasPwsh }, (t) => {
    assert.notEqual(run(t, log).status, 0);
  });
}

test('accepts PowerShell CLIXML runtime error output', { skip: !hasPwsh }, (t) => {
  const log = `WixQuietExec64: <Objs><S S="Error">${refusal.slice('WixQuietExec64: '.length)}_x000D__x000A_</S></Objs>\n${failedAction}`;
  const result = run(t, log);
  assert.equal(result.status, 0, result.stderr);
});

test('accepts a deferred failure after successful action scheduling', { skip: !hasPwsh }, (t) => {
  const log = `Action ended 19:06:09: SweepMachineState. Return value 1.\n${refusal}\nCustomAction SweepMachineState returned actual error code 1603 (note this may not be 100% accurate if translation happened inside sandbox)`;
  const result = run(t, log);
  assert.equal(result.status, 0, result.stderr);
});

test('shows the original failure before a long property dump, with bounded output', { skip: !hasPwsh }, (t) => {
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

test('reports a missing log without obscuring the original smoke failure', { skip: !hasPwsh }, (t) => {
  const result = run(t, null, 'Show-MsiFailureContext');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MSI log was not created/);
});

test('falls back to the tail when no failure marker exists', { skip: !hasPwsh }, (t) => {
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
  test(`workflow cleanup: ${name}`, { skip: !hasPwsh }, () => {
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
