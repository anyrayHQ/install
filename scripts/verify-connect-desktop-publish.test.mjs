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
  // Release assets are files in store/<tag>; store/<tag>/.state/<name> marks a non-uploaded asset and
  // .nodigest makes the listing omit digests, as an older API would.
  script(join(bin, 'gh'), `
S="${store}"
case "$1 $2" in
  "api repos/x/y/releases/latest") echo connect-v1.0.0 ;;
  "api repos/x/y/releases/tags/"*) echo 1 ;;
  "api --paginate")
    tag="$(ls "$S" | head -1)"
    for f in "$S/$tag"/*; do
      [ -f "$f" ] || continue
      n="$(basename "$f")"; state=uploaded; [ -f "$S/$tag/.state/$n" ] && state="$(cat "$S/$tag/.state/$n")"
      digest="sha256:$(sha256sum "$f" | cut -d' ' -f1)"; [ -f "$S/$tag/.nodigest" ] && digest=""
      printf '%s\t%s\t%s\t%s\n' "$n" "$n" "$state" "$digest"
    done ;;
  "api -X") tag="$(ls "$S" | head -1)"; rm -f "$S/$tag/${'$'}{4##*/}" "$S/$tag/.state/${'$'}{4##*/}" ;;
  "release view") [ -d "$S/$3" ] ;;
  "release create") mkdir -p "$S/$3" ;;
  "release upload")
    tag="$3"; shift 3; files=(); clobber=0
    while [ $# -gt 0 ]; do case "$1" in --repo) shift 2 ;; --clobber) clobber=1; shift ;; *) files+=("$1"); shift ;; esac; done
    for f in "${'$'}{files[@]}"; do
      [ "$clobber" = 1 ] || [ ! -e "$S/$tag/$(basename "$f")" ] || { echo "422 already exists" >&2; exit 1; }
      echo "$(basename "$f")" >> "$S/uploads.log"
    done
    cp "${'$'}{files[@]}" "$S/$tag/" ;;
  "release download")
    tag="$3"; shift 3; pattern='*'
    while [ $# -gt 0 ]; do case "$1" in --dir) dir="$2"; shift 2 ;; --pattern) pattern="$2"; shift 2 ;; *) shift ;; esac; done
    mkdir -p "$dir"; for f in "$S/$tag"/$pattern; do [ -f "$f" ] && cp "$f" "$dir"/; done ;;
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
  const uploads = () => { try { return readFileSync(join(store, 'uploads.log'), 'utf8').trim().split('\n'); } catch { return []; } };
  return { run, signed, manifest, store, uploads, repo, tag: `connect-desktop-v${VERSION}-aaaaaaaaaaaa` };
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

  test('republishing the same bytes uploads no installer again', (t) => {
    const s = sandbox(t);
    const dir = s.signed('macos');
    assert.equal(s.run([dir]).status, 0);
    const first = s.uploads().filter((n) => n.endsWith('.pkg')).length;
    assert.equal(s.run([dir]).status, 0);
    assert.equal(s.uploads().filter((n) => n.endsWith('.pkg')).length, first);
  });

  test('a published installer with different bytes is refused, named, and left alone', (t) => {
    const s = sandbox(t);
    const dir = s.signed('macos');
    assert.equal(s.run([dir]).status, 0);
    const pkg = names.macos[0];
    writeFileSync(join(dir, pkg), 'rebuilt bytes');
    const result = s.run([dir]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, new RegExp(`${pkg} is already published .* different bytes`));
    assert.equal(readFileSync(join(s.store, s.tag, pkg), 'utf8'), pkg);
  });

  test('without a digest in the API the published bytes are downloaded and compared', (t) => {
    const s = sandbox(t);
    const dir = s.signed('macos');
    assert.equal(s.run([dir]).status, 0);
    writeFileSync(join(s.store, s.tag, '.nodigest'), '');
    assert.equal(s.run([dir]).status, 0);
    writeFileSync(join(dir, names.macos[0]), 'rebuilt bytes');
    assert.notEqual(s.run([dir]).status, 0);
  });

  test('a half-uploaded asset is deleted and sent again', (t) => {
    const s = sandbox(t);
    const dir = s.signed('macos');
    assert.equal(s.run([dir]).status, 0);
    const pkg = names.macos[0];
    mkdirSync(join(s.store, s.tag, '.state'), { recursive: true });
    writeFileSync(join(s.store, s.tag, '.state', pkg), 'starter');
    writeFileSync(join(s.store, s.tag, pkg), 'partial');
    assert.equal(s.run([dir]).status, 0);
    assert.equal(readFileSync(join(s.store, s.tag, pkg), 'utf8'), pkg);
  });

  test('a dry run builds the consolidated checksums and signed manifest without touching GitHub', (t) => {
    const s = sandbox(t);
    const result = s.run(['macos', 'windows', 'linux'].map((os) => s.signed(os)), { DRY_RUN: 'true' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(s.manifest().minVersion, '1.0.0');
    assert.equal(s.manifest().artifacts.length, 6);
    assert.ok(readFileSync(join(s.repo, 'assets/SHA256SUMS.asc'), 'utf8'));
    assert.deepEqual(readdirSync(s.store), [], 'no release was created');
  });
});
