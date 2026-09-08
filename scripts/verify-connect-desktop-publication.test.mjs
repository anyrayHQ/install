import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyPublication } from './verify-connect-desktop-publication.mjs';

const options = { repo: 'example/install', version: '1.2.3', sourceSha: 'a'.repeat(40), dryRun: false };
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
