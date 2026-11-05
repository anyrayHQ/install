import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { test } from 'node:test';

const base = ['template', 'topology-test', 'helm', '--namespace', 'topology-test', '--set', 'host=anyray.example.com', '--set', 'postgres.storage=150Gi'];
const optional = ['gateway.trustProxy=true', 'gateway.customHostAllowlist=anyray.example.com', 'gateway.defaultModel=synthetic-model', 'optimizerRequestSigning.enabled=true', 'gateway.extraEnv[0].name=SYNTHETIC_SETTING', 'gateway.extraEnv[0].value=synthetic-value', 'gateway.extraEnv[1].name=SYNTHETIC_SECRET', 'gateway.extraEnv[1].valueFrom.secretKeyRef.name=synthetic-secret', 'gateway.extraEnv[1].valueFrom.secretKeyRef.key=value'];
const cases = { defaults: [], ingress: ['ingress.enabled=true'], httpRoute: ['httpRoute.enabled=true', 'httpRoute.parentRefs[0].name=synthetic-gateway'], networkPolicy: ['networkPolicy.enabled=true'], autoscaling: ['gateway.autoscaling.enabled=true'], autoUpdate: ['image.tag=policy-stable'], optional };
const args = (values) => values.flatMap(v => ['--set', v]);
const render = (values = []) => execFileSync('helm', [...base, ...args(values)], { encoding: 'utf8' });
const normalize = s => s.replace(/helm.sh\/chart: anyray-[^\n]+/g, 'helm.sh/chart: anyray-CHART_VERSION').replace(/(public.ecr.aws\/anyray\/[a-z-]+):v\d+\.\d+\.\d+/g, '$1:APP_VERSION');
if (process.argv.includes('--record-single')) {
  mkdirSync('tests/fixtures/topology', { recursive: true });
  for (const [name, values] of Object.entries(cases)) writeFileSync(`tests/fixtures/topology/${name}.yaml`, normalize(render(values)));
} else {
  for (const [name, values] of Object.entries(cases)) test(`single golden: ${name}`, () => {
    assert.match(execFileSync('helm', ['version', '--short'], { encoding: 'utf8' }), /^v3\.16\.3\+/, 'goldens are rendered with the Helm version helm-chart.yml pins');
    assert.equal(normalize(render(['topology=single', ...values])), readFileSync(`tests/fixtures/topology/${name}.yaml`, 'utf8'));
  });
  const split = ['topology=split', 'inference.host=inference.anyray.example.com', 'ingress.enabled=true'];
  const doc = (s, kind, name) => s.split(/^---$/m).find(d => d.includes(`kind: ${kind}\n`) && d.includes(`  name: ${name}\n`)) || '';
  test('topology validation', () => {
    for (const [values, message] of [
      [['topology=other'], /topology.*single.*split/],
      [['topology=split'], /requires.*[Ii]ngress.*HTTPRoute/],
      [['topology=split', 'ingress.enabled=true'], /inference.host/],
      [[...split, 'inference.host=anyray.example.com'], /inference.host.*existing/],
      [[...split, 'ingress.hosts[0].host=inference.anyray.example.com'], /inference.host.*existing/],
      [[...split, 'httpRoute.hostnames[0]=inference.anyray.example.com'], /inference.host.*existing/],
      [[...split, 'gateway.autoscaling.enabled=true'], /gateway.autoscaling.enabled/],
      [[...split, 'gateway.persistence.enabled=true'], /gateway.persistence.enabled/],
      ...['LoadBalancer', 'NodePort'].map(t => [[...split, `gateway.service.type=${t}`], /gateway.service.type/]),
      [[...split, 'images.gateway.tag=v1.10.562'], /v1\.10\.563/],
    ]) {
      const r = spawnSync('helm', [...base, ...args(values)], { encoding: 'utf8' });
      assert.notEqual(r.status, 0, values.join(' '));
      assert.match(r.stderr, message);
    }
  });
  test('split workloads and shared env', () => {
    for (const extra of [[], optional]) {
      const s = render([...split, ...extra, 'networkPolicy.enabled=true', 'inference.autoscaling.enabled=true', 'gateway.replicas=1']);
      const g = doc(s, 'Deployment', 'anyray-gateway');
      const i = doc(s, 'Deployment', 'anyray-inference');
      assert.ok(i, 'inference Deployment');
      assert.match(g, /replicas: 2/);
      assert.ok(doc(s, 'PodDisruptionBudget', 'anyray-gateway'));
      assert.match(i, /args: \["node", "build\/start-server.js", "--inference-only"\]/);
      const env = d => d.match(/          env:([\s\S]*?)          ports:/)?.[1];
      assert.equal(env(i), env(g));
      for (const name of readFileSync('ci/critical-gateway-env.txt', 'utf8').split('\n').map(v => v.trim()).filter(v => v && !v.startsWith('#'))) {
        assert.ok(env(i).includes(`name: ${name}\n`), name);
      }
      assert.doesNotMatch(i, /persistentVolumeClaim/);
      assert.match(i, /terminationGracePeriodSeconds: 120/);
      assert.match(i, /preStop:/);
      assert.ok(doc(s, 'PodDisruptionBudget', 'anyray-inference').split('matchLabels:\n')[1]?.includes('app.kubernetes.io/component: inference\n'));
      assert.match(doc(s, 'HorizontalPodAutoscaler', 'anyray-inference'), /kind: Deployment\n\s+name: anyray-inference\n\s+minReplicas: 2\n\s+maxReplicas: 10\n/);
      assert.equal(doc(s, 'HorizontalPodAutoscaler', 'anyray-gateway'), '');
      assert.match(doc(s, 'NetworkPolicy', 'anyray-optimizer'), /component: inference/);
      assert.ok(doc(s, 'Service', 'gateway-inference').split('selector:\n')[1]?.includes('app.kubernetes.io/component: inference\n'));
    }
    const r = spawnSync('helm', [...base, ...args([...split, 'inference.terminationGracePeriodSeconds=90'])], { encoding: 'utf8' });
    assert.notEqual(r.status, 0, 'inference must budget the 90 second gateway drain');
    assert.match(r.stderr, /drain/);
  });
  test('split inference pod matches the gateway pod apart from identity, args and replicas', () => {
    const volumes = ['gateway.extraVolumes[0].name=ca', 'gateway.extraVolumes[0].secret.secretName=ca', 'gateway.extraVolumeMounts[0].name=ca', 'gateway.extraVolumeMounts[0].mountPath=/etc/anyray/ca'];
    const strip = d => d.split('\n').filter(l => !/^\s*#/.test(l) && !/^  replicas: /.test(l) && !l.includes('args: ["node", "build/start-server.js", "--inference-only"]')).join('\n')
      .replaceAll('anyray-inference', 'anyray-gateway').replaceAll('component: inference', 'component: gateway').replace('        - name: inference\n', '        - name: gateway\n');
    for (const extra of [[], optional, volumes]) {
      const s = render([...split, ...extra]);
      assert.equal(strip(doc(s, 'Deployment', 'anyray-inference')), strip(doc(s, 'Deployment', 'anyray-gateway')), extra.join(' '));
    }
  });
  test('split routes', () => {
    const edge = JSON.parse(readFileSync('helm/files/edgeRoutes.json', 'utf8'));
    const s = render(split);
    const ing = doc(s, 'Ingress', 'anyray');
    for (const host of ['anyray.example.com', 'inference.anyray.example.com']) {
      const rule = ing.split(`    - host: ${host.startsWith('inference.') ? `"${host}"` : host}\n`)[1]?.split('    - host:')[0];
      assert.ok(rule, host);
      if (host.startsWith('inference.')) {
        assert.deepEqual(rule.match(/- path: .+/g), ['- path: /']);
        assert.match(rule, /pathType: Prefix\n[\s\S]*name: gateway-inference\n/);
        continue;
      }
      for (const r of edge.ingress) {
        const b = rule.split(`          - path: ${r.path}\n            pathType: ${r.pathType}\n`)[1]?.split('          - path:')[0];
        assert.ok(b, r.path);
        assert.match(b, new RegExp(`name: ${r.target === 'inference' ? 'gateway-inference' : r.target === 'console' ? 'anyray-proxy' : 'gateway'}\n`));
      }
    }
    const h = render(['topology=split', 'inference.host=inference.anyray.example.com', 'httpRoute.enabled=true', 'httpRoute.parentRefs[0].name=synthetic-gateway']);
    for (const name of ['anyray', 'anyray-inference']) {
      const d = doc(h, 'HTTPRoute', name);
      assert.match(d, /name: synthetic-gateway/);
      assert.ok(d.includes(`    - \"${name === 'anyray' ? 'anyray.example.com' : 'inference.anyray.example.com'}\"`));
      if (name === 'anyray-inference') {
        const rules = d.split('    - matches:').slice(1);
        assert.equal(rules.length, 1);
        assert.match(rules[0], /type: PathPrefix\n\s+value: \/\n\s+timeouts:\n\s+request: 0s\n\s+backendRefs:\n\s+- name: gateway-inference\n/);
        continue;
      }
      for (const r of edge.httpRoute) {
        const b = d.split('    - matches:').find(b => r.matches.every(m => b.includes(`value: ${m.path.value}\n`)));
        assert.ok(b);
        assert.match(b, new RegExp(`name: ${r.target === 'inference' ? 'gateway-inference' : r.target === 'console' ? 'anyray-proxy' : 'gateway'}\n`));
        if (r.timeouts) assert.match(b, /request: 0s/);
      }
    }
  });
  test('split renders on gateway images that serve inference-only', () => {
    for (const tag of ['v1.10.563', 'policy-stable']) assert.ok(doc(render([...split, `images.gateway.tag=${tag}`]), 'Deployment', 'anyray-inference'), tag);
  });
  test('split accepts a wildcard inference host', () => {
    assert.match(doc(render([...split, 'inference.host=*.inference.example.com']), 'Ingress', 'anyray'), /- host: "\*\.inference\.example\.com"\n/);
  });
  test('split updater pins inference using gateway resolver', () => {
    const s = render([...split, 'image.tag=policy-stable']);
    const cron = doc(s, 'CronJob', 'anyray-autoupdate');
    const line = cron.split('name: AUTOUPDATE_PINS')[1].split('\n')[1].trim().slice(7);
    const pins = JSON.parse(JSON.parse(line));
    const gateway = pins.find(p => p.container === 'gateway');
    assert.deepEqual(pins.find(p => p.container === 'inference'), { ...gateway, deployment: 'anyray-inference', container: 'inference' });
  });
}
