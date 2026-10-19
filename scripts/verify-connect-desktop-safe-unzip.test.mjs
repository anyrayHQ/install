import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const bash = existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const script = fileURLToPath(new URL('./safe-unzip.sh', import.meta.url));
const read = (file) => readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');

function jobs(text) {
  const body = text.slice(text.indexOf('\njobs:\n'));
  const headers = [...body.matchAll(/^  ([a-z0-9-]+):\n/gm)];
  return Object.fromEntries(headers.map((match, i) => [
    match[1], body.slice(match.index + match[0].length, headers[i + 1]?.index),
  ]));
}

function field(body, key, indent = 4) {
  const prefix = `${' '.repeat(indent)}${key}: `;
  return body.split('\n').find((line) => line.startsWith(prefix))?.slice(prefix.length);
}

function steps(body) {
  return body.slice(body.indexOf('    steps:\n')).split('\n      - ').slice(1)
    .map((step) => `        ${step}`);
}

function stepRun(step) {
  const run = field(step, 'run', 8);
  if (run !== '|') return run ?? '';
  const lines = step.slice(step.indexOf('        run: |\n') + '        run: |\n'.length).split('\n');
  const end = lines.findIndex((line) => line.trim() && !line.startsWith('          '));
  return lines.slice(0, end === -1 ? undefined : end).join('\n').replace(/^ {10}/gm, '').trimEnd();
}

function tree(t) {
  const dir = mkdtempSync(join(tmpdir(), 'safe-unzip-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function command(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result;
}

function archive(dir, entries) {
  const path = join(dir, 'input.zip');
  command('python3', ['-I', '-c', `import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as archive:
    for entry in json.loads(sys.argv[2]):
        info = zipfile.ZipInfo(entry['name'])
        info.create_system = entry.get('host', 3)
        info.external_attr = entry.get('mode', 0o100644) << 16
        archive.writestr(info, entry.get('data', 'file'))
`, path, JSON.stringify(entries)]);
  return path;
}

const benign = [
  { name: 'Fake.app/', mode: 0o40755, data: '' },
  { name: 'Fake.app/Contents/', mode: 0o40755, data: '' },
  { name: 'Fake.app/Contents/Info.plist', mode: 0o100644 },
  { name: 'Fake.app/Contents/._Info.plist', mode: 0o100644 },
  { name: 'Fake.app/Contents/MacOS/', mode: 0o40755, data: '' },
  { name: 'Fake.app/Contents/MacOS/fake', mode: 0o100755 },
];
const malicious = [
  ['symlink', { name: 'X.app/Contents/MacOS/anyray-connect', mode: 0o120777, data: '../../victim' }],
  ['parent path', { name: '../escaped' }],
  ['nested parent path', { name: 'X.app/../../escaped' }],
  ['final parent component', { name: 'X.app/..' }],
  ['absolute path', { name: '/etc/escaped' }],
  ['backslash', { name: 'X.app/evil\\entry' }],
  ['newline', { name: 'X.app/evil\nentry' }],
  ['tab', { name: 'X.app/evil\tentry' }],
  ['untyped file', { name: 'X.app/untyped', mode: 0o600 }],
  ['setuid file', { name: 'X.app/setuid', mode: 0o104755 }],
  ['non-Unix host', { name: 'X.app/dos-entry', host: 0 }],
  ['empty archive', null],
  ['non-zip file', null],
];

function badArchive(dir, kind, entry) {
  const path = archive(dir, entry ? [entry] : []);
  if (kind === 'non-zip file') writeFileSync(path, 'not a zip');
  return path;
}

function run(args) {
  const result = spawnSync(bash, [script, ...args], { encoding: 'utf8', timeout: 10_000 });
  return { ...result, log: result.stdout + result.stderr };
}

test('check accepts a ditto-shaped Unix app archive with xattr sidecars', (t) => {
  const result = run(['check', archive(tree(t), benign)]);
  assert.equal(result.status, 0, result.log);
  assert.equal(statSync(script).mode & 0o777, 0o755);
});

for (const [kind, entry] of malicious) {
  test(`check refuses ${kind} without logging the entry name`, (t) => {
    const result = run(['check', badArchive(tree(t), kind, entry)]);
    assert.equal(result.status, 1, result.log);
    assert.match(result.log, /::error::.*check/);
    if (entry) assert.ok(!result.log.includes(entry.name), 'archive entry name leaked');
  });
}

for (const kind of ['plain tree', 'symlink', 'FIFO', 'hard link', 'symlinked root', 'missing root']) {
  test(`verify-tree ${kind === 'plain tree' ? 'accepts' : 'refuses'} ${kind}`, (t) => {
    const root = tree(t);
    let dir = join(root, 'expanded');
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'nested/file'), 'file');
    if (kind === 'symlink') symlinkSync(join(root, 'victim'), join(dir, 'link'));
    if (kind === 'FIFO') command('mkfifo', [join(dir, 'fifo')]);
    if (kind === 'hard link') linkSync(join(dir, 'nested/file'), join(root, 'outside-link'));
    if (kind === 'symlinked root') {
      symlinkSync(dir, join(root, 'root-link'));
      dir = join(root, 'root-link');
    }
    if (kind === 'missing root') dir = join(root, 'absent');
    const result = run(['verify-tree', dir]);
    assert.equal(result.status, kind === 'plain tree' ? 0 : 1, result.log);
    if (kind !== 'plain tree') assert.match(result.log, /::error::.*check/);
  });
}

if (process.platform === 'darwin') {
  test('extract sandboxes a real ditto archive and preserves its file and xattr', (t) => {
    const root = tree(t);
    const app = join(root, 'Fake.app');
    mkdirSync(join(app, 'Contents'), { recursive: true });
    const file = join(app, 'Contents/Info.plist');
    writeFileSync(file, 'benign');
    command('xattr', ['-w', 'com.anyray.safe-unzip-test', 'preserved', file]);
    const zip = join(root, 'ditto.zip');
    command('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
    const dest = join(root, 'expanded');
    const result = run(['extract', zip, dest]);
    assert.equal(result.status, 0, result.log);
    const extracted = join(dest, 'Fake.app/Contents/Info.plist');
    assert.equal(readFileSync(extracted, 'utf8'), 'benign');
    assert.equal(command('xattr', ['-p', 'com.anyray.safe-unzip-test', extracted]).stdout.trim(), 'preserved');
  });

  for (const [kind, entry] of malicious) {
    test(`extract refuses ${kind} before writing a destination or an outside victim`, (t) => {
      const root = tree(t);
      const zip = badArchive(root, kind, entry);
      const victim = join(root, 'victim');
      writeFileSync(victim, 'untouched');
      writeFileSync(join(root, 'escaped'), 'untouched');
      const dest = join(root, 'expanded');
      const result = run(['extract', zip, dest]);
      assert.equal(result.status, 1, result.log);
      assert.match(result.log, /::error::.*check/);
      if (existsSync(dest)) assert.deepEqual(readdirSync(dest), []);
      for (const path of [victim, join(root, 'escaped')]) assert.equal(readFileSync(path, 'utf8'), 'untouched');
      if (entry) assert.ok(!result.log.includes(entry.name), 'archive entry name leaked');
    });
  }

  test('extract refuses an existing destination', (t) => {
    const root = tree(t);
    const dest = join(root, 'existing');
    mkdirSync(dest);
    const result = run(['extract', archive(root, benign), dest]);
    assert.equal(result.status, 1, result.log);
    assert.match(result.log, /::error::.*destination.*check/);
    assert.deepEqual(readdirSync(dest), []);
  });
} else {
  test('extract fails on other operating systems naming macOS', (t) => {
    const root = tree(t);
    const result = run(['extract', archive(root, benign), join(root, 'expanded')]);
    assert.equal(result.status, 1, result.log);
    assert.match(result.log, /::error::.*macOS/);
  });
}

// The name checks run in two layers, shell and python. Stubbing one tool on PATH proves the
// other layer refuses on its own, so removing either is a red test, not a silent gap.
function runWithStubs(t, args, stubs) {
  const bin = join(tree(t), 'bin');
  mkdirSync(bin);
  for (const [name, body] of Object.entries(stubs)) writeFileSync(join(bin, name), body, { mode: 0o755 });
  const result = spawnSync(bash, [script, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { ...result, log: result.stdout + result.stderr };
}

const PASSING_PYTHON = '#!/bin/sh\nexit 0\n';

for (const [kind, name] of [
  ['parent path', '../escaped'], ['nested parent path', 'X.app/../../escaped'],
  ['final parent component', 'X.app/..'], ['absolute path', '/etc/escaped'], ['backslash', 'X.app/evil\\entry'],
]) {
  test(`the shell name layer alone refuses ${kind}`, (t) => {
    const zip = archive(tree(t), [{ name }]);
    const result = runWithStubs(t, ['check', zip], { python3: PASSING_PYTHON });
    assert.equal(result.status, 1, result.log);
    assert.match(result.log, /::error::archive entry path check failed/);
  });
}

test('a zipinfo that prints a raw newline in a name fails the name line count', (t) => {
  // Info-ZIP's zipinfo escapes control bytes (^J), but a build that does not would turn one
  // entry into two listed names; the count check is what refuses that zipinfo.
  const zip = archive(tree(t), [{ name: 'X.app/ok' }]);
  const zipinfo = `#!/bin/sh
case "$1" in
  -1) printf 'X.app/evil\\nentry\\n' ;;
  -t) printf '1 file, 1 bytes uncompressed, 1 bytes compressed:  0.0%%\\n' ;;
  *) printf 'Archive:  x\\nZip file size: 1 bytes, number of entries: 1\\n-rw-r--r--  2.0 unx        1 b- stor 26-Oct-19 19:51 X.app/ok\\n1 file\\n' ;;
esac
`;
  const result = runWithStubs(t, ['check', zip], { python3: PASSING_PYTHON, zipinfo });
  assert.equal(result.status, 1, result.log);
  assert.match(result.log, /::error::archive name line count check failed/);
});

test('extract runs ditto only inside the sandbox and verifies the tree after it', () => {
  // No archive that passes check is known to escape, so neither second layer is reachable
  // from a black-box test; pin the wiring instead.
  const source = readFileSync(script, 'utf8');
  const body = source.slice(source.indexOf('extract() ('), source.indexOf('\n)\n', source.indexOf('extract() (')));
  const dittoLines = body.split('\n').filter((line) => /\bditto\s+-x\b/.test(line) && !line.trimStart().startsWith('#'));
  assert.equal(dittoLines.length, 1, 'extract must run ditto -x exactly once');
  assert.match(dittoLines[0], /^\s*\/usr\/bin\/sandbox-exec -p "\$profile" \/usr\/bin\/ditto -x -k "\$zip" "\$dest" .*\|\| fail /);
  assert.match(body, /profile="\(version 1\)\(allow default\)\(deny file-write\* \(require-not \(subpath \\"\$escaped\\"\)\)\)/);
  const lines = body.split('\n').map((line) => line.trim());
  const ditto = lines.findIndex((line) => line.startsWith('/usr/bin/sandbox-exec'));
  assert.equal(lines[ditto + 1], 'verify_tree "$dest"', 'the tree check must follow the extraction');
});

test('safe-unzip usage errors exit 2', () => {
  for (const args of [[], ['unknown'], ['check'], ['check', 'a', 'b'], ['extract', 'a'], ['verify-tree'], ['verify-tree', 'a', 'b']]) {
    assert.equal(run(args).status, 2, args.join(' '));
  }
});

const unsafeExtraction = /\b(?:ditto\s+-x|unzip\b|tar\s+-x\S*|bsdtar\b|pkgutil\s+--expand\S*)/;

test('desktop signing uses checked sandbox extraction before codesign and checks the tree before packaging', () => {
  const body = jobs(read('release-connect-desktop.yml'))['sign-macos'];
  const all = steps(body);
  const runs = all.map(stepRun);
  // Match commands, so safe-unzip.sh is not mistaken for an unzip invocation.
  for (const run of runs) assert.doesNotMatch(run.replace(/safe-unzip\.sh/g, 'safe-script'), unsafeExtraction);
  const signing = runs[all.findIndex((s) => field(s, 'name', 8) === 'Sign, notarize, and staple the app')];
  const extract = signing.indexOf('./scripts/safe-unzip.sh extract unsigned/connect-desktop-unsigned.zip expanded');
  assert.ok(extract > signing.indexOf('rm -rf expanded') && signing.indexOf('rm -rf expanded') >= 0);
  assert.ok(extract < signing.indexOf('codesign --force'));
  assert.match(signing, /mkdir -p out\n/);
  assert.match(signing, /#.*build-controlled.*signing account.*script/i);
  for (const name of ['Package the updater bundle', 'Build and sign the macOS installer (Developer ID Installer)']) {
    const run = runs[all.findIndex((s) => field(s, 'name', 8) === name)];
    assert.match(run, /^set -euo pipefail\n\.\/scripts\/safe-unzip.sh verify-tree expanded\n/);
  }
  const checkout = all.find((s) => (field(s, 'uses', 8) ?? '').startsWith('actions/checkout@'));
  for (const name of ['artifact-digest', 'safe-unzip']) assert.ok(checkout.includes(`            scripts/${name}.sh\n`));
});

test('every SIGN job refuses to extract downloaded build archives', () => {
  for (const [file, id] of [['release-connect-desktop.yml', 'sign-macos'], ['release-connect-binaries.yml', 'sign-macos'], ['release-fleetd-installer.yml', 'build-macos']]) {
    const body = jobs(read(file))[id];
    assert.match(field(body, 'runs-on'), /"anyray-install-mac"/);
    const all = steps(body);
    const downloads = all.filter((s) => field(s, 'uses', 8) === './.github/actions/s3-artifact-download');
    const roots = downloads.map((s) => field(s, 'path', 10));
    for (const run of all.map(stepRun)) {
      for (const line of run.split('\n').filter((line) => !line.trimStart().startsWith('#') && unsafeExtraction.test(line.replace(/safe-unzip\.sh/g, 'safe-script')))) {
        assert.equal(file, 'release-fleetd-installer.yml', `${file}:${id} extracts a build archive`);
        // fleetd extracts its checksum-pinned fleetctl or packages that fleetctl just built.
        assert.match(line.trim(), /^(?:tar -xzf "\$RUNNER_TEMP\/fleetctl.tar.gz" -C "\$RUNNER_TEMP"|tar -x[fO]|pkgutil --expand(?:-full)? fleetd.pkg)/);
        for (const root of roots) assert.ok(!line.includes(`${root}/`), 'downloaded artifact extraction');
      }
    }
    if (file === 'release-fleetd-installer.yml') {
      assert.equal(roots.length, 0, 'fleetd must not download build artifacts');
      const fleetctl = all.find((s) => field(s, 'dest', 10) === '${{ runner.temp }}/fleetctl.tar.gz');
      assert.equal(field(fleetctl, 'uses', 8), './.github/actions/fetch-pinned');
      assert.equal(field(fleetctl, 'sha256', 10), '${{ env.FLEETCTL_SHA256 }}');
    }
  }
});
