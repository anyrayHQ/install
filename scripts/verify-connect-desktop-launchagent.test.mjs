import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function fixture(t, { wrongLabel = false, extraArgument = false, wrongExecutable = false, runAtLoad = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-launchagent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binary = join(dir, 'Anyray Connect');
  const alias = join(dir, 'runner-alias');
  writeFileSync(binary, 'test executable');
  symlinkSync(binary, alias);
  const other = join(dir, 'different-binary');
  writeFileSync(other, 'different');
  const xml = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  const plist = join(dir, 'agent.plist');
  writeFileSync(plist, `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>Label</key><string>${wrongLabel ? 'wrong' : 'ai.anyray.connect-tray'}</string>
    <key>RunAtLoad</key><${runAtLoad ? 'true' : 'false'}/>
    <key>ProgramArguments</key><array><string>${xml(wrongExecutable ? other : binary)}</string>${extraArgument ? '<string>--unexpected</string>' : ''}</array>
  </dict></plist>`);
  return spawnSync('python3', [fileURLToPath(new URL('./verify-desktop-launchagent.py', import.meta.url)), plist, alias], { encoding: 'utf8' });
}

test('accepts the canonical executable when the runner installed it via a symlink alias', (t) => {
  const result = fixture(t);
  assert.equal(result.status, 0, result.stderr);
});
for (const [key, message] of [['wrongLabel', /label/], ['extraArgument', /only the installed/], ['wrongExecutable', /does not resolve/], ['runAtLoad', /run at login/]]) {
  test(`rejects ${key} with an actionable failure`, (t) => {
    const result = fixture(t, { [key]: key !== 'runAtLoad' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  });
}
