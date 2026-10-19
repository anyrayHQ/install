import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const MAC_RUNS_ON = `\${{ needs.provision-mac.outputs.mac_runner == 'ec2' && fromJSON('["self-hosted","macOS","ARM64","anyray-install-mac"]') || format('codebuild-anyray-install-runner-mac-{0}-{1}', github.run_id, github.run_attempt) }}`;
const WORKFLOWS = [
  'release-connect-desktop.yml',
  'release-connect-binaries.yml',
  'release-fleetd-installer.yml',
];
const MAC_JOBS = {
  'release-connect-desktop.yml': ['build-macos-unsigned', 'sign-macos', 'verify-macos-signed'],
  'release-connect-binaries.yml': ['sign-macos'],
  'release-fleetd-installer.yml': ['build-macos'],
};
const MAINTAINERS = ['16443050', '187185370'];

function readWorkflow(file) {
  return readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
}

function jobs(text) {
  const body = text.slice(text.indexOf('\njobs:\n'));
  const headers = [...body.matchAll(/^  ([a-z0-9-]+):\n/gm)];
  return Object.fromEntries(headers.map((match, i) => [
    match[1], body.slice(match.index + match[0].length, headers[i + 1]?.index),
  ]));
}

function field(body, key, indent = 4) {
  const prefix = `${' '.repeat(indent)}${key}: `;
  return body.split('\n').find((line) => line.startsWith(prefix))?.slice(prefix.length);
}

function needs(body) {
  return (field(body, 'needs') ?? '').replace(/^\[|\]$/g, '').split(',').map((id) => id.trim());
}

function steps(body) {
  return body.slice(body.indexOf('    steps:\n')).split('\n      - ').slice(1)
    .map((step) => `        ${step}`);
}

function evaluate(expression, macRunner, result = 'success') {
  assert.equal(typeof expression, 'string', 'workflow expression is absent');
  const code = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replace(/\b(needs|steps)\.([a-zA-Z0-9_-]+)/g, '$1["$2"]');
  const context = {
    needs: { 'provision-mac': { result, outputs: { mac_runner: macRunner } } },
    steps: { 'mac-runner': { outputs: { mac_runner: macRunner } } },
    github: { run_id: '777', run_attempt: '2' },
    fromJSON: JSON.parse,
    format: (template, ...args) => template.replace(/\{(\d+)\}/g, (_, i) => args[Number(i)]),
    always: () => true,
    cancelled: () => false,
  };
  // These expressions are read only from this repository's workflow files.
  return new Function(...Object.keys(context), `return (${code});`)(...Object.values(context));
}

function temporaryTree(t) {
  // Outside the checkout, like the fleet test: a killed run must not leave untracked trees in the repo.
  const dir = mkdtempSync(join(tmpdir(), 'mac-runner-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function select(t, value, overrides = {}, args = ['select']) {
  const dir = temporaryTree(t);
  const output = join(dir, 'output');
  writeFileSync(output, '');
  const env = {
    PATH: '/opt/homebrew/bin:/usr/bin:/bin',
    GITHUB_OUTPUT: output,
    GITHUB_REPOSITORY: 'anyrayHQ/install',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    ...overrides,
  };
  if (value !== undefined) env.INSTALL_MAC_RUNNER = value;
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const result = spawnSync('bash', [fileURLToPath(new URL('./mac-runner.sh', import.meta.url)), ...args], {
    encoding: 'utf8', timeout: 10_000, env,
  });
  return { ...result, output: readFileSync(output, 'utf8'), log: result.stdout + result.stderr };
}

function hookTree(t) {
  const dir = temporaryTree(t);
  const home = join(dir, 'home');
  const temp = join(dir, 'runner', '_work', '_temp');
  const workspace = join(dir, 'runner', '_work', 'install', 'install');
  const bin = join(dir, 'bin');
  for (const path of [home, temp, bin, ...['.git', 'private-source', 'out'].map((name) => join(workspace, name))]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(workspace, 'private-source', 'x'), 'private source');
  writeFileSync(join(workspace, 'out', 'y.pkg'), 'signed output');
  writeFileSync(join(workspace, '.hidden'), 'hidden output');
  const securityLog = join(dir, 'security.log');
  writeFileSync(securityLog, '');
  writeFileSync(join(bin, 'security'), `#!/bin/bash
printf '%s\\n' "$*" >> "$HOOK_SECURITY_LOG"
exit "\${HOOK_SECURITY_STATUS:-0}"
`, { mode: 0o755 });
  writeFileSync(join(bin, 'df'), `#!/bin/bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nstub 100000000 0 %s 0%% /\\n' "$HOOK_AVAILABLE_KIB"
`, { mode: 0o755 });
  // Keep the renamed workspace available for synchronous assertions. The real
  // detached worker removes it immediately, which would race those assertions.
  for (const command of ['taskpolicy', 'nice']) {
    writeFileSync(join(bin, command), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  }
  return {
    dir, home, temp, workspace, bin, securityLog,
    env: {
      PATH: `${bin}:/usr/bin:/bin`, HOME: home, RUNNER_TEMP: temp,
      GITHUB_WORKSPACE: workspace, GITHUB_REPOSITORY: 'anyrayHQ/install',
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
      GITHUB_WORKFLOW_REF: 'anyrayHQ/install/.github/workflows/release-connect-desktop.yml@refs/heads/main',
      GITHUB_ACTOR_ID: MAINTAINERS[0], HOOK_SECURITY_LOG: securityLog,
      HOOK_AVAILABLE_KIB: String(40 * 1048576), RUNNER_TRACKING_ID: 'test-job',
    },
  };
}

function runHook(tree, phase = 'job-started', overrides = {}, script) {
  const env = { ...tree.env, ...overrides };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const result = spawnSync(existsSync('/bin/bash') ? '/bin/bash' : 'bash', [
    script ?? fileURLToPath(new URL('./mac-runner-hook.sh', import.meta.url)),
    ...(phase === null ? [] : [phase]),
  ], { encoding: 'utf8', timeout: 30_000, env });
  return { ...result, log: result.stdout + result.stderr, security: readFileSync(tree.securityLog, 'utf8') };
}

function assertUntouched(tree) {
  assert.deepEqual(readdirSync(tree.workspace).sort(), ['.git', '.hidden', 'out', 'private-source']);
  assert.equal(readFileSync(join(tree.workspace, 'private-source', 'x'), 'utf8'), 'private source');
  assert.equal(readFileSync(join(tree.workspace, 'out', 'y.pkg'), 'utf8'), 'signed output');
  assert.equal(existsSync(join(tree.home, '.runner-trash')), false);
}

function assertMoved(tree) {
  assert.deepEqual(readdirSync(tree.workspace), ['.git']);
  assert.equal(readFileSync(join(tree.workspace, '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/main\n');
  const trash = join(tree.home, '.runner-trash');
  const moved = readdirSync(trash).filter((entry) => statSync(join(trash, entry)).isDirectory());
  assert.equal(moved.length, 1);
  assert.deepEqual(readdirSync(join(trash, moved[0])).sort(), ['.hidden', 'out', 'private-source']);
  assert.equal(readFileSync(join(trash, moved[0], 'private-source', 'x'), 'utf8'), 'private source');
  assert.equal(readFileSync(join(trash, moved[0], 'out', 'y.pkg'), 'utf8'), 'signed output');
}

test('selection preserves the CodeBuild default on pull requests for unset, empty and codebuild', (t) => {
  for (const value of [undefined, '', 'codebuild']) {
    const result = select(t, value, { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/1/merge', GITHUB_REPOSITORY: 'someone/install' });
    assert.equal(result.status, 0, result.log);
    assert.equal(result.output, 'mac_runner=codebuild\n');
    assert.equal((result.log.match(/::notice::/g) ?? []).length, 1);
  }
});

test('selection allows ec2 for an install main dispatch', (t) => {
  const result = select(t, 'ec2');
  assert.equal(result.status, 0, result.log);
  assert.equal(result.output, 'mac_runner=ec2\n');
  assert.match(result.log, /::notice::[^\n]*anyray-install-mac/);
  assert.equal((result.log.match(/::notice::/g) ?? []).length, 1);
});

test('selection refuses each untrusted ec2 event, ref and repository without writing output', (t) => {
  const deviations = [
    ...['pull_request', 'pull_request_target', 'push', 'schedule'].map((event) => ({ GITHUB_EVENT_NAME: event })),
    ...['refs/heads/feature', 'refs/pull/1/merge'].map((ref) => ({ GITHUB_REF: ref })),
    { GITHUB_REPOSITORY: 'someone/install' },
    ...['GITHUB_EVENT_NAME', 'GITHUB_REF', 'GITHUB_REPOSITORY'].map((key) => ({ [key]: undefined })),
  ];
  for (const deviation of deviations) {
    const result = select(t, 'ec2', deviation);
    assert.equal(result.status, 1, result.log);
    assert.equal(result.output, '');
    assert.ok(result.log.includes(`::error::${Object.keys(deviation)[0]}`), result.log);
    for (const value of Object.values(deviation)) if (value) assert.ok(!result.log.includes(value), result.log);
  }
});

test('selection refuses invalid switch values without logging the raw value', (t) => {
  for (const value of ['EC2', 'ec2 ', 'true', 'fleet', '::warning::injected']) {
    const result = select(t, value);
    assert.equal(result.status, 1, result.log);
    assert.equal(result.output, '');
    assert.match(result.log, /::error::INSTALL_MAC_RUNNER must be unset, codebuild or ec2/);
    assert.ok(!result.log.includes(value), result.log);
  }
});

test('selection requires a nonempty GITHUB_OUTPUT', (t) => {
  for (const output of [undefined, '']) {
    const result = select(t, 'ec2', { GITHUB_OUTPUT: output });
    assert.equal(result.status, 1, result.log);
    assert.equal(result.output, '');
    assert.match(result.log, /::error::GITHUB_OUTPUT/);
  }
});

test('selection returns usage status for missing or unknown subcommands', (t) => {
  for (const args of [[], ['unknown']]) {
    const result = select(t, undefined, {}, args);
    assert.equal(result.status, 2, result.log);
    assert.equal(result.output, '');
  }
});

test('exactly the five release Mac jobs use Mac runners', () => {
  const actual = WORKFLOWS.flatMap((file) => Object.entries(jobs(readWorkflow(file)))
    .filter(([, body]) => /anyray-install-(?:mac|runner-mac)/.test(field(body, 'runs-on') ?? ''))
    .map(([id]) => `${file}:${id}`));
  const expected = WORKFLOWS.flatMap((file) => MAC_JOBS[file].map((id) => `${file}:${id}`));
  assert.deepEqual(actual.sort(), expected.sort());
});

for (const file of WORKFLOWS) {
  test(`${file}: every Mac job evaluates the saved runner choice and needs provision-mac`, () => {
    const allJobs = jobs(readWorkflow(file));
    for (const id of MAC_JOBS[file]) {
      const body = allJobs[id];
      const runner = field(body, 'runs-on');
      assert.equal(runner, MAC_RUNS_ON, `${id}: Mac runner selection expression is absent`);
      assert.ok(needs(body).includes('provision-mac'), `${id} needs provision-mac`);
      for (const choice of ['codebuild', '']) {
        const today = 'codebuild-anyray-install-runner-mac-${{ github.run_id }}-${{ github.run_attempt }}'
          .replace(/\$\{\{\s*(github\.[a-z_]+)\s*\}\}/g, (_, expression) => evaluate(expression, choice));
        assert.equal(today, 'codebuild-anyray-install-runner-mac-777-2');
        assert.equal(evaluate(runner, choice), today);
      }
      assert.deepEqual(evaluate(runner, 'ec2'), ['self-hosted', 'macOS', 'ARM64', 'anyray-install-mac']);
    }
    for (const [id, body] of Object.entries(allJobs)) {
      if (!MAC_JOBS[file].includes(id)) {
        assert.doesNotMatch(field(body, 'runs-on') ?? '', /provision-mac|self-hosted|anyray-install-mac/, id);
      }
    }
  });

  test(`${file}: provision-mac saves the choice before conditional fleet credentials and up`, () => {
    const provision = jobs(readWorkflow(file))['provision-mac'];
    const output = field(provision, 'mac_runner', 6);
    assert.equal(output, '${{ steps.mac-runner.outputs.mac_runner }}', 'mac_runner output is absent');
    for (const choice of ['codebuild', 'ec2']) assert.equal(evaluate(output, choice), choice);
    const provisionSteps = steps(provision);
    assert.equal(provisionSteps.length, 4);
    const [checkout, selection, credentials, up] = provisionSteps;
    assert.equal(field(checkout, 'uses', 8), 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2');
    assert.equal(field(selection, 'id', 8), 'mac-runner');
    assert.equal(field(selection, 'INSTALL_MAC_RUNNER', 10), '${{ vars.INSTALL_MAC_RUNNER }}');
    assert.equal(field(selection, 'run', 8), './scripts/mac-runner.sh select');
    assert.equal(field(selection, 'if', 8), undefined);
    assert.equal(field(credentials, 'uses', 8), 'aws-actions/configure-aws-credentials@e3dd6a429d7300a6a4c196c26e071d42e0343502 # v4.0.2');
    assert.equal(field(credentials, 'role-to-assume', 10), '${{ vars.AWS_MAC_FLEET_ROLE_ARN }}');
    assert.equal(field(credentials, 'aws-region', 10), 'eu-central-1');
    assert.equal(field(up, 'run', 8), './scripts/mac-fleet.sh up');
    for (const step of [credentials, up]) {
      assert.equal(evaluate(field(step, 'if', 8), 'codebuild'), true);
      assert.equal(evaluate(field(step, 'if', 8), 'ec2'), false);
    }
  });

  test(`${file}: teardown skips only ec2 and preserves the provision result policy`, () => {
    const teardown = jobs(readWorkflow(file))['teardown-mac'];
    const fleetd = file === 'release-fleetd-installer.yml';
    for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
      for (const choice of ['codebuild', '', 'ec2']) {
        assert.equal(evaluate(field(teardown, 'if'), choice, result),
          choice !== 'ec2' && (fleetd || result !== 'skipped'), `${result}/${choice}`);
      }
    }
    assert.ok(needs(teardown).includes('provision-mac'));
    if (fleetd) assert.deepEqual(needs(teardown), ['provision-mac', 'build-macos']);
    const teardownSteps = steps(teardown);
    assert.equal(teardownSteps.length, 3);
    assert.equal(field(teardownSteps[2], 'run', 8), './scripts/mac-fleet.sh down');
    for (const step of teardownSteps) assert.equal(field(step, 'if', 8), undefined);
  });
}

test('the hook workflow allowlist equals the workflows containing Mac jobs', () => {
  const hook = readFileSync(new URL('./mac-runner-hook.sh', import.meta.url), 'utf8');
  const match = hook.match(/^ALLOWED_WORKFLOWS="([^"]+)"/m);
  assert.ok(match, 'ALLOWED_WORKFLOWS is absent');
  const expected = WORKFLOWS.filter((file) => Object.values(jobs(readWorkflow(file)))
    .some((body) => /anyray-install-(?:mac|runner-mac)/.test(field(body, 'runs-on') ?? '')))
    .map((file) => `anyrayHQ/install/.github/workflows/${file}@refs/heads/main`);
  assert.deepEqual(new Set(match[1].split('\n')), new Set(expected));
});

test('the hook maintainer ids equal the fleet webhook maintainer ids', () => {
  const hook = readFileSync(new URL('./mac-runner-hook.sh', import.meta.url), 'utf8');
  const fleet = readFileSync(new URL('./mac-fleet.sh', import.meta.url), 'utf8');
  const hookIds = hook.match(/^MAINTAINER_ACCOUNT_IDS="([^"]+)"/m);
  const fleetIds = fleet.match(/^MAINTAINER_ACCOUNT_IDS="([^"]+)"/m);
  assert.ok(hookIds && fleetIds, 'maintainer list is absent');
  assert.deepEqual(new Set(hookIds[1].split(' ')), new Set(fleetIds[1].split(' ')));
});

test('the runbook registers the persistent label and documents the switch and rollback', () => {
  const releasing = readFileSync(new URL('../RELEASING.md', import.meta.url), 'utf8');
  assert.match(releasing, /\.\/config\.sh[^\n]*--url https:\/\/github\.com\/anyrayHQ\/install[^\n]*\\\n\s*--name anyray-install-mac --labels anyray-install-mac --work _work/);
  assert.match(releasing, /INSTALL_MAC_RUNNER/);
  assert.match(releasing, /gh variable delete INSTALL_MAC_RUNNER -R anyrayHQ\/install/);
});

test('job-started allows every release workflow and maintainer and moves all entries except .git', (t) => {
  for (const file of WORKFLOWS) {
    for (const actor of MAINTAINERS) {
      const tree = hookTree(t);
      const result = runHook(tree, 'job-started', {
        GITHUB_WORKFLOW_REF: `anyrayHQ/install/.github/workflows/${file}@refs/heads/main`, GITHUB_ACTOR_ID: actor,
      });
      assert.equal(result.status, 0, result.log);
      assertMoved(tree);
    }
  }
});

test('job-started refuses each trust deviation and missing variable before touching the host', (t) => {
  const desktop = 'anyrayHQ/install/.github/workflows/release-connect-desktop.yml';
  const deviations = [
    ...['pull_request', 'push'].map((event) => ({ GITHUB_EVENT_NAME: event })),
    { GITHUB_REF: 'refs/pull/1/merge' }, { GITHUB_REPOSITORY: 'someone/install' },
    { GITHUB_WORKFLOW_REF: 'anyrayHQ/install/.github/workflows/smoke.yml@refs/heads/main' },
    { GITHUB_WORKFLOW_REF: `${desktop}@refs/heads/feature` },
    { GITHUB_ACTOR_ID: '1' }, { GITHUB_ACTOR_ID: MAINTAINERS.join(' ') },
    { GITHUB_WORKFLOW_REF: `${desktop}@refs/heads/main anyrayHQ/install/.github/workflows/release-connect-binaries.yml@refs/heads/main` },
    ...['GITHUB_REPOSITORY', 'GITHUB_EVENT_NAME', 'GITHUB_REF', 'GITHUB_WORKFLOW_REF', 'GITHUB_ACTOR_ID']
      .map((key) => ({ [key]: undefined })),
  ];
  for (const deviation of deviations) {
    const tree = hookTree(t);
    const result = runHook(tree, 'job-started', deviation);
    assert.equal(result.status, 1, result.log);
    assert.ok(result.log.includes(`::error::${Object.keys(deviation)[0]}`), result.log);
    for (const value of Object.values(deviation)) if (value) assert.ok(!result.log.includes(value), result.log);
    assert.equal(result.security, '');
    assertUntouched(tree);
  }
});

test('job-started phase is inferred from the installed symlink', (t) => {
  const tree = hookTree(t);
  const link = join(tree.bin, 'job-started.sh');
  symlinkSync(fileURLToPath(new URL('./mac-runner-hook.sh', import.meta.url)), link);
  const result = runHook(tree, null, {}, link);
  assert.equal(result.status, 0, result.log);
  assertMoved(tree);
});

test('job-started reclaims only old trash under the disk floor and refuses if space stays low', (t) => {
  const tree = hookTree(t);
  const trash = join(tree.home, '.runner-trash');
  const old = join(trash, 'old');
  const fresh = join(trash, 'fresh');
  for (const dir of [old, fresh]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(old, 'source'), 'old private source');
  const timestamp = new Date(Date.now() - 61 * 60 * 1000);
  utimesSync(old, timestamp, timestamp);
  writeFileSync(join(trash, 'cleanup.log'), 'line1\nline2\nline3\nline4\nline5\nline6\n');
  const result = runHook(tree, 'job-started', { HOOK_AVAILABLE_KIB: String(19 * 1048576) });
  assert.equal(result.status, 1, result.log);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true);
  assert.match(result.log, /::warning::/);
  assert.match(result.log, /line2\nline3\nline4\nline5\nline6/);
  assert.doesNotMatch(result.log, /line1/);
  assert.match(result.log, /::error::[^\n]*cleanup\.log[^\n]*RELEASING\.md/);
  assert.equal(result.security, '');
  assert.deepEqual(readdirSync(tree.workspace).sort(), ['.git', '.hidden', 'out', 'private-source']);
});

test('job-started warns about old trash but allows the exact disk floor', (t) => {
  const tree = hookTree(t);
  const old = join(tree.home, '.runner-trash', 'old');
  mkdirSync(old, { recursive: true });
  const timestamp = new Date(Date.now() - 61 * 60 * 1000);
  utimesSync(old, timestamp, timestamp);
  writeFileSync(join(tree.home, '.runner-trash', 'cleanup.log'), 'cleanup diagnostics\n');
  const result = runHook(tree, 'job-started', { HOOK_AVAILABLE_KIB: String(20 * 1048576) });
  assert.equal(result.status, 0, result.log);
  assert.match(result.log, /::warning::/);
  assert.match(result.log, /cleanup diagnostics/);
  assert.equal(existsSync(old), true);
  assert.deepEqual(readdirSync(tree.workspace), ['.git']);
});

test('hooks fail closed on invalid paths and completed warns without failing or moving files', (t) => {
  for (const phase of ['job-started', 'job-completed']) {
    for (const kind of ['outside', 'parent', 'work-root', 'relative-home', 'relative-temp', 'temp-suffix']) {
      const tree = hookTree(t);
      const overrides = {
        outside: { GITHUB_WORKSPACE: tree.home },
        parent: { GITHUB_WORKSPACE: join(tree.temp, 'install') + '/../install' },
        'work-root': { GITHUB_WORKSPACE: join(tree.dir, 'runner', '_work') },
        'relative-home': { HOME: 'home' },
        'relative-temp': { RUNNER_TEMP: 'runner/_work/_temp' },
        'temp-suffix': { RUNNER_TEMP: join(tree.dir, 'runner', '_work', 'temp') },
      }[kind];
      const result = runHook(tree, phase, overrides);
      assert.equal(result.status, phase === 'job-started' ? 1 : 0, `${phase}/${kind}: ${result.log}`);
      assert.match(result.log, phase === 'job-started' ? /::error::/ : /::warning::/);
      assertUntouched(tree);
    }
  }
});

test('hooks delete throwaway keychains and restore the login search list and default', (t) => {
  for (const phase of ['job-started', 'job-completed']) {
    const tree = hookTree(t);
    const login = join(tree.home, 'Library', 'Keychains', 'login.keychain-db');
    mkdirSync(join(tree.home, 'Library', 'Keychains'), { recursive: true });
    writeFileSync(login, 'login keychain');
    const stray = join(tree.temp, 'x.keychain-db');
    writeFileSync(stray, 'throwaway signing keychain');
    const result = runHook(tree, phase);
    assert.equal(result.status, 0, result.log);
    assert.ok(result.security.includes(`delete-keychain ${stray}\n`), result.security);
    assert.ok(result.security.includes(`list-keychains -d user -s ${login}\n`), result.security);
    assert.ok(result.security.includes(`default-keychain -d user -s ${login}\n`), result.security);
    assert.equal(existsSync(stray), false);
    assertMoved(tree);
  }
});

test('hooks set an empty keychain search list when the login keychain is absent', (t) => {
  const tree = hookTree(t);
  const result = runHook(tree);
  assert.equal(result.status, 0, result.log);
  assert.equal(result.security, 'list-keychains -d user -s\n');
  assertMoved(tree);
});

test('job-completed warns on security failure and still clears the workspace with exit zero', (t) => {
  const tree = hookTree(t);
  writeFileSync(join(tree.temp, 'x.keychain-db'), 'throwaway signing keychain');
  const result = runHook(tree, 'job-completed', { HOOK_SECURITY_STATUS: '1' });
  assert.equal(result.status, 0, result.log);
  assert.match(result.log, /::warning::/);
  assert.doesNotMatch(result.log, /::error::/);
  assert.equal(existsSync(join(tree.temp, 'x.keychain-db')), false);
  assertMoved(tree);
});

// The other hook tests stub the background launcher so the moved tree stays put for their
// assertions; this one lets the detached delete run, outside the runner's orphan sweep.
test('the detached delete removes the moved workspace with an empty tracking id', async (t) => {
  const tree = hookTree(t);
  const launched = join(tree.dir, 'launched.log');
  rmSync(join(tree.bin, 'taskpolicy'));
  writeFileSync(join(tree.bin, 'nice'), `#!/bin/bash
printf 'tracking=[%s]\\n' "\${RUNNER_TRACKING_ID-unset}" >> "${launched}"
shift 2
exec "$@"
`, { mode: 0o755 });
  const result = runHook(tree, 'job-completed');
  assert.equal(result.status, 0, result.log);
  assert.deepEqual(readdirSync(tree.workspace), ['.git']);
  const trash = join(tree.home, '.runner-trash');
  const deadline = Date.now() + 15_000;
  const moved = () => readdirSync(trash).filter((entry) => statSync(join(trash, entry)).isDirectory());
  while (moved().length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(moved(), [], 'the detached delete did not remove the moved workspace');
  assert.equal(readFileSync(launched, 'utf8'), 'tracking=[]\n');
});

test('hooks return usage status for unknown or missing phases', (t) => {
  const tree = hookTree(t);
  for (const phase of ['unknown', null]) {
    const result = runHook(tree, phase);
    assert.equal(result.status, 2, result.log);
    assert.equal(result.security, '');
    assertUntouched(tree);
  }
});

test('the new scripts are executable', () => {
  for (const name of ['mac-runner.sh', 'mac-runner-hook.sh']) {
    assert.equal(statSync(new URL(`./${name}`, import.meta.url)).mode & 0o777, 0o755);
  }
});
