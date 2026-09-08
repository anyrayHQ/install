import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const ownerFields = new Set(['engineOwner', 'engineOwnerPath', 'engineOwnerObservedAt']);
const settings = (profile) => Object.fromEntries(Object.entries(profile).filter(([key]) => !ownerFields.has(key)));
const readProfile = (path) => {
  const profile = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('profile must be an object');
  return profile;
};

export function verifyProfile(beforePath, currentPath, enginePath) {
  const before = readProfile(beforePath);
  const current = readProfile(currentPath);
  if (!isDeepStrictEqual(settings(before), settings(current))) throw new Error('existing CLI settings changed');
  if (current.engineOwner !== 'app') throw new Error('installed app has not adopted engine ownership');
  if (typeof current.engineOwnerPath !== 'string' || !isAbsolute(current.engineOwnerPath) ||
      realpathSync.native(current.engineOwnerPath) !== realpathSync.native(enginePath)) {
    throw new Error('engine owner path does not resolve to the installed engine');
  }
  if (typeof current.engineOwnerObservedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(current.engineOwnerObservedAt) ||
      !Number.isFinite(Date.parse(current.engineOwnerObservedAt)) ||
      new Date(current.engineOwnerObservedAt).toISOString() !== current.engineOwnerObservedAt) {
    throw new Error('engine ownership timestamp is invalid');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 5) throw new Error('usage: verify-desktop-profile.mjs <before> <current> <installed-engine>');
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        verifyProfile(...process.argv.slice(2));
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await setTimeout(500);
      }
    }
    console.log('Desktop engine ownership and existing CLI settings verified');
  } catch (error) {
    console.error(`::error::Desktop profile verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
