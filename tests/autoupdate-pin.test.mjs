// The autoUpdate pin step (helm/files/autoupdate-pin.mjs) against a fake API
// server. What it must guarantee: every Deployment lands on the digest this
// Job's own pod resolved, nothing is patched unless every digest resolved, and
// an already-pinned Deployment is left alone (no roll for nothing).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { digestOf, pin, pinnedRef } from '../helm/files/autoupdate-pin.mjs';

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

test('digestOf and pinnedRef', () => {
  assert.equal(digestOf(`docker-pullable://r/x@${D1}`), D1);
  assert.equal(digestOf('r/x:policy-stable'), null);
  assert.equal(digestOf(''), null);
  assert.equal(pinnedRef('r/x:policy-stable', D1), `r/x:policy-stable@${D1}`);
  assert.equal(pinnedRef(`r/x:policy-stable@${D1}`, D2), `r/x:policy-stable@${D2}`);
  assert.equal(pinnedRef('my.registry:5000/anyray/x:policy-stable', D1), `my.registry:5000/anyray/x:policy-stable@${D1}`);
});
