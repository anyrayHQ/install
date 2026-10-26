// The autoUpdate pin step (helm/files/autoupdate-pin.mjs) against a fake API
// server. What it must guarantee: every Deployment lands on the digest this
// Job's own pod resolved, nothing is patched unless every digest resolved, and
// an already-pinned Deployment is left alone (no roll for nothing).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { digestOf, pin, pinnedRef } from '../helm/files/autoupdate-pin.mjs';

const SCRIPT = fileURLToPath(new URL('../helm/files/autoupdate-pin.mjs', import.meta.url));

const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;

const PINS = [
  { deployment: 'anyray-gateway', container: 'gateway', resolvedBy: 'pin', image: 'public.ecr.aws/anyray/gateway:policy-stable' },
  { deployment: 'anyray-proxy', container: 'proxy', resolvedBy: 'resolve-proxy', image: 'public.ecr.aws/anyray/proxy:policy-stable' },
];

async function fakeApi({ statuses, images }) {
  const patches = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    assert.equal(req.headers.authorization, 'Bearer synthetic-token');
    if (req.method === 'GET' && req.url === '/api/v1/namespaces/ns/pods/job-pod') {
      return send(200, { status: statuses });
    }
    const m = /^\/apis\/apps\/v1\/namespaces\/ns\/deployments\/([\w-]+)$/.exec(req.url);
    if (m && m[1] in images) {
      const name = m[1].replace('anyray-', '');
      if (req.method === 'GET') {
        return send(200, { spec: { template: { spec: { containers: [{ name, image: images[m[1]] }] } } } });
      }
      if (req.method === 'PATCH') {
        patches.push({ deployment: m[1], contentType: req.headers['content-type'], body: JSON.parse(body) });
        return send(200, {});
      }
    }
    send(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { api: `http://127.0.0.1:${server.address().port}`, patches, close: () => server.close() };
}

const run = (api, pins = PINS) =>
  pin({ api, token: 'synthetic-token', namespace: 'ns', podName: 'job-pod', pins, log: () => {} });

test('pins every Deployment to the digest its resolver pulled', async () => {
  const fake = await fakeApi({
    statuses: {
      initContainerStatuses: [
        { name: 'resolve-proxy', imageID: `docker-pullable://public.ecr.aws/anyray/proxy@${D2}` },
        { name: 'pin', imageID: `public.ecr.aws/anyray/gateway@${D1}` },
      ],
    },
    images: {
      'anyray-gateway': 'public.ecr.aws/anyray/gateway:policy-stable',
      'anyray-proxy': `public.ecr.aws/anyray/proxy:policy-stable@${D1}`,
    },
  });
  try {
    await run(fake.api);
    assert.deepEqual(
      fake.patches.map((p) => [p.deployment, p.body.spec.template.spec.containers[0].image]),
      [
        ['anyray-gateway', `public.ecr.aws/anyray/gateway:policy-stable@${D1}`],
        ['anyray-proxy', `public.ecr.aws/anyray/proxy:policy-stable@${D2}`],
      ],
    );
    for (const p of fake.patches) {
      assert.equal(p.contentType, 'application/strategic-merge-patch+json');
      // Strategic merge by container name: only the image moves.
      assert.deepEqual(Object.keys(p.body.spec.template.spec.containers[0]).sort(), ['image', 'name']);
    }
  } finally {
    fake.close();
  }
});

test('leaves an already-pinned Deployment unpatched', async () => {
  const fake = await fakeApi({
    statuses: {
      initContainerStatuses: [
        { name: 'resolve-proxy', imageID: `public.ecr.aws/anyray/proxy@${D2}` },
        { name: 'pin', imageID: `public.ecr.aws/anyray/gateway@${D1}` },
      ],
    },
    images: {
      'anyray-gateway': `public.ecr.aws/anyray/gateway:policy-stable@${D1}`,
      'anyray-proxy': `public.ecr.aws/anyray/proxy:policy-stable@${D2}`,
    },
  });
  try {
    await run(fake.api);
    assert.equal(fake.patches.length, 0);
  } finally {
    fake.close();
  }
});

test('patches nothing when any digest is unresolved', async () => {
  const fake = await fakeApi({
    statuses: { initContainerStatuses: [{ name: 'pin', imageID: `public.ecr.aws/anyray/gateway@${D1}` }] },
    images: {
      'anyray-gateway': 'public.ecr.aws/anyray/gateway:policy-stable',
      'anyray-proxy': 'public.ecr.aws/anyray/proxy:policy-stable',
    },
  });
  try {
    await assert.rejects(run(fake.api), /no digest for resolve-proxy/);
    assert.equal(fake.patches.length, 0, 'a half-pinned release is the split this exists to prevent');
  } finally {
    fake.close();
  }
});

// Run a node process WITHOUT blocking this one: the fake API server it calls
// lives in this process's event loop.
function runNode(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// Loaded with --import ahead of the script, in the child only: the in-cluster
// API address goes to the fake server, and the service-account token file
// (absent outside a pod) reads as the fake's token. Everything else is the
// script's own main(), unmodified.
const IN_CLUSTER_PRELOAD = `data:text/javascript,${encodeURIComponent(`
  import fsp from 'node:fs/promises';
  import { syncBuiltinESMExports } from 'node:module';
  const readFile = fsp.readFile;
  fsp.readFile = (path, ...rest) =>
    String(path) === '/var/run/secrets/kubernetes.io/serviceaccount/token'
      ? Promise.resolve('synthetic-token\\n')
      : readFile(path, ...rest);
  syncBuiltinESMExports();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    realFetch(String(url).replace('https://k8s.invalid:6443', process.env.FAKE_API), init);
`)}`;

// THE REGRESSION. The CronJob runs `node /pin/autoupdate-pin.mjs`, and /pin is
// a ConfigMap volume: the file is a symlink to ..data/, itself a symlink to a
// timestamped directory. Node resolves the entry module's import.meta.url
// through those links while process.argv[1] keeps the link path, so a guard
// comparing the two never matched, main() never ran, and every scheduled roll
// shipped unpinned without a word in the log.
test('pins when run the way the CronJob runs it: through a ConfigMap symlink', async () => {
  const fake = await fakeApi({
    statuses: {
      initContainerStatuses: [
        { name: 'resolve-proxy', imageID: `docker-pullable://public.ecr.aws/anyray/proxy@${D2}` },
        { name: 'pin', imageID: `public.ecr.aws/anyray/gateway@${D1}` },
      ],
    },
    images: {
      'anyray-gateway': 'public.ecr.aws/anyray/gateway:policy-stable',
      'anyray-proxy': 'public.ecr.aws/anyray/proxy:policy-stable',
    },
  });
  let mount;
  try {
    mount = await mkdtemp(join(tmpdir(), 'autoupdate-pin-mount-'));
    // The layout the kubelet writes for a ConfigMap volume.
    const stamp = '..2026_10_25_12_00_00.000000001';
    await mkdir(join(mount, stamp));
    await copyFile(SCRIPT, join(mount, stamp, 'autoupdate-pin.mjs'));
    await symlink(stamp, join(mount, '..data'));
    await symlink('..data/autoupdate-pin.mjs', join(mount, 'autoupdate-pin.mjs'));

    const res = await runNode(['--import', IN_CLUSTER_PRELOAD, join(mount, 'autoupdate-pin.mjs')], {
      KUBERNETES_SERVICE_HOST: 'k8s.invalid',
      KUBERNETES_SERVICE_PORT: '6443',
      POD_NAMESPACE: 'ns',
      POD_NAME: 'job-pod',
      AUTOUPDATE_PINS: JSON.stringify(PINS),
      FAKE_API: fake.api,
    });
    assert.equal(res.code, 0, `exit ${res.code}: ${res.stderr}`);
    assert.deepEqual(
      fake.patches.map((p) => [p.deployment, p.body.spec.template.spec.containers[0].image]),
      [
        ['anyray-gateway', `public.ecr.aws/anyray/gateway:policy-stable@${D1}`],
        ['anyray-proxy', `public.ecr.aws/anyray/proxy:policy-stable@${D2}`],
      ],
      'the script ran and pinned both Deployments',
    );
    assert.match(res.stdout, /anyray-gateway: .* -> .*@sha256:/, 'it says what it pinned');
  } finally {
    fake.close();
    if (mount) await rm(mount, { recursive: true, force: true });
  }
});

test('importing the module never runs the in-cluster entry point', async () => {
  // No cluster env: if import ran main(), it would print and exit 1.
  const res = await runNode(['--input-type=module', '-e', `await import(${JSON.stringify(SCRIPT)});`], {});
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stderr, '');
  assert.equal(res.stdout, '');
});

test('digestOf and pinnedRef', () => {
  assert.equal(digestOf(`docker-pullable://r/x@${D1}`), D1);
  assert.equal(digestOf('r/x:policy-stable'), null);
  assert.equal(digestOf(''), null);
  assert.equal(pinnedRef('r/x:policy-stable', D1), `r/x:policy-stable@${D1}`);
  assert.equal(pinnedRef(`r/x:policy-stable@${D1}`, D2), `r/x:policy-stable@${D2}`);
  assert.equal(pinnedRef('my.registry:5000/anyray/x:policy-stable', D1), `my.registry:5000/anyray/x:policy-stable@${D1}`);
});
