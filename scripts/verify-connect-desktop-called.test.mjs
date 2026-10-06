import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const read = (name) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
const caller = read('release-connect-binaries.yml');
const callee = read('release-connect-desktop.yml');

const job = (text, name) => {
  const marker = `\n  ${name}:\n`;
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow job ${name}`);
  const bodyStart = start + marker.length;
  const next = text.slice(bodyStart).search(/^  [a-z0-9-]+:\n/m);
  return next === -1 ? text.slice(bodyStart) : text.slice(bodyStart, bodyStart + next);
};

describe('the CLI release calls the desktop workflow', () => {
  test('desktop jobs live only in release-connect-desktop.yml', () => {
    for (const name of ['build-macos-unsigned', 'sign-windows-inner', 'build-linux-unsigned', 'publish']) {
      assert.doesNotMatch(caller, new RegExp(`\\n  ${name}:\\n`));
      assert.match(callee, new RegExp(`\\n  ${name}:\\n`));
    }
  });

  test('one desktop job, after the CLI release and the CLI Mac teardown, stable and engine-reusing', () => {
    const desktop = job(caller, 'desktop');
    assert.match(desktop, /needs: \[signing-preflight, build, sign-macos, sign-windows, package-linux, load-set, release, teardown-mac\]/);
    assert.match(desktop, /inputs\.source_sha != '' && !inputs\.staging && \(\(inputs\.mode == 'release' && needs\.release\.result == 'success'\)/);
    assert.match(desktop, /uses: \.\/\.github\/workflows\/release-connect-desktop\.yml/);
    assert.match(desktop, /secrets: inherit/);
    assert.match(desktop, /channel: stable/);
    assert.match(desktop, /reuse_engines: true/);
    assert.match(desktop, /version: \$\{\{ needs\.build\.outputs\.version \|\| inputs\.version \}\}/);
  });

  test('the CLI release never waits on desktop', () => {
    assert.match(job(caller, 'release'), /needs: \[build, sign-macos, sign-windows, package-linux, load-set\]/);
  });

  test('a bad desktop input fails in preflight, before anything ships', () => {
    const pf = job(caller, 'signing-preflight');
    assert.match(pf, /Desktop inputs/);
    assert.match(pf, /source_sha must be an exact lowercase 40-hex commit SHA/);
  });
});

describe('the desktop workflow is callable', () => {
  test('workflow_call takes the dispatch inputs plus reuse_engines, and keeps workflow_dispatch', () => {
    const trigger = callee.slice(callee.indexOf('\non:'), callee.indexOf('\npermissions:'));
    assert.match(trigger, /workflow_call:/);
    assert.match(trigger, /workflow_dispatch:/);
    assert.match(trigger, /reuse_engines:/);
  });

  test('every engine is compiled only when not reused, and reused from the caller artifacts otherwise', () => {
    for (const [name, artifact] of [['build-macos-unsigned', 'binaries-unsigned'], ['build-linux-unsigned', 'binaries-unsigned'], ['build-windows-unsigned', 'binaries-windows']]) {
      const body = job(callee, name);
      assert.match(body, new RegExp(`if: \\$\\{\\{ inputs\\.reuse_engines \\}\\}\\n\\s+with:\\n[\\s\\S]*?name: ${artifact}`));
      assert.match(body, /if: \$\{\{ !inputs\.reuse_engines \}\}/);
    }
  });

  test('a reused Windows engine keeps the CLI release signature', () => {
    const sign = job(callee, 'sign-windows-inner');
    assert.match(sign, /REUSE_ENGINES: \$\{\{ inputs\.reuse_engines \}\}/);
    assert.match(sign, /\[ "\$exe" = out\/anyray-connect-engine-windows-x64\.exe \]/);
  });
});

describe('prepare and publish modes', () => {
  test('mode, set_key and set_sums_sha256 exist; release is the default', () => {
    assert.match(caller, /\n      mode:\n[\s\S]*?options: \[release, prepare, publish\]\n\s+default: release\n/);
    assert.match(caller, /\n      set_key:\n/);
    assert.match(caller, /\n      set_sums_sha256:\n/);
  });

  test('publish builds nothing and has its own concurrency group', () => {
    assert.match(job(caller, 'build'), /inputs\.mode != 'publish'/);
    assert.match(caller, /group: \$\{\{ inputs\.mode == 'publish' && 'anyray-install-connect-publish' \|\| 'anyray-install-mac-release' \}\}/);
    assert.match(job(caller, 'teardown-mac'), /needs\.provision-mac\.result != 'skipped'/);
  });

  test('prepare compiles the .tgz stored under set_key, not npm', () => {
    const build = job(caller, 'build');
    assert.match(build, /connect-sets\/\$\{SET_KEY\}\/npm\/anyray-connect-\$\{VERSION_INPUT\}\.tgz/);
    assert.match(build, /id: pkg\n\s+if: \$\{\{ inputs\.mode != 'prepare' \}\}/);
  });

  test('prepare stores the set (MISSING always written, SHA256SUMS last) and publishes nothing', () => {
    const store = job(caller, 'store-set');
    assert.match(store, /inputs\.mode == 'prepare'/);
    assert.match(store, /MACOS_OK: \$\{\{ needs\.desktop\.outputs\.macos \}\}/);
    assert.match(store, /printf '%b' "\$missing" > set\/MISSING/);
    assert.ok(store.indexOf('set/SHA256SUMS "${set_prefix}/SHA256SUMS"') > store.indexOf('set/MISSING "${set_prefix}/MISSING"'));
    assert.match(job(caller, 'release'), /inputs\.mode == 'release' && needs\.build\.result == 'success'/);
  });

  test('publish checks the recorded hash before reading any other file and stages artifacts for the unchanged jobs', () => {
    const load = job(caller, 'load-set');
    assert.ok(load.indexOf('SET_SUMS_SHA256" ]') < load.indexOf('aws s3 cp "${src}/${file}"'));
    assert.match(load, /sha256sum --check --strict SHA256SUMS/);
    assert.match(job(caller, 'release'), /inputs\.mode == 'publish' && needs\.load-set\.result == 'success' && needs\.load-set\.outputs\.cli_published != 'true'/);
  });

  test('the desktop workflow publishes only staged OSes in publish mode and nothing in prepare', () => {
    for (const name of ['publish', 'reconcile-feed']) {
      assert.match(job(callee, name), /inputs\.mode != 'prepare'/);
      assert.match(job(callee, name), /needs\.validate-source\.result == 'success' \|\| inputs\.mode == 'publish'/);
    }
    assert.match(job(callee, 'publish'), /contains\(inputs\.present, 'macos'\)/);
    assert.match(job(callee, 'validate-source'), /if: \$\{\{ inputs\.mode != 'publish' \}\}/);
    assert.match(callee, /outputs:\n\s+macos:[\s\S]*?jobs\.outcome\.outputs\.macos/);
  });
});

describe('validation gates what ships', () => {
  test('the caller proves the source commit before build, and a failed proof blocks it', () => {
    const validate = job(caller, 'validate-desktop');
    assert.match(validate, /uses: \.\/\.github\/actions\/gate-private-source/);
    assert.match(validate, /verify_npm_head: \$\{\{ inputs\.mode == 'release' && 'true' \|\| 'false' \}\}/);
    assert.match(job(caller, 'build'), /needs: \[signing-preflight, validate-desktop\]/);
    assert.match(job(caller, 'build'), /needs\.validate-desktop\.result != 'failure'/);
  });

  test('the desktop validate-source uses the same shared gate, not a copy', () => {
    assert.match(job(callee, 'validate-source'), /uses: \.\/\.github\/actions\/gate-private-source/);
    assert.doesNotMatch(job(callee, 'validate-source'), /verify-connect-desktop-source\.mjs/);
  });

  test('the shared gate compares the npm gitHead with source_sha', () => {
    const gate = readFileSync(new URL('../.github/actions/gate-private-source/action.yml', import.meta.url), 'utf8');
    assert.match(gate, /npm view --prefer-online "anyray-connect@\$\{PACKAGE_VERSION\}" gitHead/);
    assert.match(gate, /test "\$head" = "\$EXPECTED_SOURCE_SHA"/);
  });

  test('neither the per-OS publish nor reconcile-feed runs unless validation succeeded', () => {
    for (const name of ['publish', 'reconcile-feed']) {
      const body = job(callee, name);
      assert.match(body, /needs: \[[^\]]*validate-source/);
      assert.match(body, /needs\.validate-source\.result == 'success'/);
    }
    // publish mode builds nothing, so load-set (the caller's gate for the call) stands in for validate-source.
    assert.match(job(caller, 'desktop'), /needs\.load-set\.result == 'success'/);
  });
});

describe('publish refuses mislabeled or incomplete sets', () => {
  test('the set records its version and commit, and load-set refuses a different label', () => {
    const store = job(caller, 'store-set');
    assert.match(store, /printf '%s\\n' "\$VERSION" > set\/VERSION/);
    assert.match(store, /printf '%s\\n' "\$SOURCE_SHA" > set\/SOURCE_SHA/);
    const load = job(caller, 'load-set');
    assert.match(load, /refusing to relabel it/);
    assert.ok(load.indexOf('sha256sum --check --strict SHA256SUMS') < load.indexOf('refusing to relabel it'));
  });

  test('every top-level file the set writes is uploaded before SHA256SUMS', () => {
    const store = job(caller, 'store-set');
    const written = [...store.matchAll(/> set\/([A-Z0-9_]+)\b/g)].map((m) => m[1]).filter((n) => n !== 'SHA256SUMS');
    assert.ok(written.includes('VERSION') && written.includes('SOURCE_SHA'));
    const sums = store.indexOf('aws s3 cp set/SHA256SUMS');
    for (const name of new Set(written)) {
      const upload = store.indexOf(`aws s3 cp set/${name} `);
      assert.ok(upload !== -1, `${name} is listed in SHA256SUMS but never uploaded`);
      assert.ok(upload < sums, `${name} must upload before SHA256SUMS`);
    }
  });

  // Runs the real "already published?" step against a fake gh and a fake set.
  const runCheck = (t, { have, latest = 'connect-v0.0.1', version = '1.2.3' }) => {
    const load = job(caller, 'load-set');
    const start = load.indexOf('        id: check\n        run: |\n') + '        id: check\n        run: |\n'.length;
    const script = load.slice(start).split('\n').map((line) => line.slice(10)).join('\n');
    const root = mkdtempSync(join(tmpdir(), 'check-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'bin'));
    for (const dir of ['binaries-unsigned', 'binaries-darwin', 'linux-packages']) mkdirSync(join(root, 'set', dir), { recursive: true });
    writeFileSync(join(root, 'set/binaries-unsigned/anyray-connect-linux-x64'), 'x');
    writeFileSync(join(root, 'set/binaries-darwin/anyray-connect-darwin-arm64'), 'x');
    writeFileSync(join(root, 'set/linux-packages/anyray-connect.deb'), 'x');
    writeFileSync(join(root, 'bin/gh'), `#!/usr/bin/env bash
case "$*" in
  *"--json assets"*) printf '%s\\n' ${have.map((n) => `'${n}'`).join(' ')} ;;
  "release view"*) ${have === null ? 'exit 1' : 'exit 0'} ;;
  *releases/latest*) echo ${latest} ;;
esac
`, { mode: 0o755 });
    const out = join(root, 'out');
    writeFileSync(out, '');
    const result = spawnSync('bash', ['-c', script], {
      cwd: root, encoding: 'utf8',
      env: { PATH: `${join(root, 'bin')}:${process.env.PATH}`, VERSION: version, REPO: 'x/y', GITHUB_OUTPUT: out },
    });
    return { result, output: readFileSync(out, 'utf8') };
  };
  const all = ['SHA256SUMS', 'SHA256SUMS.asc', 'anyray-connect-linux-x64', 'anyray-connect-darwin-arm64', 'anyray-connect.deb'];

  test('a complete existing release is skipped', (t) => {
    const { result, output } = runCheck(t, { have: all });
    assert.equal(result.status, 0, result.stderr);
    assert.match(output, /cli_published=true/);
  });

  test('an existing release missing an asset is rebuilt, not skipped', (t) => {
    const { result, output } = runCheck(t, { have: all.filter((n) => n !== 'anyray-connect.deb') });
    assert.equal(result.status, 0, result.stderr);
    assert.match(output, /cli_published=false/);
    assert.match(result.stdout + result.stderr, /lacks: anyray-connect\.deb/);
  });
});

describe('the shared gate and the npm retry', () => {
  const gate = readFileSync(new URL('../.github/actions/gate-private-source/action.yml', import.meta.url), 'utf8');

  test('publication eligibility lives in the gate only, used by both workflows', () => {
    assert.match(gate, /run: node scripts\/verify-connect-desktop-publication\.mjs/);
    assert.doesNotMatch(callee, /verify-connect-desktop-publication\.mjs/);
    assert.doesNotMatch(caller, /verify-connect-desktop-publication\.mjs/);
    assert.match(job(caller, 'validate-desktop'), /min_version: \$\{\{ inputs\.min_version \}\}/);
    assert.match(job(callee, 'validate-source'), /min_version: \$\{\{ needs\.preflight\.outputs\.min_version \}\}/);
  });

  test('the gitHead check retries visibility through the one shared budget, then compares', () => {
    assert.match(gate, /\.\/scripts\/retry-npm\.sh npm view --prefer-online "anyray-connect@\$\{PACKAGE_VERSION\}" gitHead/);
    assert.match(job(caller, 'build'), /\.\/scripts\/retry-npm\.sh npm pack --prefer-online/);
    assert.doesNotMatch(caller, /FETCH_DEADLINE/);
  });

  const tmp = (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'retry-npm-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'bin'));
    return dir;
  };
  const fakeNpm = (dir, failures) => {
    writeFileSync(join(dir, 'count'), '0');
    writeFileSync(join(dir, 'bin/npm'), `#!/usr/bin/env bash
n=$(( $(cat "${dir}/count") + 1 )); echo $n > "${dir}/count"
if [ $n -le ${failures} ]; then echo "npm error code E404" >&2; exit 1; fi
echo abc123
`, { mode: 0o755 });
  };
  const retry = (dir, env) => spawnSync('bash', [new URL('./retry-npm.sh', import.meta.url).pathname, 'npm', 'view', 'x'], {
    encoding: 'utf8', env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, NPM_RETRY_SLEEP: '0', ...env },
  });

  test('a version that appears after two misses is returned, with only its value on stdout', (t) => {
    const dir = tmp(t);
    fakeNpm(dir, 2);
    const result = retry(dir, {});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'abc123');
    assert.equal(readFileSync(join(dir, 'count'), 'utf8').trim(), '3');
  });

  test('a version that never appears fails once the deadline passes', (t) => {
    const dir = tmp(t);
    fakeNpm(dir, 1000);
    const result = retry(dir, { NPM_RETRY_SECONDS: '0' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /still failing after/);
  });
});

describe('the stored set is attested by an annotation only this run can write', () => {
  test('store-set emits the SHA256SUMS hash as a notice after uploading SHA256SUMS', () => {
    const store = job(caller, 'store-set');
    const upload = store.indexOf('aws s3 cp set/SHA256SUMS "${set_prefix}/SHA256SUMS"');
    const notice = store.indexOf('echo "::notice title=connect-set::sha256=${sums}"');
    assert.ok(upload > 0 && notice > upload, 'the notice follows the SHA256SUMS upload');
    const calculation = store.indexOf('sums="$(sha256sum set/SHA256SUMS | cut -d\' \' -f1)"');
    assert.ok(calculation >= 0 && calculation < notice, 'the notice hashes the SHA256SUMS it uploaded');
  });
});
