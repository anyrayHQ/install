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

const CURL_DOWNLOAD = /curl\b[^\n]*(?:-o\s|--output(?:\s|=))/;
const CHECKSUM_CHECK = /sha256sum -c|shasum -a 256 -c/;

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
        const hasDownload = CURL_DOWNLOAD.test(block.text);
        const hasChecksum = CHECKSUM_CHECK.test(block.text);
        assert.ok(
          !(hasDownload && hasChecksum),
          `${file}:${block.startLine} downloads with curl -o/--output and checksums inline ` +
            `instead of going through ./.github/actions/fetch-pinned`
        );
      }
    });
  }
});

describe('the fetch-pinned action itself', () => {
  test('retries transient failures over HTTPS only', () => {
    assert.match(action, /--retry-all-errors/);
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
