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

// A fake xcrun whose `stapler staple` fails the first `fails` calls with the hosted runner's
// Error 68, and logs every call so the test can count them.
function run(fails, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'staple-'));
  try {
    const log = join(dir, 'calls');
    const count = join(dir, 'count');
    writeFileSync(count, '0');
    writeFileSync(
      join(dir, 'xcrun'),
      `#!/usr/bin/env bash
echo "$*" >> '${log}'
if [ "$2" = staple ]; then
  n=$(( $(cat '${count}') + 1 )); echo "$n" > '${count}'
  if [ "$n" -le ${fails} ]; then echo 'The staple and validate action failed! Error 68.' >&2; exit 68; fi
fi
exit 0
`
    );
    chmodSync(join(dir, 'xcrun'), 0o755);
    const result = spawnSync('bash', [script, 'out/app.pkg'], {
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

test('every workflow staple goes through the retry, and its job checks the script out', () => {
  let callers = 0;
  for (const [name, text] of workflows) {
    assert.doesNotMatch(text, /^\s*xcrun stapler staple /m, `${name} staples without the retry`);
    const jobs = text.split(/\n(?= {2}[a-z][\w-]*:\n)/);
    for (const job of jobs.filter((body) => body.includes('./scripts/staple-notarized.sh '))) {
      callers += job.split('./scripts/staple-notarized.sh ').length - 1;
      assert.match(job, /sparse-checkout: \|\n(?: {12}\S+\n)* {12}scripts\/staple-notarized\.sh\n/, `${name}: a stapling job does not check the script out`);
    }
  }
  assert.equal(callers, 4, 'the app, the uninstaller and the desktop PKG, and the binaries PKG');
});
