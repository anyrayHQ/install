import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const setup = join(repo, 'setup.sh');
const token = 'arr_synthetic-region.synthetic-secret-for-tests';
const host = 'eu.anyray.example.com';

const run = (args, { env = {}, cwd = mkdtempSync(join(tmpdir(), 'setup-region-')) } = {}) => {
  const { ANYRAY_REGION_TOKEN: _, ...base } = process.env;
  const r = spawnSync('bash', [setup, ...args], { cwd, env: { ...base, ...env }, encoding: 'utf8' });
  return { ...r, cwd, out: r.stdout + r.stderr };
};
const secretKeys = dir => Object.fromEntries(
  readFileSync(join(dir, 'anyray-secrets.yaml'), 'utf8').split(/^data:\n/m)[1].trim().split('\n')
    .map(l => l.trim().split(/:\s*/)).map(([k, v]) => [k, Buffer.from(v, 'base64').toString()]));

test('region mode writes a Secret with only the region keys and a region values file', () => {
  const r = run(['--k8s', '--region', '--host', host], { env: { ANYRAY_REGION_TOKEN: token } });
  assert.equal(r.status, 0, r.out);
  const keys = secretKeys(r.cwd);
  assert.deepEqual(Object.keys(keys).sort(), ['ANYRAY_OPTIMIZER_TOKEN', 'ANYRAY_REGION_TOKEN', 'POSTGRES_PASSWORD']);
  assert.equal(keys.ANYRAY_REGION_TOKEN, token);
  assert.match(keys.ANYRAY_OPTIMIZER_TOKEN, /^[0-9a-f]{64}$/);
  assert.match(keys.POSTGRES_PASSWORD, /^[0-9a-f]{32}$/);
  assert.equal(statSync(join(r.cwd, 'anyray-secrets.yaml')).mode & 0o777, 0o600);
  const values = readFileSync(join(r.cwd, 'my-values.yaml'), 'utf8');
  assert.match(values, /^topology: region$/m);
  assert.match(values, new RegExp(`^host: "${host}"$`, 'm'));
  assert.match(values, /^ingress:\n {2}enabled: true$/m);
  assert.match(values, /^image:\n {2}tag: policy-stable$/m);
  assert.ok(!r.out.includes(token), 'the region token must not be printed');
});

test('two region runs generate different optimizer tokens', () => {
  const a = secretKeys(run(['--k8s', '--region', '--host', host], { env: { ANYRAY_REGION_TOKEN: token } }).cwd);
  const b = secretKeys(run(['--k8s', '--region', '--host', host], { env: { ANYRAY_REGION_TOKEN: token } }).cwd);
  assert.notEqual(a.ANYRAY_OPTIMIZER_TOKEN, b.ANYRAY_OPTIMIZER_TOKEN);
});

test('region mode reads the token from a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-region-'));
  writeFileSync(join(dir, 'region-token'), `${token}\n`);
  const r = run(['--k8s', '--region', '--host', host, '--region-token-file', 'region-token'], { cwd: dir });
  assert.equal(r.status, 0, r.out);
  assert.equal(secretKeys(dir).ANYRAY_REGION_TOKEN, token);
});

test('region mode sets the namespace on the Secret', () => {
  const r = run(['--k8s', '--region', '--host', host, '--namespace', 'anyray-eu'], { env: { ANYRAY_REGION_TOKEN: token } });
  assert.equal(r.status, 0, r.out);
  assert.match(readFileSync(join(r.cwd, 'anyray-secrets.yaml'), 'utf8'), /^ {2}namespace: anyray-eu$/m);
});

test('region mode refuses what would put home settings or secrets in a region', () => {
  for (const extra of [
    ['--connect', 'adt_synthetic0000000000'],
    ['--claim', 'https://app.anyray.ai/install/aic_synthetic_claim_for_tests'],
    ['--attach'],
    ['--upstream', 'http://upstream.internal'],
    ['--gateway-url', 'https://other.example.com'],
    ['--control-plane', 'https://cp.example.com'],
    ['--json'],
  ]) {
    const r = run(['--k8s', '--region', '--host', host, ...extra], { env: { ANYRAY_REGION_TOKEN: token } });
    assert.notEqual(r.status, 0, extra.join(' '));
    assert.match(r.stderr, new RegExp(`--region cannot be combined with ${extra[0]}`), extra.join(' '));
    assert.ok(!existsSync(join(r.cwd, 'anyray-secrets.yaml')), extra.join(' '));
  }
});

test('region mode refuses a missing, malformed or command-line token', () => {
  for (const [args, env, message] of [
    [['--k8s', '--region', '--host', host], {}, /ANYRAY_REGION_TOKEN.*--region-token-file/],
    [['--k8s', '--region', '--host', host], { ANYRAY_REGION_TOKEN: 'arr_synthetic' }, /arr_/],
    [['--k8s', '--region', '--host', host], { ANYRAY_REGION_TOKEN: 'adt_synthetic0000000000' }, /arr_/],
    [['--k8s', '--region', '--host', host, '--region-token-file', 'missing'], {}, /missing/],
    [['--k8s', '--region', '--host', host, '--region-token', token], {}, /unknown flag/],
    [['--region', '--host', host], { ANYRAY_REGION_TOKEN: token }, /--k8s/],
    [['--k8s', '--region'], { ANYRAY_REGION_TOKEN: token }, /--host/],
    [['--k8s', '--host', host, '--region-token-file', 'x'], {}, /--region/],
    [['--k8s', '--region', '--host', '203.0.113.7'], { ANYRAY_REGION_TOKEN: token }, /hostname/],
  ]) {
    const r = run(args, { env });
    assert.notEqual(r.status, 0, args.join(' '));
    assert.match(r.stderr, message, args.join(' '));
    assert.ok(!r.out.includes(token), 'the region token must not be printed');
    assert.ok(!existsSync(join(r.cwd, 'anyray-secrets.yaml')), args.join(' '));
  }
});

test('a region and a home never share a secrets file', () => {
  const home = run(['--k8s', '--connect', 'adt_synthetic0000000000', '--host', 'anyray.example.com']);
  assert.equal(home.status, 0, home.out);
  const homeSecret = readFileSync(join(home.cwd, 'anyray-secrets.yaml'), 'utf8');
  const intoHome = run(['--k8s', '--region', '--host', host], { cwd: home.cwd, env: { ANYRAY_REGION_TOKEN: token } });
  assert.notEqual(intoHome.status, 0);
  assert.match(intoHome.stderr, /home/);
  assert.equal(readFileSync(join(home.cwd, 'anyray-secrets.yaml'), 'utf8'), homeSecret);

  const region = run(['--k8s', '--region', '--host', host], { env: { ANYRAY_REGION_TOKEN: token } });
  const regionSecret = readFileSync(join(region.cwd, 'anyray-secrets.yaml'), 'utf8');
  for (const args of [['--k8s', '--connect', 'adt_synthetic0000000000', '--host', host], ['--k8s', '--host', host]]) {
    const intoRegion = run(args, { cwd: region.cwd });
    assert.notEqual(intoRegion.status, 0, args.join(' '));
    assert.match(intoRegion.stderr, /region/, args.join(' '));
    assert.equal(readFileSync(join(region.cwd, 'anyray-secrets.yaml'), 'utf8'), regionSecret);
  }

  const valuesOnly = mkdtempSync(join(tmpdir(), 'setup-region-'));
  writeFileSync(join(valuesOnly, 'my-values.yaml'), 'host: "anyray.example.com"\n');
  const homeValues = run(['--k8s', '--region', '--host', host], { cwd: valuesOnly, env: { ANYRAY_REGION_TOKEN: token } });
  assert.notEqual(homeValues.status, 0);
  assert.match(homeValues.stderr, /topology: region/);
  assert.ok(!existsSync(join(valuesOnly, 'anyray-secrets.yaml')));

  const again = run(['--k8s', '--region', '--host', host], { cwd: region.cwd, env: { ANYRAY_REGION_TOKEN: token } });
  assert.equal(again.status, 0, again.out);
  assert.equal(readFileSync(join(region.cwd, 'anyray-secrets.yaml'), 'utf8'), regionSecret);
});

test('the region values render against the chart', { skip: spawnSync('helm', ['version']).status !== 0 && 'helm not installed' }, () => {
  const r = run(['--k8s', '--region', '--host', host], { env: { ANYRAY_REGION_TOKEN: token } });
  assert.equal(r.status, 0, r.out);
  const t = spawnSync('helm', ['template', 't', join(repo, 'helm'), '-f', join(r.cwd, 'my-values.yaml')], { encoding: 'utf8' });
  assert.equal(t.status, 0, t.stderr);
  const keys = new Set([...t.stdout.matchAll(/^\s+key: (\S+)$/gm)].map(m => m[1]));
  assert.deepEqual([...keys].sort(), Object.keys(secretKeys(r.cwd)).sort());
});
