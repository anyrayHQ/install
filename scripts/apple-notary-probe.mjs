#!/usr/bin/env node
// Ask Apple's notary API, once a day, whether it still accepts the notarization key
// (apple-notary-probe.yml, ANY-2279). From 2026-11-13 every Connect prepare failed at
// sign-macos with "Error: HTTP status code: 403. A required agreement is missing or has
// expired.": Apple had issued a new Program License Agreement on 2026-10-29 and nobody had
// accepted it. Nobody knew for 36 hours. This finds that within a day, before a release does.
//
// The call is read-only: it lists this team's notary submissions and submits nothing. It
// mints an App Store Connect API token (ES256, the team key RELEASING.md describes) from
// APPLE_NOTARY_KEY (base64 of the .p8), APPLE_NOTARY_KEY_ID and APPLE_NOTARY_ISSUER_ID.
//
// Exit 0 when Apple accepts the key; 1 when it refuses (401/403), when Apple cannot be read
// after three tries, or when the secrets are unset or unreadable. $GITHUB_OUTPUT gets
// verdict=accepted|refused|inconclusive|unconfigured, status and Apple's error code, for the
// report job. This repository is public: the log names the HTTP status and Apple's error
// code only. Never the token, the key, its id, the issuer, or Apple's response body.
import { createPrivateKey, sign } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { request } from 'node:https';
import { pathToFileURL } from 'node:url';

export const NOTARY_URL = 'https://appstoreconnect.apple.com/notary/v2/submissions';
// Apple refuses a token whose exp is more than 20 minutes after its iat.
const TOKEN_SECONDS = 15 * 60;
const TRIES = 3;
const SECRETS = ['APPLE_NOTARY_KEY', 'APPLE_NOTARY_KEY_ID', 'APPLE_NOTARY_ISSUER_ID'];
const CODE = /^[A-Z0-9_.]{1,80}$/;

const b64url = (value) => Buffer.from(value).toString('base64url');

/** The P-256 private key in APPLE_NOTARY_KEY: base64 of the .p8 (RELEASING.md), or the PEM itself. */
export function notaryKey(value) {
  const text = String(value ?? '').trim();
  const pem = text.includes('-----BEGIN') ? text : Buffer.from(text, 'base64').toString('utf8');
  const key = createPrivateKey({ key: pem, format: 'pem' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('ES256 needs a P-256 key');
  }
  return key;
}

/** An App Store Connect API token for a team key: ES256, the raw 64-byte r||s signature. */
export function mintToken({ key, keyId, issuerId, now = Math.floor(Date.now() / 1000) }) {
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = { iss: issuerId, iat: now, exp: now + TOKEN_SECONDS, aud: 'appstoreconnect-v1' };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${input}.${b64url(sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }))}`;
}

/** What an answer says about the key. Apple's error code is kept only when it is a plain code. */
export function classify(status, body) {
  let code = '';
  try {
    const found = JSON.parse(body)?.errors?.[0]?.code;
    if (typeof found === 'string' && CODE.test(found)) code = found;
  } catch {
    // Not JSON: no code to name.
  }
  if (status >= 200 && status < 300) return { verdict: 'accepted', status, code: '' };
  if (status === 401 || status === 403) return { verdict: 'refused', status, code };
  return { verdict: 'inconclusive', status, code };
}

/** One bounded GET; status 0 when nothing answered. Redirects are not followed. */
export function get(url, token, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const req = request(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (body.length < 65_536) body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', () => resolve({ status: 0, body: '' }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
}

export async function main({
  env = process.env,
  get: fetchOnce = get,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  log = (line) => console.log(line),
} = {}) {
  const output = (result) => {
    if (!env.GITHUB_OUTPUT) return;
    appendFileSync(env.GITHUB_OUTPUT, `verdict=${result.verdict}\nstatus=${result.status}\ncode=${result.code}\n`);
  };
  const missing = SECRETS.filter((name) => !env[name]);
  if (missing.length) {
    // Names only, never values.
    log(`::error::the notarization secrets are not set: ${missing.join(' ')} (the release-signing environment, RELEASING.md)`);
    output({ verdict: 'unconfigured', status: 0, code: '' });
    return 1;
  }
  let key;
  try {
    key = notaryKey(env.APPLE_NOTARY_KEY);
  } catch (err) {
    // A code-shaped label only: an error's message can quote what it failed to parse.
    const label = typeof err?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(err.code) ? err.code : 'unreadable';
    log(`::error::APPLE_NOTARY_KEY is not a readable P-256 private key (${label}); set it again from the original .p8 (RELEASING.md)`);
    output({ verdict: 'unconfigured', status: 0, code: '' });
    return 1;
  }

  let result;
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    // A fresh token each try: it is short-lived by design.
    const token = mintToken({ key, keyId: env.APPLE_NOTARY_KEY_ID, issuerId: env.APPLE_NOTARY_ISSUER_ID });
    const answer = await fetchOnce(NOTARY_URL, token);
    result = classify(answer.status, answer.body);
    if (result.verdict !== 'inconclusive') break;
    if (attempt < TRIES) {
      log(`Apple's notary API answered ${result.status ? `HTTP ${result.status}` : 'nothing'}; trying again`);
      await sleep(attempt * 15_000);
    }
  }
  output(result);
  const why = `HTTP ${result.status}${result.code ? `, ${result.code}` : ''}`;
  if (result.verdict === 'accepted') {
    log(`Apple's notary API accepted the notarization key (${why}).`);
    return 0;
  }
  if (result.verdict === 'refused') {
    log(`::error::Apple's notary API refused the notarization key (${why}). Every macOS notarization (sign-macos) fails until this is fixed, so no Connect can be prepared or released. If an agreement is pending, the Account Holder must accept the pending agreement at https://developer.apple.com/account (on 2026-11-13 a new Program License Agreement stopped every prepare for 36 hours). If none is pending, the key was revoked or is wrong: rotate the key (a new Team key, then APPLE_NOTARY_KEY, APPLE_NOTARY_KEY_ID and APPLE_NOTARY_ISSUER_ID in the release-signing environment, RELEASING.md).`);
    return 1;
  }
  log(`::error::Apple's notary API could not be checked (${result.status ? `HTTP ${result.status}` : 'no answer'}) after ${TRIES} tries; this says nothing about the key.`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code; });
}
