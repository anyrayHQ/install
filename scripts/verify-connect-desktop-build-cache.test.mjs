import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

// The desktop build reuses compiled public crates across runs (GitHub's own cache actions,
// pruned of the private tray before every save) and skips work that never changes the output:
// the whole VCTools workload, and an apt source no job installs from.

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
const RESTORE = 'actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0';
const SAVE = 'actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0';
const PATHS = /path: \|\n\s+~\/\.cargo\/registry\/index\n\s+~\/\.cargo\/registry\/cache\n\s+private-source\/connect-tray\/src-tauri\/target\n/;

const stepAt = (body, index) => {
  const end = body.indexOf('\n      - ', index + 1);
  return end === -1 ? body.slice(index) : body.slice(index, end);
};

describe('the Rust dependency cache', () => {
  for (const name of BUILDS) {
    test(`${name} restores compiled public crates after the toolchain and before the compile`, () => {
      const body = job(name);
      const toolchain = body.indexOf('rustup toolchain install "');
      const key = body.indexOf('node scripts/desktop-rust-cache.mjs key private-source/connect-tray/src-tauri/Cargo.lock');
      const restore = body.indexOf(`uses: ${RESTORE}`);
      const compile = body.indexOf('run-desktop-tauri.mjs');
      assert.ok(toolchain > 0, 'installs the pinned toolchain');
      assert.ok(key > toolchain && restore > key, 'keys after the toolchain, restores after the key');
      assert.ok(compile > restore, 'the compile runs on the restored cache');
      const step = stepAt(body, restore);
      assert.match(step, PATHS);
      assert.match(step, /key: \$\{\{ steps\.rust-cache-key\.outputs\.key \}\}/);
      assert.match(step, /restore-keys: \$\{\{ steps\.rust-cache-key\.outputs\.prefix \}\}/);
    });

    test(`${name} prunes the private tray output, then saves from main only on a miss`, () => {
      const body = job(name);
      const compile = body.indexOf('run-desktop-tauri.mjs');
      const prune = body.indexOf('node scripts/desktop-rust-cache.mjs prune private-source/connect-tray/src-tauri/target');
      const save = body.indexOf(`uses: ${SAVE}`);
      assert.ok(prune > compile, 'prunes after the build');
      assert.ok(save > prune, 'saves after the prune');
      // The prune runs even after a failure; the save never follows a failed prune.
      assert.match(stepAt(body, body.lastIndexOf('\n      - ', prune)), /if: \$\{\{ always\(\) \}\}/);
      const step = stepAt(body, save);
      assert.match(step, PATHS);
      assert.match(step, /key: \$\{\{ steps\.rust-cache-key\.outputs\.key \}\}/);
      const condition = body.slice(body.lastIndexOf('\n      - ', save), save);
      assert.match(condition, /if: \$\{\{ github\.ref == 'refs\/heads\/main' && steps\.rust-cache\.outputs\.cache-hit != 'true' \}\}/);
      assert.doesNotMatch(condition, /always\(\)|failure\(\)|cancelled\(\)/);
      // Nothing reads the target dir after the prune but the save itself.
      const after = body.indexOf('\n      - ', save + 1);
      assert.ok(after === -1 || body.indexOf('connect-tray/src-tauri/target', after) === -1);
    });
  }

  test('each build installs the pinned toolchain in its own step, not inside the compile', () => {
    for (const name of BUILDS) {
      const body = job(name);
      const install = body.indexOf('rustup toolchain install "');
      const compileStep = body.lastIndexOf('\n      - name: ', body.indexOf('run-desktop-tauri.mjs'));
      assert.ok(install < compileStep, `${name}: the toolchain step precedes the compile step`);
    }
  });

  test('no third-party cache action: the repo allows only GitHub-owned actions plus a short list', () => {
    assert.doesNotMatch(workflow, /Swatinem\/rust-cache|mozilla-actions\/sccache/);
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
