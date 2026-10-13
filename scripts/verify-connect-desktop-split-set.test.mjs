import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { describe, test } from 'node:test';

// The release gate needs only the CLI set, so prepare stores it as soon as the CLI is signed
// and stores the desktop set later under desktop/ with its own SHA256SUMS and notice. These
// tests run the real step scripts against a fake `aws` that maps s3:// onto a directory.

const caller = readFileSync(new URL('../.github/workflows/release-connect-binaries.yml', import.meta.url), 'utf8');

const job = (name) => {
  const marker = `\n  ${name}:\n`;
  const start = caller.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow job ${name}`);
  const bodyStart = start + marker.length;
  const next = caller.slice(bodyStart).search(/^  [a-z0-9-]+:\n/m);
  return next === -1 ? caller.slice(bodyStart) : caller.slice(bodyStart, bodyStart + next);
};

// The `run: |` block of the step named `name` (or with `id: name`), dedented.
const stepScript = (body, name) => {
  let header = body.indexOf(`\n      - name: ${name}\n`);
  if (header === -1) {
    const id = body.indexOf(`\n        id: ${name}\n`);
    header = id === -1 ? -1 : body.lastIndexOf('\n      - ', id);
  }
  assert.notEqual(header, -1, `missing step ${name}`);
  const rest = body.slice(header + 1);
  const run = rest.indexOf('        run: |\n');
  const nextStep = rest.indexOf('\n      - ', 1);
  assert.ok(run !== -1 && (nextStep === -1 || run < nextStep), `step ${name} has no run block`);
  const lines = rest.slice(run + '        run: |\n'.length).split('\n');
  const script = [];
  for (const line of lines) {
    if (line.trim() !== '' && !line.startsWith('          ')) break;
    script.push(line.slice(10));
  }
  return script.join('\n');
};

const FAKE_AWS = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.FAKE_S3;
const args = process.argv.slice(2).filter((a) => a !== '--only-show-errors');
fs.appendFileSync(path.join(root, '..', 'aws.log'), args.join(' ') + '\\n');
const local = (p) => (p.startsWith('s3://') ? path.join(root, p.slice(5)) : p);
const copy = (src, dst) => { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); };
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const [svc, op, src, dst, ...flags] = args;
if (svc !== 's3' || !['cp', 'sync'].includes(op)) { console.error('fake aws: unsupported ' + args.join(' ')); process.exit(2); }
const from = local(src);
const to = local(dst);
if (!fs.existsSync(from)) { console.error('fatal error: An error occurred (404) when calling the HeadObject operation: Not Found'); process.exit(1); }
if (op === 'sync' || flags.includes('--recursive')) {
  for (const file of walk(from)) copy(file, path.join(to, path.relative(from, file)));
} else {
  copy(from, to.endsWith('/') ? path.join(to, path.basename(from)) : to);
}
`;

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const tree = (dir) => (existsSync(dir)
  ? readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath ?? e.path, e.name)))
    .sort()
  : []);

const sandbox = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'split-set-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 's3'));
  mkdirSync(join(root, 'work'));
  mkdirSync(join(root, 'tmp'));
  writeFileSync(join(root, 'bin/aws'), FAKE_AWS, { mode: 0o755 });
  writeFileSync(join(root, 'aws.log'), '');
  return root;
};

// Each step runs in a fresh workspace, as each job does on its own runner.
let steps = 0;
const run = (root, script, env) => {
  const output = join(root, 'github_output');
  writeFileSync(output, '');
  const cwd = join(root, 'work', String(++steps));
  mkdirSync(cwd, { recursive: true });
  const result = spawnSync('bash', ['-c', script], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      FAKE_S3: join(root, 's3'),
      RUNNER_TEMP: join(root, 'tmp'),
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: join(root, 'summary'),
      GITHUB_REPOSITORY: 'anyrayHQ/install',
      GITHUB_RUN_ID: '77',
      GITHUB_RUN_ATTEMPT: '1',
      ...env,
    },
  });
  return { ...result, output: readFileSync(output, 'utf8'), log: readFileSync(join(root, 'aws.log'), 'utf8') };
};

const BUCKET = 'ci-bucket';
const SET_KEY = '1.2.3';
const VERSION = '1.2.3';
const SOURCE_SHA = 'a'.repeat(40);
const PACKAGE_SHA256 = 'b'.repeat(64);
const setPrefix = (root) => join(root, 's3', BUCKET, 'connect-sets', SET_KEY);
const runPrefix = (root) => join(root, 's3', BUCKET, 'install', '77-1');

const DESKTOP_ARTIFACTS = {
  macos: ['connect-desktop-macos-signed'],
  windows: ['connect-desktop-windows-inner-signed', 'connect-desktop-windows-installer-signed'],
  linux: ['connect-desktop-linux-signed'],
};

// What the desktop call leaves in this run's S3 artifacts for each OS that verified.
const stageDesktopArtifacts = (root, oses) => {
  for (const os of oses) {
    for (const name of DESKTOP_ARTIFACTS[os]) write(join(runPrefix(root), name, `${name}.bin`), `${name}\n`);
  }
};

const storeDesktop = (root, ok) => run(root, stepScript(job('store-desktop'), 'Store the signed desktop set'), {
  BUCKET, SET_KEY, VERSION, SOURCE_SHA, PACKAGE_SHA256,
  MACOS_OK: String(ok.macos), WINDOWS_OK: String(ok.windows), LINUX_OK: String(ok.linux),
});

describe('the CLI set is stored without waiting for the desktop', () => {
  test('store-set needs only the CLI jobs and stores no desktop file', () => {
    const store = job('store-set').split('\n').filter((line) => !line.startsWith('  #')).join('\n');
    assert.match(store, /needs: \[signing-preflight, build, sign-macos, sign-windows, package-linux\]/);
    assert.doesNotMatch(store, /needs\.desktop|connect-desktop-|MISSING/);
    assert.match(store, /inputs\.mode == 'prepare'/);
  });
});

describe('store-desktop', () => {
  test('runs in prepare after the desktop call and the CLI set, whatever the desktop outcome', () => {
    const store = job('store-desktop');
    assert.match(store, /needs: \[signing-preflight, build, store-set, desktop\]/);
    assert.match(store, /always\(\) && inputs\.mode == 'prepare' && needs\.store-set\.result == 'success' && needs\.desktop\.result != 'skipped'/);
    for (const os of ['macos', 'windows', 'linux']) {
      assert.match(store, new RegExp(`${os.toUpperCase()}_OK: \\$\\{\\{ needs\\.desktop\\.outputs\\.${os} \\}\\}`));
    }
  });

  test('stores each verified OS under desktop/, lists the rest as MISSING, and attests SHA256SUMS', (t) => {
    const root = sandbox(t);
    stageDesktopArtifacts(root, ['macos', 'linux']);
    const result = storeDesktop(root, { macos: true, windows: false, linux: true });
    assert.equal(result.status, 0, result.stderr);
    const desktop = join(setPrefix(root), 'desktop');
    assert.deepEqual(tree(desktop), [
      'MISSING',
      'PACKAGE_SHA256',
      'SHA256SUMS',
      'SOURCE_SHA',
      'VERSION',
      'connect-desktop-linux-signed/connect-desktop-linux-signed.bin',
      'connect-desktop-macos-signed/connect-desktop-macos-signed.bin',
    ]);
    assert.equal(readFileSync(join(desktop, 'MISSING'), 'utf8'), 'windows\n');
    assert.equal(readFileSync(join(desktop, 'VERSION'), 'utf8'), `${VERSION}\n`);
    assert.equal(readFileSync(join(desktop, 'SOURCE_SHA'), 'utf8'), `${SOURCE_SHA}\n`);
    assert.equal(readFileSync(join(desktop, 'PACKAGE_SHA256'), 'utf8'), `${PACKAGE_SHA256}\n`);
    const listed = readFileSync(join(desktop, 'SHA256SUMS'), 'utf8').trim().split('\n').map((l) => l.replace(/^[0-9a-f]{64} {2}/, ''));
    assert.deepEqual(listed, tree(desktop).filter((f) => f !== 'SHA256SUMS'));
    const check = spawnSync('sha256sum', ['--check', '--strict', 'SHA256SUMS'], { cwd: desktop, encoding: 'utf8' });
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.match(result.stdout, new RegExp(`::notice title=connect-set-desktop::sha256=${sha256(join(desktop, 'SHA256SUMS'))}\\n`));
    // The CLI set at the prefix root is not touched.
    assert.equal(existsSync(join(setPrefix(root), 'SHA256SUMS')), false);
  });

  test('uploads SHA256SUMS after every file it lists', (t) => {
    const root = sandbox(t);
    stageDesktopArtifacts(root, ['macos', 'windows', 'linux']);
    const result = storeDesktop(root, { macos: true, windows: true, linux: true });
    assert.equal(result.status, 0, result.stderr);
    const writes = result.log.split('\n').filter((l) => / s3:\/\/ci-bucket\/connect-sets\//.test(l));
    const sums = writes.findIndex((l) => l.includes('/desktop/SHA256SUMS'));
    assert.equal(sums, writes.length - 1, `SHA256SUMS must be the last upload:\n${writes.join('\n')}`);
    assert.equal(readFileSync(join(setPrefix(root), 'desktop/MISSING'), 'utf8'), '');
  });

  test('an OS that reported success with nothing staged fails the job instead of storing an empty dir', (t) => {
    const root = sandbox(t);
    stageDesktopArtifacts(root, ['macos']);
    const result = storeDesktop(root, { macos: true, windows: false, linux: true });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(setPrefix(root), 'desktop/SHA256SUMS')), false);
  });
});

describe('load-set publishes the desktop set only when the record attests it', () => {
  // A CLI set as store-set writes it, plus (optionally) a desktop set as store-desktop writes it.
  const seedCliSet = (root, { combinedDesktop = false } = {}) => {
    const set = setPrefix(root);
    for (const name of ['binaries-unsigned', 'binaries-darwin', 'binaries-macos-pkg', 'binaries-windows', 'linux-packages']) {
      write(join(set, name, `${name}.bin`), `${name}\n`);
    }
    if (combinedDesktop) {
      for (const name of [...DESKTOP_ARTIFACTS.macos, ...DESKTOP_ARTIFACTS.windows, ...DESKTOP_ARTIFACTS.linux]) {
        write(join(set, name, `${name}.bin`), `${name}\n`);
      }
      write(join(set, 'MISSING'), '');
    }
    write(join(set, 'PACKAGE_SHA256'), `${PACKAGE_SHA256}\n`);
    write(join(set, 'VERSION'), `${VERSION}\n`);
    write(join(set, 'SOURCE_SHA'), `${SOURCE_SHA}\n`);
    const files = tree(set);
    const sums = spawnSync('sha256sum', ['--', ...files], { cwd: set, encoding: 'utf8' });
    assert.equal(sums.status, 0, sums.stderr);
    writeFileSync(join(set, 'SHA256SUMS'), sums.stdout);
    return sha256(join(set, 'SHA256SUMS'));
  };
  const seedDesktopSet = (root, t, oses = ['macos', 'windows', 'linux'], ok = { macos: true, windows: true, linux: true }) => {
    stageDesktopArtifacts(root, oses);
    const result = storeDesktop(root, ok);
    assert.equal(result.status, 0, result.stderr);
    // Leave only the stored set: the run artifacts load-set stages must come from the set.
    rmSync(runPrefix(root), { recursive: true, force: true });
    writeFileSync(join(root, 'aws.log'), '');
    return sha256(join(setPrefix(root), 'desktop/SHA256SUMS'));
  };
  const load = (root, env) => run(root, stepScript(job('load-set'), 'verify'), {
    BUCKET, SET_KEY, VERSION, SOURCE_SHA, ...env,
  });
  const present = (result) => (result.output.match(/^present=(.*)$/m) ?? [])[1];

  test('the dispatch input exists and reaches the verify step', () => {
    assert.match(caller, /\n      desktop_sums_sha256:\n/);
    assert.match(job('load-set'), /DESKTOP_SUMS_SHA256: \$\{\{ inputs\.desktop_sums_sha256 \}\}/);
  });

  test('stages a split desktop set whose SHA256SUMS matches the record', (t) => {
    const root = sandbox(t);
    const sums = seedCliSet(root);
    const desktopSums = seedDesktopSet(root, t, ['macos', 'linux'], { macos: true, windows: false, linux: true });
    const result = load(root, { SET_SUMS_SHA256: sums, DESKTOP_SUMS_SHA256: desktopSums });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(present(result), 'macos linux');
    const staged = tree(runPrefix(root));
    assert.ok(staged.includes('connect-desktop-macos-signed/connect-desktop-macos-signed.bin'), staged.join('\n'));
    assert.ok(staged.includes('connect-desktop-linux-signed/connect-desktop-linux-signed.bin'), staged.join('\n'));
    assert.ok(staged.includes('binaries-unsigned/binaries-unsigned.bin'), staged.join('\n'));
  });

  test('without the input a split set publishes the CLI and no desktop', (t) => {
    const root = sandbox(t);
    const sums = seedCliSet(root);
    seedDesktopSet(root, t);
    const result = load(root, { SET_SUMS_SHA256: sums, DESKTOP_SUMS_SHA256: '' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(present(result), '');
    assert.ok(!tree(runPrefix(root)).some((f) => f.startsWith('connect-desktop-')));
  });

  test('a combined set from before the split still publishes its desktop without the input', (t) => {
    const root = sandbox(t);
    const sums = seedCliSet(root, { combinedDesktop: true });
    const result = load(root, { SET_SUMS_SHA256: sums, DESKTOP_SUMS_SHA256: '' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(present(result), 'macos windows linux');
  });

  test('refuses a desktop SHA256SUMS that is not the recorded one, before fetching any desktop file', (t) => {
    const root = sandbox(t);
    const sums = seedCliSet(root);
    seedDesktopSet(root, t);
    const result = load(root, { SET_SUMS_SHA256: sums, DESKTOP_SUMS_SHA256: 'c'.repeat(64) });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /desktop SHA256SUMS is [0-9a-f]{64}, not the recorded c{64}; refusing to publish it/);
    assert.doesNotMatch(result.log, /desktop\/connect-desktop-/);
  });

  test('refuses a desktop file that does not match its SHA256SUMS', (t) => {
    const root = sandbox(t);
    const sums = seedCliSet(root);
    const desktopSums = seedDesktopSet(root, t);
    writeFileSync(join(setPrefix(root), 'desktop/connect-desktop-linux-signed/connect-desktop-linux-signed.bin'), 'tampered\n');
    const result = load(root, { SET_SUMS_SHA256: sums, DESKTOP_SUMS_SHA256: desktopSums });
    assert.notEqual(result.status, 0);
    assert.ok(!tree(runPrefix(root)).some((f) => f.startsWith('connect-desktop-')), 'nothing desktop is staged');
  });

  test('refuses a desktop set prepared for another version or commit', (t) => {
    for (const [label, value] of [['VERSION', '9.9.9'], ['SOURCE_SHA', 'f'.repeat(40)]]) {
      const root = sandbox(t);
      const sums = seedCliSet(root);
      stageDesktopArtifacts(root, ['macos']);
      const stored = run(root, stepScript(job('store-desktop'), 'Store the signed desktop set'), {
        BUCKET, SET_KEY, VERSION, SOURCE_SHA, PACKAGE_SHA256, MACOS_OK: 'true', WINDOWS_OK: 'false', LINUX_OK: 'false',
        [label]: value,
      });
      assert.equal(stored.status, 0, stored.stderr);
      rmSync(runPrefix(root), { recursive: true, force: true });
      const desktopSums = sha256(join(setPrefix(root), 'desktop/SHA256SUMS'));
      const result = load(root, { SET_SUMS_SHA256: sums, DESKTOP_SUMS_SHA256: desktopSums });
      assert.notEqual(result.status, 0, `${label} mismatch must be refused`);
      assert.match(result.stdout + result.stderr, new RegExp(`desktop set ${SET_KEY} was prepared for ${label} ${value}, not`));
    }
  });

  test('refuses an unsafe path listed in the desktop SHA256SUMS', (t) => {
    const root = sandbox(t);
    const sums = seedCliSet(root);
    const desktop = join(setPrefix(root), 'desktop');
    write(join(desktop, 'SHA256SUMS'), `${'0'.repeat(64)}  ../binaries-unsigned/binaries-unsigned.bin\n`);
    const result = load(root, { SET_SUMS_SHA256: sums, DESKTOP_SUMS_SHA256: sha256(join(desktop, 'SHA256SUMS')) });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /unsafe path in the desktop set/);
  });

  test('refuses a desktop set that lists a file outside the desktop artifacts', (t) => {
    const root = sandbox(t);
    const sums = seedCliSet(root);
    const desktop = join(setPrefix(root), 'desktop');
    write(join(desktop, 'binaries-unsigned/anyray-connect-linux-x64'), 'x\n');
    write(join(desktop, 'VERSION'), `${VERSION}\n`);
    write(join(desktop, 'SOURCE_SHA'), `${SOURCE_SHA}\n`);
    const listing = spawnSync('sha256sum', ['--', 'VERSION', 'SOURCE_SHA', 'binaries-unsigned/anyray-connect-linux-x64'], { cwd: desktop, encoding: 'utf8' });
    writeFileSync(join(desktop, 'SHA256SUMS'), listing.stdout);
    const result = load(root, { SET_SUMS_SHA256: sums, DESKTOP_SUMS_SHA256: sha256(join(desktop, 'SHA256SUMS')) });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /the desktop set may only carry connect-desktop-\* artifacts/);
  });
});
