import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const script = new URL('./staple-notarized.sh', import.meta.url).pathname;
const workflows = ['release-connect-desktop.yml', 'release-connect-binaries.yml'].map((name) => [
  name,
  readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'),
]);

// A fake xcrun whose `stapler staple` fails the first `fails` calls and `stapler validate` the
// first `validateFails` calls with the hosted runner's Error 68, and logs every call so the test
// can count them.
function run(fails, env = {}, { validateFails = 0, args = ['out/app.pkg'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'staple-'));
  try {
    const log = join(dir, 'calls');
    writeFileSync(join(dir, 'staple'), '0');
    writeFileSync(join(dir, 'validate'), '0');
    writeFileSync(
      join(dir, 'xcrun'),
      `#!/usr/bin/env bash
echo "$*" >> '${log}'
case "$2" in staple) limit=${fails} ;; validate) limit=${validateFails} ;; *) exit 0 ;; esac
n=$(( $(cat "${dir}/$2") + 1 )); echo "$n" > "${dir}/$2"
if [ "$n" -le "$limit" ]; then echo "The $2 action failed! Error 68." >&2; exit 68; fi
exit 0
`
    );
    chmodSync(join(dir, 'xcrun'), 0o755);
    const result = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STAPLE_RETRY_SLEEP: '0', ...env },
    });
    let calls = [];
    try {
      calls = readFileSync(log, 'utf8').trim().split('\n');
    } catch {}
    return { ...result, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a dropped connection to Apple retries the staple instead of failing the release', () => {
  const result = run(2);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    'stapler staple out/app.pkg',
    'stapler staple out/app.pkg',
    'stapler staple out/app.pkg',
    'stapler validate out/app.pkg',
  ]);
});

test('a staple that never succeeds still fails the job, naming the file', () => {
  const result = run(1000, { STAPLE_RETRY_SECONDS: '0' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /::error::.*out\/app\.pkg/);
  assert.ok(!result.calls.includes('stapler validate out/app.pkg'));
});

// Validating a stapled ticket also calls Apple, and drops the same way: on 10-28 and 10-29 every
// failed Mac release (0.11.503, .504, .505) stapled fine and then lost the connection in validate.
test('a dropped connection to Apple during validate retries the validate, not the staple', () => {
  const result = run(0, {}, { validateFails: 2 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    'stapler staple out/app.pkg',
    'stapler validate out/app.pkg',
    'stapler validate out/app.pkg',
    'stapler validate out/app.pkg',
  ]);
});

test('a validate that never succeeds still fails the job, naming the file', () => {
  const result = run(0, { STAPLE_RETRY_SECONDS: '0' }, { validateFails: 1000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /::error::.*validat.*out\/app\.pkg/);
});

test('--validate-only checks an already-stapled file with the retry and never staples it', () => {
  const result = run(1000, {}, { validateFails: 1, args: ['--validate-only', 'signed/app.pkg'] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, ['stapler validate signed/app.pkg', 'stapler validate signed/app.pkg']);
});

test('every workflow staple and validate goes through the retry, and its job checks the script out', () => {
  let callers = 0;
  for (const [name, text] of workflows) {
    assert.doesNotMatch(text, /^\s*xcrun stapler (?:staple|validate) /m, `${name} calls Apple without the retry`);
    const jobs = text.split(/\n(?= {2}[a-z][\w-]*:\n)/);
    for (const job of jobs.filter((body) => body.includes('./scripts/staple-notarized.sh '))) {
      callers += job.split('./scripts/staple-notarized.sh ').length - 1;
      assert.match(job, /sparse-checkout: \|\n(?: {12}\S+\n)* {12}scripts(?:\/staple-notarized\.sh)?\n/, `${name}: a stapling job does not check the script out`);
    }
  }
  assert.equal(callers, 6, 'the app, the uninstaller and the desktop PKG, the binaries PKG, and the two desktop verify checks');
});
