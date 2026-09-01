import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { verifyConnectDesktopSource } from './verify-connect-desktop-source.mjs';

const VERSION = '1.2.3';

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const writeFixture = (dir, { externalBin = ['binaries/anyray-connect'] } = {}) => {
  mkdirSync(join(dir, 'connect'), { recursive: true });
  mkdirSync(join(dir, 'connect-tray/src-tauri'), { recursive: true });
  writeFileSync(
    join(dir, 'connect/package.json'),
    `${JSON.stringify({ version: VERSION }, null, 2)}\n`
  );
  writeFileSync(
    join(dir, 'connect-tray/src-tauri/Cargo.toml'),
    `[package]\nname = "connect-tray"\nversion = "${VERSION}"\n`
  );
  writeFileSync(
    join(dir, 'connect-tray/src-tauri/Cargo.lock'),
    `[[package]]\nname = "connect-tray"\nversion = "${VERSION}"\n`
  );
  writeFileSync(
    join(dir, 'connect-tray/src-tauri/tauri.conf.json'),
    `${JSON.stringify(
      { version: VERSION, bundle: { externalBin } },
      null,
      2
    )}\n`
  );
};

const repositoryFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-source-contract-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  writeFixture(dir);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'fixture');
  const sha = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'update-ref', 'refs/remotes/origin/main', sha);
  return { dir, sha };
};

describe('private Connect desktop source contract', () => {
  test('accepts the exact versioned commit reachable from origin/main', () => {
    const { dir, sha } = repositoryFixture();
    const result = verifyConnectDesktopSource({
      sourceDir: dir,
      version: VERSION,
      sourceSha: sha,
    });
    assert.equal(result.head, sha);
    assert.deepEqual(result.versions, {
      cli: VERSION,
      cargo: VERSION,
      lock: VERSION,
      tauri: VERSION,
    });
  });

  test('rejects a commit that is not reachable from origin/main', () => {
    const { dir } = repositoryFixture();
    writeFileSync(join(dir, 'unreviewed.txt'), 'not on main\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'unreviewed');
    const unreviewed = git(dir, 'rev-parse', 'HEAD');

    assert.throws(
      () =>
        verifyConnectDesktopSource({
          sourceDir: dir,
          version: VERSION,
          sourceSha: unreviewed,
        }),
      /not reachable from .*origin\/main/
    );
  });

  test('rejects version drift before source can execute', () => {
    const { dir, sha } = repositoryFixture();
    assert.throws(
      () =>
        verifyConnectDesktopSource({
          sourceDir: dir,
          version: '1.2.4',
          sourceSha: sha,
        }),
      /version drift.*expected=1\.2\.4/
    );
  });

  test('rejects an externalBin contract that would omit the engine', () => {
    const { dir } = repositoryFixture();
    writeFixture(dir, { externalBin: [] });
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'break externalBin');
    const sha = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'update-ref', 'refs/remotes/origin/main', sha);

    assert.throws(
      () => verifyConnectDesktopSource({ sourceDir: dir, version: VERSION, sourceSha: sha }),
      /bundle\.externalBin must be exactly/
    );
  });

  test('requires explicit stable versions and full lowercase SHAs', () => {
    const { dir, sha } = repositoryFixture();
    assert.throws(
      () => verifyConnectDesktopSource({ sourceDir: dir, version: 'latest', sourceSha: sha }),
      /plain x\.y\.z/
    );
    assert.throws(
      () =>
        verifyConnectDesktopSource({
          sourceDir: dir,
          version: VERSION,
          sourceSha: sha.slice(0, 12),
        }),
      /exact lowercase 40-hex/
    );
  });
});
