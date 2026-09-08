import { spawnSync } from 'node:child_process';
import { delimiter, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Tauri spawns cargo by name. Changing rustup's default does not replace a
// standalone Cargo earlier on a runner's PATH. Pin the actual child process PATH.
export function runDesktopTauri(args, { env = process.env, spawn = spawnSync } = {}) {
  const version = env.RUST_TOOLCHAIN;
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('RUST_TOOLCHAIN must be an exact version');
  if (!args.length) throw new Error('Expected the installed Tauri JavaScript entrypoint and arguments');
  const found = spawn('rustup', ['which', '--toolchain', version, 'cargo'], { env, encoding: 'utf8' });
  if (found.error || found.status !== 0 || !found.stdout?.trim()) throw new Error('Cannot locate pinned Cargo with rustup');
  const childEnv = { ...env, RUSTUP_TOOLCHAIN: version };
  // Windows environment names are case-insensitive; never leave both Path/PATH.
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  for (const key of Object.keys(childEnv)) if (key.toLowerCase() === 'path') delete childEnv[key];
  childEnv[pathKey] = `${dirname(found.stdout.trim())}${delimiter}${env[pathKey] ?? ''}`;
  for (const tool of ['cargo', 'rustc']) {
    const checked = spawn(tool, ['--version'], { env: childEnv, encoding: 'utf8' });
    if (checked.error || checked.status !== 0 || checked.stdout?.trim().split(/\s+/)[1] !== version) {
      throw new Error(`${tool} does not resolve to pinned Rust ${version}`);
    }
  }
  const result = spawn(process.execPath, args, { env: childEnv, stdio: 'inherit' });
  if (result.error || result.status === null) throw new Error('Could not execute the Tauri CLI');
  return result.status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runDesktopTauri(process.argv.slice(2));
}
