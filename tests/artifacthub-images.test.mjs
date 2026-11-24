// scripts/stamp-artifacthub-images.sh writes the chart's artifacthub.io/images
// annotation. Artifact Hub finds a chart's images by rendering it with default
// values, and the default render fails on purpose (postgres.storage is below the
// retention floor), so without this list it shows no images and scans nothing.
// What it must guarantee: the list is exactly the images a default install
// deploys, it follows appVersion, it touches nothing else in Chart.yaml, and
// --check catches a list that has gone stale.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/stamp-artifacthub-images.sh', import.meta.url));
const CHART = fileURLToPath(new URL('../helm', import.meta.url));

const stamp = (...args) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });

const annotation = chartYaml => {
  const lines = chartYaml.split('\n');
  const start = lines.indexOf('  artifacthub.io/images: |');
  if (start < 0) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('    ')) break;
    body.push(line);
  }
  return body.join('\n');
};

const imagesIn = block => [...block.matchAll(/^ {6}image: (\S+)$/gm)].map(m => m[1]);

const defaultRenderImages = chart => {
  const r = spawnSync('helm', ['template', 't', chart, '--set', 'postgres.acknowledgeSmallVolume=true'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return [...new Set([...r.stdout.matchAll(/^\s*-?\s*image:\s*"?([^"\s]+)"?/gm)].map(m => m[1]))].sort();
};

const copyChart = () => {
  const dir = mkdtempSync(join(tmpdir(), 'artifacthub-images-'));
  cpSync(CHART, join(dir, 'helm'), { recursive: true });
  return { dir, chart: join(dir, 'helm'), file: join(dir, 'helm', 'Chart.yaml') };
};

test('the committed chart lists exactly the images a default install deploys', () => {
  const r = stamp('--check', CHART);
  assert.equal(r.status, 0, r.stderr);
  const block = annotation(readFileSync(join(CHART, 'Chart.yaml'), 'utf8'));
  assert.ok(block !== null, 'Chart.yaml has no artifacthub.io/images annotation');
  assert.deepEqual(imagesIn(block).sort(), defaultRenderImages(CHART));
  const app = readFileSync(join(CHART, 'Chart.yaml'), 'utf8').match(/^appVersion: "?(v[\d.]+)"?$/m)[1];
  assert.ok(imagesIn(block).includes(`public.ecr.aws/anyray/gateway:${app}`));
});

test('a new appVersion restamps the list, changes nothing else, and a second run is a no-op', () => {
  const { dir, chart, file } = copyChart();
  try {
    const before = readFileSync(file, 'utf8');
    const app = before.match(/^appVersion: "?(v[\d.]+)"?$/m)[1];
    writeFileSync(file, before.replace(/^appVersion: .*$/m, 'appVersion: "v9.9.9"'));

    assert.notEqual(stamp('--check', chart).status, 0, '--check passed a stale list');
    const r = stamp(chart);
    assert.equal(r.status, 0, r.stderr);

    const after = readFileSync(file, 'utf8');
    assert.ok(imagesIn(annotation(after)).includes('public.ecr.aws/anyray/gateway:v9.9.9'));
    assert.ok(!imagesIn(annotation(after)).some(i => i.endsWith(`:${app}`)), 'an old tag survived the restamp');
    assert.equal(after.replace(annotation(after), ''), before.replace(/^appVersion: .*$/m, 'appVersion: "v9.9.9"').replace(annotation(before), ''));

    assert.equal(stamp(chart).status, 0);
    assert.equal(readFileSync(file, 'utf8'), after);
    assert.equal(stamp('--check', chart).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a chart without the annotation gets one inside its annotations map', () => {
  const { dir, chart, file } = copyChart();
  try {
    const original = readFileSync(file, 'utf8');
    const stripped = original.replace(`  artifacthub.io/images: |\n${annotation(original)}\n`, '');
    assert.equal(annotation(stripped), null);
    writeFileSync(file, stripped);

    const r = stamp(chart);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(imagesIn(annotation(readFileSync(file, 'utf8'))).sort(), defaultRenderImages(chart));
    const lint = spawnSync('helm', ['show', 'chart', chart], { encoding: 'utf8' });
    assert.equal(lint.status, 0, lint.stderr);
    assert.match(lint.stdout, /^ {2}artifacthub\.io\/images: \|$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a chart that does not render fails the stamp and leaves Chart.yaml alone', () => {
  const { dir, chart, file } = copyChart();
  try {
    writeFileSync(join(chart, 'templates', 'broken.yaml'), '{{ fail "synthetic render failure" }}\n');
    const before = readFileSync(file, 'utf8');
    const r = stamp(chart);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /synthetic render failure/);
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
