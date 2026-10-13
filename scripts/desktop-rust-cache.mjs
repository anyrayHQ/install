#!/usr/bin/env node
// The desktop build's Rust dependency cache (release-connect-desktop.yml, all three OSes).
//
//   desktop-rust-cache.mjs key <Cargo.lock>   writes key= and prefix= to $GITHUB_OUTPUT
//   desktop-rust-cache.mjs prune <target dir> removes the private tray's own build output
//
// This repo is public and so is its Actions cache, while the tray is built from private
// source. Only compiled public crates may be saved: the prune keeps a profile dir's build/,
// .fingerprint/ and deps/ minus every connect-tray entry, then proves no tray output is left.
// If it cannot, it deletes the whole target dir and fails, so the save step never runs.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PRIVATE = /^(lib)?connect[-_]tray/;
const KEEP_IN_PROFILE = new Set(['build', '.fingerprint', 'deps']);

// Cargo.lock's registry entries only. The tray is a local package with no source, so its
// per-release version bump leaves the key, and the compiled dependencies, unchanged.
export function lockDigest(text) {
  const registry = text
    .split('[[package]]')
    .slice(1)
    .map((block) => Object.fromEntries([...block.matchAll(/^(name|version|source|checksum) = "([^"]*)"$/gm)].map((m) => [m[1], m[2]])))
    .filter((pkg) => pkg.source)
    .map((pkg) => [pkg.name, pkg.version, pkg.source, pkg.checksum ?? '']);
  return createHash('sha256').update(JSON.stringify(registry)).digest('hex');
}

export function cacheKey(lockPath, env) {
  for (const name of ['RUNNER_OS', 'TARGET_TRIPLE', 'RUST_TOOLCHAIN']) {
    if (!env[name]) throw new Error(`${name} is required to key the Rust dependency cache`);
  }
  const prefix = `connect-desktop-v1-${env.RUNNER_OS}-${env.TARGET_TRIPLE}-${env.RUST_TOOLCHAIN}-`;
  return { key: `${prefix}${lockDigest(readFileSync(lockPath, 'utf8'))}`, prefix };
}

const isProfile = (dir) => [...KEEP_IN_PROFILE].some((name) => existsSync(join(dir, name)));

const pruneProfile = (profile) => {
  for (const entry of readdirSync(profile, { withFileTypes: true })) {
    const path = join(profile, entry.name);
    if (!entry.isDirectory() || !KEEP_IN_PROFILE.has(entry.name)) {
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    for (const item of readdirSync(path)) {
      if (PRIVATE.test(item)) rmSync(join(path, item), { recursive: true, force: true });
    }
  }
};

const pruneTree = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (isProfile(path)) pruneProfile(path);
    else pruneTree(path);
  }
};

const survivors = (dir) => readdirSync(dir, { recursive: true }).filter((path) => PRIVATE.test(path.split(/[\\/]/).pop()));

export function prune(target) {
  if (!existsSync(target)) return;
  pruneTree(target);
  const left = survivors(target);
  if (left.length > 0) {
    rmSync(target, { recursive: true, force: true });
    throw new Error(`private tray build output survived the prune (${left.slice(0, 3).join(', ')}); removed ${target} so no cache can carry it`);
  }
}

const main = ([command, path]) => {
  if (command === 'key' && path) {
    const { key, prefix } = cacheKey(path, process.env);
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
    appendFileSync(process.env.GITHUB_OUTPUT, `key=${key}\nprefix=${prefix}\n`);
    console.log(`Rust dependency cache key ${key}`);
  } else if (command === 'prune' && path) {
    prune(path);
    console.log(`pruned the tray build output from ${path}`);
  } else {
    throw new Error('usage: desktop-rust-cache.mjs key <Cargo.lock> | prune <target dir>');
  }
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exit(1);
  }
}
