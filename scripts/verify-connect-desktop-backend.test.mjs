import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicKey } from 'node:crypto';
import { verifyDesktopBackend, STAGING_ORIGIN, assertNativeOrigin } from './verify-connect-desktop-backend.mjs';

test('probes native callback acceptance with a real key and private random path', async () => {
  await verifyDesktopBackend(async (url, options) => {
    assert.equal(url, `${STAGING_ORIGIN}/sso/desktop/start`);
    assert.equal(options.redirect, 'error');
    const request = JSON.parse(options.body);
    assert.match(request.callback_uri, /^ai\.anyray\.connect:\/\/auth\/[A-Za-z0-9_-]{43}$/);
    assert.equal(createPublicKey(request.devPublicKey).asymmetricKeyType, 'ed25519');
    return Response.json({ id: 'fixture', poll_secret: 'fixture', browser_url: `${STAGING_ORIGIN}/sso/desktop`, user_code: 'BCDF-GHJK', interval: 2, expires_in: 600 });
  });
});

test('blocks an old backend, edge denial, redirect and malformed success', async () => {
  for (const status of [400, 403, 404, 503]) {
    await assert.rejects(verifyDesktopBackend(async () => Response.json({}, { status })));
  }
  await assert.rejects(verifyDesktopBackend(async () => Response.json({})));
  await assert.rejects(verifyDesktopBackend(async () => { throw new TypeError('fixture transport failure'); }));
});

test('the checked-out app and release probe must use the same staging origin', () => {
  assertNativeOrigin(`const STAGING_CONTROL_PLANE_ORIGIN: &str = "${STAGING_ORIGIN}";`);
  assert.throws(() => assertNativeOrigin('const STAGING_CONTROL_PLANE_ORIGIN: &str = "https://other.example";'));
});
