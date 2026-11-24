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

import { digestOf, followHome, pin, pinnedRef, releaseRef } from '../helm/files/autoupdate-pin.mjs';

const SCRIPT = fileURLToPath(new URL('../helm/files/autoupdate-pin.mjs', import.meta.url));

const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;

const PINS = [
  { deployment: 'anyray-gateway', container: 'gateway', resolvedBy: 'pin', image: 'public.ecr.aws/anyray/gateway:policy-stable' },
  { deployment: 'anyray-proxy', container: 'proxy', resolvedBy: 'resolve-proxy', image: 'public.ecr.aws/anyray/proxy:policy-stable' },
];

const helmApply = { manager: 'helm', operation: 'Apply' };
const ownedImage = (container, extra = {}) => ({
  'f:spec': { 'f:template': { 'f:spec': { 'f:containers': { [`k:{"name":"${container}"}`]: { '.': {}, 'f:image': {}, 'f:name': {} } } } }, ...extra },
});
const nodeEntry = (container, extra) => ({ manager: 'node', operation: 'Update', fieldsV1: ownedImage(container, extra) });
const controller = { manager: 'kube-controller-manager', operation: 'Update' };

// Stands in for the API server's field ownership: a write that names no
// manager is recorded under the client's user agent, `node`, and a merge patch
// that carries a stale resourceVersion is refused with 409.
async function fakeApi({ statuses, images: initial, managers = {}, staleReleases = 0, failPatch = [] }) {
  const patches = [];
  const images = { ...initial };
  const releases = [];
  const managedFields = Object.fromEntries(Object.keys(images).map((d) => [d, managers[d] ?? [helmApply, controller]]));
  const versions = Object.fromEntries(Object.keys(images).map((d) => [d, 1]));
  let stale = staleReleases;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    assert.equal(req.headers.authorization, 'Bearer synthetic-token');
    const url = new URL(req.url, 'http://fake');
    if (req.method === 'GET' && url.pathname === '/api/v1/namespaces/ns/pods/job-pod') {
      return send(200, { status: statuses });
    }
    const m = /^\/apis\/apps\/v1\/namespaces\/ns\/deployments\/([\w-]+)$/.exec(url.pathname);
    if (m && m[1] in images) {
      const name = m[1].replace('anyray-', '');
      const object = () => ({
        metadata: { resourceVersion: String(versions[m[1]]), managedFields: managedFields[m[1]] },
        spec: { template: { spec: { containers: [{ name, image: images[m[1]] }] } } },
      });
      if (req.method === 'GET') return send(200, object());
      if (req.method === 'PATCH') {
        if (failPatch.includes(m[1])) return send(500, {});
        const patch = JSON.parse(body);
        if (req.headers['content-type'] === 'application/merge-patch+json') {
          releases.push({ deployment: m[1], body: patch });
          if (stale > 0 || patch.metadata.resourceVersion !== String(versions[m[1]])) {
            stale = Math.max(0, stale - 1);
            versions[m[1]] += 1;
            return send(409, {});
          }
          managedFields[m[1]] = patch.metadata.managedFields;
        } else {
          patches.push({
            deployment: m[1],
            contentType: req.headers['content-type'],
            fieldManager: url.searchParams.get('fieldManager'),
            body: patch,
          });
          images[m[1]] = patch.spec.template.spec.containers[0].image;
          managedFields[m[1]] = [
            ...managedFields[m[1]],
            { manager: url.searchParams.get('fieldManager') ?? 'node', operation: 'Update', fieldsV1: ownedImage(name) },
          ];
        }
        versions[m[1]] += 1;
        return send(200, object());
      }
    }
    send(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { api: `http://127.0.0.1:${server.address().port}`, patches, releases, images, managedFields, close: () => server.close() };
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

const RESOLVED = {
  initContainerStatuses: [
    { name: 'resolve-proxy', imageID: `public.ecr.aws/anyray/proxy@${D2}` },
    { name: 'pin', imageID: `public.ecr.aws/anyray/gateway@${D1}` },
  ],
};
const PLAIN = {
  'anyray-gateway': 'public.ecr.aws/anyray/gateway:policy-stable',
  'anyray-proxy': 'public.ecr.aws/anyray/proxy:policy-stable',
};
const PINNED = {
  'anyray-gateway': `public.ecr.aws/anyray/gateway:policy-stable@${D1}`,
  'anyray-proxy': `public.ecr.aws/anyray/proxy:policy-stable@${D2}`,
};
const owners = (fake, deployment) => fake.managedFields[deployment].map((e) => `${e.manager}/${e.operation}`);

// Helm 4 applies server-side and refuses an image field another manager owns.
test('leaves no field ownership behind for the pin, so a later helm upgrade takes the image back', async () => {
  const fake = await fakeApi({ statuses: RESOLVED, images: { ...PLAIN } });
  try {
    await run(fake.api);
    assert.deepEqual(
      fake.patches.map((p) => p.fieldManager),
      ['anyray-autoupdate', 'anyray-autoupdate'],
      'the pin names itself, so its entry can be told apart',
    );
    for (const d of ['anyray-gateway', 'anyray-proxy']) {
      assert.deepEqual(owners(fake, d), ['helm/Apply', 'kube-controller-manager/Update'], `${d}: only the others remain`);
    }
    assert.ok(fake.releases.every((r) => r.body.metadata.resourceVersion), 'a release is conditional on the version it read');
  } finally {
    fake.close();
  }
});

test('releases ownership an older release of the pin left under the client name, with no image patch', async () => {
  const fake = await fakeApi({
    statuses: RESOLVED,
    images: { ...PINNED },
    managers: {
      'anyray-gateway': [helmApply, controller, nodeEntry('gateway')],
      'anyray-proxy': [helmApply, controller, nodeEntry('proxy')],
    },
  });
  try {
    await run(fake.api);
    assert.equal(fake.patches.length, 0);
    assert.deepEqual(owners(fake, 'anyray-gateway'), ['helm/Apply', 'kube-controller-manager/Update']);
    assert.deepEqual(owners(fake, 'anyray-proxy'), ['helm/Apply', 'kube-controller-manager/Update']);
  } finally {
    fake.close();
  }
});

test('keeps entries of other managers that share the client name only by operation', async () => {
  const kubectl = { manager: 'kubectl-rollout', operation: 'Update' };
  const nodeApply = { manager: 'node', operation: 'Apply' };
  const fake = await fakeApi({
    statuses: RESOLVED,
    images: { ...PINNED },
    managers: { 'anyray-gateway': [helmApply, kubectl, nodeApply] },
  });
  try {
    await run(fake.api);
    assert.deepEqual(owners(fake, 'anyray-gateway'), ['helm/Apply', 'kubectl-rollout/Update', 'node/Apply']);
    assert.equal(fake.releases.length, 0, 'nothing of the pin to release, so nothing is written');
  } finally {
    fake.close();
  }
});

test('retries a release that lost a race with another writer', async () => {
  const fake = await fakeApi({ statuses: RESOLVED, images: { ...PLAIN }, staleReleases: 2 });
  try {
    await run(fake.api);
    assert.deepEqual(owners(fake, 'anyray-gateway'), ['helm/Apply', 'kube-controller-manager/Update']);
    assert.ok(fake.releases.length >= 3, 'two refused attempts, then one that landed');
  } finally {
    fake.close();
  }
});

test('fails when ownership cannot be released, so the Job retries and the next run finishes it', async () => {
  const fake = await fakeApi({ statuses: RESOLVED, images: { ...PLAIN }, staleReleases: 99 });
  try {
    await assert.rejects(run(fake.api), /HTTP 409/);
  } finally {
    fake.close();
  }
});

test('drops only the image from an entry that owns more, and keeps the rest', async () => {
  const fake = await fakeApi({
    statuses: RESOLVED,
    images: { ...PINNED },
    managers: { 'anyray-gateway': [helmApply, nodeEntry('gateway', { 'f:replicas': {} })] },
  });
  try {
    await run(fake.api);
    assert.deepEqual(fake.managedFields['anyray-gateway'], [
      helmApply,
      { manager: 'node', operation: 'Update', fieldsV1: { 'f:spec': { 'f:replicas': {} } } },
    ]);
  } finally {
    fake.close();
  }
});

test('keeps another container\'s image and a sidecar field of the same entry', async () => {
  const other = { 'f:spec': { 'f:template': { 'f:spec': { 'f:containers': {
    'k:{"name":"gateway"}': { '.': {}, 'f:image': {}, 'f:name': {}, 'f:env': {} },
    'k:{"name":"sidecar"}': { '.': {}, 'f:image': {}, 'f:name': {} },
  } } } } };
  const fake = await fakeApi({
    statuses: RESOLVED,
    images: { ...PINNED },
    managers: { 'anyray-gateway': [helmApply, { manager: 'node', operation: 'Update', fieldsV1: other }] },
  });
  try {
    await run(fake.api);
    const { fieldsV1 } = fake.managedFields['anyray-gateway'][1];
    const containers = fieldsV1['f:spec']['f:template']['f:spec']['f:containers'];
    assert.deepEqual(containers['k:{"name":"gateway"}'], { '.': {}, 'f:name': {}, 'f:env': {} });
    assert.deepEqual(containers['k:{"name":"sidecar"}'], { '.': {}, 'f:image': {}, 'f:name': {} });
  } finally {
    fake.close();
  }
});

test('never clears every owner of a Deployment', async () => {
  const fake = await fakeApi({
    statuses: RESOLVED,
    images: { ...PINNED },
    managers: { 'anyray-gateway': [nodeEntry('gateway')] },
  });
  try {
    await run(fake.api);
    assert.equal(fake.releases.length, 0);
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

// Region mode: the job follows home's build, read from the region gateway's internal listener.
const FOLLOW = [
  { deployment: 'anyray-gateway', container: 'gateway', image: 'public.ecr.aws/anyray/gateway:policy-stable' },
  { deployment: 'anyray-optimizer', container: 'optimizer', image: 'public.ecr.aws/anyray/optimizer:policy-stable' },
];

async function fakeRegionGateway(respond) {
  const server = createServer((req, res) => respond(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/v1/region-home-build`, close: () => server.close() };
}
const answering = (body, status = 200) =>
  fakeRegionGateway((req, res) => {
    assert.equal(req.headers.authorization, undefined, 'the service-account token goes to the API server only');
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });

const runFollow = (fake, build, log = () => {}) =>
  followHome({ api: fake.api, token: 'synthetic-token', namespace: 'ns', url: build.url, pins: FOLLOW, log });

async function follow({ build, images }) {
  const fake = await fakeApi({ statuses: {}, images });
  const lines = [];
  try {
    await runFollow(fake, build, (line) => lines.push(line));
    return { patches: fake.patches, lines };
  } finally {
    fake.close();
    build.close();
  }
}

const stable = {
  'anyray-gateway': 'public.ecr.aws/anyray/gateway:policy-stable',
  'anyray-optimizer': 'public.ecr.aws/anyray/optimizer:policy-stable',
};

test('follow-home: moves both images to home\'s release tag when the region runs another build', async () => {
  const { patches, lines } = await follow({
    build: await answering({ v: 1, region: '1.10.621', home: '1.10.619' }),
    images: stable,
  });
  assert.deepEqual(
    patches.map((p) => [p.deployment, p.body.spec.template.spec.containers[0].image]),
    [
      ['anyray-optimizer', 'public.ecr.aws/anyray/optimizer:v1.10.619'],
      ['anyray-gateway', 'public.ecr.aws/anyray/gateway:v1.10.619'],
    ],
  );
  for (const p of patches) assert.equal(p.contentType, 'application/strategic-merge-patch+json');
  assert.ok(lines.some((line) => /home runs v1\.10\.619, region runs v1\.10\.621/.test(line)), lines.join('\n'));
});

test('follow-home: pins images still on the moving channel to home\'s release tag when the region already runs home\'s build', async () => {
  for (const images of [
    stable,
    {
      'anyray-gateway': `public.ecr.aws/anyray/gateway:policy-stable@${D1}`,
      'anyray-optimizer': `public.ecr.aws/anyray/optimizer:policy-stable@${D2}`,
    },
  ]) {
    const { patches, lines } = await follow({
      build: await answering({ v: 1, region: '1.10.621', home: '1.10.621' }),
      images,
    });
    assert.deepEqual(
      patches.map((p) => [p.deployment, p.body.spec.template.spec.containers[0].image]),
      [
        ['anyray-optimizer', 'public.ecr.aws/anyray/optimizer:v1.10.621'],
        ['anyray-gateway', 'public.ecr.aws/anyray/gateway:v1.10.621'],
      ],
    );
    assert.ok(lines.some((line) => /already runs home's build v1\.10\.621/.test(line)), lines.join('\n'));
  }
});

test('follow-home: changes nothing, and restarts nothing, when both images already carry home\'s release tag', async () => {
  const { patches } = await follow({
    build: await answering({ v: 1, region: '1.10.621', home: '1.10.621' }),
    images: { 'anyray-gateway': 'public.ecr.aws/anyray/gateway:v1.10.621', 'anyray-optimizer': 'public.ecr.aws/anyray/optimizer:v1.10.621' },
  });
  assert.equal(patches.length, 0);
});

test('follow-home: leaves no field ownership behind for the move, so a later helm upgrade takes the image back', async () => {
  const fake = await fakeApi({ statuses: {}, images: stable });
  const build = await answering({ v: 1, region: '1.10.621', home: '1.10.619' });
  try {
    await runFollow(fake, build);
    assert.deepEqual(fake.patches.map((p) => p.fieldManager), ['anyray-autoupdate', 'anyray-autoupdate']);
    for (const d of Object.keys(stable)) assert.deepEqual(owners(fake, d), ['helm/Apply', 'kube-controller-manager/Update']);
  } finally {
    fake.close();
    build.close();
  }
});

test('follow-home: when the region already runs home\'s build, still releases ownership an earlier run left behind', async () => {
  const fake = await fakeApi({
    statuses: {},
    images: { 'anyray-gateway': 'public.ecr.aws/anyray/gateway:v1.10.621', 'anyray-optimizer': 'public.ecr.aws/anyray/optimizer:v1.10.621' },
    managers: {
      'anyray-gateway': [helmApply, controller, nodeEntry('gateway')],
      'anyray-optimizer': [helmApply, controller, nodeEntry('optimizer')],
    },
  });
  const build = await answering({ v: 1, region: '1.10.621', home: '1.10.621' });
  try {
    await runFollow(fake, build);
    assert.equal(fake.patches.length, 0);
    for (const d of Object.keys(stable)) assert.deepEqual(owners(fake, d), ['helm/Apply', 'kube-controller-manager/Update']);
  } finally {
    fake.close();
    build.close();
  }
});

test('follow-home: patches nothing already set to home\'s tag', async () => {
  const { patches } = await follow({
    build: await answering({ v: 1, region: '1.10.621', home: '1.10.619' }),
    images: {
      'anyray-gateway': 'public.ecr.aws/anyray/gateway:v1.10.619',
      'anyray-optimizer': 'public.ecr.aws/anyray/optimizer:policy-stable',
    },
  });
  assert.deepEqual(patches.map((p) => p.deployment), ['anyray-optimizer']);
});

test('follow-home: holds, changes nothing and says why', async (t) => {
  const cases = [
    ['the region gateway holds', () => answering({ v: 1, region: '1.10.621', home: null, hold: 'warming' }), /hold: warming/],
    ['a region gateway that predates following home (404)', () => answering({ error: 'not found' }, 404), /hold: .*HTTP 404/],
    ['an answer that is not JSON', () => answering('<html>'), /hold: .*unreadable/],
    ['an unknown answer version', () => answering({ v: 2, region: '1.10.621', home: '1.10.619' }), /hold: .*unreadable/],
    ['a home build that is not a release number', () => answering({ v: 1, region: '1.10.621', home: 'latest' }), /hold: .*unreadable/],
    ['builds that are not strings', () => answering({ v: 1, region: ['1.10.621'], home: ['1.10.619'] }), /hold: .*unreadable/],
    ['an unreachable region gateway', async () => {
      const gone = await answering({});
      gone.close();
      return gone;
    }, /hold: region gateway unreachable/],
  ];
  for (const [name, build, said] of cases) {
    await t.test(name, async () => {
      const { patches, lines } = await follow({ build: await build(), images: stable });
      assert.equal(patches.length, 0);
      assert.ok(lines.some((line) => said.test(line)), lines.join('\n'));
    });
  }
});

test('follow-home: reads every Deployment before patching any', async () => {
  const build = await answering({ v: 1, region: '1.10.621', home: '1.10.619' });
  const fake = await fakeApi({ statuses: {}, images: { 'anyray-gateway': stable['anyray-gateway'] } });
  try {
    await assert.rejects(
      runFollow(fake, build),
      /anyray-optimizer -> HTTP 404/,
    );
    assert.equal(fake.patches.length, 0);
  } finally {
    fake.close();
    build.close();
  }
});

test('follow-home: moves the gateway last, so a run that failed half way finishes on the retry', async () => {
  const failPatch = ['anyray-optimizer'];
  const fake = await fakeApi({ statuses: {}, images: stable, failPatch });
  const build = await answering({ v: 1, region: '1.10.621', home: '1.10.619' });
  const run = () => runFollow(fake, build);
  try {
    await assert.rejects(run(), /PATCH .*anyray-optimizer.* -> HTTP 500/);
    // The region reports its gateway's build: a moved gateway would read as done and strand the optimizer.
    assert.equal(fake.images['anyray-gateway'], stable['anyray-gateway']);
    failPatch.length = 0;
    await run();
    assert.deepEqual(fake.patches.map((p) => p.deployment), ['anyray-optimizer', 'anyray-gateway']);
    assert.deepEqual(fake.images, {
      'anyray-gateway': 'public.ecr.aws/anyray/gateway:v1.10.619',
      'anyray-optimizer': 'public.ecr.aws/anyray/optimizer:v1.10.619',
    });
  } finally {
    fake.close();
    build.close();
  }
});

test('follow-home: runs the way the CronJob runs it, through a ConfigMap symlink', async () => {
  const fake = await fakeApi({ statuses: {}, images: stable });
  const build = await answering({ v: 1, region: '1.10.621', home: '1.10.619' });
  let mount;
  try {
    mount = await mkdtemp(join(tmpdir(), 'autoupdate-follow-mount-'));
    const stamp = '..2026_10_25_12_00_00.000000001';
    await mkdir(join(mount, stamp));
    await copyFile(SCRIPT, join(mount, stamp, 'autoupdate-pin.mjs'));
    await symlink(stamp, join(mount, '..data'));
    await symlink('..data/autoupdate-pin.mjs', join(mount, 'autoupdate-pin.mjs'));
    const res = await runNode(
      ['--import', IN_CLUSTER_PRELOAD, join(mount, 'autoupdate-pin.mjs'), 'follow-home', build.url],
      {
        KUBERNETES_SERVICE_HOST: 'k8s.invalid',
        KUBERNETES_SERVICE_PORT: '6443',
        POD_NAMESPACE: 'ns',
        AUTOUPDATE_PINS: JSON.stringify(FOLLOW),
        FAKE_API: fake.api,
      },
    );
    assert.equal(res.code, 0, `exit ${res.code}: ${res.stderr}`);
    assert.deepEqual(fake.patches.map((p) => p.deployment), ['anyray-optimizer', 'anyray-gateway']);
  } finally {
    fake.close();
    build.close();
    if (mount) await rm(mount, { recursive: true, force: true });
  }
});

test('releaseRef', () => {
  assert.equal(releaseRef('r/x:policy-stable', '1.10.619'), 'r/x:v1.10.619');
  assert.equal(releaseRef(`r/x:policy-stable@${D1}`, '1.10.619'), 'r/x:v1.10.619');
  assert.equal(releaseRef('my.registry:5000/anyray/x:policy-stable', '1.10.619'), 'my.registry:5000/anyray/x:v1.10.619');
  assert.equal(releaseRef('my.registry:5000/anyray/x', '1.10.619'), 'my.registry:5000/anyray/x:v1.10.619');
});
