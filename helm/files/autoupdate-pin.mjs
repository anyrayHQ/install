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
// The pin gives up its ownership of the image field once written, so that
// upgrade also works under Helm 4's server-side apply.
//
// Talks to the API server directly (Node's fetch, the mounted service-account
// token, NODE_EXTRA_CA_CERTS for the cluster CA): the kubectl image is
// distroless and cannot run a script.

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const DIGEST = /@(sha256:[0-9a-f]{64})$/;
const FIELD_MANAGER = 'anyray-autoupdate';
// Whose `Update` entries can hold the pin's image: ours, and the client name older releases wrote under.
const PIN_MANAGERS = new Set([FIELD_MANAGER, 'node']);
const RELEASE_ATTEMPTS = 5;

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

// `fields` without the container's image: what a `Update` entry owns after the pin wrote it.
function withoutImage(fields, container) {
  const path = ['f:spec', 'f:template', 'f:spec', 'f:containers', `k:${JSON.stringify({ name: container })}`];
  const tree = structuredClone(fields ?? {});
  const chain = [tree];
  for (const key of path) {
    const next = chain.at(-1)[key];
    if (!next) return fields;
    chain.push(next);
  }
  const owned = chain.at(-1);
  if (!('f:image' in owned)) return fields;
  delete owned['f:image'];
  if (Object.keys(owned).every((key) => key === '.' || key === 'f:name')) {
    for (let i = path.length - 1; i >= 0; i--) {
      delete chain[i][path[i]];
      if (Object.keys(chain[i]).length) break;
    }
  }
  return tree;
}

// Helm 4 applies server-side and refuses an image field another manager owns, so a pin that kept
// ownership would fail every later `helm upgrade`. Dropping it lets that upgrade take the field back.
async function releaseOwnership(call, path, container, deployment) {
  for (let attempt = 1; ; attempt++) {
    const entries = deployment.metadata?.managedFields ?? [];
    const kept = [];
    for (const entry of entries) {
      if (entry.operation !== 'Update' || !PIN_MANAGERS.has(entry.manager)) {
        kept.push(entry);
        continue;
      }
      const fields = withoutImage(entry.fieldsV1, container);
      if (fields !== entry.fieldsV1 && !Object.keys(fields).length) continue;
      kept.push(fields === entry.fieldsV1 ? entry : { ...entry, fieldsV1: fields });
    }
    // The API server ignores an empty list, and an object with no owner at all is not safe to apply over.
    if (!kept.length || (kept.length === entries.length && kept.every((entry, i) => entry === entries[i]))) return;
    try {
      await call(
        'PATCH',
        path,
        { metadata: { resourceVersion: deployment.metadata.resourceVersion, managedFields: kept } },
        'application/merge-patch+json',
      );
      return;
    } catch (err) {
      if (err.status !== 409 || attempt === RELEASE_ATTEMPTS) throw err;
      deployment = await call('GET', path);
    }
  }
}

export async function pin({ api, token, namespace, podName, pins, log = console.log }) {
  const call = async (method, path, body, contentType) => {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': contentType } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw Object.assign(new Error(`${method} ${path} -> HTTP ${res.status}`), { status: res.status });
    return res.json();
  };

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

  for (const p of plan) {
    const path = `/apis/apps/v1/namespaces/${namespace}/deployments/${p.deployment}`;
    const current = await call('GET', path);
    const container = current.spec?.template?.spec?.containers?.find((c) => c.name === p.container);
    if (!container) throw new Error(`deployment ${p.deployment} has no container ${p.container}`);
    if (container.image === p.target) {
      log(`${p.deployment}: already ${p.target}`);
      await releaseOwnership(call, path, p.container, current);
      continue;
    }
    const patched = await call(
      'PATCH',
      `${path}?fieldManager=${FIELD_MANAGER}`,
      { spec: { template: { spec: { containers: [{ name: p.container, image: p.target }] } } } },
      'application/strategic-merge-patch+json',
    );
    log(`${p.deployment}: ${container.image} -> ${p.target}`);
    await releaseOwnership(call, path, p.container, patched);
  }
}

async function main() {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT;
  if (!host || !port) throw new Error('not running in a cluster (KUBERNETES_SERVICE_HOST unset)');
  await pin({
    api: `https://${host.includes(':') ? `[${host}]` : host}:${port}`,
    token: (await readFile(`${SA}/token`, 'utf8')).trim(),
    namespace: process.env.POD_NAMESPACE,
    podName: process.env.POD_NAME,
    pins: JSON.parse(process.env.AUTOUPDATE_PINS),
  });
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
