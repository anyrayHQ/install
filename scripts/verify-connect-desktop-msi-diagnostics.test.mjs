import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
