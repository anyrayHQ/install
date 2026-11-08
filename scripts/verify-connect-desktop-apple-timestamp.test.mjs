import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const script = new URL('./apple-timestamp-retry.sh', import.meta.url).pathname;
const workflows = ['release-connect-desktop.yml', 'release-connect-binaries.yml'].map((name) => [
  name,
  readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'),
]);

// Apple's own wording, from the productsign that cost connect 0.11.602 its macOS desktop.
const TIMESTAMP_DOWN = 'CMS signature encoding failed: The timestamp service is not available. (-67885)';

// A fake signer that fails its first `fails` calls with `message`, logs every call, and, given an
// output path, refuses to run over a file a failed attempt left behind (as a re-sign would).
function run(fails, { message = TIMESTAMP_DOWN, remove = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'apple-ts-'));
  try {
    const log = join(dir, 'calls');
    const out = join(dir, 'signed.pkg');
    writeFileSync(join(dir, 'count'), '0');
    writeFileSync(
      join(dir, 'fakesign'),
      `#!/usr/bin/env bash
echo "$*" >> '${log}'
if [ -e '${out}' ]; then echo "destination exists" >&2; exit 9; fi
n=$(( $(cat '${dir}/count') + 1 )); echo "$n" > '${dir}/count'
if [ "$n" -le ${fails} ]; then echo partial > '${out}'; echo "${message}" >&2; exit 1; fi
echo signed > '${out}'
exit 0
`
    );
    chmodSync(join(dir, 'fakesign'), 0o755);
    const args = remove ? ['--remove', out, 'fakesign', '--sign', 'X'] : ['fakesign', '--sign', 'X'];
    const result = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, APPLE_TIMESTAMP_RETRY_SLEEP: '0' },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    return { status: result.status, output: `${result.stdout}${result.stderr}`, calls, signed: existsSync(out) && readFileSync(out, 'utf8').trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a timestamp outage is retried until the signature lands', () => {
  const result = run(2, { remove: true });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.calls.length, 3);
  assert.equal(result.signed, 'signed');
  assert.match(result.output, /::warning::Apple's timestamp service did not answer 'fakesign' \(try 1 of 4\)/);
});

test('a partial output from a failed attempt is removed before the retry', () => {
  // Without --remove the second attempt meets the partial file and fails on it, not on Apple.
  const kept = run(1);
  assert.equal(kept.status, 9, kept.output);
  assert.equal(kept.calls.length, 2);
  const removed = run(1, { remove: true });
  assert.equal(removed.status, 0, removed.output);
  assert.equal(removed.signed, 'signed');
});

test('it gives up after four tries and keeps the signer\'s status', () => {
  const result = run(10, { remove: true });
  assert.equal(result.status, 1, result.output);
  assert.equal(result.calls.length, 4);
  assert.match(result.output, /::error::Apple's timestamp service did not answer 'fakesign' 4 times/);
});

test('any other signing failure fails at once, unretried', () => {
  const result = run(10, { message: 'error: The specified item could not be found in the keychain.', remove: true });
  assert.equal(result.status, 1, result.output);
  assert.equal(result.calls.length, 1);
  assert.doesNotMatch(result.output, /retrying/);
  assert.match(result.output, /could not be found in the keychain/);
});

test('every timestamped codesign and every productsign goes through the retry, and its job checks the script out', () => {
  let callers = 0;
  for (const [name, text] of workflows) {
    assert.doesNotMatch(text, /^\s*codesign --force [^\n]*--timestamp/m, `${name} signs with a timestamp without the retry`);
    assert.doesNotMatch(text, /^\s*productsign /m, `${name} calls productsign without the retry`);
    const jobs = text.split(/\n(?= {2}[a-z][\w-]*:\n)/);
    for (const job of jobs.filter((body) => body.includes('./scripts/apple-timestamp-retry.sh '))) {
      callers += job.split('./scripts/apple-timestamp-retry.sh ').length - 1;
      assert.match(job, /sparse-checkout: \|\n(?: {12}\S+\n)* {12}scripts(?:\/apple-timestamp-retry\.sh)?\n/, `${name}: a signing job does not check the retry out`);
    }
  }
  assert.equal(callers, 7, 'desktop: engine, app, uninstaller, PKG; binaries: each darwin binary, the universal binary, the PKG');
});
