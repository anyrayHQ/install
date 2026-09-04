import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const setup = join(repo, 'setup.sh');
const verify = join(repo, 'scripts', 'verify-deploy.sh');
const claimUrl =
  'https://app.anyray.ai/install/aic_synthetic_claim_for_tests';
const deploymentToken = 'adt_synthetic_redeemed_secret';

const fakeCurl = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CLAIM_TEST_ARGV, JSON.stringify(args) + '\\n');
if (!args.includes('--config')) process.exit(0);
const config = fs.readFileSync(0, 'utf8');
const url = config.match(/^url = "([^"]+)"/m)?.[1] ?? '';
if (url.endsWith('/admin/health')) {
  process.stdout.write(JSON.stringify({
    ok: true,
    observability: { ok: true, configured: true },
    spend: { ok: true },
    optimizer: { ok: true, configured: true },
    portal: { metering: true, lease: 'active' },
  }));
} else if (url.endsWith('/redeem')) {
  process.stdout.write(JSON.stringify({
    version: 1,
    deploymentId: 'dep_synthetic',
    deploymentToken: process.env.CLAIM_TEST_DEPLOYMENT_TOKEN,
    status: 'claimed',
    statusUrl: process.env.CLAIM_TEST_URL,
  }));
} else if (url.endsWith('/progress')) {
  if (!config.includes('Authorization: Bearer ' + process.env.CLAIM_TEST_DEPLOYMENT_TOKEN)) {
    process.exit(22);
  }
  if (config.includes('\\\\"status\\\\":\\\\"ready\\\\"')) {
    fs.writeFileSync(process.env.CLAIM_TEST_READY, 'ready');
  }
  process.stdout.write('{}');
} else if (url === process.env.CLAIM_TEST_URL) {
  const ready = fs.existsSync(process.env.CLAIM_TEST_READY);
  process.stdout.write(JSON.stringify({
    version: 1,
    claimId: 'icl_synthetic',
    deploymentId: 'dep_synthetic',
    status: ready ? 'ready' : (process.env.CLAIM_TEST_INITIAL_STATUS || 'pending'),
    createdAt: '2026-09-04T00:00:00.000Z',
    expiresAt: '2026-09-04T01:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
  }));
} else {
  process.exit(22);
}
`;

const fakeDocker = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'volume' && args[1] === 'inspect') process.exit(1);
process.exit(0);
`;

const makeWorld = async (initialStatus, activeClaimUrl = claimUrl) => {
  const root = await mkdtemp(join(tmpdir(), 'anyray-agent-install-'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'curl'), fakeCurl);
  await writeFile(join(bin, 'docker'), fakeDocker);
  await chmod(join(bin, 'curl'), 0o755);
  await chmod(join(bin, 'docker'), 0o755);
  const argv = join(root, 'curl-argv.ndjson');
  const ready = join(root, 'ready');
  return {
    root,
    argv,
    ready,
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      CLAIM_TEST_ARGV: argv,
      CLAIM_TEST_READY: ready,
      CLAIM_TEST_URL: activeClaimUrl,
      CLAIM_TEST_DEPLOYMENT_TOKEN: deploymentToken,
      CLAIM_TEST_INITIAL_STATUS: initialStatus,
    },
  };
};

const readYamlSecret = async (root, key) => {
  const yaml = await readFile(join(root, 'anyray-secrets.yaml'), 'utf8');
  const encoded = yaml.match(new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`, 'm'))?.[1];
  assert.ok(encoded, `${key} missing from anyray-secrets.yaml`);
  return Buffer.from(encoded, 'base64').toString('utf8');
};

const statuses = (stdout) =>
  stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).status);

const assertSecretAbsent = async (result, argvPath) => {
  assert.doesNotMatch(result.stdout, /adt_/);
  assert.doesNotMatch(result.stderr, /adt_/);
  assert.doesNotMatch(result.stdout, /ar-adm-[0-9a-f]{32}/);
  assert.doesNotMatch(result.stderr, /ar-adm-[0-9a-f]{32}/);
  assert.doesNotMatch(await readFile(argvPath, 'utf8'), /adt_/);
};

test('setup redeems a claim into files while stdout and argv stay secret-free', async () => {
  const world = await makeWorld('pending');
  const result = spawnSync(
    setup,
    ['--claim', claimUrl, '--host', 'ci.example.com', '--json'],
    { cwd: world.root, env: world.env, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(statuses(result.stdout), [
    'pending',
    'claimed',
    'preflight',
    'configured',
  ]);
  await assertSecretAbsent(result, world.argv);
  const envFile = await readFile(join(world.root, '.env'), 'utf8');
  assert.ok(envFile.includes(`ANYRAY_DEPLOYMENT_TOKEN=${deploymentToken}`));
  const curlArgv = (await readFile(world.argv, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(curlArgv.length >= 4);
  assert.ok(
    curlArgv.every(
      (args) =>
        args.length === 3 &&
        args[0] === '-q' &&
        args[1] === '--config' &&
        args[2] === '-'
    )
  );
});

test('setup rejects a claim from another origin before curl or credential rotation', async () => {
  const world = await makeWorld('pending');
  const result = spawnSync(
    setup,
    [
      '--claim',
      'https://attacker.invalid/install/aic_synthetic',
      '--host',
      'ci.example.com',
      '--json',
    ],
    { cwd: world.root, env: world.env, encoding: 'utf8' }
  );
  assert.notEqual(result.status, 0);
  assert.deepEqual(statuses(result.stdout), ['error']);
  await assert.rejects(readFile(world.argv, 'utf8'));
});

test('setup rejects a plaintext claim origin before making any request', async () => {
  const insecureOrigin = 'http://198.51.100.42:18080';
  const insecureClaim = `${insecureOrigin}/install/aic_synthetic_claim_for_tests`;
  const world = await makeWorld('pending', insecureClaim);
  const result = spawnSync(
    setup,
    [
      '--claim',
      insecureClaim,
      '--control-plane',
      insecureOrigin,
      '--host',
      'ci.example.com',
      '--json',
    ],
    { cwd: world.root, env: world.env, encoding: 'utf8' }
  );
  assert.notEqual(result.status, 0);
  assert.deepEqual(statuses(result.stdout), ['error']);
  assert.match(result.stderr, /requires an https control-plane origin/);
  await assert.rejects(readFile(world.argv, 'utf8'));
});

test('Kubernetes claims preserve a custom Billing origin across setup and verification', async () => {
  const controlPlane = 'https://billing.dev.example';
  const firstClaim = `${controlPlane}/install/aic_first_synthetic_claim`;
  const secondClaim = `${controlPlane}/install/aic_second_synthetic_claim`;
  const world = await makeWorld('pending', firstClaim);
  const setupArgs = (activeClaim) => [
    '--k8s',
    '--claim',
    activeClaim,
    '--control-plane',
    controlPlane,
    '--host',
    'cluster.example.com',
    '--namespace',
    'anyray',
    '--json',
  ];

  const firstSetup = spawnSync(setup, setupArgs(firstClaim), {
    cwd: world.root,
    env: world.env,
    encoding: 'utf8',
  });
  assert.equal(firstSetup.status, 0, firstSetup.stderr);
  assert.equal(
    await readYamlSecret(world.root, 'ANYRAY_CONTROL_PLANE_URL'),
    controlPlane
  );

  const secondSetup = spawnSync(setup, setupArgs(secondClaim), {
    cwd: world.root,
    env: { ...world.env, CLAIM_TEST_URL: secondClaim },
    encoding: 'utf8',
  });
  assert.equal(secondSetup.status, 0, secondSetup.stderr);
  const secretYaml = await readFile(join(world.root, 'anyray-secrets.yaml'), 'utf8');
  assert.equal((secretYaml.match(/ANYRAY_CONTROL_PLANE_URL:/g) ?? []).length, 1);
  assert.equal(
    await readYamlSecret(world.root, 'ANYRAY_CONTROL_PLANE_URL'),
    controlPlane
  );

  const scripts = join(world.root, 'scripts');
  await mkdir(scripts);
  const copiedVerify = join(scripts, 'verify-deploy.sh');
  await copyFile(verify, copiedVerify);
  await chmod(copiedVerify, 0o755);
  const verified = spawnSync(
    copiedVerify,
    ['--claim', secondClaim, '--json', 'http://gateway.test:8787'],
    {
      cwd: world.root,
      env: {
        ...world.env,
        CLAIM_TEST_URL: secondClaim,
        CLAIM_TEST_INITIAL_STATUS: 'gateway_connected',
      },
      encoding: 'utf8',
    }
  );
  assert.equal(verified.status, 0, verified.stderr);
  assert.deepEqual(statuses(verified.stdout), ['gateway_connected', 'ready']);
  await assertSecretAbsent(verified, world.argv);
});

test('setup disables xtrace before the redeemed credential enters shell state', async () => {
  const world = await makeWorld('pending');
  const result = spawnSync(
    'bash',
    [
      '-x',
      setup,
      '--claim',
      claimUrl,
      '--host',
      'ci.example.com',
      '--json',
    ],
    { cwd: world.root, env: world.env, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  await assertSecretAbsent(result, world.argv);
});

test('claim mode keeps generated credentials out of human-readable output too', async () => {
  const world = await makeWorld('pending');
  const result = spawnSync(
    setup,
    ['--claim', claimUrl, '--host', 'ci.example.com'],
    { cwd: world.root, env: world.env, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Admin key: stored in \.env/);
  await assertSecretAbsent(result, world.argv);
});

test('verifier reads the stored token, submits Ready via stdin, and confirms it', async () => {
  const world = await makeWorld('gateway_connected');
  const scripts = join(world.root, 'scripts');
  await mkdir(scripts);
  const copiedVerify = join(scripts, 'verify-deploy.sh');
  await copyFile(verify, copiedVerify);
  await chmod(copiedVerify, 0o755);
  await writeFile(
    join(world.root, '.env'),
    [
      `ANYRAY_DEPLOYMENT_TOKEN=${deploymentToken}`,
      'ANYRAY_ADMIN_TOKEN=ar-adm-synthetic',
      'ANYRAY_GATEWAY_PUBLIC_URL=http://gateway.test:8787',
      'ANYRAY_CONTROL_PLANE_URL=https://app.anyray.ai',
      '',
    ].join('\n'),
    { mode: 0o600 }
  );

  const result = spawnSync(
    copiedVerify,
    ['--claim', claimUrl, '--json'],
    { cwd: world.root, env: world.env, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(statuses(result.stdout), ['gateway_connected', 'ready']);
  await assertSecretAbsent(result, world.argv);
});

test('verifier disables xtrace before reading the stored deployment credential', async () => {
  const world = await makeWorld('gateway_connected');
  const scripts = join(world.root, 'scripts');
  await mkdir(scripts);
  const copiedVerify = join(scripts, 'verify-deploy.sh');
  await copyFile(verify, copiedVerify);
  await chmod(copiedVerify, 0o755);
  await writeFile(
    join(world.root, '.env'),
    [
      `ANYRAY_DEPLOYMENT_TOKEN=${deploymentToken}`,
      'ANYRAY_ADMIN_TOKEN=ar-adm-synthetic',
      'ANYRAY_GATEWAY_PUBLIC_URL=http://gateway.test:8787',
      'ANYRAY_CONTROL_PLANE_URL=https://app.anyray.ai',
      '',
    ].join('\n'),
    { mode: 0o600 }
  );

  const result = spawnSync(
    'bash',
    ['-x', copiedVerify, '--claim', claimUrl, '--json'],
    { cwd: world.root, env: world.env, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  await assertSecretAbsent(result, world.argv);
});
