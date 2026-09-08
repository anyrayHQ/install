import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, delimiter, join } from 'node:path';
import { runDesktopTauri } from './run-desktop-tauri.mjs';

const pinnedCargo = join('/toolchains', '1.98.0', 'bin', 'cargo');
test('Tauri and version probes inherit pinned binaries ahead of a stale runner PATH', () => {
  const calls = [];
  const env = { RUST_TOOLCHAIN: '1.98.0', Path: '/old-cargo/bin', OTHER_SETTING: 'preserved' };
  const result = runDesktopTauri(['tauri.js', 'build', '--', '--locked'], { env, spawn(command, args, options) {
    calls.push({ command, args, options });
    if (command === 'rustup') return { status: 0, stdout: `${pinnedCargo}\n` };
    assert.equal(options.env.Path, `${dirname(pinnedCargo)}${delimiter}/old-cargo/bin`);
    assert.equal(options.env.PATH, undefined);
    assert.equal(options.env.RUSTUP_TOOLCHAIN, '1.98.0');
    assert.equal(options.env.OTHER_SETTING, 'preserved');
    if (command === process.execPath) {
      assert.deepEqual(args, ['tauri.js', 'build', '--', '--locked']);
      return { status: 17 }; // Do not hide failures from the actual CLI.
    }
    return { status: 0, stdout: `${command} 1.98.0 (test)\n` };
  } });
  assert.equal(result, 17);
  assert.equal(calls.length, 4);
  assert.equal(env.Path, '/old-cargo/bin');
});

test('wrong Cargo fails before executing Tauri', () => {
  assert.throws(() => runDesktopTauri(['tauri.js', 'build'], {
    env: { RUST_TOOLCHAIN: '1.98.0', PATH: '/old/bin' },
    spawn(command) {
      if (command === 'rustup') return { status: 0, stdout: pinnedCargo };
      assert.equal(command, 'cargo');
      return { status: 0, stdout: 'cargo 1.84.1 (old)' };
    },
  }), /cargo does not resolve/);
});

test('missing pinned toolchain fails before executing Tauri', () => {
  assert.throws(() => runDesktopTauri(['tauri.js', 'build'], {
    env: { RUST_TOOLCHAIN: '1.98.0' }, spawn: () => ({ status: 1 }),
  }), /Cannot locate/);
});
