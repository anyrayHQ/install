import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const feed = 'connect-desktop-staging';
const names = ['connect-desktop-staging.json', 'connect-desktop-staging.json.asc'];
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

export function compareVersions(left, right) {
  for (const value of [left, right]) {
    if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) {
      throw new Error('Feed versions must be plain x.y.z strings');
    }
  }
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

// Upload both candidates before touching live names. Retain old bytes remotely
// for recovery even if the runner is killed or a rollback API request fails.
export function publishFeed({ repo, version, tag, assetsDir }, run = gh) {
  compareVersions(version, version);
  const api = (path, ...args) => run(['api', `repos/${repo}/${path}`, ...args]);
  const releases = JSON.parse(api('releases', '--paginate', '--slurp')).flat();
  const release = releases.find((item) => item.tag_name === feed);
  const notes = `Updater feed for staging desktop builds. Points at ${tag}. Install from the versioned prerelease.`;
  if (!release) {
    // Listing errors throw; only a successful listing permits first publication.
    run(['release', 'create', feed, '--repo', repo, '--title', 'Anyray Connect desktop staging feed',
      '--notes', notes, '--prerelease', '--latest=false', ...names.map((name) => join(assetsDir, name))]);
    return;
  }
  if (!release.prerelease) throw new Error('Refusing to replace a non-prerelease feed');
  const assets = JSON.parse(api(`releases/${release.id}/assets`, '--paginate', '--slurp')).flat();
  if (assets.some((asset) => /\.(previous|pending)$/.test(asset.name))) {
    throw new Error('Incomplete feed publication: recover previous/pending assets before retrying');
  }
  const previous = names.map((name) => {
    const asset = assets.find((item) => item.name === name);
    if (!asset) throw new Error(`Existing feed is missing ${name}`);
    return asset;
  });
  const current = JSON.parse(api(`releases/assets/${previous[0].id}`, '-H', 'Accept: application/octet-stream'));
  if (compareVersions(current.version, version) > 0) throw new Error('Refusing to downgrade the staging feed');

  const directory = mkdtempSync(join(tmpdir(), 'desktop-feed-'));
  const renames = [];
  const rename = (id, name) => api(`releases/assets/${id}`, '-X', 'PATCH', '-f', `name=${name}`);
  try {
    for (const name of names) copyFileSync(join(assetsDir, name), join(directory, `${name}.pending`));
    run(['release', 'upload', feed, '--repo', repo, ...names.map((name) => join(directory, `${name}.pending`))]);
    const staged = JSON.parse(api(`releases/${release.id}/assets`, '--paginate', '--slurp')).flat();
    const candidates = names.map((name) => {
      const asset = staged.find((item) => item.name === `${name}.pending`);
      if (!asset) throw new Error(`Missing staged asset ${name}`);
      return asset;
    });
    for (let i = 0; i < names.length; i++) {
      // Record before the request: an error response may follow a server-side change.
      renames.push([previous[i].id, names[i]]);
      rename(previous[i].id, `${names[i]}.previous`);
      renames.push([candidates[i].id, `${names[i]}.pending`]);
      rename(candidates[i].id, names[i]);
    }
    const published = JSON.parse(api(`releases/assets/${candidates[0].id}`, '-H', 'Accept: application/octet-stream'));
    if (published.version !== version || published.tag !== tag) throw new Error('Published feed does not match release');
    run(['release', 'edit', feed, '--repo', repo, '--notes', notes, '--prerelease', '--latest=false']);
  } catch (error) {
    const rollbackErrors = [];
    for (const [id, name] of renames.reverse()) {
      try { rename(id, name); } catch (rollbackError) {
        // One failed rename must not prevent independent assets being restored.
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], 'Feed rollback failed; recover retained previous/pending assets before retrying');
    }
    throw error;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  // Only remove backups after the whole switch succeeds. Failed cleanup blocks
  // retries rather than silently discarding recovery state.
  for (const asset of previous) api(`releases/assets/${asset.id}`, '-X', 'DELETE');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  publishFeed({ repo: process.env.REPO, version: process.env.VERSION,
    tag: `connect-desktop-staging-v${process.env.VERSION}-${process.env.SHORT_SHA}`, assetsDir: 'assets' });
}
