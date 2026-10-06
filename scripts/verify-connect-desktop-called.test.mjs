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
    for (const name of ['build-macos-unsigned', 'sign-windows-inner', 'build-linux-unsigned', 'publish']) {
      assert.doesNotMatch(caller, new RegExp(`\\n  ${name}:\\n`));
      assert.match(callee, new RegExp(`\\n  ${name}:\\n`));
    }
  });

  test('one desktop job, after the CLI release and the CLI Mac teardown, stable and engine-reusing', () => {
    const desktop = job(caller, 'desktop');
    assert.match(desktop, /needs: \[signing-preflight, build, release, teardown-mac\]/);
    assert.match(desktop, /inputs\.source_sha != '' && !inputs\.staging && needs\.release\.result == 'success'/);
    assert.match(desktop, /uses: \.\/\.github\/workflows\/release-connect-desktop\.yml/);
    assert.match(desktop, /secrets: inherit/);
    assert.match(desktop, /channel: stable/);
    assert.match(desktop, /reuse_engines: true/);
    assert.match(desktop, /version: \$\{\{ needs\.build\.outputs\.version \}\}/);
  });

  test('the CLI release never waits on desktop', () => {
    assert.match(job(caller, 'release'), /needs: \[build, sign-macos, sign-windows, package-linux\]/);
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

describe('validation gates what ships', () => {
  test('the caller proves the source commit before build, and a failed proof blocks it', () => {
    const validate = job(caller, 'validate-desktop');
    assert.match(validate, /uses: \.\/\.github\/actions\/gate-private-source/);
    assert.match(validate, /verify_npm_head: 'true'/);
    assert.match(job(caller, 'build'), /needs: \[signing-preflight, validate-desktop\]/);
    assert.match(job(caller, 'build'), /needs\.validate-desktop\.result != 'failure'/);
  });

  test('the desktop validate-source uses the same shared gate, not a copy', () => {
    assert.match(job(callee, 'validate-source'), /uses: \.\/\.github\/actions\/gate-private-source/);
    assert.doesNotMatch(job(callee, 'validate-source'), /verify-connect-desktop-source\.mjs/);
  });

  test('the shared gate compares the npm gitHead with source_sha', () => {
    const gate = readFileSync(new URL('../.github/actions/gate-private-source/action.yml', import.meta.url), 'utf8');
    assert.match(gate, /npm view "anyray-connect@\$\{PACKAGE_VERSION\}" gitHead/);
    assert.match(gate, /test "\$head" = "\$EXPECTED_SOURCE_SHA"/);
  });

  test('neither the per-OS publish nor reconcile-feed runs unless validation succeeded', () => {
    for (const name of ['publish', 'reconcile-feed']) {
      const body = job(callee, name);
      assert.match(body, /needs: \[[^\]]*validate-source/);
      assert.match(body, /needs\.validate-source\.result == 'success'/);
    }
  });
});
