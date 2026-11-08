import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const helm = values => spawnSync('helm', ['template', 'topology-test', 'helm', '--set', 'host=anyray.example.com', '--set', 'postgres.storage=150Gi', ...values.flatMap(v => ['--set', v])], { encoding: 'utf8' });
const render = values => { const r = helm(values); assert.equal(r.status, 0, r.stderr); return r.stdout; };
const doc = (s, kind, name) => s.split(/^---$/m).find(d => d.includes(`kind: ${kind}\n`) && d.includes(`  name: ${name}\n`)) || '';
const selectsInference = (d, key) => d.split(`${key}:\n`)[1]?.includes('app.kubernetes.io/component: inference\n');
const split = ['topology=split', 'inference.host=inference.anyray.example.com', 'ingress.enabled=true'];
const httpRoute = ['topology=split', 'inference.host=inference.anyray.example.com', 'httpRoute.enabled=true', 'httpRoute.parentRefs[0].name=synthetic-gateway'];
const backend = target => ({ inference: 'gateway-inference', console: 'anyray-proxy' })[target] || 'gateway';

test('split refuses settings it cannot run safely', () => {
  for (const [values, message] of [
    [['topology=other'], /topology.*single.*split/],
    [['topology=split'], /requires.*[Ii]ngress.*HTTPRoute/],
    [[...split, 'inference.host=anyray.example.com'], /inference.host.*existing/],
    [[...split, 'ingress.hosts[0].host=inference.anyray.example.com'], /inference.host.*existing/],
    [[...split, 'httpRoute.hostnames[0]=inference.anyray.example.com'], /inference.host.*existing/],
    [[...split, 'gateway.autoscaling.enabled=true'], /gateway.autoscaling.enabled/],
    [[...split, 'gateway.persistence.enabled=true'], /gateway.persistence.enabled/],
    [[...split, 'gateway.service.type=LoadBalancer'], /gateway.service.type/],
    [[...split, 'gateway.service.type=NodePort'], /gateway.service.type/],
    [[...split, 'images.gateway.tag=v1.10.562'], /v1\.10\.563/],
    [[...split, 'inference.terminationGracePeriodSeconds=90'], /drain/],
  ]) {
    const r = helm(values);
    assert.notEqual(r.status, 0, values.join(' '));
    assert.match(r.stderr, message);
  }
  for (const tag of ['v1.10.563', 'policy-stable']) render([...split, `images.gateway.tag=${tag}`]);
});

test('inference pods match the gateway pods apart from name, start command and replica count', () => {
  const optional = ['gateway.trustProxy=true', 'gateway.customHostAllowlist=anyray.example.com', 'gateway.extraEnv[0].name=SYNTHETIC_SECRET', 'gateway.extraEnv[0].valueFrom.secretKeyRef.name=synthetic-secret', 'gateway.extraEnv[0].valueFrom.secretKeyRef.key=value'];
  const volumes = ['gateway.extraVolumes[0].name=ca', 'gateway.extraVolumes[0].secret.secretName=ca', 'gateway.extraVolumeMounts[0].name=ca', 'gateway.extraVolumeMounts[0].mountPath=/etc/anyray/ca'];
  const args = 'args: ["node", "build/start-server.js", "--inference-only"]';
  const strip = d => d.split('\n').filter(l => !/^\s*#/.test(l) && !/^  replicas: /.test(l) && !l.includes(args)).join('\n')
    .replaceAll('anyray-inference', 'anyray-gateway').replaceAll('component: inference', 'component: gateway').replace('        - name: inference\n', '        - name: gateway\n');
  for (const extra of [[], optional, volumes]) {
    const s = render([...split, ...extra]);
    assert.ok(doc(s, 'Deployment', 'anyray-inference').includes(args));
    assert.equal(strip(doc(s, 'Deployment', 'anyray-inference')), strip(doc(s, 'Deployment', 'anyray-gateway')), extra.join(' '));
  }
});

test('split wiring: gateway stays at two, inference scales, is protected, reaches the optimizer and updates with the gateway', () => {
  const s = render([...split, 'gateway.replicas=1', 'networkPolicy.enabled=true', 'image.tag=policy-stable']);
  assert.match(doc(s, 'Deployment', 'anyray-gateway'), /\n  replicas: 2\n/);
  assert.ok(doc(s, 'PodDisruptionBudget', 'anyray-gateway'));
  assert.equal(doc(s, 'HorizontalPodAutoscaler', 'anyray-gateway'), '');
  assert.match(doc(s, 'HorizontalPodAutoscaler', 'anyray-inference'), /kind: Deployment\n\s+name: anyray-inference\n\s+minReplicas: 2\n\s+maxReplicas: 10\n/);
  assert.ok(selectsInference(doc(s, 'PodDisruptionBudget', 'anyray-inference'), 'matchLabels'));
  assert.ok(selectsInference(doc(s, 'Service', 'gateway-inference'), 'selector'));
  assert.match(doc(s, 'NetworkPolicy', 'anyray-optimizer'), /component: inference/);
  const pins = JSON.parse(JSON.parse(doc(s, 'CronJob', 'anyray-autoupdate').split('name: AUTOUPDATE_PINS')[1].split('\n')[1].trim().slice(7)));
  assert.deepEqual(pins.find(p => p.container === 'inference'), { ...pins.find(p => p.container === 'gateway'), deployment: 'anyray-inference', container: 'inference' });
});

test('split routes model paths to inference on both hosts and everything on the inference host', () => {
  const edge = JSON.parse(readFileSync('helm/files/edgeRoutes.json', 'utf8'));
  const ing = doc(render([...split, 'inference.host=*.inference.example.com']), 'Ingress', 'anyray');
  const existing = ing.split('    - host: anyray.example.com\n')[1].split('    - host:')[0];
  for (const r of edge.ingress) {
    assert.ok(existing.split(`          - path: ${r.path}\n            pathType: ${r.pathType}\n`)[1]?.split('          - path:')[0].includes(`name: ${backend(r.target)}\n`), r.path);
  }
  const inference = ing.split('    - host: "*.inference.example.com"\n')[1];
  assert.deepEqual(inference.match(/- path: .+/g), ['- path: /']);
  assert.ok(inference.includes('name: gateway-inference\n'));
  const h = render(httpRoute);
  const main = doc(h, 'HTTPRoute', 'anyray');
  for (const r of edge.httpRoute) {
    const rule = main.split('    - matches:').find(b => r.matches.every(m => b.includes(`value: ${m.path.value}\n`)));
    assert.ok(rule?.includes(`name: ${backend(r.target)}\n`), r.target);
  }
  const rules = doc(h, 'HTTPRoute', 'anyray-inference').split('    - matches:');
  assert.equal(rules.length, 2);
  assert.ok(rules[0].includes('- "inference.anyray.example.com"') && rules[0].includes('name: synthetic-gateway'));
  assert.match(rules[1], /value: \/\n\s+timeouts:\n\s+request: 0s\n\s+backendRefs:\n\s+- name: gateway-inference\n/);
});

test('split without inference.host routes model paths to inference on the existing host only', () => {
  const edge = JSON.parse(readFileSync('helm/files/edgeRoutes.json', 'utf8'));
  const ing = doc(render(['topology=split', 'ingress.enabled=true']), 'Ingress', 'anyray');
  assert.equal(ing.match(/    - host: .+/g).length, 1);
  const r = edge.ingress.find(r => r.target === 'inference');
  assert.ok(ing.split(`          - path: ${r.path}\n`)[1].split('          - path:')[0].includes('name: gateway-inference\n'));
  const h = render(['topology=split', 'httpRoute.enabled=true', 'httpRoute.parentRefs[0].name=synthetic-gateway']);
  assert.ok(doc(h, 'HTTPRoute', 'anyray').includes('name: gateway-inference\n'));
  assert.equal(doc(h, 'HTTPRoute', 'anyray-inference'), '');
});
test('split hands both pods the inference URL only when inference.host is set', () => {
  const s = render(split);
  for (const name of ['anyray-gateway', 'anyray-inference']) {
    assert.match(doc(s, 'Deployment', name), /- name: ANYRAY_INFERENCE_PUBLIC_URL\n\s+value: "https:\/\/inference\.anyray\.example\.com"\n/, name);
  }
  assert.doesNotMatch(render(['topology=split', 'ingress.enabled=true']), /ANYRAY_INFERENCE_PUBLIC_URL/);
  assert.doesNotMatch(render(['inference.host=inference.anyray.example.com']), /ANYRAY_INFERENCE_PUBLIC_URL/);
  assert.doesNotMatch(render([...split, 'inference.host=*.inference.anyray.example.com']), /ANYRAY_INFERENCE_PUBLIC_URL/, 'a wildcard is not a URL a client can connect to');
  assert.doesNotMatch(render([...split, 'gateway.publicUrl=http://anyray.example.com']), /ANYRAY_INFERENCE_PUBLIC_URL/, 'a plain-HTTP install keeps its gateway URL');
  for (const route of [['ingress.hosts[0].host=mgmt.anyray.example.com'], ['ingress.enabled=false', 'httpRoute.enabled=true', 'httpRoute.parentRefs[0].name=synthetic-gateway', 'httpRoute.hostnames[0]=mgmt.anyray.example.com']]) {
    assert.match(render([...split, 'host=', ...route]), /- name: ANYRAY_INFERENCE_PUBLIC_URL\n\s+value: "https:\/\/inference\.anyray\.example\.com"\n/, route.join(' '));
  }
});
