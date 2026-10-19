import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const bash = existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const script = fileURLToPath(new URL('./artifact-digest.sh', import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const workflowDir = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const read = (file) => readFileSync(join(workflowDir, file), 'utf8');

// Keep the job, step and literal-block boundaries used by the Mac runner tests.
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
  const dir = mkdtempSync(join(tmpdir(), 'artifact-digest-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(args, env = {}) {
  const result = spawnSync(bash, [script, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, ...env },
  });
  return { ...result, log: result.stdout + result.stderr };
}

function fixture(t) {
  const dir = tree(t);
  const files = [['z-file', 'z'], ['A_file', 'A']];
  for (const [name, bytes] of files) writeFileSync(join(dir, name), bytes);
  return {
    dir, files: files.map(([name]) => join(dir, name)),
    manifest: `A_file=${sha('A')},z-file=${sha('z')}`,
  };
}

test('manifest uses basenames, SHA256 and C sorting', (t) => {
  const f = fixture(t);
  const result = run(['manifest', ...f.files]);
  assert.equal(result.status, 0, result.log);
  assert.equal(result.stdout, `${f.manifest}\n`);
  assert.equal(statSync(script).mode & 0o777, 0o755);
});

for (const kind of ['no files', 'missing file', 'directory', 'symlink', 'duplicate basename', 'unsafe basename']) {
  test(`manifest refuses ${kind}`, (t) => {
    const f = fixture(t);
    let files = [];
    if (kind === 'missing file') files = [join(f.dir, 'absent')];
    if (kind === 'directory') files = [f.dir];
    if (kind === 'symlink') {
      symlinkSync(f.files[0], join(f.dir, 'link'));
      files = [join(f.dir, 'link')];
    }
    if (kind === 'duplicate basename') {
      mkdirSync(join(f.dir, 'other'));
      copyFileSync(f.files[0], join(f.dir, 'other/z-file'));
      files = [f.files[0], join(f.dir, 'other/z-file')];
    }
    if (kind === 'unsafe basename') {
      writeFileSync(join(f.dir, '::warning::injected'), 'secret');
      files = [join(f.dir, '::warning::injected')];
    }
    const result = run(['manifest', ...files]);
    assert.equal(result.status, 1, result.log);
    assert.match(result.log, /::error::/);
    assert.ok(!result.log.includes('::warning::injected'));
  });
}

test('emit appends exactly one output line and a count notice', (t) => {
  const f = fixture(t);
  const output = join(tree(t), 'output');
  writeFileSync(output, 'existing=value\n');
  const result = run(['emit', 'darwin_manifest', ...f.files], { GITHUB_OUTPUT: output });
  assert.equal(result.status, 0, result.log);
  assert.equal(readFileSync(output, 'utf8'), `existing=value\ndarwin_manifest=${f.manifest}\n`);
  assert.match(result.stdout, /^::notice::.*darwin_manifest.*2.*\n$/);
  assert.ok(!result.log.includes(sha('A')));
});

test('emit refuses an empty output path and an invalid output name', (t) => {
  const f = fixture(t);
  for (const [name, output] of [['manifest', ''], ['BAD-name', join(tree(t), 'output')]]) {
    const result = run(['emit', name, ...f.files], { GITHUB_OUTPUT: output });
    assert.equal(result.status, 1, result.log);
    assert.match(result.log, /::error::/);
  }
});

test('verify accepts exactly the signed set', (t) => {
  const f = fixture(t);
  const result = run(['verify', 'Signed macOS', f.dir, f.manifest]);
  assert.equal(result.status, 0, result.log);
});

for (const kind of [
  'changed byte', 'extra file', 'missing file', 'subdirectory', 'symlink',
  'empty manifest', 'malformed manifest', 'dropped manifest entry', 'reordered manifest',
  'empty directory', 'missing directory', 'symlinked directory', 'injected filename',
  'hidden extra file',
]) {
  test(`verify refuses ${kind} without logging filenames or digests`, (t) => {
    const f = fixture(t);
    let expected = f.manifest;
    let dir = f.dir;
    if (kind === 'changed byte') writeFileSync(f.files[0], 'y');
    if (kind === 'extra file' || kind === 'injected filename') writeFileSync(join(dir, '::warning::injected'), 'extra');
    // A dotfile is still an extra object under the prefix; a glob without dotglob would miss it.
    if (kind === 'hidden extra file') writeFileSync(join(dir, '.injected'), 'extra');
    if (kind === 'missing file') rmSync(f.files[0]);
    if (kind === 'subdirectory') mkdirSync(join(dir, 'nested'));
    if (kind === 'symlink') {
      rmSync(f.files[0]);
      symlinkSync(f.files[1], f.files[0]);
    }
    if (kind === 'empty manifest') expected = '';
    if (kind === 'malformed manifest') expected = `A_file=${'G'.repeat(64)}`;
    if (kind === 'dropped manifest entry') expected = expected.split(',')[0];
    if (kind === 'reordered manifest') expected = expected.split(',').reverse().join(',');
    if (kind === 'empty directory') for (const file of f.files) rmSync(file);
    if (kind === 'missing directory') dir = join(tree(t), 'absent');
    if (kind === 'symlinked directory') {
      dir = join(tree(t), 'link');
      symlinkSync(f.dir, dir);
    }
    const result = run(['verify', 'Signed macOS', dir, expected]);
    assert.equal(result.status, 1, result.log);
    assert.match(result.log, /::error::Signed macOS:/);
    if (kind === 'empty manifest') assert.match(result.log, /no digests from the signing job; refusing the downloaded files/);
    // The directory scan refuses these itself, not only through the manifest it would compute.
    if (['subdirectory', 'symlink'].includes(kind)) assert.match(result.log, /::error::Signed macOS: direct regular files check failed/);
    if (['changed byte', 'extra file', 'missing file', 'dropped manifest entry', 'reordered manifest', 'injected filename', 'hidden extra file'].includes(kind)) {
      assert.match(result.log, /downloaded files do not match the digests the signing job reported/);
      assert.match(result.log, /expected.*\d.*downloaded.*\d/);
    }
    for (const hidden of ['::warning::injected', '.injected', 'A_file', 'z-file', sha('A'), sha('z'), sha('extra')]) {
      assert.ok(!result.log.includes(hidden), `logged untrusted data: ${hidden}`);
    }
  });
}

test('bad labels are refused without printing them', (t) => {
  const f = fixture(t);
  const result = run(['verify', '::warning::injected', f.dir, f.manifest]);
  assert.equal(result.status, 1, result.log);
  assert.match(result.log, /::error::.*label/);
  assert.ok(!result.log.includes('::warning::injected'));
});

test('usage errors exit 2', () => {
  for (const args of [[], ['unknown'], ['emit'], ['emit', 'manifest'], ['verify'], ['verify', 'label', 'dir'], ['verify', 'label', 'dir', 'expected', 'extra']]) {
    assert.equal(run(args).status, 2, args.join(' '));
  }
});

const binaries = () => jobs(read('release-connect-binaries.yml'));
const desktop = () => jobs(read('release-connect-desktop.yml'));
const verifyName = "Verify the signed macOS files against the signing job's digests";
const digestStep = (body) => {
  const step = steps(body).find((s) => stepRun(s).includes('./scripts/artifact-digest.sh verify'));
  assert.ok(step, 'signed artifact digest verification step is absent');
  return step;
};

test('the signed macOS artifact consumer inventory is exact, including staged sets', () => {
  const names = ['binaries-darwin', 'binaries-macos-pkg', 'connect-desktop-macos-signed'];
  const consumers = [];
  for (const file of readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name))) {
    for (const [id, body] of Object.entries(jobs(read(file)))) {
      const downloads = steps(body).filter((s) => field(s, 'uses', 8) === './.github/actions/s3-artifact-download');
      const direct = downloads.some((s) => names.includes(field(s, 'name', 10)));
      const matrix = downloads.some((s) => field(s, 'name', 10) === '${{ matrix.artifact }}')
        && names.some((name) => body.split('\n').some((line) => line.trim() === `artifact: ${name}`));
      const runs = steps(body).map(stepRun).join('\n');
      const fetch = names.some((name) => new RegExp(`\\bfetch ${name}\\b`).test(runs))
        || /fetch "\$name"/.test(runs) && names.some((name) => new RegExp(`for name in [^\n]*\\b${name}\\b`).test(runs));
      const staging = id === 'load-set' && names.some((name) => runs.includes(name));
      if (direct || matrix || fetch || staging) consumers.push(`${file}:${id}`);
    }
  }
  assert.deepEqual(consumers.sort(), [
    'release-connect-binaries.yml:verify-macos-launch', 'release-connect-binaries.yml:release',
    'release-connect-binaries.yml:store-set', 'release-connect-binaries.yml:store-desktop',
    'release-connect-binaries.yml:load-set', 'release-connect-desktop.yml:verify-macos-signed',
    'release-connect-desktop.yml:publish', 'release-connect-desktop.yml:assemble-dry-run',
  ].sort());
});

function evaluate(expression, mode, staged, signed) {
  assert.equal(typeof expression, 'string', 'expected-manifest expression is absent');
  const code = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replace(/\bneeds\.([a-zA-Z0-9_-]+)/g, 'needs["$1"]');
  const context = {
    inputs: { mode, macos_signed_manifest: staged },
    needs: {
      'load-set': { outputs: { darwin_manifest: staged, pkg_manifest: staged } },
      'sign-macos': { outputs: { darwin_manifest: signed, pkg_manifest: signed, manifest: signed } },
    },
  };
  return new Function(...Object.keys(context), `return (${code});`)(...Object.values(context));
}

test('release verifies both isolated downloads before copying, completeness checks or hashing', () => {
  const body = binaries().release;
  const all = steps(body);
  const downloads = all.filter((s) => field(s, 'uses', 8) === './.github/actions/s3-artifact-download');
  assert.deepEqual(downloads.map((s) => [field(s, 'name', 10), field(s, 'path', 10)]), [
    ['binaries-unsigned', 'assets'], ['binaries-darwin', 'signed-macos/binaries-darwin'],
    ['binaries-macos-pkg', 'signed-macos/binaries-macos-pkg'], ['binaries-windows', 'assets'], ['linux-packages', 'assets'],
  ]);
  const verify = digestStep(body);
  assert.equal(field(verify, 'name', 8), verifyName);
  assert.equal(all.indexOf(verify), all.indexOf(downloads.at(-1)) + 1);
  const run = stepRun(verify);
  for (const [name, env] of [['binaries-darwin', 'DARWIN_MANIFEST'], ['binaries-macos-pkg', 'PKG_MANIFEST']]) {
    assert.ok(run.includes(`./scripts/artifact-digest.sh verify ${name} signed-macos/${name} "$${env}"`));
  }
  const lastVerify = run.lastIndexOf('./scripts/artifact-digest.sh verify');
  assert.ok(run.indexOf('cp ') > lastVerify);
  for (const name of ['Check the complete release asset set', 'Generate SHA256SUMS']) {
    assert.ok(all.findIndex((s) => (field(s, 'name', 8) ?? '').startsWith(name)) > all.indexOf(verify));
  }
});

test('release and publish expressions never mix release and staged manifests', () => {
  const release = digestStep(binaries().release);
  const publish = digestStep(desktop().publish);
  for (const expression of [field(release, 'DARWIN_MANIFEST', 10), field(release, 'PKG_MANIFEST', 10), field(publish, 'MACOS_MANIFEST', 10)]) {
    assert.equal(evaluate(expression, 'release', 'staged', 'signed'), 'signed');
    assert.equal(evaluate(expression, 'publish', 'staged', 'signed'), 'staged');
    assert.equal(evaluate(expression, 'publish', '', 'signed'), '');
  }
});

for (const id of ['store-set', 'store-desktop']) {
  test(`${id} verifies immediately after fetch before hashing or uploading`, () => {
    const body = binaries()[id];
    const all = steps(body);
    assert.equal(field(all[0], 'uses', 8), 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2');
    assert.match(all[0], /sparse-checkout: scripts\/artifact-digest\.sh\n/);
    const run = stepRun(all.find((s) => (field(s, 'name', 8) ?? '').startsWith('Store the signed')));
    if (id === 'store-set') {
      assert.equal(field(body, 'DARWIN_MANIFEST', 6), '${{ needs.sign-macos.outputs.darwin_manifest }}');
      assert.equal(field(body, 'PKG_MANIFEST', 6), '${{ needs.sign-macos.outputs.pkg_manifest }}');
      assert.match(run, /fetch "\$name"\n *done\n *\.\/scripts\/artifact-digest\.sh verify binaries-darwin set\/binaries-darwin "\$DARWIN_MANIFEST"\n *\.\/scripts\/artifact-digest\.sh verify binaries-macos-pkg set\/binaries-macos-pkg "\$PKG_MANIFEST"/);
    } else {
      assert.equal(field(body, 'MACOS_MANIFEST', 6), '${{ needs.desktop.outputs.macos_manifest }}');
      assert.match(run, /if \[ "\$MACOS_OK" = true \]; then\n *fetch connect-desktop-macos-signed\n *\.\/scripts\/artifact-digest\.sh verify connect-desktop-macos-signed desktop\/connect-desktop-macos-signed "\$MACOS_MANIFEST"/);
    }
    const verify = run.lastIndexOf('./scripts/artifact-digest.sh verify');
    for (const marker of ['> '+(id === 'store-set' ? 'set' : 'desktop')+'/PACKAGE_SHA256', 'SHA256SUMS', 'aws s3 sync']) {
      assert.ok(run.indexOf(marker) > verify, `${marker} must follow digest verification`);
    }
  });
}

test('load-set emits digests after checksum verification and desktop staging, before its upload', () => {
  const body = binaries()['load-set'];
  const run = stepRun(steps(body).find((s) => field(s, 'id', 8) === 'verify'));
  for (const [output, glob] of [['darwin_manifest', 'set/binaries-darwin/*'], ['pkg_manifest', 'set/binaries-macos-pkg/*'], ['desktop_macos_manifest', 'set/connect-desktop-macos-signed/*']]) {
    assert.equal(field(body, output, 6), '${{ steps.verify.outputs.'+output+' }}');
    const index = run.indexOf(`./scripts/artifact-digest.sh emit ${output} ${glob}`);
    assert.ok(index > run.lastIndexOf('sha256sum --check'));
    assert.ok(index > run.indexOf('cp -R "$dir" "set/${name}"'));
    assert.ok(index < run.indexOf('aws s3 cp "$dir"'));
  }
  assert.match(run, /if \[ -d set\/connect-desktop-macos-signed \]; then\n *\.\/scripts\/artifact-digest\.sh emit desktop_macos_manifest/);
  assert.equal(field(binaries().desktop, 'macos_signed_manifest', 6), '${{ needs.load-set.outputs.desktop_macos_manifest }}');
  const call = read('release-connect-desktop.yml').split('  workflow_call:\n')[1].split('  workflow_dispatch:\n')[0];
  const input = call.match(/^      macos_signed_manifest:\n((?:        .*\n)+)/m)?.[1];
  assert.ok(input, 'macos_signed_manifest input is absent');
  assert.match(input, /required: false\n/);
  assert.match(input, /type: string\n/);
  assert.match(input, /default: ''\n/);
  assert.match(call, /      macos_manifest:\n        description: [^\n]+\n        value: \$\{\{ jobs.sign-macos.outputs.manifest \}\}/);
});

test('desktop publish and dry-run verify the downloaded macOS directory before publication', () => {
  for (const id of ['publish', 'assemble-dry-run']) {
    const body = desktop()[id];
    assert.match(field(body, 'needs'), /\bsign-macos\b/);
    const all = steps(body);
    const verify = digestStep(body);
    const download = all.find((s) => field(s, 'uses', 8) === './.github/actions/s3-artifact-download');
    assert.equal(all.indexOf(verify), all.indexOf(download) + 1);
    const dir = id === 'publish' ? 'platform/connect-desktop-macos-signed' : 'platform/macos';
    assert.ok(stepRun(verify).includes(`./scripts/artifact-digest.sh verify connect-desktop-macos-signed "${dir}" "$MACOS_MANIFEST"`));
    assert.ok(all.findIndex((s) => stepRun(s).includes('./scripts/publish-desktop-release.sh')) > all.indexOf(verify));
    if (id === 'publish') {
      assert.equal(field(verify, 'if', 8), "${{ matrix.os == 'macos' && format('{0}', matrix.ready) == 'true' }}");
    } else {
      assert.equal(field(verify, 'MACOS_MANIFEST', 10), '${{ needs.sign-macos.outputs.manifest }}');
    }
  }
});

for (const [label, getJobs, outputs] of [
  ['binaries', binaries, { darwin_manifest: 'binaries-darwin', pkg_manifest: 'binaries-macos-pkg' }],
  ['desktop', desktop, { manifest: 'connect-desktop-macos-signed' }],
]) {
  test(`${label} producer records exactly its uploaded paths after signing and before upload`, () => {
    const body = getJobs()['sign-macos'];
    const all = steps(body);
    const record = all.find((s) => field(s, 'id', 8) === 'digests');
    assert.ok(record, 'digests producer step is absent');
    assert.equal(field(record, 'name', 8), 'Record the digests of the signed outputs');
    const uploads = all.filter((s) => field(s, 'uses', 8) === './.github/actions/s3-artifact-upload');
    assert.equal(all.indexOf(record), all.indexOf(uploads[0]) - 1);
    const commands = stepRun(record).split('\n').filter((line) => line.startsWith('./scripts/artifact-digest.sh emit '));
    assert.equal(commands.length, Object.keys(outputs).length);
    for (const [output, artifact] of Object.entries(outputs)) {
      const upload = uploads.find((s) => field(s, 'name', 10) === artifact);
      assert.ok(upload);
      assert.ok(commands.includes(`./scripts/artifact-digest.sh emit ${output} ${field(upload, 'path', 10)}`));
      assert.equal(field(body, output, 6), '${{ steps.digests.outputs.'+output+' }}');
    }
    for (const step of all) {
      if (/\b(?:codesign|notarytool|productsign|stapler)\b/.test(stepRun(step))) assert.ok(all.indexOf(step) < all.indexOf(record));
    }
    const checkout = all.find((s) => (field(s, 'uses', 8) ?? '').startsWith('actions/checkout@'));
    assert.match(checkout, /            \.github\/actions\n/);
    assert.match(checkout, /            scripts\/artifact-digest.sh\n/);
  });
}

for (const kind of ['matching set', 'swapped byte', 'added object', 'empty manifest']) {
  test(`release verification behavior: ${kind}`, (t) => {
    const root = tree(t);
    mkdirSync(join(root, 'scripts'));
    copyFileSync(script, join(root, 'scripts/artifact-digest.sh'));
    const darwin = join(root, 'signed-macos/binaries-darwin');
    const pkg = join(root, 'signed-macos/binaries-macos-pkg');
    for (const dir of [darwin, pkg, join(root, 'assets')]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(darwin, 'anyray-connect-darwin-arm64'), 'signed-arm');
    writeFileSync(join(darwin, 'anyray-connect-darwin-x64'), 'signed-x64');
    writeFileSync(join(pkg, 'anyray-connect.pkg'), 'signed-pkg');
    const expected = `anyray-connect-darwin-arm64=${sha('signed-arm')},anyray-connect-darwin-x64=${sha('signed-x64')}`;
    if (kind === 'swapped byte') writeFileSync(join(darwin, 'anyray-connect-darwin-arm64'), 'swapped');
    if (kind === 'added object') writeFileSync(join(pkg, '::warning::injected'), 'extra');
    const runBlock = stepRun(digestStep(binaries().release));
    const result = spawnSync(bash, ['-c', runBlock], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { PATH: process.env.PATH, DARWIN_MANIFEST: kind === 'empty manifest' ? '' : expected, PKG_MANIFEST: `anyray-connect.pkg=${sha('signed-pkg')}` },
    });
    assert.equal(result.status, kind === 'matching set' ? 0 : 1, result.stdout + result.stderr);
    if (kind === 'matching set') {
      for (const [name, bytes] of [['anyray-connect-darwin-arm64', 'signed-arm'], ['anyray-connect-darwin-x64', 'signed-x64'], ['anyray-connect.pkg', 'signed-pkg']]) {
        assert.equal(readFileSync(join(root, 'assets', name), 'utf8'), bytes);
      }
    } else {
      assert.deepEqual(readdirSync(join(root, 'assets')), []);
      assert.ok(!(result.stdout + result.stderr).includes('::warning::injected'));
    }
  });
}

test('the persistent-host posture documents signed Mac digest pinning and the other OS follow-up', () => {
  const section = readFileSync(new URL('../RELEASING.md', import.meta.url), 'utf8')
    .split('### The persistent macOS signing host (ANY-1405)\n')[1].split('\n## ')[0];
  assert.match(section, /- Signed macOS outputs are pinned by digest from the signing job to every consumer/);
  assert.match(section, /build account cannot swap them after signing/);
  assert.match(section, /Windows and Linux signed outputs share the same bucket and are not pinned yet/);
});
