import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { compareVersions } from './publish-desktop-feed.mjs';

export async function verifyPublication({ repo, version, sourceSha, minVersion, dryRun, token }, request = fetch) {
  compareVersions(version, version);
  const components = version.split('.').map(Number);
  if (components.some((value, i) => value > [255, 255, 65535][i])) {
    throw new Error('Version exceeds Windows MSI limits (255.255.65535)');
  }
  if (minVersion) {
    if (!/^\d+(\.\d+){1,3}$/.test(minVersion)) throw new Error('Invalid min_version');
    const minimum = minVersion.split('.').map(BigInt);
    const release = version.split('.').map(BigInt);
    for (let i = 0; i < Math.max(minimum.length, release.length); i++) {
      const left = minimum[i] ?? 0n;
      const right = release[i] ?? 0n;
      if (left > right) throw new Error('min_version cannot exceed the version being released');
      if (left < right) break;
    }
  }
  if (dryRun) return;
  const api = async (path, optional = false) => {
    const response = await request(`https://api.github.com/repos/${repo}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (optional && response.status === 404) return null;
    if (!response.ok) throw new Error(`Publication preflight ${path}: HTTP ${response.status}`);
    return response.json();
  };
  const tag = `connect-desktop-staging-v${version}-${sourceSha.slice(0, 12)}`;
  if (await api(`releases/tags/${tag}`, true)) {
    throw new Error(`Release ${tag} already exists; use a new version/source, or recover its feed without rebuilding`);
  }
  // The publishing job preserves latest and therefore requires it to exist.
  await api('releases/latest');
  const feed = await api('releases/tags/connect-desktop-staging', true);
  if (!feed) return;
  if (!feed.prerelease) throw new Error('Staging feed is not a prerelease');
  // Paginate rather than relying on the release response's embedded asset subset.
  const assets = [];
  for (let page = 1; ; page++) {
    const batch = await api(`releases/${feed.id}/assets?per_page=100&page=${page}`);
    assets.push(...batch);
    if (batch.length < 100) break;
  }
  if (assets.some(({ name }) => /\.(previous|pending)$/.test(name))) {
    throw new Error('Staging feed needs recovery of previous/pending assets before building');
  }
  for (const name of ['connect-desktop-staging.json', 'connect-desktop-staging.json.asc']) {
    if (!assets.some((asset) => asset.name === name)) throw new Error(`Staging feed is missing ${name}`);
  }
  const manifest = assets.find(({ name }) => name === 'connect-desktop-staging.json');
  // Public asset URL: do not send the GitHub token across download redirects.
  const response = await request(`https://github.com/${repo}/releases/download/connect-desktop-staging/${manifest.name}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Staging feed download: HTTP ${response.status}`);
  const current = await response.json();
  if (compareVersions(current.version, version) > 0) throw new Error('Refusing to downgrade the staging feed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await verifyPublication({ repo: process.env.REPO, version: process.env.VERSION,
    sourceSha: process.env.SOURCE_SHA, minVersion: process.env.MIN_VERSION,
    dryRun: process.env.DRY_RUN === 'true', token: process.env.GH_TOKEN });
}
