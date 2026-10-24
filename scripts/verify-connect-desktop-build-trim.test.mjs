import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

// The desktop build skips work that never changes its output: the whole VCTools workload,
// and an apt source no job installs from.

const workflow = readFileSync(new URL('../.github/workflows/release-connect-desktop.yml', import.meta.url), 'utf8');

const job = (name) => {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow job ${name}`);
  const bodyStart = start + marker.length;
  const next = workflow.slice(bodyStart).search(/^  [a-z0-9-]+:\n/m);
  return next === -1 ? workflow.slice(bodyStart) : workflow.slice(bodyStart, bodyStart + next);
};

const BUILDS = ['build-macos-unsigned', 'build-windows-unsigned', 'build-linux-unsigned'];

describe('the Rust toolchain', () => {
  test('each build installs the pinned toolchain in its own step, not inside the compile', () => {
    for (const name of BUILDS) {
      const body = job(name);
      const install = body.indexOf('rustup toolchain install "');
      const compileStep = body.lastIndexOf('\n      - name: ', body.indexOf('run-desktop-tauri.mjs'));
      assert.ok(install > 0, `${name}: installs the pinned toolchain`);
      assert.ok(install < compileStep, `${name}: the toolchain step precedes the compile step`);
    }
  });

  test('no build output is cached in this public repository', () => {
    assert.doesNotMatch(workflow, /actions\/cache|Swatinem\/rust-cache|sccache/);
  });
});

describe('MSVC', () => {
  test('installs only the x64 compiler and the Windows SDK the tray links with', () => {
    const build = job('build-windows-unsigned');
    assert.match(build, /'--add', 'Microsoft\.VisualStudio\.Component\.VC\.Tools\.x86\.x64'/);
    assert.match(build, /'--add', 'Microsoft\.VisualStudio\.Component\.Windows11SDK\.22621'/);
    assert.doesNotMatch(build, /Workload\.VCTools|includeRecommended/);
    assert.match(build, /VS_BUILDTOOLS_SHA256/);
  });
});

describe('apt', () => {
  test('every apt-get update reads only the Ubuntu archive', () => {
    const updates = [...workflow.matchAll(/^.*apt-get update.*$/gm)].map((m) => m[0]);
    assert.ok(updates.length >= 2, 'the Linux build and the Linux smoke both update');
    for (const line of updates) {
      assert.match(line, /-o Dir::Etc::SourceParts=/, `${line.trim()} must skip sources.list.d`);
    }
  });

  test('the Ubuntu-only update fails loudly when the image keeps the archive elsewhere', () => {
    for (const name of ['build-linux-unsigned', 'smoke-linux-installers']) {
      const body = job(name);
      const guard = body.indexOf("grep -Eq '^deb .*archive\\.ubuntu\\.com/ubuntu' /etc/apt/sources.list || {");
      assert.ok(guard > 0 && guard < body.indexOf('apt-get update'), `${name} checks /etc/apt/sources.list first`);
    }
  });
});
