import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NOTARY_URL, classify, main, mintToken, notaryKey } from './apple-notary-probe.mjs';

// The daily probe of Apple's notary API (ANY-2279). From 2026-11-13 every Connect prepare
// failed at sign-macos with "Error: HTTP status code: 403. A required agreement is missing
// or has expired." and nobody knew for 36 hours. Every key here is a throwaway generated for
// the test; no request reaches Apple.
const throwaway = (namedCurve = 'prime256v1') => generateKeyPairSync('ec', { namedCurve });
const pemOf = (privateKey) => privateKey.export({ format: 'pem', type: 'pkcs8' });
const b64 = (s) => Buffer.from(s).toString('base64');
const part = (jwt, i) => JSON.parse(Buffer.from(jwt.split('.')[i], 'base64url').toString('utf8'));

const KEY_ID = 'SYNTHKEY01';
const ISSUER = '00000000-0000-4000-8000-000000000001';
const APPLE_403 = JSON.stringify({ errors: [{ status: '403', code: 'FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED', title: 'A required agreement is missing or has expired.', detail: 'This request requires an in-effect agreement that has not been signed or has expired.' }] });

test('the token is an ES256 App Store Connect token for the team key, valid under 20 minutes, and verifies', () => {
  const { privateKey, publicKey } = throwaway();
  const jwt = mintToken({ key: notaryKey(b64(pemOf(privateKey))), keyId: KEY_ID, issuerId: ISSUER, now: 1_800_000_000 });
  assert.deepEqual(part(jwt, 0), { alg: 'ES256', kid: KEY_ID, typ: 'JWT' });
  const payload = part(jwt, 1);
  assert.deepEqual(payload, { iss: ISSUER, iat: 1_800_000_000, exp: payload.exp, aud: 'appstoreconnect-v1' });
  assert.ok(payload.exp > payload.iat && payload.exp - payload.iat <= 20 * 60, 'Apple refuses a token valid for more than 20 minutes');
  const [h, p, s] = jwt.split('.');
  const signature = Buffer.from(s, 'base64url');
  // ES256 is the raw 64-byte r||s, not DER.
  assert.equal(signature.length, 64);
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature));
});

test('the key is read as RELEASING.md stores it (base64 of the .p8), or as the PEM itself; anything else is refused', () => {
  const { privateKey } = throwaway();
  assert.equal(notaryKey(b64(pemOf(privateKey))).asymmetricKeyType, 'ec');
  assert.equal(notaryKey(pemOf(privateKey)).asymmetricKeyType, 'ec');
  // ES256 is P-256 only.
  assert.throws(() => notaryKey(b64(pemOf(throwaway('secp384r1').privateKey))), /P-256/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.throws(() => notaryKey(b64(pemOf(rsa))), /P-256/);
  assert.throws(() => notaryKey(b64('not a key')));
  assert.throws(() => notaryKey(''));
});

test('only a 2xx accepts; 401 and 403 refuse; anything else proves nothing about the key', () => {
  assert.deepEqual(classify(200, '{"data":[]}'), { verdict: 'accepted', status: 200, code: '' });
  assert.deepEqual(classify(403, APPLE_403), { verdict: 'refused', status: 403, code: 'FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED' });
  assert.deepEqual(classify(401, '{"errors":[{"code":"NOT_AUTHORIZED"}]}'), { verdict: 'refused', status: 401, code: 'NOT_AUTHORIZED' });
  for (const status of [0, 404, 429, 500, 503]) assert.equal(classify(status, '').verdict, 'inconclusive', String(status));
  // Apple's code is the one field ever repeated, and only when it is a plain code.
  assert.equal(classify(403, '{"errors":[{"code":"::set-output name=x::1"}]}').code, '');
  assert.equal(classify(403, '<html>').code, '');
  assert.equal(classify(403, JSON.stringify({ errors: [{ code: 'A'.repeat(81) }] })).code, '');
});

// main() with a fake transport: what it asks, what it prints, what it writes for the report job.
async function probe(t, answers, envOver = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'notary-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { privateKey } = throwaway();
  const env = {
    APPLE_NOTARY_KEY: b64(pemOf(privateKey)),
    APPLE_NOTARY_KEY_ID: KEY_ID,
    APPLE_NOTARY_ISSUER_ID: ISSUER,
    GITHUB_OUTPUT: join(dir, 'out'),
    ...envOver,
  };
  const calls = [];
  const lines = [];
  const sleeps = [];
  const code = await main({
    env,
    get: async (url, token) => {
      calls.push({ url, token });
      const next = answers[Math.min(calls.length, answers.length) - 1];
      return typeof next === 'number' ? { status: next, body: '' } : next;
    },
    sleep: async (ms) => { sleeps.push(ms); },
    log: (line) => lines.push(line),
  });
  let outputs = {};
  try {
    outputs = Object.fromEntries(readFileSync(env.GITHUB_OUTPUT, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  } catch { /* nothing written */ }
  const out = lines.join('\n');
  for (const c of calls) assert.ok(!out.includes(c.token), 'the token never reaches the log');
  assert.ok(!out.includes(KEY_ID) && !out.includes(ISSUER), 'the key id and issuer never reach the log');
  assert.ok(!env.APPLE_NOTARY_KEY || !out.includes(env.APPLE_NOTARY_KEY), 'the key never reaches the log');
  return { code, calls, out, outputs, sleeps };
}

test('an accepted key: one read-only call with the token, exit 0, verdict accepted', async (t) => {
  const r = await probe(t, [{ status: 200, body: '{"data":[{"id":"synthetic","attributes":{"name":"anyray-connect.zip"}}]}' }]);
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, NOTARY_URL);
  assert.equal(NOTARY_URL, 'https://appstoreconnect.apple.com/notary/v2/submissions');
  assert.equal(r.calls[0].token.split('.').length, 3);
  assert.deepEqual(r.outputs, { verdict: 'accepted', status: '200', code: '' });
  assert.match(r.out, /accepted the notarization key \(HTTP 200\)/);
  assert.doesNotMatch(r.out, /synthetic|anyray-connect\.zip/, 'the submissions list is never printed');
});

test('a refused key (2026-11-13: Apple\'s 403) fails at once, naming the Account Holder and developer.apple.com', async (t) => {
  const r = await probe(t, [{ status: 403, body: APPLE_403 }, 200]);
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 1, 'a refusal is not retried');
  assert.deepEqual(r.outputs, { verdict: 'refused', status: '403', code: 'FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED' });
  assert.match(r.out, /^::error::Apple's notary API refused the notarization key \(HTTP 403, FORBIDDEN\.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED\)/m);
  assert.match(r.out, /Account Holder must accept the pending agreement at https:\/\/developer\.apple\.com\/account/);
  assert.match(r.out, /rotate the key/);
  assert.doesNotMatch(r.out, /in-effect agreement that has not been signed/, 'Apple\'s detail text is not repeated');
  const unauthorized = await probe(t, [{ status: 401, body: '' }]);
  assert.equal(unauthorized.code, 1);
  assert.equal(unauthorized.outputs.verdict, 'refused');
});

test('Apple down or unreachable: three tries, then a failure that leaves the key\'s verdict alone', async (t) => {
  const recovered = await probe(t, [503, 0, 200]);
  assert.equal(recovered.code, 0);
  assert.equal(recovered.calls.length, 3);
  assert.equal(recovered.outputs.verdict, 'accepted');
  assert.equal(recovered.sleeps.length, 2);
  const down = await probe(t, [503, 0, 500, 200]);
  assert.equal(down.code, 1);
  assert.equal(down.calls.length, 3);
  assert.equal(down.outputs.verdict, 'inconclusive');
  assert.match(down.out, /^::error::Apple's notary API could not be checked \(HTTP 500\) after 3 tries; this says nothing about the key\./m);
});

test('unset or unreadable secrets: no request, a failure naming only what is missing', async (t) => {
  const unset = await probe(t, [200], { APPLE_NOTARY_KEY_ID: '', APPLE_NOTARY_ISSUER_ID: '' });
  assert.equal(unset.code, 1);
  assert.equal(unset.calls.length, 0);
  assert.equal(unset.outputs.verdict, 'unconfigured');
  assert.match(unset.out, /^::error::the notarization secrets are not set: APPLE_NOTARY_KEY_ID APPLE_NOTARY_ISSUER_ID/m);
  const garbled = await probe(t, [200], { APPLE_NOTARY_KEY: b64('-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----\n') });
  assert.equal(garbled.code, 1);
  assert.equal(garbled.calls.length, 0);
  assert.equal(garbled.outputs.verdict, 'unconfigured');
  assert.match(garbled.out, /^::error::APPLE_NOTARY_KEY is not a readable P-256 private key/m);
});

// ---- .github/workflows/apple-notary-probe.yml ----

const WORKFLOW = readFileSync(new URL('../.github/workflows/apple-notary-probe.yml', import.meta.url), 'utf8');
const jobBody = (id) => {
  const body = WORKFLOW.slice(WORKFLOW.indexOf('\njobs:\n'));
  const headers = [...body.matchAll(/^ {2}([a-z0-9-]+):\n/gm)];
  const at = headers.findIndex((m) => m[1] === id);
  assert.notEqual(at, -1, `no job ${id}`);
  return body.slice(headers[at].index, headers[at + 1]?.index);
};
const RUNNER = '    runs-on: codebuild-anyray-install-runner-${{ github.run_id }}-${{ github.run_attempt }}\n';

test('workflow: daily and on dispatch; the probe runs on the install runner inside release-signing', () => {
  assert.match(WORKFLOW, /\non:\n {2}schedule:\n {4}- cron: '\d+ \d+ \* \* \*'[^\n]*\n {2}workflow_dispatch:\n\n/);
  assert.match(WORKFLOW, /\npermissions:\n {2}contents: read\n\n/);
  const probeJob = jobBody('probe');
  assert.ok(probeJob.includes(RUNNER), 'AWS CodeBuild, never a GitHub-hosted runner');
  assert.match(probeJob, /\n {4}environment: release-signing\n/);
  assert.match(probeJob, /\n {4}permissions:\n {6}contents: read\n {4}outputs:/);
  assert.match(probeJob, /persist-credentials: false/);
  assert.match(probeJob, /\n {8}run: node scripts\/apple-notary-probe\.mjs\n/);
});

test('workflow: the report holds no Apple secret and runs only on a verdict about the key', () => {
  const report = jobBody('report');
  assert.ok(report.includes(RUNNER));
  assert.doesNotMatch(report, /secrets\.|environment:/);
  assert.match(report, /\n {4}needs: probe\n/);
  assert.match(report, /\n {4}permissions:\n {6}contents: read\n {6}issues: write\n/);
  const cond = /\n {4}if: \$\{\{ (.*) \}\}\n/.exec(report)?.[1];
  assert.ok(cond, 'report has an if:');
  const runs = (verdict, cancelled = false) => new Function('needs', 'cancelled', `return (${cond});`)({ probe: { outputs: { verdict } } }, () => cancelled);
  assert.equal(runs('refused'), true);
  assert.equal(runs('accepted'), true);
  for (const verdict of ['inconclusive', 'unconfigured', '']) assert.equal(runs(verdict), false, verdict);
  assert.equal(runs('refused', true), false);
});

const issueScript = (() => {
  const report = jobBody('report');
  const at = report.indexOf('          script: |\n');
  assert.notEqual(at, -1, 'no github-script body');
  const out = [];
  for (const line of report.slice(at + '          script: |\n'.length).split('\n')) {
    if (line.trim() !== '' && !line.startsWith('            ')) break;
    out.push(line.slice(12));
  }
  return out.join('\n');
})();
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
async function report(env, items = []) {
  assert.ok(issueScript.includes("const LABEL = 'apple-notary-refused'"), 'the real workflow script was extracted');
  const writes = [];
  const issues = { listForRepo: async () => ({ data: items }) };
  for (const method of ['createComment', 'update', 'createLabel', 'create']) issues[method] = async (args) => writes.push({ method, ...args });
  const saved = { ...process.env };
  Object.assign(process.env, { RUN_URL: 'https://github.invalid/anyrayHQ/install/actions/runs/1', STATUS: '', CODE: '', ...env });
  try {
    await new AsyncFunction('github', 'context', issueScript)({ rest: { issues } }, { repo: { owner: 'anyrayHQ', repo: 'install' } });
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  return writes;
}
const refused = { VERDICT: 'refused', STATUS: '403', CODE: 'FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED' };

test('issue: the first refusal opens one labelled issue that says what to do', async () => {
  const writes = await report(refused);
  assert.deepEqual(writes.map((w) => w.method), ['createLabel', 'create']);
  const created = writes[1];
  assert.deepEqual(created.labels, ['apple-notary-refused']);
  for (const part of ['HTTP 403, FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED', 'Account Holder', 'https://developer.apple.com/account', 'release-signing', 'closes itself']) {
    assert.ok(created.body.includes(part), part);
  }
});

test('issue: a refusal while it is open comments; an acceptance closes it; nothing else writes', async () => {
  const items = [{ number: 3, pull_request: {} }, { number: 4 }];
  const again = await report(refused, items);
  assert.deepEqual(again.map((w) => [w.method, w.issue_number]), [['createComment', 4]]);
  assert.match(again[0].body, /^Still refused: HTTP 403/);
  const closed = await report({ VERDICT: 'accepted', STATUS: '200' }, items);
  assert.deepEqual(closed.map((w) => [w.method, w.issue_number]), [['createComment', 4], ['update', 4]]);
  assert.equal(closed[1].state, 'closed');
  assert.deepEqual(await report({ VERDICT: 'accepted', STATUS: '200' }), []);
  assert.deepEqual(await report({ VERDICT: 'accepted', STATUS: '200' }, [{ number: 3, pull_request: {} }]), [], 'a labelled PR is never the issue');
  for (const VERDICT of ['inconclusive', 'unconfigured', '']) assert.deepEqual(await report({ ...refused, VERDICT }, items), [], VERDICT);
});

test('issue: only a code-shaped Apple code and a numeric status reach this public repo\'s issue', async () => {
  const [, created] = await report({ VERDICT: 'refused', STATUS: '403<b>', CODE: 'x](https://evil.invalid) <img>' });
  assert.doesNotMatch(created.body, /evil\.invalid|<img>|<b>/);
  assert.match(created.body, /was refused \(HTTP \?\)/);
});
