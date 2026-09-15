import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const STAGING_ORIGIN = 'https://app-staging.anyray.ai';

export function assertNativeOrigin(source) {
  const origin = source.match(/const STAGING_CONTROL_PLANE_ORIGIN: &str = "([^"]+)";/)?.[1];
  if (origin !== STAGING_ORIGIN) throw new Error('desktop-probe-origin-drift');
}

// Exercise the public edge, including its access policy. Never print the grant,
// callback, browser URL or polling credential. This creates no enrollment.
export async function verifyDesktopBackend(fetchImpl = fetch) {
  const { publicKey } = generateKeyPairSync('ed25519');
  const response = await fetchImpl(`${STAGING_ORIGIN}/sso/desktop/start`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      devPublicKey: publicKey.export({ type: 'spki', format: 'pem' }),
      callback_uri: `ai.anyray.connect://auth/${randomBytes(32).toString('base64url')}`,
    }),
  });
  if (response.status !== 200) throw new Error('backend-rejected-native-sign-in');
  const grant = await response.json();
  if (!grant || typeof grant.id !== 'string' || !grant.id
      || typeof grant.poll_secret !== 'string' || !grant.poll_secret
      || typeof grant.browser_url !== 'string'
      || new URL(grant.browser_url).origin !== STAGING_ORIGIN
      || !/^[BCDFGHJKMNPQRSTVWXYZ23456789]{4}-[BCDFGHJKMNPQRSTVWXYZ23456789]{4}$/.test(grant.user_code)
      || typeof grant.expires_in !== 'number' || !Number.isFinite(grant.expires_in) || !(grant.expires_in > 0)
      || typeof grant.interval !== 'number' || !Number.isFinite(grant.interval) || !(grant.interval > 0)) {
    throw new Error('backend-invalid-native-grant');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.argv[2]) throw new Error('source-checkout-required');
    assertNativeOrigin(readFileSync(resolve(process.argv[2], 'connect-tray/src-tauri/src/main.rs'), 'utf8'));
    await verifyDesktopBackend();
    console.log('Public staging accepts native desktop sign-in.');
  } catch {
    console.error('::error::Staging native desktop sign-in failed. Deploy the matching Billing backend and check public access before releasing desktop.');
    process.exitCode = 1;
  }
}
