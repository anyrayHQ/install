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

test('first publication passes, but duplicate releases fail before building', async () => {
  await verifyPublication(options, fixtures());
  await assert.rejects(verifyPublication(options, fixtures({ [`releases/tags/${tag}`]: response({}) })), /already exists/);
});

test('lookup authorization and server errors are not interpreted as absence', async () => {
  for (const status of [401, 403, 500]) {
    await assert.rejects(verifyPublication(options, fixtures({ [`releases/tags/${tag}`]: response(null, status) })), new RegExp(`HTTP ${status}`));
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
const stagingTag = 'connect-desktop-staging-v1.2.3-aaaaaaaaaaaa';
const stableTag = 'connect-desktop-v1.2.3-aaaaaaaaaaaa';
const stagedOn = (assets = [{ name: 'connect-desktop-staging.json' }, { name: 'connect-desktop-staging.json.asc' }]) => ({
  [`releases/tags/${stagingTag}`]: response({ id: 7 }),
  'releases/7/assets?per_page=100&page=1': response(assets),
  [`releases/tags/${stableTag}`]: response(null, 404),
  'releases/tags/connect-desktop': response(null, 404),
});

test('stable refuses a version and commit that never published on staging, dry runs included', async () => {
  for (const dryRun of [false, true]) {
    await assert.rejects(verifyPublication({ ...stable, dryRun }, fixtures({ [`releases/tags/${stagingTag}`]: response(null, 404) })),
      /publish 1\.2\.3 at this commit on staging first/);
  }
  // Same version from another commit is not the tested build.
  const other = { ...stable, sourceSha: 'b'.repeat(40) };
  await assert.rejects(verifyPublication(other, fixtures({ ...stagedOn(),
    'releases/tags/connect-desktop-staging-v1.2.3-bbbbbbbbbbbb': response(null, 404) })), /on staging first/);
});

test('stable refuses a staging release without its signed manifest pair', async () => {
  await assert.rejects(verifyPublication(stable, fixtures(stagedOn([{ name: 'SHA256SUMS' }]))), /did not finish publishing/);
  // A manifest without its signature is not the signed staging build.
  await assert.rejects(verifyPublication(stable, fixtures(stagedOn([{ name: 'connect-desktop-staging.json' }]))),
    /missing connect-desktop-staging\.json\.asc/);
});

test('an existing stable feed missing any installer fails before the versioned release exists', async () => {
  const full = feedFiles('stable', '1.2.3').map(({ name }) => ({ name }));
  const live = (assets) => ({
    ...stagedOn(),
    'releases/tags/connect-desktop': response({ id: 9, prerelease: true }),
    'releases/9/assets?per_page=100&page=1': response(assets),
    'https://github.com/example/install/releases/download/connect-desktop/connect-desktop.json': response({ version: '1.2.2' }),
  });
  await verifyPublication(stable, fixtures(live(full)));
  for (const dropped of full) {
    await assert.rejects(verifyPublication(stable, fixtures(live(full.filter((asset) => asset !== dropped)))),
      (error) => error.message.includes(`missing ${dropped.name}`));
  }
});

test('stable after staging passes, and checks the stable feed, never the staging one', async () => {
  await verifyPublication(stable, fixtures(stagedOn()));
  await verifyPublication({ ...stable, dryRun: true }, fixtures(stagedOn()));
  await assert.rejects(verifyPublication(stable, fixtures({ ...stagedOn(), [`releases/tags/${stableTag}`]: response({}) })), /already exists/);
  const feed = feedFiles('stable', '1.2.3').map(({ name }) => ({ name }));
  const live = {
    ...stagedOn(),
    'releases/tags/connect-desktop': response({ id: 9, prerelease: true }),
    'releases/9/assets?per_page=100&page=1': response(feed),
    'https://github.com/example/install/releases/download/connect-desktop/connect-desktop.json': response({ version: '2.0.0' }),
  };
  await assert.rejects(verifyPublication(stable, fixtures(live)), /downgrade the connect-desktop feed/);
});

test('an unknown channel fails before any request', async () => {
  const request = () => assert.fail('no request for an unknown channel');
  await assert.rejects(verifyPublication({ ...options, channel: 'production' }, request), /Unknown desktop channel/);
});
