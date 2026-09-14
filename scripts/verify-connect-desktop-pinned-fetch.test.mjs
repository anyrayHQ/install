import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
    assert.match(action, /uses: actions\/cache@[0-9a-f]{40} # v/);
    assert.match(action, /key: fetch-pinned-\$\{\{ runner\.os \}\}-\$\{\{ inputs\.sha256 \}\}/);
    assert.match(action, /if: steps\.cache\.outputs\.cache-hit != 'true'/);
    assert.ok(action.indexOf('name: Verify checksum and mode') > action.indexOf('name: Download on a cache miss'));
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
