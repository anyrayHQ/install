import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const STAGING_ORIGIN = 'https://app-staging.anyray.ai';

const PROBE_LABELS = new Set([
  'origin-drift',
  'source-read-failed',
  'source-checkout-required',
  'transport-failure',
  'backend-rate-limited',
  'backend-temporary-failure',
  'backend-native-sign-in-unavailable',
  'backend-rejected-native-sign-in',
  'unexpected-http-status',
  'backend-invalid-native-grant'
]);
class ProbeFailure extends Error {
  constructor(label, status) {
    super(label);
    this.label = label;
    this.status = status;
  }
}
export function probeDiagnostic(error) {
  if (!(error instanceof ProbeFailure) || !PROBE_LABELS.has(error.label))
    return 'probe-failed';
  const status =
    Number.isInteger(error.status) && error.status >= 100 && error.status <= 599
      ? ` http_status=${error.status}`
      : '';
  return `${error.label}${status}`;
}

export function assertNativeOrigin(source) {
  const origin = source.match(
    /const STAGING_CONTROL_PLANE_ORIGIN: &str = "([^"]+)";/
  )?.[1];
  if (origin !== STAGING_ORIGIN) throw new ProbeFailure('origin-drift');
}

// Exercise the public edge, including its access policy. Never print the grant,
// callback, browser URL or polling credential. This creates no enrollment.
export async function verifyDesktopBackend(fetchImpl = fetch) {
  const { publicKey } = generateKeyPairSync('ed25519');
  let response;
  try {
    response = await fetchImpl(`${STAGING_ORIGIN}/sso/desktop/start`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        devPublicKey: publicKey.export({ type: 'spki', format: 'pem' }),
        callback_uri: `ai.anyray.connect://auth/${randomBytes(32).toString('base64url')}`
      })
    });
  } catch {
    throw new ProbeFailure('transport-failure');
  }
  if (response.status !== 200) {
    const status = response.status;
    const label =
      status === 429
        ? 'backend-rate-limited'
        : status >= 500
          ? 'backend-temporary-failure'
          : status === 404
            ? 'backend-native-sign-in-unavailable'
            : status >= 400
              ? 'backend-rejected-native-sign-in'
              : 'unexpected-http-status';
    throw new ProbeFailure(label, status);
  }
  let grant;
  try {
    grant = await response.json();
  } catch {
    throw new ProbeFailure('backend-invalid-native-grant', response.status);
  }
  try {
    if (
      !grant ||
      typeof grant.id !== 'string' ||
      !grant.id ||
      typeof grant.poll_secret !== 'string' ||
      !grant.poll_secret ||
      typeof grant.browser_url !== 'string' ||
      new URL(grant.browser_url).origin !== STAGING_ORIGIN ||
      !/^[BCDFGHJKMNPQRSTVWXYZ23456789]{4}-[BCDFGHJKMNPQRSTVWXYZ23456789]{4}$/.test(
        grant.user_code
      ) ||
      typeof grant.expires_in !== 'number' ||
      !Number.isFinite(grant.expires_in) ||
      !(grant.expires_in > 0) ||
      typeof grant.interval !== 'number' ||
      !Number.isFinite(grant.interval) ||
      !(grant.interval > 0)
    ) {
      throw new ProbeFailure('backend-invalid-native-grant', response.status);
    }
  } catch {
    throw new ProbeFailure('backend-invalid-native-grant', response.status);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (!process.argv[2]) throw new ProbeFailure('source-checkout-required');
    let source;
    try {
      source = readFileSync(
        resolve(process.argv[2], 'connect-tray/src-tauri/src/main.rs'),
        'utf8'
      );
    } catch {
      throw new ProbeFailure('source-read-failed');
    }
    assertNativeOrigin(source);
    await verifyDesktopBackend();
    console.log('Public staging accepts native desktop sign-in.');
  } catch (error) {
    console.error(
      `::error::Staging native desktop sign-in: ${probeDiagnostic(error)}`
    );
    process.exitCode = 1;
  }
}
