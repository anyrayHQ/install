import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { compareVersions } from './publish-desktop-feed.mjs';
import { channelConfig, releaseTag } from './desktop-channel.mjs';

export async function verifyPublication({ repo, version, sourceSha, minVersion, channel, dryRun, token }, request = fetch) {
  compareVersions(version, version);
  const { feed } = channelConfig(channel);
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
  if (dryRun && channel !== 'stable') return;
  const api = async (path, optional = false) => {
    const response = await request(`https://api.github.com/repos/${repo}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (optional && response.status === 404) return null;
    if (!response.ok) throw new Error(`Publication preflight ${path}: HTTP ${response.status}`);
    return response.json();
  };
  const listAssets = async (release) => {
    // Paginate rather than relying on the release response's embedded asset subset.
    const assets = [];
    for (let page = 1; ; page++) {
      const batch = await api(`releases/${release.id}/assets?per_page=100&page=${page}`);
      assets.push(...batch);
      if (batch.length < 100) break;
    }
    return assets;
  };
  if (channel === 'stable') {
    // Production only ships bytes built from a commit that already built, passed its
    // smokes and published on staging at this exact version. Dry runs included: a
    // rehearsal of a stable build nobody may publish proves nothing.
    const stagingTag = releaseTag('staging', version, sourceSha);
    const staged = await api(`releases/tags/${stagingTag}`, true);
    if (!staged) throw new Error(`Stable requires staging release ${stagingTag}; publish ${version} at this commit on staging first`);
    if (!(await listAssets(staged)).some(({ name }) => name === 'connect-desktop-staging.json')) {
      throw new Error(`Staging release ${stagingTag} has no signed manifest; it did not finish publishing`);
    }
    if (dryRun) return;
  }
  const tag = releaseTag(channel, version, sourceSha);
  if (await api(`releases/tags/${tag}`, true)) {
    throw new Error(`Release ${tag} already exists; use a new version/source, or recover its feed without rebuilding`);
  }
  // The publishing job preserves latest and therefore requires it to exist.
  await api('releases/latest');
  const release = await api(`releases/tags/${feed}`, true);
  if (!release) return;
  if (!release.prerelease) throw new Error(`${feed} feed is not a prerelease`);
  const assets = await listAssets(release);
  if (assets.some(({ name }) => /\.(previous|pending)$/.test(name))) {
    throw new Error(`${feed} feed needs recovery of previous/pending assets before building`);
  }
  for (const name of [`${feed}.json`, `${feed}.json.asc`]) {
    if (!assets.some((asset) => asset.name === name)) throw new Error(`${feed} feed is missing ${name}`);
  }
  // Public asset URL: do not send the GitHub token across download redirects.
  const response = await request(`https://github.com/${repo}/releases/download/${feed}/${feed}.json`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${feed} feed download: HTTP ${response.status}`);
  const current = await response.json();
  if (compareVersions(current.version, version) > 0) throw new Error(`Refusing to downgrade the ${feed} feed`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await verifyPublication({ repo: process.env.REPO, version: process.env.VERSION,
    sourceSha: process.env.SOURCE_SHA, minVersion: process.env.MIN_VERSION, channel: process.env.CHANNEL,
    dryRun: process.env.DRY_RUN === 'true', token: process.env.GH_TOKEN });
}
