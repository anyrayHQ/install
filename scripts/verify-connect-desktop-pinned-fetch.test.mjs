import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const workflowsDir = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const workflowFiles = readdirSync(workflowsDir).filter((f) => f.endsWith('.yml'));

const actionPath = fileURLToPath(
  new URL('../.github/actions/fetch-pinned/action.yml', import.meta.url)
);
const action = readFileSync(actionPath, 'utf8');

const CHECKSUM_CHECK = /sha256sum -c|shasum -a 256 -c/;

// True when any curl invocation in the script writes to a file: `-o`, `-O`,
// `--output`, `--output=`, `--remote-name`, or a combined short group such as
// `-fsSLo`. Continuation lines are joined first so the flag may sit on the
// line after `curl`.
export function curlWritesFile(script) {
  const joined = script.replace(/\\\n\s*/g, ' ');
  for (const command of joined.split(/\n|&&|\|\||;|\|/)) {
    const tokens = command.trim().split(/\s+/);
    const at = tokens.indexOf('curl');
    if (at === -1) continue;
    for (const token of tokens.slice(at + 1)) {
      if (token === '--output' || token.startsWith('--output=') || token === '--remote-name') return true;
      if (/^-[A-Za-z]*[oO][A-Za-z]*$/.test(token)) return true;
    }
  }
  return false;
}

// Extracts every `run:` scalar's text (block or single-line) so the guard
// below can check each SCRIPT in isolation, not just proximity in the file.
function extractRunBlocks(content) {
  const lines = content.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const blockMatch = lines[i].match(/^(\s*)run:\s*[|>][+-]?\s*$/);
    if (blockMatch) {
      const indent = blockMatch[1].length;
      const bodyLines = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const line = lines[j];
        if (line.trim() === '') {
          bodyLines.push(line);
          continue;
        }
        const lineIndent = line.match(/^ */)[0].length;
        if (lineIndent <= indent) break;
        bodyLines.push(line);
      }
      blocks.push({ startLine: i + 1, text: bodyLines.join('\n') });
      i = j - 1;
      continue;
    }
    const inlineMatch = lines[i].match(/^\s*run:\s*(.+)$/);
    if (inlineMatch) {
      blocks.push({ startLine: i + 1, text: inlineMatch[1] });
    }
  }
  return blocks;
}

describe('every checksum-verified download goes through fetch-pinned', () => {
  for (const file of workflowFiles) {
    test(`${file} has no inline curl-download + checksum-check pair`, () => {
      const content = readFileSync(new URL(file, `file://${workflowsDir}`), 'utf8');
      for (const block of extractRunBlocks(content)) {
        const hasDownload = curlWritesFile(block.text);
        const hasChecksum = CHECKSUM_CHECK.test(block.text);
        assert.ok(
          !(hasDownload && hasChecksum),
          `${file}:${block.startLine} downloads with curl (-o/-O/--output/combined flags) and checksums inline ` +
            `instead of going through ./.github/actions/fetch-pinned`
        );
      }
    });
  }
});

describe('the fetch-pinned action itself', () => {
  test('retries transient failures over HTTPS only', () => {
    assert.match(action, /--retry-all-errors/);
    // Bounded per attempt and overall, so a stalled upstream cannot hold a runner.
    assert.match(action, /--connect-timeout 10 --max-time 120/);
    assert.match(action, /--retry 3 --retry-delay 5 --retry-max-time 180/);
    // The verified file is cached by hash; the hash is still checked on a hit.
    assert.match(action, /uses: actions\/cache\/restore@[0-9a-f]{40} # v/);
    assert.match(action, /uses: actions\/cache\/save@[0-9a-f]{40} # v/);
    assert.match(action, /key: fetch-pinned-\$\{\{ runner\.os \}\}-\$\{\{ inputs\.sha256 \}\}/);
    // A hit is checked before it is trusted; a bad entry is refetched, not fatal.
    assert.match(action, /if: steps\.cache\.outputs\.cache-hit == 'true'/);
    assert.match(action, /if: steps\.cache\.outputs\.cache-hit != 'true' \|\| steps\.restored\.outputs\.valid != 'true'/);
    // Saved only after a fresh, verified download.
    assert.match(action, /if: steps\.download\.outcome == 'success'/);
    const order = ['name: Restore from cache', 'name: Check the restored file', 'name: Download on a cache miss or a bad entry', 'name: Verify checksum and mode', 'name: Save to cache'].map((n) => action.indexOf(n));
    assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])));
    assert.match(action, /--proto '=https'/);
  });

  test('verifies a checksum and fails the step on mismatch', () => {
    assert.match(action, /sha256sum|shasum -a 256/);
    assert.match(action, /if \[ "\$actual" != "\$FETCH_SHA256" \]/);
    assert.match(action, /exit 1/);
  });

  test('refuses a non-https url', () => {
    assert.match(action, /https:\/\/\*\)/);
  });

  test('validates the sha256 input shape', () => {
    assert.match(action, /64 lowercase hex/);
  });
});

describe('the curl detector sees every output form', () => {
  test('combined short flags, continuation lines and long options are caught', () => {
    assert.ok(curlWritesFile('curl -fso x.tgz https://a/b'));
    assert.ok(curlWritesFile('curl -sSfL "https://a/b" \\\n  -o rustup-init'));
    assert.ok(curlWritesFile('curl --output=x https://a/b'));
    assert.ok(curlWritesFile('curl -fsSL --remote-name https://a/b'));
    assert.ok(curlWritesFile('set -e\ncurl -fsSLO https://a/b\necho done'));
  });
  test('a status probe that writes nothing is not a download', () => {
    assert.ok(!curlWritesFile("code=\"$(curl -sL -w '%{http_code}' https://a/b)\""));
    assert.ok(!curlWritesFile('curl -fsS https://a/b | tar -xz'));
  });
});

// The `run:` body of a named step in the action, dedented so bash can execute it.
function stepBody(name) {
  const lines = action.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(at >= 0, `step ${name} missing`);
  const runAt = lines.findIndex((l, i) => i > at && /^\s*run: \|/.test(l));
  const indent = lines[runAt].match(/^ */)[0].length + 2;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    if (lines[i].trim() !== '' && lines[i].match(/^ */)[0].length < indent) break;
    body.push(lines[i].slice(indent));
  }
  return body.join('\n');
}

function runStep(name, env) {
  const dir = mkdtempSync(join(tmpdir(), 'fetch-pinned-'));
  const out = join(dir, 'output');
  writeFileSync(out, '');
  const result = spawnSync('bash', ['-c', stepBody(name)], {
    encoding: 'utf8',
    env: { ...process.env, ...env, GITHUB_OUTPUT: out },
  });
  const outputs = readFileSync(out, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return { ...result, outputs };
}

describe('fetch-pinned step bodies behave (executed, not pattern-matched)', () => {
  const sha0 = '0'.repeat(64);
  test('a missing restored file is an invalid entry, not a job failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fetch-pinned-'));
    const r = runStep('Check the restored file', { FETCH_SHA256: sha0, FETCH_DEST: join(dir, 'absent') });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.outputs, /valid=false/);
  });
  test('a restored file with the wrong hash is removed and marked invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fetch-pinned-'));
    const dest = join(dir, 'tool');
    writeFileSync(dest, 'stale bytes');
    const r = runStep('Check the restored file', { FETCH_SHA256: sha0, FETCH_DEST: dest });
    const gone = !readdirSync(dir).includes('tool');
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.outputs, /valid=false/);
    assert.ok(gone);
  });
  test('a restored file with the right hash is valid and kept', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fetch-pinned-'));
    const dest = join(dir, 'tool');
    writeFileSync(dest, 'known bytes\n');
    const sha = spawnSync('shasum', ['-a', '256', dest], { encoding: 'utf8' }).stdout.split(' ')[0];
    const r = runStep('Check the restored file', { FETCH_SHA256: sha, FETCH_DEST: dest });
    const kept = readdirSync(dir).includes('tool');
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.outputs, /valid=true/);
    assert.ok(kept);
  });
  test('verification after download fails loudly and removes a mismatching file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fetch-pinned-'));
    const dest = join(dir, 'tool');
    writeFileSync(dest, 'wrong bytes');
    const r = runStep('Verify checksum and mode', { FETCH_URL: 'https://example.invalid/x', FETCH_SHA256: sha0, FETCH_DEST: dest, FETCH_MODE: '' });
    const gone = !readdirSync(dir).includes('tool');
    rmSync(dir, { recursive: true, force: true });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /checksum mismatch/);
    assert.ok(gone);
  });
  test('the download step refuses a non-https url and a malformed hash before any fetch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fetch-pinned-'));
    const http = runStep('Download on a cache miss or a bad entry', { FETCH_URL: 'http://example.invalid/x', FETCH_SHA256: sha0, FETCH_DEST: join(dir, 'x'), FETCH_MODE: '' });
    const badSha = runStep('Download on a cache miss or a bad entry', { FETCH_URL: 'https://example.invalid/x', FETCH_SHA256: 'ABC', FETCH_DEST: join(dir, 'x'), FETCH_MODE: '' });
    rmSync(dir, { recursive: true, force: true });
    assert.notEqual(http.status, 0);
    assert.match(http.stdout + http.stderr, /refuses a non-https url/);
    assert.notEqual(badSha.status, 0);
    assert.match(badSha.stdout + badSha.stderr, /64 lowercase hex/);
  });
});
