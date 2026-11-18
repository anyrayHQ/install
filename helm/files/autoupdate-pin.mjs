// Pin every app Deployment to ONE resolved digest before the nightly roll.
//
// WHY. With a moving tag (policy-stable) and imagePullPolicy: Always, each pod
// resolves the tag when IT starts. The roll moves every pod together, but any
// later start (a reschedule, a node drain, an eviction, an autoscale) pulls
// whatever the channel points at by then, so replicas split across builds
// until the next roll. Across proxy replicas that blanked the console (a page
// from one build, its hashed assets requested from the other). Across
// optimizer replicas it flips a warm session's prompt bytes each time a turn
// lands on the other build, and every flip rewrites the provider's prompt
// cache. Pinning `<repo>:<tag>@sha256:…` makes every later start pull the
// build the roll chose.
//
// HOW. The init containers of this Job pod run each app image at the moving
// tag with pullPolicy Always, so the kubelet resolves each digest with the
// cluster's own pull secrets and mirrors (no registry client, no credentials
// here). This script reads those digests from its own pod's status and patches
// each Deployment's container image. The kubectl container that runs next does
// the same `rollout restart` as before, so the roll lands on the pinned build.
// A `helm upgrade` renders the plain tag again; the next scheduled run pins it.
//
// Talks to the API server directly (Node's fetch, the mounted service-account
// token, NODE_EXTRA_CA_CERTS for the cluster CA): the kubectl image is
// distroless and cannot run a script.

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const DIGEST = /@(sha256:[0-9a-f]{64})$/;

export function digestOf(imageID) {
  const match = DIGEST.exec(String(imageID ?? ''));
  return match ? match[1] : null;
}

// `repo:tag` -> `repo:tag@sha256:…`. An already-pinned ref keeps its tag part
// and takes the new digest, so a rerun never stacks two `@sha256` suffixes.
export function pinnedRef(image, digest) {
  const at = image.indexOf('@');
  return `${at < 0 ? image : image.slice(0, at)}@${digest}`;
}

function kubeApi(api, token) {
  return async (method, path, body, contentType) => {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': contentType } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}`);
    return res.json();
  };
}

async function moveImage(call, namespace, p, current, log) {
  if (current === p.target) {
    log(`${p.deployment}: already ${p.target}`);
    return;
  }
  await call(
    'PATCH',
    `/apis/apps/v1/namespaces/${namespace}/deployments/${p.deployment}`,
    { spec: { template: { spec: { containers: [{ name: p.container, image: p.target }] } } } },
    'application/strategic-merge-patch+json',
  );
  log(`${p.deployment}: ${current} -> ${p.target}`);
}

async function containerImage(call, namespace, p) {
  const current = await call('GET', `/apis/apps/v1/namespaces/${namespace}/deployments/${p.deployment}`);
  const container = current.spec?.template?.spec?.containers?.find((c) => c.name === p.container);
  if (!container) throw new Error(`deployment ${p.deployment} has no container ${p.container}`);
  return container.image;
}

export async function pin({ api, token, namespace, podName, pins, log = console.log }) {
  const call = kubeApi(api, token);

  const pod = await call('GET', `/api/v1/namespaces/${namespace}/pods/${podName}`);
  const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
  const imageIdOf = new Map(statuses.map((s) => [s.name, s.imageID]));

  // Resolve every digest before patching anything: a half-pinned release is
  // exactly the split this exists to prevent.
  const plan = pins.map((p) => {
    const digest = digestOf(imageIdOf.get(p.resolvedBy));
    if (!digest) throw new Error(`no digest for ${p.resolvedBy} (imageID ${JSON.stringify(imageIdOf.get(p.resolvedBy) ?? null)})`);
    return { ...p, target: pinnedRef(p.image, digest) };
  });

  for (const p of plan) await moveImage(call, namespace, p, await containerImage(call, namespace, p), log);
}

const RELEASE = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
const isRelease = (value) => typeof value === 'string' && RELEASE.test(value);

// `repo:tag[@digest]` -> `repo:v<version>`. A release tag never moves, so it needs no digest.
export function releaseRef(image, version) {
  const at = image.indexOf('@');
  let repository = at < 0 ? image : image.slice(0, at);
  if (repository.lastIndexOf(':') > repository.lastIndexOf('/')) repository = repository.slice(0, repository.lastIndexOf(':'));
  return `${repository}:v${version}`;
}

// What the region gateway knows of home: the lowest build home's gateways announced, or why it holds.
async function readHomeBuild(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch {
    return { hold: 'region gateway unreachable' };
  }
  if (!res.ok) return { hold: `region gateway answered HTTP ${res.status} (older than following home)` };
  const body = await res.json().catch(() => undefined);
  if (body?.v !== 1 || !isRelease(body.region)) return { hold: 'region gateway answer unreadable' };
  if (body.home === null) return { hold: /^[a-z_]{1,40}$/.test(body.hold) ? body.hold : 'unknown' };
  if (!isRelease(body.home)) return { hold: 'region gateway answer unreadable' };
  return { home: body.home, region: body.region };
}

// Region mode: move the region to the build home runs, never past it. Every reason not to act is a hold.
export async function followHome({ api, token, namespace, url, pins, log = console.log }) {
  const build = await readHomeBuild(url);
  if (build.hold) {
    log(`hold: ${build.hold}; nothing changed`);
    return;
  }
  if (build.region === build.home) {
    log(`region already runs home's build v${build.home}; nothing changed`);
    return;
  }
  log(`home runs v${build.home}, region runs v${build.region}`);
  const call = kubeApi(api, token);
  const plan = [];
  for (const p of pins) {
    plan.push({ ...p, current: await containerImage(call, namespace, p), target: releaseRef(p.image, build.home) });
  }
  // The gateway goes last: the region reports its build, so a gateway moved early reads as done.
  plan.sort((a, b) => (a.container === 'gateway') - (b.container === 'gateway'));
  for (const p of plan) await moveImage(call, namespace, p, p.current, log);
}

async function main() {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT;
  if (!host || !port) throw new Error('not running in a cluster (KUBERNETES_SERVICE_HOST unset)');
  const cluster = {
    api: `https://${host.includes(':') ? `[${host}]` : host}:${port}`,
    token: (await readFile(`${SA}/token`, 'utf8')).trim(),
    namespace: process.env.POD_NAMESPACE,
    pins: JSON.parse(process.env.AUTOUPDATE_PINS),
  };
  const [mode, url] = process.argv.slice(2);
  if (mode === 'follow-home') await followHome({ ...cluster, url });
  else await pin({ ...cluster, podName: process.env.POD_NAME });
}

// ConfigMap volumes expose the script through symlinks, while Node resolves
// import.meta.url to the target. Compare real paths to recognize the entry point.
let isEntryPoint = false;
try {
  if (process.argv[1]) {
    isEntryPoint = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  }
} catch {}

if (isEntryPoint) {
  main().catch((err) => {
    console.error(`autoupdate-pin: ${err.message}`);
    process.exit(1);
  });
}
