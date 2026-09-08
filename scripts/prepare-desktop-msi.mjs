import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const unknown = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
const msi = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_MSI');

// Tauri bundler 2.9.4 (CLI 2.11.4) patches UNK before packaging and restores
// its input afterward. Set MSI while unsigned so packaging cannot invalidate
// Authenticode. Fail closed if a future Tauri version changes this contract.
export function prepareMsi(bytes, checkOnly = false) {
  const data = Buffer.from(bytes);
  if (data.length < 64 || data.toString('ascii', 0, 2) !== 'MZ') throw new Error('expected a PE executable');
  const pe = data.readUInt32LE(60);
  if (pe + 24 > data.length || data.readUInt32LE(pe) !== 0x4550) throw new Error('invalid PE header');
  const optional = pe + 24;
  const size = data.readUInt16LE(pe + 20);
  if (size < 152 || optional + size > data.length || data.readUInt16LE(optional) !== 0x20b) {
    throw new Error('expected a PE32+ optional header');
  }
  if (data.readUInt32LE(optional + 108) < 5) throw new Error('missing PE certificate directory');
  if (!checkOnly && (data.readUInt32LE(optional + 144) || data.readUInt32LE(optional + 148))) {
    throw new Error('refusing to patch an already-signed executable');
  }
  const index = data.indexOf(unknown);
  if (checkOnly) {
    if (index !== -1 || data.indexOf(msi) === -1 || data.indexOf(msi, data.indexOf(msi) + 1) !== -1) {
      throw new Error('expected exactly one MSI marker and no unpatched bundle marker');
    }
  } else {
    if (index === -1 || data.indexOf(unknown, index + 1) !== -1 || data.indexOf(msi) !== -1) {
      throw new Error('expected exactly one unpatched Tauri bundle marker');
    }
    msi.copy(data, index);
  }
  return data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [path, mode] = process.argv.slice(2);
    if (!path || !['--prepare', '--check'].includes(mode) || process.argv.length !== 4) {
      throw new Error('usage: prepare-desktop-msi.mjs <exe> <--prepare|--check>');
    }
    const prepared = prepareMsi(readFileSync(path), mode === '--check');
    if (mode === '--prepare') writeFileSync(path, prepared);
    console.log(`Desktop MSI bundle marker ${mode === '--check' ? 'verified' : 'prepared before signing'}`);
  } catch (error) {
    console.error(`::error::Desktop MSI preparation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
