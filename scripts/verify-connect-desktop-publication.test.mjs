import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyPublication } from './verify-connect-desktop-publication.mjs';
import { feedFiles } from './desktop-channel.mjs';

const options = { repo: 'example/install', version: '1.2.3', sourceSha: 'a'.repeat(40), channel: 'staging', dryRun: false };
const tag = 'connect-desktop-staging-v1.2.3-aaaaaaaaaaaa';
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const fixtures = (overrides = {}) => async (url) => {
  const route = url.replace('https://api.github.com/repos/example/install/', '');
  const rows = {
    [`releases/tags/${tag}`]: response(null, 404),
    'releases/latest': response({ tag_name: 'cli-1' }),
    'releases/tags/connect-desktop-staging': response(null, 404),
    ...overrides,
  };
  assert.ok(route in rows, `unexpected request: ${route}`);
  return rows[route];
};

test('first publication passes, and an existing versioned release is a retry, not an error', async () => {
  await verifyPublication(options, fixtures());
  await verifyPublication(options, fixtures({ [`releases/tags/${tag}`]: response({}) }));
});

test('lookup authorization and server errors are not interpreted as absence', async () => {
  for (const status of [401, 403, 500]) {
    await assert.rejects(verifyPublication(options, fixtures({ 'releases/latest': response(null, status) })), new RegExp(`HTTP ${status}`));
  }
});

test('dry runs require a valid MSI version and attainable update floor, without release requests', async () => {
  const request = () => assert.fail('dry runs must not require published releases');
  for (const minVersion of ['', '1.2', '1.2.3', '1.2.3.0']) {
    await verifyPublication({ ...options, dryRun: true, minVersion }, request);
  }
  for (const minVersion of ['1.2.4', '1.2.3.1', 'invalid']) {
    await assert.rejects(verifyPublication({ ...options, dryRun: true, minVersion }, request));
  }
  await assert.rejects(verifyPublication({ ...options, dryRun: true, version: '0.256.0' }, request), /MSI limits/);
});

test('a damaged or newer staging feed rejects the build', async () => {
  const assets = [{ name: 'connect-desktop-staging.json' }, { name: 'connect-desktop-staging.json.asc' }];
  const base = {
    'releases/tags/connect-desktop-staging': response({ id: 2, prerelease: true }),
    'releases/2/assets?per_page=100&page=1': response(assets),
    'https://github.com/example/install/releases/download/connect-desktop-staging/connect-desktop-staging.json': response({ version: '1.2.2' }),
  };
  await verifyPublication(options, fixtures(base));
  await assert.rejects(verifyPublication(options, fixtures({ ...base,
    'releases/2/assets?per_page=100&page=1': response([...assets, { name: 'connect-desktop-staging.json.pending' }]),
  })), /needs recovery/);
  await assert.rejects(verifyPublication(options, fixtures({ ...base,
    'https://github.com/example/install/releases/download/connect-desktop-staging/connect-desktop-staging.json': response({ version: '2.0.0' }),
  })), /downgrade/);
});

const stable = { ...options, channel: 'stable' };
const stableFeed = (assets, version = '1.2.2') => ({
  'releases/tags/connect-desktop': response({ id: 9, prerelease: true }),
  'releases/9/assets?per_page=100&page=1': response(assets),
  'https://github.com/example/install/releases/download/connect-desktop/connect-desktop.json': response({ version }),
});
const stableFixtures = (overrides = {}) => fixtures({
  'releases/tags/connect-desktop-v1.2.3-aaaaaaaaaaaa': response(null, 404),
  'releases/tags/connect-desktop': response(null, 404),
  ...overrides,
});

test('stable needs no staging release first', async () => {
  await verifyPublication(stable, stableFixtures());
  await verifyPublication({ ...stable, dryRun: true }, () => assert.fail('dry runs make no requests'));
});

test('an existing stable feed must carry its manifest pair, not every installer', async () => {
  const pair = feedFiles('stable', '1.2.3', []).map(({ name }) => ({ name }));
  await verifyPublication(stable, stableFixtures(stableFeed(pair)));
  for (const dropped of pair) {
    await assert.rejects(verifyPublication(stable, stableFixtures(stableFeed(pair.filter((asset) => asset !== dropped)))),
      (error) => error.message.includes(`missing ${dropped.name}`));
  }
});

test('a newer stable feed rejects the build', async () => {
  const pair = feedFiles('stable', '1.2.3', []).map(({ name }) => ({ name }));
  await assert.rejects(verifyPublication(stable, stableFixtures(stableFeed(pair, '2.0.0'))), /downgrade the connect-desktop feed/);
});

test('an unknown channel fails before any request', async () => {
  const request = () => assert.fail('no request for an unknown channel');
  await assert.rejects(verifyPublication({ ...options, channel: 'production' }, request), /Unknown desktop channel/);
});
