#!/usr/bin/env node

// Validate the private source checkout before any release job executes it.
//
// The install repository is public and its desktop release jobs receive a
// short-lived token for the private monorepo. A syntactically valid commit SHA
// is not enough: a maintainer could otherwise dispatch an arbitrary unreviewed
// commit and let its build.rs execute on a privileged release runner. The
// checkout must be the requested commit, must be reachable from the fetched
// origin/main snapshot, and must carry one version across the CLI and Tauri
// declarations.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const EXTERNAL_BIN = 'binaries/anyray-connect';

const read = (path) => readFileSync(path, 'utf8');

const match = (text, pattern, label, path) => {
  const value = text.match(pattern)?.[1];
  if (!value) {
    throw new Error(`missing ${label} in ${path}`);
  }
  return value;
};

const git = (sourceDir, args) =>
  execFileSync('git', ['-C', sourceDir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

export const readDesktopVersions = (sourceDir) => {
  const connectPackagePath = resolve(sourceDir, 'connect/package.json');
  const cargoPath = resolve(sourceDir, 'connect-tray/src-tauri/Cargo.toml');
  const lockPath = resolve(sourceDir, 'connect-tray/src-tauri/Cargo.lock');
  const tauriPath = resolve(sourceDir, 'connect-tray/src-tauri/tauri.conf.json');

  const connectPackage = JSON.parse(read(connectPackagePath));
  const cargo = read(cargoPath);
  const lock = read(lockPath);
  const tauri = JSON.parse(read(tauriPath));

  const externalBin = tauri.bundle?.externalBin;
  if (
    !Array.isArray(externalBin) ||
    externalBin.length !== 1 ||
    externalBin[0] !== EXTERNAL_BIN
  ) {
    throw new Error(
      `${tauriPath}: bundle.externalBin must be exactly [${JSON.stringify(EXTERNAL_BIN)}]`
    );
  }

  return {
    cli: connectPackage.version,
    cargo: match(
      cargo,
      /\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/,
      'package version',
      cargoPath
    ),
    lock: match(
      lock,
      /\[\[package\]\]\nname = "connect-tray"\nversion = "([^"]+)"/,
      'connect-tray locked version',
      lockPath
    ),
    tauri: tauri.version,
  };
};

export const verifyConnectDesktopSource = ({ sourceDir, version, sourceSha }) => {
  if (!VERSION_RE.test(version ?? '')) {
    throw new Error(`version must be a plain x.y.z version, got ${JSON.stringify(version)}`);
  }
  if (!SHA_RE.test(sourceSha ?? '')) {
    throw new Error(
      `source_sha must be an exact lowercase 40-hex commit SHA, got ${JSON.stringify(sourceSha)}`
    );
  }

  const absoluteSource = resolve(sourceDir);
  const head = git(absoluteSource, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head !== sourceSha) {
    throw new Error(`private checkout drift: requested=${sourceSha} checked-out=${head}`);
  }

  try {
    git(absoluteSource, ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main']);
  } catch {
    throw new Error(
      'private checkout has no refs/remotes/origin/main; checkout must use fetch-depth: 0'
    );
  }

  try {
    git(absoluteSource, [
      'merge-base',
      '--is-ancestor',
      head,
      'refs/remotes/origin/main',
    ]);
  } catch {
    throw new Error(
      `source commit ${head} is not reachable from the fetched private-monorepo origin/main`
    );
  }

  const versions = readDesktopVersions(absoluteSource);
  const drift = Object.entries(versions).filter(([, found]) => found !== version);
  if (drift.length > 0) {
    throw new Error(
      `Connect desktop version drift: expected=${version} ${Object.entries(versions)
        .map(([name, found]) => `${name}=${found ?? '(missing)'}`)
        .join(' ')}`
    );
  }

  return { head, versions };
};

const isMain =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const [sourceDir, version, sourceSha] = process.argv.slice(2);
  if (!sourceDir || !version || !sourceSha) {
    console.error(
      'usage: verify-connect-desktop-source.mjs <private-source-dir> <version> <source-sha>'
    );
    process.exit(2);
  }

  try {
    const result = verifyConnectDesktopSource({ sourceDir, version, sourceSha });
    console.log(
      `verified private desktop source: version=${version} commit=${result.head} reachable-from=origin/main externalBin=${EXTERNAL_BIN}`
    );
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
