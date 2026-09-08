import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareMsi } from './prepare-desktop-msi.mjs';

function fixture(marker = '__TAURI_BUNDLE_TYPE_VAR_UNK') {
  const bytes = Buffer.alloc(512);
  bytes.write('MZ');
  bytes.writeUInt32LE(64, 60);
  bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(240, 84);
  bytes.writeUInt16LE(0x20b, 88);
  bytes.writeUInt32LE(16, 196);
  bytes.write(marker, 350);
  return bytes;
}
test('prepares MSI before signing and leaves subsequent bundler input unchanged', () => {
  const before = fixture();
  const prepared = prepareMsi(before);
  assert.equal(prepared.length, before.length);
  assert.deepEqual(prepared.subarray(0, 350), before.subarray(0, 350));
  assert.deepEqual(prepared.subarray(350 + Buffer.byteLength('__TAURI_BUNDLE_TYPE_VAR_UNK')), before.subarray(350 + Buffer.byteLength('__TAURI_BUNDLE_TYPE_VAR_UNK')));
  assert.equal(prepared.indexOf('__TAURI_BUNDLE_TYPE_VAR_UNK'), -1);
  // Simulate a certificate directory added by signing. Check mode is read-only.
  prepared.writeUInt32LE(512, 232);
  prepared.writeUInt32LE(128, 236);
  assert.deepEqual(prepareMsi(prepared, true), prepared);
});
test('refuses signed inputs before any modification', () => {
  const bytes = fixture();
  bytes.writeUInt32LE(512, 232);
  assert.throws(() => prepareMsi(bytes), /already-signed/);
});
for (const marker of ['', '__TAURI_BUNDLE_TYPE_VAR_MSI', '__TAURI_BUNDLE_TYPE_VAR_UNK__TAURI_BUNDLE_TYPE_VAR_UNK']) {
  test(`rejects missing or ambiguous unsigned marker: ${marker}`, () => {
    assert.throws(() => prepareMsi(fixture(marker)), /exactly one unpatched/);
  });
}
test('rejects unprepared signed handoff and malformed executables', () => {
  assert.throws(() => prepareMsi(fixture(), true), /no unpatched/);
  assert.throws(() => prepareMsi(Buffer.from('not a PE')), /PE executable/);
  const bytes = fixture();
  bytes.writeUInt32LE(0xffffffff, 60);
  assert.throws(() => prepareMsi(bytes), /PE header/);
});
