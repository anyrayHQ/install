import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    for (const name of ['build-macos-unsigned', 'sign-windows-inner', 'build-linux-unsigned', 'publish-macos']) {
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
    assert.match(job(caller, 'build'), /if: \$\{\{ inputs\.mode != 'publish' \}\}/);
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
    for (const name of ['publish-macos', 'publish-windows', 'publish-linux', 'reconcile-feed']) {
      assert.match(job(callee, name), /inputs\.mode != 'prepare'/);
    }
    assert.match(job(callee, 'publish-macos'), /contains\(inputs\.present, 'macos'\)/);
    assert.match(job(callee, 'validate-source'), /if: \$\{\{ inputs\.mode != 'publish' \}\}/);
    assert.match(callee, /outputs:\n\s+macos:[\s\S]*?jobs\.outcome\.outputs\.macos/);
  });
});

describe('compile cache for the desktop app builds', () => {
  const action = readFileSync(new URL('../.github/actions/setup-sccache/action.yml', import.meta.url), 'utf8');

  test('each native compile job sets up sccache fail-open and prints its stats', () => {
    for (const name of ['build-macos-unsigned', 'build-windows-unsigned', 'build-linux-unsigned']) {
      const body = job(callee, name);
      assert.match(body, /continue-on-error: true\n\s+uses: \.\/\.github\/actions\/setup-sccache/);
      assert.match(body, /sccache --show-stats/);
      assert.match(body, /bucket: \$\{\{ vars\.CI_ARTIFACTS_BUCKET \}\}/);
    }
  });

  test('the cache lives only in the private bucket, never in actions/cache', () => {
    assert.doesNotMatch(callee, /uses: actions\/cache/);
    assert.doesNotMatch(action, /uses: actions\/cache/);
    assert.match(action, /SCCACHE_S3_KEY_PREFIX="sccache\/connect-tray\/\$\{CACHE_OS\}"/);
    assert.match(action, /RUSTC_WRAPPER=sccache/);
    assert.match(action, /sccache did not start against the bucket; building uncached/);
  });

  test('the release archives are pinned by checksum', () => {
    for (const name of ['SCCACHE_SHA256_DARWIN_ARM64', 'SCCACHE_SHA256_LINUX_X64', 'SCCACHE_SHA256_WINDOWS_X64']) {
      assert.match(callee, new RegExp(`${name}: '[0-9a-f]{64}'`));
    }
  });
});
