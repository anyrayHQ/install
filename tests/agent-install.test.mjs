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
const forwards = () => {
  const file = process.env.CLAIM_TEST_KUBECTL_ARGV + '.forwards.ndjson';
  return fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\\n').map((line) => JSON.parse(line))
    : [];
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const forwardPort = (target) => target.match(/^http:\\/\\/127\\.0\\.0\\.1:(\\d+)\\//)?.[1];
// Only a live kubectl forwards its own port; the gateway behind it may still be starting.
const forwardAnswers = (port) => {
  const forward = forwards().find((entry) => String(entry.port) === port);
  if (!forward || !alive(forward.pid)) return false;
  const counter = process.env.CLAIM_TEST_KUBECTL_ARGV + '.gateway-requests';
  const seen = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
  fs.writeFileSync(counter, String(seen));
  return seen > Number(process.env.CLAIM_TEST_GATEWAY_STARTING || 0);
};
if (!args.includes('--config')) {
  const target = args.at(-1);
  const dropMarker = process.env.CLAIM_TEST_KUBECTL_ARGV + '.dropped';
  if (process.env.CLAIM_TEST_POD_RESTARTS_DURING_INGRESS_CHECK &&
      target.startsWith(process.env.CLAIM_TEST_INGRESS_ORIGIN + '/') && !fs.existsSync(dropMarker)) {
    fs.writeFileSync(dropMarker, '');
    for (const { pid } of forwards()) if (alive(pid)) process.kill(pid);
  }
  const port = forwardPort(target);
  process.exit(port && !forwardAnswers(port) ? 7 : 0);
}
const config = fs.readFileSync(0, 'utf8');
const url = config.match(/^url = "([^"]+)"/m)?.[1] ?? '';
const healthPort = forwardPort(url);
if (healthPort && !forwardAnswers(healthPort)) process.exit(7);
const writeOut = (status) => {
  if (/^write-out = /m.test(config)) process.stdout.write('\\n' + status);
};
const ingressOrigin = process.env.CLAIM_TEST_INGRESS_ORIGIN;
if (ingressOrigin && url.startsWith(ingressOrigin + '/admin/')) {
  // The console proxy strips Authorization and answers its own 401 page.
  process.stdout.write('<html><head><title>401 Authorization Required</title></head></html>');
  writeOut(401);
} else if (url.endsWith('/admin/health')) {
  const expectedUrl = process.env.CLAIM_TEST_HEALTH_URL;
  if (expectedUrl && url !== expectedUrl) process.exit(7);
  const adminToken = process.env.CLAIM_TEST_ADMIN_TOKEN;
  if (adminToken && !config.includes('Authorization: Bearer ' + adminToken + '"')) {
    const denied = Number(process.env.CLAIM_TEST_HEALTH_DENY_STATUS || 401);
    process.stdout.write(JSON.stringify({ error: { code: denied === 401 ? 'unauthorized' : 'forbidden' } }));
    writeOut(denied);
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    ok: process.env.CLAIM_TEST_HEALTH_OK !== 'false',
    observability: { ok: true, configured: true },
    spend: { ok: true },
    optimizer: { ok: true, configured: true },
    portal: { metering: true, lease: 'active' },
  }));
  writeOut(200);
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
  // Billing parses the body as JSON; curl config unescapes the quoted data first.
  let progress;
  try {
    progress = JSON.parse(JSON.parse('"' + (config.match(/^data = "(.*)"$/m)?.[1] ?? '') + '"'));
  } catch {
    fs.appendFileSync(process.env.CLAIM_TEST_ARGV + '.invalid-json', config.match(/^data = .*$/m)?.[0] + '\\n');
    if (/^fail$/m.test(config)) process.exit(22);
    process.stdout.write(JSON.stringify({ error: { code: 'invalid-json' } }));
    process.exit(0);
  }
  fs.appendFileSync(process.env.CLAIM_TEST_ARGV + '.progress', JSON.stringify(progress) + '\\n');
  if (progress.status === 'ready') {
    const rejections = Number(process.env.CLAIM_TEST_READY_REJECTIONS || 0);
    const counter = process.env.CLAIM_TEST_READY + '.attempts';
    const attempt = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
    fs.writeFileSync(counter, String(attempt));
    if (process.env.CLAIM_TEST_READY_RAW) {
      process.stdout.write(process.env.CLAIM_TEST_READY_RAW);
      process.exit(0);
    }
    const code = process.env.CLAIM_TEST_READY_REJECT_CODE ||
      (attempt <= rejections ? 'gateway-not-connected' : '');
    if (code) {
      if (/^fail$/m.test(config)) process.exit(22);
      process.stdout.write(
        process.env.CLAIM_TEST_WAITING_BODY ||
          JSON.stringify({ error: { code, message: 'Rejected.' } })
      );
      process.exit(0);
    }
    fs.writeFileSync(process.env.CLAIM_TEST_READY, 'ready');
    process.stdout.write(
      process.env.CLAIM_TEST_ACCEPT_BODY || JSON.stringify({ version: 1, status: 'ready' })
    );
  } else {
    process.stdout.write('{}');
  }
} else if (url === process.env.CLAIM_TEST_URL) {
  const ready = fs.existsSync(process.env.CLAIM_TEST_READY);
  process.stdout.write(JSON.stringify({
    version: 1,
    claimId: 'icl_synthetic',
    deploymentId: 'dep_synthetic',
    status: ready ? 'ready' : (process.env.CLAIM_TEST_INITIAL_STATUS || 'pending'),
    ...(!ready && process.env.CLAIM_TEST_INITIAL_ERROR_CODE
      ? { errorCode: process.env.CLAIM_TEST_INITIAL_ERROR_CODE }
      : {}),
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

const fakeKubectl = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CLAIM_TEST_KUBECTL_ARGV, JSON.stringify(args) + '\\n');
if (args[0] !== 'port-forward') process.exit(1);
const counter = process.env.CLAIM_TEST_KUBECTL_ARGV + '.forwards';
const attempt = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
fs.writeFileSync(counter, String(attempt));
if (attempt <= Number(process.env.CLAIM_TEST_FORWARD_FAILURES || 0)) {
  process.stderr.write('error: unable to forward port because pod is not running\\n');
  process.exit(1);
}
const port = Number(process.env.CLAIM_TEST_FORWARD_PORT) + attempt;
fs.appendFileSync(process.env.CLAIM_TEST_KUBECTL_ARGV + '.pids', process.pid + '\\n');
fs.appendFileSync(
  process.env.CLAIM_TEST_KUBECTL_ARGV + '.forwards.ndjson',
  JSON.stringify({ pid: process.pid, port }) + '\\n'
);
process.stdout.write('Forwarding from 127.0.0.1:' + port + ' -> 8787\\n');
if (attempt === 1 && process.env.CLAIM_TEST_FORWARD_DROPS_FIRST) setTimeout(() => process.exit(1), 200);
setInterval(() => {}, 1000);
`;

const makeWorld = async (initialStatus, activeClaimUrl = claimUrl) => {
  const root = await mkdtemp(join(tmpdir(), 'anyray-agent-install-'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'curl'), fakeCurl);
  await writeFile(join(bin, 'docker'), fakeDocker);
  await writeFile(join(bin, 'kubectl'), fakeKubectl);
  await chmod(join(bin, 'curl'), 0o755);
  await chmod(join(bin, 'docker'), 0o755);
  await chmod(join(bin, 'kubectl'), 0o755);
  const argv = join(root, 'curl-argv.ndjson');
  const kubectlArgv = join(root, 'kubectl-argv.ndjson');
  const ready = join(root, 'ready');
  return {
    root,
    argv,
    kubectlArgv,
    ready,
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      CLAIM_TEST_ARGV: argv,
      CLAIM_TEST_READY: ready,
      CLAIM_TEST_URL: activeClaimUrl,
      CLAIM_TEST_DEPLOYMENT_TOKEN: deploymentToken,
      CLAIM_TEST_INITIAL_STATUS: initialStatus,
      CLAIM_TEST_KUBECTL_ARGV: kubectlArgv,
      CLAIM_TEST_FORWARD_PORT: '18787',
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
  await assert.rejects(readFile(`${argvPath}.invalid-json`, 'utf8'), 'a progress body was not valid JSON');
};

const progressReports = async (world) =>
  (await readFile(`${world.argv}.progress`, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

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

const ingressOrigin = 'https://anyray.example.com';
const k8sAdminToken = 'ar-adm-synthetic-k8s';
const k8sHealthEnv = {
  CLAIM_TEST_INGRESS_ORIGIN: ingressOrigin,
  CLAIM_TEST_ADMIN_TOKEN: k8sAdminToken,
};

const makeKubernetesRoot = async (world, { namespace = 'anyray-synthetic' } = {}) => {
  const b64 = (value) => Buffer.from(value).toString('base64');
  await writeFile(
    join(world.root, 'anyray-secrets.yaml'),
    [
      'apiVersion: v1',
      'kind: Secret',
      'metadata:',
      '  name: anyray-secrets',
      ...(namespace ? [`  namespace: ${namespace}`] : []),
      'type: Opaque',
      'data:',
      `  ANYRAY_ADMIN_TOKEN: ${b64(k8sAdminToken)}`,
      `  ANYRAY_CONTROL_PLANE_URL: ${b64('https://app.anyray.ai')}`,
      `  ANYRAY_DEPLOYMENT_TOKEN: ${b64(deploymentToken)}`,
      '',
    ].join('\n'),
    { mode: 0o600 }
  );
  const scripts = join(world.root, 'scripts');
  await mkdir(scripts);
  const copiedVerify = join(scripts, 'verify-deploy.sh');
  await copyFile(verify, copiedVerify);
  await chmod(copiedVerify, 0o755);
  return copiedVerify;
};

const makeDockerRoot = async (world) => {
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
  return copiedVerify;
};

const jsonLines = (stdout) =>
  stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

const kubectlCalls = async (world) =>
  (await readFile(world.kubectlArgv, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

const assertForwardsStopped = async (world) => {
  const pids = (await readFile(`${world.kubectlArgv}.pids`, 'utf8'))
    .trim()
    .split('\n')
    .map(Number);
  assert.ok(pids.length > 0);
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
};

const assertAdminTokenAbsent = async (result, world, token) => {
  assert.ok(!result.stdout.includes(token));
  assert.ok(!result.stderr.includes(token));
  assert.ok(!(await readFile(world.argv, 'utf8')).includes(token));
  assert.ok(!(await readFile(world.kubectlArgv, 'utf8')).includes(token));
};

test('Kubernetes verifier reads health from the gateway Service, not the cookie-gated ingress', async () => {
  const world = await makeWorld('gateway_connected');
  const copiedVerify = await makeKubernetesRoot(world);
  const result = spawnSync(
    copiedVerify,
    ['--claim', claimUrl, '--json', ingressOrigin],
    {
      cwd: world.root,
      env: { ...world.env, ...k8sHealthEnv },
      encoding: 'utf8',
    }
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(statuses(result.stdout), ['gateway_connected', 'ready']);
  assert.ok((await readFile(world.argv, 'utf8')).includes(JSON.stringify(`${ingressOrigin}/`)));
  assert.deepEqual(await kubectlCalls(world), [
    ['port-forward', '--namespace', 'anyray-synthetic', 'svc/gateway', ':8787'],
  ]);
  await assertForwardsStopped(world);
  await assertSecretAbsent(result, world.argv);
  await assertAdminTokenAbsent(result, world, k8sAdminToken);
});

test('Kubernetes verifier retries the forward while the gateway pod starts and uses the current namespace', async () => {
  const world = await makeWorld('gateway_connected');
  const copiedVerify = await makeKubernetesRoot(world, { namespace: '' });
  const result = spawnSync(copiedVerify, ['--claim', claimUrl, '--json', ingressOrigin], {
    cwd: world.root,
    env: {
      ...world.env,
      ...k8sHealthEnv,
      CLAIM_TEST_FORWARD_FAILURES: '2',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(statuses(result.stdout), ['gateway_connected', 'ready']);
  const calls = await kubectlCalls(world);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.deepEqual(call, ['port-forward', 'svc/gateway', ':8787']);
  }
  await assertForwardsStopped(world);
});

for (const [name, override, forwards] of [
  ['the gateway behind the forward answers', { CLAIM_TEST_GATEWAY_STARTING: '3' }, 1],
  ['a dropped forward is restarted', { CLAIM_TEST_FORWARD_DROPS_FIRST: '1' }, 2],
  ['a forward lost while the public URL was checked is restarted', { CLAIM_TEST_POD_RESTARTS_DURING_INGRESS_CHECK: '1' }, 2],
]) {
  test(`Kubernetes verifier waits until ${name} before reading health`, async () => {
    const world = await makeWorld('gateway_connected');
    const copiedVerify = await makeKubernetesRoot(world);
    const result = spawnSync(
      copiedVerify,
      ['--claim', claimUrl, '--json', ingressOrigin],
      { cwd: world.root, env: { ...world.env, ...k8sHealthEnv, ...override }, encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(statuses(result.stdout), ['gateway_connected', 'ready']);
    assert.equal((await kubectlCalls(world)).length, forwards);
    await assertForwardsStopped(world);
  });
}

test('Kubernetes verifier requires the public URL so Ready cannot skip the ingress', async () => {
  const world = await makeWorld('gateway_connected');
  const copiedVerify = await makeKubernetesRoot(world);
  const result = spawnSync(copiedVerify, ['--claim', claimUrl, '--json'], {
    cwd: world.root,
    env: { ...world.env, ...k8sHealthEnv },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.deepEqual(jsonLines(result.stdout), [
    { status: 'error', errorCode: 'invalid_arguments' },
  ]);
  await assert.rejects(readFile(world.kubectlArgv, 'utf8'));
  await assert.rejects(readFile(world.ready, 'utf8'));
});

test('Kubernetes verifier stops its forward when health fails', async () => {
  const world = await makeWorld('gateway_connected');
  const copiedVerify = await makeKubernetesRoot(world);
  const result = spawnSync(
    copiedVerify,
    ['--claim', claimUrl, '--json', ingressOrigin],
    {
      cwd: world.root,
      env: {
        ...world.env,
        ...k8sHealthEnv,
        CLAIM_TEST_HEALTH_OK: 'false',
      },
      encoding: 'utf8',
    }
  );
  assert.notEqual(result.status, 0);
  assert.deepEqual(jsonLines(result.stdout), [
    { status: 'error', errorCode: 'health_failed' },
  ]);
  await assertForwardsStopped(world);
});

test('Docker verifier reads health from the configured gateway URL without kubectl', async () => {
  const world = await makeWorld('gateway_connected');
  const copiedVerify = await makeDockerRoot(world);
  const result = spawnSync(copiedVerify, ['--claim', claimUrl, '--json'], {
    cwd: world.root,
    env: {
      ...world.env,
      CLAIM_TEST_HEALTH_URL: 'http://gateway.test:8787/admin/health',
      CLAIM_TEST_ADMIN_TOKEN: 'ar-adm-synthetic',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(statuses(result.stdout), ['gateway_connected', 'ready']);
  await assert.rejects(readFile(world.kubectlArgv, 'utf8'));
});

for (const [name, bodies] of [
  ['compact replies', {}],
  ['spaced and reordered replies', {
    CLAIM_TEST_WAITING_BODY: '{ "error": { "message": "Waiting", "code": "gateway-not-connected" } }',
    CLAIM_TEST_ACCEPT_BODY: '{ "claimId": "icl_synthetic", "status": "ready", "version": 1 }',
  }],
]) {
  test(`verifier recovers a claim left in error once the heartbeat lands (${name})`, async () => {
    const world = await makeWorld('error');
    const copiedVerify = await makeDockerRoot(world);
    const result = spawnSync(copiedVerify, ['--claim', claimUrl, '--json'], {
      cwd: world.root,
      env: {
        ...world.env,
        ...bodies,
        CLAIM_TEST_INITIAL_ERROR_CODE: 'verification_failed',
        CLAIM_TEST_READY_REJECTIONS: '2',
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(statuses(result.stdout), ['gateway_connected', 'ready']);
    assert.equal(await readFile(`${world.ready}.attempts`, 'utf8'), '3');
    await assertSecretAbsent(result, world.argv);
  });
}

for (const [name, override] of [
  ['a superseded claim', { CLAIM_TEST_INITIAL_ERROR_CODE: 'superseded', CLAIM_TEST_READY_REJECT_CODE: 'install-claim-inactive' }],
  ['a revoked deployment', { CLAIM_TEST_INITIAL_ERROR_CODE: 'deployment_revoked', CLAIM_TEST_READY_REJECT_CODE: 'deployment-revoked' }],
  ['a malformed answer', { CLAIM_TEST_INITIAL_ERROR_CODE: 'verification_failed', CLAIM_TEST_READY_RAW: '<html>bad gateway</html>' }],
  ['a truncated answer', { CLAIM_TEST_INITIAL_ERROR_CODE: 'verification_failed', CLAIM_TEST_READY_RAW: '{"version":1,"status":"ready"' }],
  ['a status nested in an error', { CLAIM_TEST_INITIAL_ERROR_CODE: 'verification_failed', CLAIM_TEST_READY_RAW: '{"error":{"status":"ready","code":"deployment-revoked"}}' }],
]) {
  test(`verifier keeps a claim error fatal for ${name}`, async () => {
    const world = await makeWorld('error');
    const copiedVerify = await makeDockerRoot(world);
    const result = spawnSync(copiedVerify, ['--claim', claimUrl, '--json'], {
      cwd: world.root,
      env: { ...world.env, ...override },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.deepEqual(jsonLines(result.stdout), [
      { status: 'error', errorCode: 'install_claim_error' },
    ]);
    await assert.rejects(readFile(world.ready, 'utf8'));
    assert.deepEqual((await progressReports(world)).at(-1), {
      status: 'error',
      errorCode: 'verification_failed',
    });
    await assertSecretAbsent(result, world.argv);
  });
}

test('claim progress bodies avoid the escape that bash 3.2 renders as malformed JSON', async () => {
  for (const script of [setup, verify]) {
    const source = await readFile(script, 'utf8');
    assert.doesNotMatch(source, /\$\{[A-Za-z_]+\/\/\\"/, script);
  }
});

test('verifier reports a rejected admin token instead of an unreadable health response', async () => {
  const world = await makeWorld('gateway_connected');
  const copiedVerify = await makeDockerRoot(world);
  const result = spawnSync(copiedVerify, ['--claim', claimUrl, '--json'], {
    cwd: world.root,
    env: { ...world.env, CLAIM_TEST_ADMIN_TOKEN: 'ar-adm-synthetic-other' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.deepEqual(jsonLines(result.stdout), [
    { status: 'error', errorCode: 'admin_token_rejected' },
  ]);
  assert.match(result.stderr, /rejected the admin token/);
  await assertSecretAbsent(result, world.argv);
});

test('verifier does not blame the admin token for a 403', async () => {
  const world = await makeWorld('gateway_connected');
  const copiedVerify = await makeDockerRoot(world);
  const result = spawnSync(copiedVerify, ['--claim', claimUrl, '--json'], {
    cwd: world.root,
    env: {
      ...world.env,
      CLAIM_TEST_ADMIN_TOKEN: 'ar-adm-synthetic-other',
      CLAIM_TEST_HEALTH_DENY_STATUS: '403',
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.deepEqual(jsonLines(result.stdout), [
    { status: 'error', errorCode: 'invalid_health_response' },
  ]);
  assert.doesNotMatch(result.stderr, /admin token/);
});

test('verifier pointed at the console proxy with a token reports the rejection', async () => {
  const world = await makeWorld('pending');
  const copiedVerify = await makeDockerRoot(world);
  const result = spawnSync(copiedVerify, [ingressOrigin, 'ar-adm-synthetic'], {
    cwd: world.root,
    env: { ...world.env, CLAIM_TEST_INGRESS_ORIGIN: ingressOrigin },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rejected the admin token \(HTTP 401\)/);
});
