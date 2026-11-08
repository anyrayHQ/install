import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { compareVersions } from './publish-desktop-feed.mjs';
import { channelConfig, feedFiles } from './desktop-channel.mjs';

// GitHub sometimes does not answer: connect 0.11.588 lost its whole prepare to one HTTP 504 on the
// feed download and 0.11.600 to one 30s timeout. A timeout, a network error, a 5xx or a 429 is
// tried three times in all (10s, then 20s apart); any other answer is final, so a 401, 403 or
// 404 still decides at once. Worst case is about two minutes a request, inside the 15-minute job.
const TRIES = 3;
const FIRST_DELAY_MS = 10_000;
const transientStatus = (status) => status === 429 || status >= 500;
const transientError = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError' || error instanceof TypeError;

async function requestWithRetry(request, wait, url, init = {}) {
  for (let attempt = 1, delay = FIRST_DELAY_MS; ; attempt++, delay *= 2) {
    let response;
    try {
      // A fresh signal per attempt: a timed-out one stays aborted.
      response = await request(url, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      if (!transientError(error) || attempt >= TRIES) throw error;
      await wait(delay);
      continue;
    }
    if (!transientStatus(response.status) || attempt >= TRIES) return response;
    await wait(delay);
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export async function verifyPublication({ repo, version, minVersion, channel, dryRun, token }, request = fetch, { wait = sleep } = {}) {
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
  if (dryRun) return;
  const api = async (path, optional = false) => {
    const response = await requestWithRetry(request, wait, `https://api.github.com/repos/${repo}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
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
  // The publishing job preserves latest and therefore requires it to exist.
  await api('releases/latest');
  const release = await api(`releases/tags/${feed}`, true);
  if (!release) return;
  if (!release.prerelease) throw new Error(`${feed} feed is not a prerelease`);
  const assets = await listAssets(release);
  if (assets.some(({ name }) => /\.(previous|pending)$/.test(name))) {
    throw new Error(`${feed} feed needs recovery of previous/pending assets before building`);
  }
  // The manifest pair publishFeed swaps; installer downloads are added per OS as they publish.
  for (const { name } of feedFiles(channel, version, [])) {
    if (!assets.some((asset) => asset.name === name)) throw new Error(`${feed} feed is missing ${name}`);
  }
  // Public asset URL: do not send the GitHub token across download redirects.
  const response = await requestWithRetry(request, wait, `https://github.com/${repo}/releases/download/${feed}/${feed}.json`);
  if (!response.ok) throw new Error(`${feed} feed download: HTTP ${response.status}`);
  const current = await response.json();
  if (compareVersions(current.version, version) > 0) throw new Error(`Refusing to downgrade the ${feed} feed`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await verifyPublication({ repo: process.env.REPO, version: process.env.VERSION,
    minVersion: process.env.MIN_VERSION, channel: process.env.CHANNEL,
    dryRun: process.env.DRY_RUN === 'true', token: process.env.GH_TOKEN });
}
