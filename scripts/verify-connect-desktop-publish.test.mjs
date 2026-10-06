import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const tools = ['bash', 'jq', 'sha256sum'].every((name) => spawnSync('which', [name]).status === 0);
const VERSION = '1.2.3';
const names = {
  macos: [`anyray-connect-desktop-${VERSION}-macos-universal.pkg`, `anyray-connect-desktop-${VERSION}-macos-universal.app.tar.gz`],
  windows: [`anyray-connect-desktop-${VERSION}-windows-x64.msi`],
  linux: [`anyray-connect-desktop-${VERSION}-linux-x64.deb`, `anyray-connect-desktop-${VERSION}-linux-x64.rpm`],
};

// A fake gh keeps releases as directories; the signer and gpg are stubs, so only the script's own logic runs.
function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'publish-desktop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  const store = join(root, 'store');
  for (const dir of [join(repo, 'scripts'), bin, store]) mkdirSync(dir, { recursive: true });
  copyFileSync(new URL('./publish-desktop-release.sh', import.meta.url), join(repo, 'scripts/publish-desktop-release.sh'));
  const script = (path, body) => { writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`); chmodSync(path, 0o755); };
  script(join(repo, 'scripts/sign-gpg-artifacts.sh'), `
out="$1"; shift; mkdir -p "$out"; printf key > "$out/anyray-endpoint-signing-key.asc"
for a in "$@"; do printf sig > "$a.asc"; done`);
  writeFileSync(join(repo, 'scripts/publish-desktop-feed.mjs'), 'process.exit(0);\n');
  script(join(bin, 'gpg'), 'exit 0');
  script(join(bin, 'curl'), 'printf \'{"version":"1.2.3"}\'');
  script(join(bin, 'gh'), `
S="${store}"
case "$1 $2" in
  "api repos/x/y/releases/latest") echo connect-v1.0.0 ;;
  "release view") [ -d "$S/$3" ] ;;
  "release create") mkdir -p "$S/$3" ;;
  "release upload")
    tag="$3"; shift 3; files=()
    while [ $# -gt 0 ]; do case "$1" in --repo) shift 2 ;; --clobber) shift ;; *) files+=("$1"); shift ;; esac; done
    cp "\${files[@]}" "$S/$tag/" ;;
  "release download")
    tag="$3"; shift 3
    while [ $# -gt 0 ]; do case "$1" in --dir) dir="$2"; shift 2 ;; *) shift ;; esac; done
    cp "$S/$tag"/* "$dir"/ ;;
  *) echo "unexpected gh $*" >&2; exit 9 ;;
esac`);
  const signed = (os) => {
    const dir = join(root, 'signed', os);
    mkdirSync(dir, { recursive: true });
    for (const name of names[os]) writeFileSync(join(dir, name), name);
    return dir;
  };
  const run = (args, env = {}) => spawnSync('bash', ['scripts/publish-desktop-release.sh', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: root, REPO: 'x/y', VERSION, SOURCE_SHA: 'a'.repeat(40),
      TAG: `connect-desktop-v${VERSION}-aaaaaaaaaaaa`, FEED: 'connect-desktop', ARTIFACT: 'anyray-connect-desktop',
      GH_TOKEN: 'synthetic', MIN_VERSION: '1.0.0', ...env },
  });
  const manifest = () => JSON.parse(readFileSync(join(repo, 'assets/connect-desktop.json'), 'utf8'));
  return { run, signed, manifest, store, tag: `connect-desktop-v${VERSION}-aaaaaaaaaaaa` };
}

describe('desktop per-OS publication', { skip: !tools && 'needs bash, jq and sha256sum' }, () => {
  test('a partial set publishes what it has and carries no minVersion', (t) => {
    const s = sandbox(t);
    const result = s.run([s.signed('macos')]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(s.manifest().minVersion, undefined);
    assert.ok(s.manifest().artifacts.some(({ name }) => name.endsWith('-macos-universal.pkg')));
    assert.ok(!s.manifest().artifacts.some(({ name }) => name.endsWith('.msi')));
    assert.ok(readdirSync(join(s.store, s.tag)).includes('connect-desktop.json.asc'));
  });

  test('--require-all fails naming the missing OS, and still rewrites the feed', (t) => {
    const s = sandbox(t);
    assert.equal(s.run([s.signed('macos')]).status, 0);
    assert.equal(s.run([s.signed('linux')]).status, 0);
    const result = s.run(['--require-all']);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /missing: windows/);
    assert.deepEqual(s.manifest().artifacts.some(({ name }) => name.endsWith('-linux-x64.deb')), true);
  });

  test('minVersion appears only once every OS is on the release', (t) => {
    const s = sandbox(t);
    for (const os of ['macos', 'linux']) assert.equal(s.run([s.signed(os)]).status, 0);
    assert.equal(s.manifest().minVersion, undefined);
    assert.equal(s.run([s.signed('windows')]).status, 0);
    assert.equal(s.manifest().minVersion, '1.0.0');
    assert.equal(s.run(['--require-all']).status, 0);
  });

  test('reconcile with nothing ever published fails instead of creating an empty release', (t) => {
    const s = sandbox(t);
    const result = s.run(['--require-all']);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /never created/);
  });
});
