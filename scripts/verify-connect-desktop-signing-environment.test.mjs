import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

// The Apple signing and notarization secrets live in the `release-signing` environment, whose
// deployment-branch policy admits main only. A job that does not declare it reads nothing, and a
// run from any other ref (a pull request, a branch dispatch) is refused before its first step.
// These tests keep every reader of those secrets inside that boundary.
const ENVIRONMENT = 'release-signing';
const APPLE_SECRETS = [
  'APPLE_SIGNING_CERT_P12', 'APPLE_SIGNING_CERT_PASSWORD',
  'APPLE_INSTALLER_CERT_P12', 'APPLE_INSTALLER_CERT_PASSWORD',
  'APPLE_NOTARY_KEY', 'APPLE_NOTARY_KEY_ID', 'APPLE_NOTARY_ISSUER_ID',
];
const SIGNING_JOBS = [
  'release-connect-binaries.yml:signing-preflight',
  'release-connect-binaries.yml:sign-macos',
  'release-connect-desktop.yml:preflight',
  'release-connect-desktop.yml:sign-macos',
];
// The daily notary probe (ANY-2279) signs nothing: it reads the three notary secrets only.
const NOTARY_PROBE = 'apple-notary-probe.yml:probe';
const NOTARY_SECRETS = ['APPLE_NOTARY_KEY', 'APPLE_NOTARY_KEY_ID', 'APPLE_NOTARY_ISSUER_ID'];
const APPLE_READERS = [...SIGNING_JOBS, NOTARY_PROBE];
const WORKFLOW_DIR = new URL('../.github/workflows/', import.meta.url);

function workflowFiles() {
  return readdirSync(WORKFLOW_DIR).filter((name) => /\.ya?ml$/.test(name)).sort();
}

function readWorkflow(file) {
  return readFileSync(new URL(file, WORKFLOW_DIR), 'utf8');
}

function jobs(text) {
  const body = text.slice(text.indexOf('\njobs:\n'));
  const headers = [...body.matchAll(/^  ([a-z0-9-]+):\n/gm)];
  return Object.fromEntries(headers.map((match, i) => [
    match[1], body.slice(match.index + match[0].length, headers[i + 1]?.index),
  ]));
}

function triggers(text) {
  const start = text.indexOf('\non:\n');
  assert.ok(start >= 0, 'workflow has no block-style on:');
  const rest = text.slice(start + '\non:\n'.length);
  const end = rest.search(/^\S/m);
  return [...rest.slice(0, end === -1 ? undefined : end).matchAll(/^  ([a-z_]+):/gm)].map((match) => match[1]);
}

function preamble(text) {
  return text.slice(0, text.indexOf('\njobs:\n'));
}

test('the workflow directory is read', () => {
  assert.ok(workflowFiles().length >= 10, workflowFiles().join(', '));
});

test('every job that reads an Apple secret declares the release-signing environment, and no other job does', () => {
  const readers = [];
  const declared = [];
  for (const file of workflowFiles()) {
    for (const [id, body] of Object.entries(jobs(readWorkflow(file)))) {
      if (/secrets\.APPLE_/.test(body)) readers.push(`${file}:${id}`);
      if (body.includes(`\n    environment: ${ENVIRONMENT}\n`)) declared.push(`${file}:${id}`);
      assert.doesNotMatch(body, /^\s+environment:\s*\$\{\{/m, `${file}:${id} must name its environment literally`);
    }
  }
  assert.deepEqual(readers.sort(), [...APPLE_READERS].sort());
  assert.deepEqual(declared.sort(), [...APPLE_READERS].sort());
});

test('each signing job reads every Apple secret it names from the job env, never at workflow level', () => {
  for (const file of workflowFiles()) {
    assert.doesNotMatch(preamble(readWorkflow(file)), /secrets\./, `${file} maps a secret above its jobs`);
  }
  for (const entry of SIGNING_JOBS) {
    const [file, id] = entry.split(':');
    const body = jobs(readWorkflow(file))[id];
    for (const name of APPLE_SECRETS) {
      assert.ok(body.includes(`${name}: \${{ secrets.${name} }}`), `${entry} must read ${name}`);
    }
  }
});

test('the notary probe reads exactly the three notary secrets, in its probe step alone', () => {
  const [file, id] = NOTARY_PROBE.split(':');
  const body = jobs(readWorkflow(file))[id];
  const read = [...body.matchAll(/\bsecrets\.(APPLE_[A-Z0-9_]+)/g)].map((match) => match[1]).sort();
  assert.deepEqual(read, [...NOTARY_SECRETS].sort());
  const steps = body.split(/\n(?= {6}- )/).slice(1).filter((step) => /secrets\./.test(step));
  assert.equal(steps.length, 1, 'one step holds the notary secrets');
  assert.match(steps[0], /\n {8}id: probe\n/);
  assert.doesNotMatch(body.slice(0, body.indexOf('\n    steps:\n')), /secrets\./, 'no notary secret in the job env');
});

// A schedule runs the default branch's copy of a workflow at the default branch's head: the
// same trust as a dispatch from main, which the environment admits anyway. Only the notary
// probe, which reads the three notary secrets and signs nothing, is allowed one (ANY-2279).
const allowedTriggers = (file) => (file === NOTARY_PROBE.split(':')[0] ? ['schedule', 'workflow_dispatch'] : ['workflow_dispatch', 'workflow_call']);

test('workflows that can reach Apple material run only by dispatch or a call from one; the notary probe also daily', () => {
  for (const file of workflowFiles()) {
    const text = readWorkflow(file);
    if (!/secrets\.APPLE_|release-signing/.test(text)) continue;
    const on = triggers(text);
    assert.ok(on.length > 0, file);
    for (const trigger of on) assert.ok(allowedTriggers(file).includes(trigger), `${file} is triggered by ${trigger}`);
  }
  assert.deepEqual(triggers(readWorkflow(NOTARY_PROBE.split(':')[0])).sort(), ['schedule', 'workflow_dispatch']);
  // The schedule is the probe's alone: a signing workflow on a timer is still refused.
  for (const entry of SIGNING_JOBS) assert.ok(!allowedTriggers(entry.split(':')[0]).includes('schedule'), entry);
});

test('no workflow runs privileged on pull request or another run', () => {
  for (const file of workflowFiles()) {
    const on = triggers(readWorkflow(file));
    for (const trigger of ['pull_request_target', 'workflow_run']) {
      assert.ok(!on.includes(trigger), `${file} is triggered by ${trigger}`);
    }
  }
});

test('secrets are inherited only by the binaries call into the desktop workflow', () => {
  const inheriting = [];
  for (const file of workflowFiles()) {
    for (const [id, body] of Object.entries(jobs(readWorkflow(file)))) {
      if (/^\s+secrets: inherit$/m.test(body)) {
        inheriting.push(`${file}:${id}`);
        assert.match(body, /^ {4}uses: \.\/\.github\/workflows\/release-connect-desktop\.yml$/m, `${file}:${id}`);
      }
    }
  }
  assert.deepEqual(inheriting, ['release-connect-binaries.yml:desktop']);
});

test('the unused rcodesign PEM is referenced by no workflow', () => {
  for (const file of workflowFiles()) assert.ok(!readWorkflow(file).includes('APPLE_SIGNING_CERT_PEM'), file);
});

test('the runbook gives the admin the environment, branch policy, secret move and read-back commands', () => {
  const releasing = readFileSync(new URL('../RELEASING.md', import.meta.url), 'utf8');
  const section = releasing.split('\n### The `release-signing` environment (Apple secrets)\n')[1]?.split('\n## ')[0];
  assert.ok(section, 'the release-signing environment section is absent');
  for (const required of [
    "gh api -X PUT repos/anyrayHQ/install/environments/release-signing --input - <<'JSON'",
    '"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}',
    'gh api -X POST repos/anyrayHQ/install/environments/release-signing/deployment-branch-policies -f name=main -f type=branch',
    'gh api repos/anyrayHQ/install/environments/release-signing/deployment-branch-policies --jq',
    'gh secret list -R anyrayHQ/install --env release-signing',
    'repo:anyrayHQ/install:environment:release-signing',
  ]) assert.ok(section.includes(required), `runbook is missing ${required}`);
  for (const name of APPLE_SECRETS) {
    assert.ok(section.includes(`gh secret set ${name} -R anyrayHQ/install --env release-signing`), `${name} move is absent`);
  }
  // Only deleting the repository-level copies closes the gap: until then any branch can read them.
  const removal = section.match(/^for name in ([A-Z0-9_ ]+); do gh secret delete "\$name" -R anyrayHQ\/install; done$/m);
  assert.ok(removal, 'the repository-level delete loop is absent');
  assert.deepEqual(removal[1].split(' ').sort(), [...APPLE_SECRETS, 'APPLE_SIGNING_CERT_PEM'].sort());
  for (const entry of APPLE_READERS) {
    const [file, id] = entry.split(':');
    assert.ok(section.includes(`\`${id}\``) && section.includes(file.replace('.yml', '')), `runbook must name ${entry}`);
  }
});
