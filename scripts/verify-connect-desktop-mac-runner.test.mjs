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

// The workflow expression. The dollar sign is interpolated rather than backslash-escaped
// (CodeQL js/useless-regexp-character-escape).
const runsOn = (label) => `${'$'}{{ needs.provision-mac.outputs.mac_runner == 'ec2' && fromJSON('["self-hosted","macOS","ARM64","${label}"]') || format('codebuild-anyray-install-runner-mac-{0}-{1}', github.run_id, github.run_attempt) }}`;
const SIGN_RUNS_ON = runsOn('anyray-install-mac');
const BUILD_RUNS_ON = runsOn('anyray-install-mac-build');
const WORKFLOWS = [
  'release-connect-desktop.yml',
  'release-connect-binaries.yml',
];
const MAC_JOBS = {
  'release-connect-desktop.yml': ['build-macos-unsigned', 'sign-macos', 'verify-macos-signed'],
  'release-connect-binaries.yml': ['sign-macos', 'verify-macos-launch'],
};
const ROLE_JOBS = {
  sign: ['sign-macos'],
  build: ['build-macos-unsigned', 'verify-macos-signed', 'verify-macos-launch'],
};
const MAINTAINERS = ['16443050', '187185370'];
const MAINTAINER_LOGINS = ['0xtechdean', 'Dima-Othentic'];

function readWorkflow(file) {
  return readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
}

function persistentRunbook() {
  return readFileSync(new URL('../RELEASING.md', import.meta.url), 'utf8')
    .split('### The persistent macOS signing host (ANY-1405)\n')[1].split('\n## ')[0];
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

function stepRun(step) {
  assert.equal(field(step, 'run', 8), '|', 'step must have a literal run block');
  const lines = step.slice(step.indexOf('        run: |\n') + '        run: |\n'.length).split('\n');
  const end = lines.findIndex((line) => line.trim() && !line.startsWith('          '));
  return lines.slice(0, end === -1 ? undefined : end).join('\n').replace(/^ {10}/gm, '').trimEnd();
}

function evaluate(expression, macRunner, result = 'success', overrides = {}) {
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
    ...overrides,
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

function hookTree(t, role = 'sign') {
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
  writeFileSync(join(bin, 'id'), `#!/bin/bash
case "$1" in
  -un) printf '%s\\n' "$HOOK_USER" ;;
  -Gn) printf '%s\\n' "$HOOK_GROUPS" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, 'sudo'), '#!/bin/bash\nexit "${HOOK_SUDO_STATUS:-1}"\n', { mode: 0o755 });
  // Keep the renamed workspace available for synchronous assertions. The real
  // detached worker removes it immediately, which would race those assertions.
  for (const command of ['taskpolicy', 'nice']) {
    writeFileSync(join(bin, command), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  }
  return {
    dir, home, temp, workspace, bin, securityLog, role,
    env: {
      PATH: `${bin}:/usr/bin:/bin`, HOME: home, RUNNER_TEMP: temp,
      GITHUB_WORKSPACE: workspace, GITHUB_REPOSITORY: 'anyrayHQ/install',
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
      GITHUB_WORKFLOW_REF: 'anyrayHQ/install/.github/workflows/release-connect-desktop.yml@refs/heads/main',
      GITHUB_ACTOR_ID: MAINTAINERS[0], HOOK_SECURITY_LOG: securityLog,
      GITHUB_TRIGGERING_ACTOR: '0xtechdean', GITHUB_RUN_ID: '777', GITHUB_RUN_ATTEMPT: '2',
      GITHUB_JOB: role === 'sign' ? 'sign-macos' : 'build-macos-unsigned',
      HOOK_USER: `anyray-${role}`, HOOK_GROUPS: 'staff everyone',
      HOOK_AVAILABLE_KIB: String(40 * 1048576), RUNNER_TRACKING_ID: 'test-job',
    },
  };
}

function runHook(tree, phase = 'job-started', overrides = {}, script, role = tree.role) {
  const env = { ...tree.env, ...overrides };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const result = spawnSync(existsSync('/bin/bash') ? '/bin/bash' : 'bash', [
    '--noprofile', '--norc', '-e', '-o', 'pipefail',
    script ?? fileURLToPath(new URL('./mac-runner-hook.sh', import.meta.url)),
    ...(phase === null ? [] : [role, phase]),
  ], { encoding: 'utf8', timeout: 30_000, env });
  return { ...result, log: result.stdout + result.stderr, security: readFileSync(tree.securityLog, 'utf8') };
}

function assertUntouched(tree) {
  assert.deepEqual(readdirSync(tree.workspace).sort(), ['.git', '.hidden', 'out', 'private-source']);
  assert.equal(readFileSync(join(tree.workspace, 'private-source', 'x'), 'utf8'), 'private source');
  assert.equal(readFileSync(join(tree.workspace, 'out', 'y.pkg'), 'utf8'), 'signed output');
  assert.equal(existsSync(join(tree.home, '.runner-trash')), false);
  assert.deepEqual(readdirSync(tree.temp).filter((name) => name.startsWith('.trust-gate-')), []);
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

test('exactly the six release Mac jobs use Mac runners', () => {
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
      const role = ROLE_JOBS.sign.includes(id) ? 'sign' : 'build';
      assert.equal(runner, role === 'sign' ? SIGN_RUNS_ON : BUILD_RUNS_ON, `${id}: Mac runner selection expression is absent`);
      assert.ok(needs(body).includes('provision-mac'), `${id} needs provision-mac`);
      for (const choice of ['codebuild', '']) {
        const today = 'codebuild-anyray-install-runner-mac-${{ github.run_id }}-${{ github.run_attempt }}'
          .replace(/\$\{\{\s*(github\.[a-z_]+)\s*\}\}/g, (_, expression) => evaluate(expression, choice));
        assert.equal(today, 'codebuild-anyray-install-runner-mac-777-2');
        assert.equal(evaluate(runner, choice), today);
      }
      assert.deepEqual(evaluate(runner, 'ec2'), ['self-hosted', 'macOS', 'ARM64', role === 'sign' ? 'anyray-install-mac' : 'anyray-install-mac-build']);
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
    assert.equal(field(selection, 'INSTALL_MAC_RUNNER', 10), file === 'release-connect-desktop.yml'
      ? '${{ inputs.mac_runner || vars.INSTALL_MAC_RUNNER }}' : '${{ vars.INSTALL_MAC_RUNNER }}');
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
    for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
      for (const choice of ['codebuild', '', 'ec2']) {
        assert.equal(evaluate(field(teardown, 'if'), choice, result),
          choice !== 'ec2' && result !== 'skipped', `${result}/${choice}`);
      }
    }
    assert.ok(needs(teardown).includes('provision-mac'));
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

for (const [role, expression] of [['sign', SIGN_RUNS_ON], ['build', BUILD_RUNS_ON]]) {
  test(`the hook ${role} job list equals the jobs assigned to its runner in the workflows`, () => {
    const hook = readFileSync(new URL('./mac-runner-hook.sh', import.meta.url), 'utf8');
    const constant = `${role.toUpperCase()}_JOBS`;
    const match = hook.match(new RegExp(`^${constant}="([^"]+)"`, 'm'));
    assert.ok(match, `${constant} is absent`);
    const expected = WORKFLOWS.flatMap((file) => Object.entries(jobs(readWorkflow(file)))
      .filter(([, body]) => field(body, 'runs-on') === expression).map(([id]) => id));
    assert.deepEqual(new Set(match[1].split(' ')), new Set(expected));
  });
}

test('signing jobs never execute build output and the binary launches run in verify-macos-launch', () => {
  const binaries = jobs(readWorkflow('release-connect-binaries.yml'));
  const signingJobs = [
    binaries['sign-macos'],
    jobs(readWorkflow('release-connect-desktop.yml'))['sign-macos'],
  ];
  for (const body of signingJobs) {
    assert.doesNotMatch(body, /(?:"\$(?:bin|universal_connect|engine)"|"?out\/[^\s"]+"?|"[^"\n]*anyray-connect[^"\n]*")\s+--(?:help|version)\b/);
  }
  const verify = binaries['verify-macos-launch'];
  assert.ok(verify, 'verify-macos-launch is absent');
  assert.deepEqual(needs(verify), ['provision-mac', 'sign-macos']);
  assert.equal(field(verify, 'timeout-minutes'), '20');
  assert.match(verify, /permissions:\n      contents: read\n      id-token: write/);
  assert.match(verify, /s3-artifact-download\n[\s\S]*?name: binaries-darwin\n          path: signed\n/);
  assert.match(verify, /s3-artifact-download\n[\s\S]*?name: binaries-macos-pkg\n          path: signed-pkg\n/);
  assert.match(verify, /signed\/anyray-connect-darwin-arm64 --help > \/dev\/null/);
  assert.match(verify, /pkgutil --expand-full signed-pkg\/anyray-connect\.pkg/);
  assert.match(verify, /find "\$expanded" -type f -path '\*\/usr\/local\/bin\/anyray-connect'/);
  assert.match(verify, /"\$universal" --version > \/dev\/null/);
  assert.ok(Object.keys(binaries).indexOf('verify-macos-launch') === Object.keys(binaries).indexOf('sign-macos') + 1);
});

for (const [id, mode] of [['store-set', 'prepare'], ['release', 'release'], ['desktop', 'prepare']]) {
  test(`binaries ${id} requires a successful launch check when consuming sign-macos`, () => {
    const body = jobs(readWorkflow('release-connect-binaries.yml'))[id];
    assert.ok(needs(body).includes('verify-macos-launch'), `${id} needs verify-macos-launch`);
    for (const result of ['failure', 'success']) {
      const context = {
        inputs: { mode, source_sha: 'a'.repeat(40), staging: false },
        needs: Object.fromEntries(needs(body).map((name) => [name, {
          result: name === 'verify-macos-launch' ? result : 'success', outputs: {},
        }])),
      };
      assert.equal(evaluate(field(body, 'if'), 'ec2', 'success', context), result === 'success', `${id}/${result}`);
    }
  });
}

test('binaries teardown waits for the launch check', () => {
  assert.deepEqual(needs(jobs(readWorkflow('release-connect-binaries.yml'))['teardown-mac']),
    ['provision-mac', 'sign-macos', 'verify-macos-launch']);
});

test('desktop ec2 verification runs the engine then the root-smoke gate before any root smoke', () => {
  const verify = jobs(readWorkflow('release-connect-desktop.yml'))['verify-macos-signed'];
  const step = steps(verify).find((body) => field(body, 'name', 8) === 'Verify signed installation, sweep cases and uninstall');
  assert.equal(field(step, 'MAC_RUNNER', 10), '${{ needs.provision-mac.outputs.mac_runner }}');
  assert.equal(field(step, 'CHANNEL', 10), '${{ needs.preflight.outputs.channel }}');
  assert.equal(field(step, 'ROOT_SMOKE_ACCEPTED', 10), '${{ vars.INSTALL_MAC_ROOT_SMOKE_ACCEPTED }}');
  const run = stepRun(step);
  const block = run.match(/if \[ "\$MAC_RUNNER" = ec2 \]; then\n[\s\S]*?^fi$/m);
  assert.ok(block, 'ec2 verification block is absent');
  const throughEc2 = run.slice(0, block.index + block[0].length);
  assert.doesNotMatch(throughEc2, /\bsudo\b|trap cleanup EXIT/);
  assert.match(block[0], /test "\$\("\$updater_app\/Contents\/MacOS\/anyray-connect" --version \| head -1\)" = "anyray-connect \$VERSION"/);
  assert.doesNotMatch(block[0], /\bsudo\b/);
  const launch = block[0].indexOf('"$updater_app/Contents/MacOS/anyray-connect" --version');
  const gate = block[0].indexOf('./scripts/mac-root-smoke-gate.sh');
  assert.ok(gate > launch && launch >= 0 && block[0].indexOf('exit 0') > gate);
  assert.match(block[0], /\n  exit 0\nfi$/);
  assert.ok(run.indexOf("installed_app='/Applications/Anyray Connect.app'") > throughEc2.length);
});

function smokeGate(channel, acceptance) {
  const env = { PATH: process.env.PATH };
  if (channel !== undefined) env.CHANNEL = channel;
  if (acceptance !== undefined) env.ROOT_SMOKE_ACCEPTED = acceptance;
  const result = spawnSync(existsSync('/bin/bash') ? '/bin/bash' : 'bash', [
    fileURLToPath(new URL('./mac-root-smoke-gate.sh', import.meta.url)),
  ], { encoding: 'utf8', timeout: 10_000, env });
  return { ...result, log: result.stdout + result.stderr };
}

test('root-smoke gate allows staging with the staging warning', () => {
  const result = smokeGate('staging');
  assert.equal(result.status, 0, result.log);
  assert.equal(result.stdout, '::warning::root install, sweep and uninstall smoke skipped on the persistent Mac host (staging)\n');
  assert.equal(statSync(new URL('./mac-root-smoke-gate.sh', import.meta.url)).mode & 0o777, 0o755);
});

for (const acceptance of ['ANY-1405', 'https://github.com/anyrayHQ/install/issues/12#issuecomment-345', 'https://github.com/anyrayHQ/install/pull/12#issuecomment-345']) {
  test(`root-smoke gate allows stable with recorded acceptance ${acceptance}`, () => {
    const result = smokeGate('stable', acceptance);
    assert.equal(result.status, 0, result.log);
    assert.equal(result.stdout, `::warning::stable macOS ships without the root install smoke under the recorded acceptance ${acceptance}\n`);
  });
}

for (const acceptance of [
  undefined, '', 'yes', 'ANY-', 'any-1405', 'ANY-1405 ',
  'https://github.com/evil/x/issues/1#issuecomment-2',
  'https://github.com/anyrayHQ/install/issues/12', '::warning::x',
]) {
  test(`root-smoke gate refuses stable acceptance ${JSON.stringify(acceptance) ?? '<unset>'}`, () => {
    const result = smokeGate('stable', acceptance);
    assert.equal(result.status, 1, result.log);
    assert.match(result.log, /::error::the stable lane needs the root install smoke/);
    assert.match(result.log, /set INSTALL_MAC_ROOT_SMOKE_ACCEPTED to Dean's written acceptance \(RELEASING.md\) or run stable on the CodeBuild fleet/);
    if (acceptance) assert.ok(!result.log.includes(acceptance), 'rejected acceptance was printed');
  });
}

test('root-smoke gate refuses unknown, empty and unset channels', () => {
  for (const channel of ['unknown', '', undefined]) {
    const result = smokeGate(channel, 'ANY-1405');
    assert.equal(result.status, 1, result.log);
    assert.match(result.log, /::error::/);
  }
});

test('the runbook states the stable root-smoke acceptance and the fleet fallback', () => {
  const section = persistentRunbook();
  assert.match(section, /root install, sweep and uninstall smoke does not run on this host/);
  assert.match(section, /no CI code as root/);
  assert.match(section, /staging proceeds with a warning/);
  assert.match(section, /stable FAILS the macOS desktop leg on ec2 unless/);
  assert.match(section, /INSTALL_MAC_ROOT_SMOKE_ACCEPTED[\s\S]*Jira key or the GitHub comment URL[\s\S]*Dean's written acceptance/);
  assert.ok(section.includes('gh variable set INSTALL_MAC_ROOT_SMOKE_ACCEPTED -R anyrayHQ/install --body <ANY-key or comment URL>'));
  assert.ok(section.includes('gh variable delete INSTALL_MAC_ROOT_SMOKE_ACCEPTED -R anyrayHQ/install'));
  assert.match(section, /without it[\s\S]*stable macOS[\s\S]*CodeBuild fleet[\s\S]*unset `INSTALL_MAC_RUNNER` for that release/i);
});

test('rustup detection uses the build home and restores its PATH entry', (t) => {
  const build = jobs(readWorkflow('release-connect-desktop.yml'))['build-macos-unsigned'];
  const step = steps(build).find((body) => field(body, 'name', 8) === 'Check for an existing Rust toolchain');
  const run = stepRun(step);
  assert.ok(run.includes('[ -x "$HOME/.cargo/bin/rustup" ]'), 'rustup check must use the explicit home path');
  assert.doesNotMatch(run, /command -v rustup/);
  for (const present of [false, true]) {
    const dir = temporaryTree(t);
    const output = join(dir, 'output');
    const githubPath = join(dir, 'github-path');
    mkdirSync(join(dir, '.cargo', 'bin'), { recursive: true });
    if (present) writeFileSync(join(dir, '.cargo', 'bin', 'rustup'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    writeFileSync(githubPath, '');
    const result = spawnSync('bash', ['-c', run], { encoding: 'utf8', timeout: 10_000, env: {
      PATH: '/usr/bin:/bin', HOME: dir, GITHUB_OUTPUT: output, GITHUB_PATH: githubPath,
    } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(output, 'utf8'), `present=${present}\n`);
    assert.equal(readFileSync(githubPath, 'utf8'), present ? `${dir}/.cargo/bin\n` : '');
  }
});

test('the documented daemon PATH uses system tools first and leaves cargo to the build job', () => {
  const releasing = readFileSync(new URL('../RELEASING.md', import.meta.url), 'utf8');
  const paths = [...releasing.matchAll(/<key>PATH<\/key>\s*<string>([^<]+)<\/string>/g)];
  assert.ok(paths.length > 0, 'daemon PATH is absent');
  for (const [, path] of paths) assert.equal(path, '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin');
});

for (const role of ['sign', 'build']) {
  test(`${role} job-started writes exactly its empty run-attempt-job canary`, (t) => {
    const tree = hookTree(t, role);
    const result = runHook(tree);
    assert.equal(result.status, 0, result.log);
    const expected = `.trust-gate-${tree.env.GITHUB_RUN_ID}-${tree.env.GITHUB_RUN_ATTEMPT}-${tree.env.GITHUB_JOB}`;
    assert.deepEqual(readdirSync(tree.temp), [expected]);
    assert.equal(readFileSync(join(tree.temp, expected), 'utf8'), '');
  });
}

test('job-started refuses a canary write failure without announcing a passing gate', (t) => {
  const tree = hookTree(t);
  mkdirSync(join(tree.temp, '.trust-gate-777-2-sign-macos'));
  const result = runHook(tree);
  assert.equal(result.status, 1, result.log);
  assert.match(result.log, /::error::Trust-gate canary write check failed/);
  assert.doesNotMatch(result.log, /::notice::/);
});

const CANARY_RUN = `set -euo pipefail
[ "$MAC_RUNNER" = ec2 ] || exit 0
test -f "$RUNNER_TEMP/.trust-gate-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB" || {
  echo '::error::the job-started trust gate did not run on this host (RELEASING.md, The persistent macOS signing host)'
  exit 1
}`;

for (const file of WORKFLOWS) {
  for (const id of MAC_JOBS[file]) {
    test(`${file}:${id} starts with the identical canary step and enforces the hook result`, (t) => {
      const first = steps(jobs(readWorkflow(file))[id])[0];
      const header = `        name: Refuse unless the host's trust gate ran (persistent Mac only)
        env:
          MAC_RUNNER: \${{ needs.provision-mac.outputs.mac_runner }}
`;
      assert.equal(first.slice(0, first.indexOf('        run: |\n')), header);
      const run = stepRun(first);
      assert.equal(run, CANARY_RUN, 'canary run blocks must be byte-identical');
      const tree = hookTree(t, ROLE_JOBS.sign.includes(id) ? 'sign' : 'build');
      tree.env.GITHUB_JOB = id;
      tree.env.GITHUB_WORKFLOW_REF = `anyrayHQ/install/.github/workflows/${file}@refs/heads/main`;
      const result = runHook(tree);
      assert.equal(result.status, 0, result.log);
      const check = (choice) => spawnSync('bash', ['-c', run], {
        encoding: 'utf8', timeout: 10_000, env: { ...tree.env, MAC_RUNNER: choice },
      });
      assert.equal(check('ec2').status, 0, 'a passing hook must allow the job');
      rmSync(join(tree.temp, `.trust-gate-777-2-${id}`));
      const missing = check('ec2');
      assert.equal(missing.status, 1, 'a missing hook must refuse the job');
      assert.match(missing.stdout + missing.stderr, /::error::the job-started trust gate did not run/);
      assert.equal(check('codebuild').status, 0, 'CodeBuild must not require a canary');
    });
  }
}

test('the runbook requires the runner group before ec2 and explains the canary limit', () => {
  const releasing = readFileSync(new URL('../RELEASING.md', import.meta.url), 'utf8');
  assert.match(releasing, /runner group[^\n]*REQUIRED before[^\n]*INSTALL_MAC_RUNNER=ec2/);
  assert.doesNotMatch(releasing, /Optionally[^\n]*(?:\n[^\n]*)?runner group/);
  assert.match(releasing, /canary[\s\S]*hooks were removed or never configured[\s\S]*red job/);
  assert.match(releasing, /already compromised[\s\S]*write the file itself/);
});

test('the runbook includes the two-role spoofed-environment probe verbatim', () => {
  const releasing = readFileSync(new URL('../RELEASING.md', import.meta.url), 'utf8');
  const probe = releasing.match(/```yaml\n(name: Probe the Mac host trust gate[\s\S]*?)\n```/);
  assert.equal(probe?.[1], `name: Probe the Mac host trust gate (delete after use)
on:
  push:
    branches: [probe/any-1405-hook]
permissions:
  contents: read
env:
  BASH_ENV: '$(/usr/bin/touch /tmp/hook-env-probe)'
  GITHUB_EVENT_NAME: workflow_dispatch
  GITHUB_REF: refs/heads/main
jobs:
  sign-macos:
    runs-on: [self-hosted, macOS, ARM64, anyray-install-mac]
    timeout-minutes: 5
    steps:
      - run: /usr/bin/touch /tmp/hook-env-probe-step
  build-macos-unsigned:
    runs-on: [self-hosted, macOS, ARM64, anyray-install-mac-build]
    timeout-minutes: 5
    steps:
      - run: /usr/bin/touch /tmp/hook-env-probe-step`);
});

test('the runbook requires both probe rounds before enabling ec2', () => {
  const releasing = readFileSync(new URL('../RELEASING.md', import.meta.url), 'utf8');
  const first = releasing.indexOf('First round,');
  const second = releasing.indexOf('Second round,');
  const enable = releasing.indexOf('gh variable set INSTALL_MAC_RUNNER');
  assert.ok(first >= 0 && second > first && enable > second, 'both probe rounds must precede enabling ec2');
  assert.ok(releasing.includes('.github/workflows/probe-mac-hook.yml'), 'probe workflow path is absent');
  assert.match(releasing, /First round,[\s\S]*all workflows of this repo[\s\S]*proves the hook/);
  assert.ok(releasing.includes('::error::GITHUB_EVENT_NAME check failed'), 'probe must prove the real push event is checked');
  assert.match(releasing, /Second round,[\s\S]*restrict[\s\S]*proves the group[\s\S]*queued with no runner[\s\S]*cancel[\s\S]*delete the branch/);
});

test('the third probe replaces a listed workflow at a non-main ref before enabling ec2', () => {
  const releasing = persistentRunbook();
  const third = releasing.indexOf('Third round,');
  const second = releasing.indexOf('Second round,');
  const enable = releasing.indexOf('gh variable set INSTALL_MAC_RUNNER');
  assert.ok(third > second && second >= 0 && enable > third, 'the third probe round must precede enabling ec2');
  const round = releasing.slice(third, enable);
  assert.match(round, /REPLACE the whole content of\s+`\.github\/workflows\/release-connect-binaries.yml`/);
  assert.match(round, /nothing else in that workflow runs/);
  const block = round.match(/```yaml\n([\s\S]*?)\n```/);
  assert.equal(block?.[1], `name: Probe the runner group's ref pinning (delete after use)
on:
  push:
    branches: [probe/any-1405-ref]
permissions:
  contents: read
jobs:
  sign-macos:
    runs-on: [self-hosted, macOS, ARM64, anyray-install-mac]
    timeout-minutes: 5
    steps:
      - run: /usr/bin/touch /tmp/hook-env-probe-ref`);
  assert.match(round, /stays queued with no runner/);
  assert.match(round, /cancel the run[\s\S]*ls -l \/tmp\/hook-env-probe-ref[\s\S]*prints nothing[\s\S]*delete the branch/);
  assert.match(round, /fails at "job started hook"[\s\S]*non-main ref[\s\S]*stop, fix the entry[\s\S]*@refs\/heads\/main[\s\S]*@main[\s\S]*repeat rounds two and three/);
  assert.match(releasing.slice(enable), /staging dry run[\s\S]*still admits main/);
  // The gate sentence right before the switch names all three rounds, not an older count.
  const gate = releasing.lastIndexOf('Only after', enable);
  assert.ok(gate > third, 'the switch must be gated by a sentence after round three');
  assert.equal(releasing.slice(gate, releasing.indexOf('\n', gate)), 'Only after all three rounds pass, set the repository variable:');
});

test('the runbook checks probe sentinels and proves invocation through the hook symlink', () => {
  const releasing = readFileSync(new URL('../RELEASING.md', import.meta.url), 'utf8');
  assert.ok(releasing.includes('ls -l /tmp/hook-env-probe*'), 'probe sentinel check is absent');
  assert.ok(releasing.includes('neither `/tmp/hook-env-probe` nor `/tmp/hook-env-probe-step` exists'), 'both probe sentinels must be absent');
  assert.ok(releasing.includes('A job started hook has been configured by the self-hosted runner administrator'), 'runner hook log evidence is absent');
  assert.match(releasing, /symlink[\s\S]*mac-runner-hook\.sh[\s\S]*no arguments[\s\S]*usage error/);
});

for (const file of WORKFLOWS) {
  test(`${file}: every secret decode uses a one-line umask 077 subshell`, () => {
    const decodes = readWorkflow(file).split('\n').filter((line) => line.includes('base64 -d'));
    assert.equal(decodes.length, 3, 'secret decode count changed');
    for (const line of decodes) {
      assert.match(line, /^\s*\( umask 077; printf '%s' "\$[A-Z0-9_]+" \| base64 -d > "\$RUNNER_TEMP\/[^"]+" \)$/);
    }
  });
}

test('the six secret decodes preserve the binaries keychain umask 022 rule', () => {
  assert.equal(WORKFLOWS.flatMap((file) => readWorkflow(file).split('\n')).filter((line) => line.includes('base64 -d')).length, 6);
  const binaries = readWorkflow('release-connect-binaries.yml');
  assert.match(binaries, /# umask is scoped to the password file: a 0600 keychain-db is\n\s+# unreadable to trustd, so codesign can't build the cert chain/);
  assert.match(binaries, /^          umask 022$/m);
});

test('called desktop declares the optional saved mac_runner input', () => {
  const call = readWorkflow('release-connect-desktop.yml').split('  workflow_call:\n')[1].split('    outputs:\n')[0];
  const input = call.match(/^      mac_runner:\n((?: {8}[^\n]*\n)+)/m)?.[1];
  assert.ok(input, 'workflow_call.inputs.mac_runner is absent');
  assert.equal(field(input, 'type', 8), 'string');
  assert.equal(field(input, 'required', 8), 'false');
  assert.equal(field(input, 'default', 8), "''");
  assert.match(input, /description: .*caller's provision-mac choice \(codebuild or ec2\); empty when run by hand/);
});

test('called desktop selection prefers the caller choice over the variable in either direction', () => {
  const provision = jobs(readWorkflow('release-connect-desktop.yml'))['provision-mac'];
  const selection = steps(provision).find((body) => field(body, 'id', 8) === 'mac-runner');
  const expression = field(selection, 'INSTALL_MAC_RUNNER', 10);
  for (const [input, variable, expected] of [
    ['codebuild', 'ec2', 'codebuild'], ['ec2', 'codebuild', 'ec2'],
    ['', 'codebuild', 'codebuild'], ['', 'ec2', 'ec2'], ['', '', ''],
  ]) {
    assert.equal(evaluate(expression, '', 'success', { inputs: { mac_runner: input }, vars: { INSTALL_MAC_RUNNER: variable } }),
      expected, `input=${input}, variable=${variable}`);
  }
});

test('binaries desktop passes provision-mac choice to the called workflow', () => {
  const desktop = jobs(readWorkflow('release-connect-binaries.yml')).desktop;
  assert.ok(needs(desktop).includes('provision-mac'), 'desktop needs provision-mac');
  assert.equal(field(desktop, 'mac_runner', 6), '${{ needs.provision-mac.outputs.mac_runner }}');
});

test('the runbook explains that called desktop inherits the saved choice', () => {
  const releasing = readFileSync(new URL('../RELEASING.md', import.meta.url), 'utf8');
  assert.match(releasing, /called desktop workflow takes the caller's saved choice/);
  assert.match(releasing, /Only a desktop run dispatched by hand reads the variable itself/);
});

test('the hook maintainer ids equal the fleet webhook maintainer ids', () => {
  const hook = readFileSync(new URL('./mac-runner-hook.sh', import.meta.url), 'utf8');
  const fleet = readFileSync(new URL('./mac-fleet.sh', import.meta.url), 'utf8');
  const hookIds = hook.match(/^MAINTAINER_ACCOUNT_IDS="([^"]+)"/m);
  const fleetIds = fleet.match(/^MAINTAINER_ACCOUNT_IDS="([^"]+)"/m);
  assert.ok(hookIds && fleetIds, 'maintainer list is absent');
  assert.deepEqual(new Set(hookIds[1].split(' ')), new Set(fleetIds[1].split(' ')));
});

test('the hook maintainer logins equal the fleet comment and pair with the account ids', () => {
  const hook = readFileSync(new URL('./mac-runner-hook.sh', import.meta.url), 'utf8');
  const fleet = readFileSync(new URL('./mac-fleet.sh', import.meta.url), 'utf8');
  const logins = hook.match(/^MAINTAINER_LOGINS="([^"]+)"/m);
  const ids = hook.match(/^MAINTAINER_ACCOUNT_IDS="([^"]+)"/m);
  const comment = fleet.match(/^# Release maintainers: ([^.]+)\./m);
  assert.ok(logins && ids && comment, 'maintainer logins or fleet comment are absent');
  assert.deepEqual(new Set(logins[1].split(' ')), new Set(comment[1].split(',').map((login) => login.trim())));
  assert.equal(logins[1].split(' ').length, ids[1].split(' ').length);
});

for (const role of ['sign', 'build']) {
  for (const login of ['someone', undefined, MAINTAINER_LOGINS.join(' '), '0XTECHDEAN']) {
    test(`${role} re-run refuses triggering actor ${login ?? '<missing>'} despite a maintainer dispatcher`, (t) => {
      const tree = hookTree(t, role);
      const result = runHook(tree, 'job-started', { GITHUB_TRIGGERING_ACTOR: login });
      assert.equal(result.status, 1, result.log);
      assert.match(result.log, /::error::GITHUB_TRIGGERING_ACTOR check failed/);
      if (login) assert.ok(!result.log.includes(login), result.log);
      assert.equal(result.security, '');
      assertUntouched(tree);
    });
  }
  test(`${role} re-run allows each canonical maintainer triggering actor`, (t) => {
    for (const login of MAINTAINER_LOGINS) {
      const tree = hookTree(t, role);
      const result = runHook(tree, 'job-started', { GITHUB_TRIGGERING_ACTOR: login });
      assert.equal(result.status, 0, result.log);
      assertMoved(tree);
    }
  });
}

test('the runbook registers the persistent label and documents the switch and rollback', () => {
  const releasing = readFileSync(new URL('../RELEASING.md', import.meta.url), 'utf8');
  assert.match(releasing, /sudo -u "\$user" -H bash -c 'cd ~\/actions-runner && \.\/config\.sh --unattended --url https:\/\/github\.com\/anyrayHQ \\\n\s*--token "\$0" --name "\$1" --labels "\$1" --runnergroup anyray-install-mac --work _work' "\$token" "\$label"/);
  assert.match(releasing, /INSTALL_MAC_RUNNER/);
  assert.match(releasing, /gh variable delete INSTALL_MAC_RUNNER -R anyrayHQ\/install/);
});

test('the runbook creates non-admin role accounts and keeps each runner install startable', () => {
  const section = persistentRunbook();
  for (const required of [
    'for user in anyray-sign anyray-build; do', 'sudo sysadminctl -addUser "$user"',
    'sudo createhomedir -c -u "$user"', 'IsHidden 1', 'sudo chmod 0700 "/Users/$user"',
    'dseditgroup -o checkmember -m "$user" admin', 'sudo -u "$user" sudo -n true',
    'sudo chmod 0700 /Users/ec2-user', "stat -f '%Su %Lp %N' /usr/local/bin /opt/homebrew/bin",
    'label=anyray-install-mac', 'label=anyray-install-mac-build',
    // run.sh copies run-helper.sh.template over run-helper.sh in the install directory on
    // every start, and the runner writes its migrated credential files there: a root-owned
    // install does not start, so the runbook must say why it stays account-owned.
    'run-helper.sh',
  ]) assert.ok(section.includes(required), `runbook is missing ${required}`);
  assert.doesNotMatch(section, /--disableupdate/);
  assert.doesNotMatch(section, /chown -R root:wheel \/Users\/anyray-(?:sign|build)\/actions-runner/);
  assert.doesNotMatch(section, /chmod 0644 [^\n]*\.credentials/);
});

test('the runbook requires and reads back an organization group restricted to the main release workflows', () => {
  const section = persistentRunbook();
  for (const required of [
    'restricted_to_workflows=true', 'allows_public_repositories=true',
    'orgs/anyrayHQ/actions/runner-groups', 'restricted_to_workflows, selected_workflows, allows_public_repositories',
    'jobs directly defined within the selected workflows', '@refs/heads/main',
    'stop and do not set the variable',
    'gh api -X POST orgs/anyrayHQ/actions/runners/registration-token',
  ]) assert.ok(section.includes(required), `runbook is missing ${required}`);
  for (const file of WORKFLOWS) {
    assert.ok(section.includes(`selected_workflows[]=anyrayHQ/install/.github/workflows/${file}@main`), `group must include ${file}`);
  }
  assert.doesNotMatch(section, /Optionally[^\n]*(?:\n[^\n]*)?runner group/);
});

test('the runbook wires all four hooks and both unprivileged LaunchDaemons', () => {
  const section = persistentRunbook();
  for (const role of ['sign', 'build']) {
    for (const phase of ['started', 'completed']) {
      const link = `/usr/local/libexec/anyray-install-runner/${role}-job-${phase}.sh`;
      assert.ok(section.includes(`sudo ln -sf mac-runner-hook.sh ${link}`), `${role}-${phase} symlink is absent`);
    }
    const daemon = `/Library/LaunchDaemons/com.anyray.install-actions-runner.${role}.plist`;
    assert.ok(section.includes(`sudo launchctl bootstrap system ${daemon}`), `${role} daemon must be bootstrapped`);
  }
  // The hook paths live in the root-owned daemon plist, not in the account-writable .env.
  for (const [phase, variable] of [['started', 'STARTED'], ['completed', 'COMPLETED']]) {
    assert.ok(
      section.includes(`<key>ACTIONS_RUNNER_HOOK_JOB_${variable}</key>\n    <string>/usr/local/libexec/anyray-install-runner/sign-job-${phase}.sh</string>`),
      `sign daemon must carry the ${phase} hook`,
    );
  }
  assert.ok(section.includes("-e 's/sign-job-/build-job-/g'"), 'the build daemon must point at the build hooks');
  assert.doesNotMatch(section, /actions-runner\/\.env/);
  assert.doesNotMatch(section, /ACTIONS_RUNNER_HOOK_JOB_(?:STARTED|COMPLETED)=/);
  assert.match(section, /<key>Label<\/key>\s*<string>com\.anyray\.install-actions-runner\.sign<\/string>/);
  assert.match(section, /<key>UserName<\/key>\s*<string>anyray-sign<\/string>/);
  assert.match(section, /<key>HOME<\/key>\s*<string>\/Users\/anyray-sign<\/string>/);
  assert.doesNotMatch(section, /<string>(?:\/Users\/)?ec2-user(?:\/[^<]*)?<\/string>/);
  assert.ok(section.includes('gh api orgs/anyrayHQ/actions/runners'), 'online check must use organization runners');
});

test('the runbook states the signing boundary and persistent build-account risks', () => {
  const section = persistentRunbook();
  for (const required of [
    "from install main, pinned actions and Apple's tools.", 'It never runs build output', 'cargo build scripts and proc macros always run',
    'both homes are mode 0700', 'local privilege-escalation exploit',
    'tamper with later builds, which are then signed', "copy the build runner's credentials",
    'monorepo read App key', 'S3 artifact role', 'until the build account is reset',
    'ephemeral build account and runner per job', 'disposable macOS VM per smoke',
    'root can copy the runner registration credentials', 'a reset does not revoke them',
    'ec2-user`, which runs no runner',
  ]) assert.ok(section.includes(required), `security posture is missing ${required}`);
  assert.doesNotMatch(section, /Jobs run as `ec2-user`|anyray-smoke|verify job that died mid-smoke/);
});

test('the runbook requires weekly build-account revocation and recreation', () => {
  const section = persistentRunbook();
  for (const required of [
    '**Reset the build account.**', 'weekly and after any dependency incident',
    'sudo launchctl bootout system/com.anyray.install-actions-runner.build',
    'gh api -X DELETE orgs/anyrayHQ/actions/runners/<id>',
    'sudo sysadminctl -deleteUser anyray-build',
    'repeat the account, runner, hook and daemon steps for it',
  ]) assert.ok(section.includes(required), `reset procedure is missing ${required}`);
});

test('the runbook dry run proves the runner roles, notices and root-smoke skip', () => {
  const section = persistentRunbook();
  assert.match(section, /build-macos-unsigned` and `verify-macos-signed` on\s+`anyray-install-mac-build`, and `sign-macos` on `anyray-install-mac`/);
  assert.ok(section.includes('trust gate passed (<role> job-started)'), 'dry run must prove the hook notices');
  assert.ok(section.includes('root install, sweep and uninstall smoke skipped on the persistent Mac host (staging)'), 'dry run must prove the staging root-smoke warning');
  assert.match(section, /teardown-mac is skipped/);
});

test('the runbook maintainer update covers ids and canonical logins', () => {
  const releasing = readFileSync(new URL('../RELEASING.md', import.meta.url), 'utf8');
  assert.match(releasing, /Also update `MAINTAINER_ACCOUNT_IDS` and `MAINTAINER_LOGINS` in\s+`scripts\/mac-runner-hook\.sh`/);
});

test('each role allows its jobs for every release workflow and maintainer and keeps only .git', (t) => {
  for (const [role, ids] of Object.entries(ROLE_JOBS)) {
    for (const id of ids) {
      for (const file of WORKFLOWS) {
        for (const actor of MAINTAINERS) {
          const tree = hookTree(t, role);
          const result = runHook(tree, 'job-started', {
            GITHUB_WORKFLOW_REF: `anyrayHQ/install/.github/workflows/${file}@refs/heads/main`,
            GITHUB_ACTOR_ID: actor, GITHUB_JOB: id,
          });
          assert.equal(result.status, 0, result.log);
          assert.equal((result.log.match(/::notice::/g) ?? []).length, 1);
          assert.ok(result.log.includes(`trust gate passed (${role} job-started)`), result.log);
          assertMoved(tree);
        }
      }
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

for (const role of ['sign', 'build']) {
  const other = role === 'sign' ? 'build' : 'sign';
  // The last value is a space-joined run of the role's own jobs: it must not pass word by word.
  for (const job of [...ROLE_JOBS[other], 'unknown', undefined, [...ROLE_JOBS[role], ...ROLE_JOBS[role]].join(' ')]) {
    test(`${role} role refuses GITHUB_JOB ${job ?? '<missing>'} without touching the host`, (t) => {
      const tree = hookTree(t, role);
      const result = runHook(tree, 'job-started', { GITHUB_JOB: job });
      assert.equal(result.status, 1, result.log);
      assert.match(result.log, /::error::GITHUB_JOB check failed/);
      assert.equal(result.security, '');
      assertUntouched(tree);
    });
  }
  for (const [check, deviation] of [
    ['account', { HOOK_USER: `anyray-${other}` }],
    ['account', { HOOK_USER: 'ec2-user' }],
    ['admin-group', { HOOK_GROUPS: 'admin' }],
    ['admin-group', { HOOK_GROUPS: 'staff admin everyone' }],
    ['sudo', { HOOK_SUDO_STATUS: '0' }],
  ]) {
    test(`${role} account gate refuses ${JSON.stringify(deviation)} without touching the host`, (t) => {
      const tree = hookTree(t, role);
      const stray = join(tree.temp, 'x.keychain-db');
      writeFileSync(stray, 'throwaway keychain');
      const result = runHook(tree, 'job-started', deviation);
      assert.equal(result.status, 1, result.log);
      assert.ok(result.log.includes(`::error::Runner ${check} check failed`), result.log);
      assert.equal(result.security, '');
      assert.equal(readFileSync(stray, 'utf8'), 'throwaway keychain');
      assertUntouched(tree);
    });
  }
  test(`${role} account gate allows administrator as a distinct group word`, (t) => {
    const tree = hookTree(t, role);
    const result = runHook(tree, 'job-started', { HOOK_GROUPS: 'staff administrator' });
    assert.equal(result.status, 0, result.log);
    assertMoved(tree);
  });
}

for (const role of ['sign', 'build']) {
  for (const phase of ['job-started', 'job-completed']) {
    test(`${role}-${phase} symlink selects the role and phase as the runner invokes it`, (t) => {
      const tree = hookTree(t, role);
      const link = join(tree.bin, `${role}-${phase}.sh`);
      symlinkSync(fileURLToPath(new URL('./mac-runner-hook.sh', import.meta.url)), link);
      const result = runHook(tree, null, {}, link);
      assert.equal(result.status, 0, result.log);
      assertMoved(tree);
    });
  }
}

test('an unknown symlink phase returns usage without touching the host', (t) => {
  const tree = hookTree(t);
  const link = join(tree.bin, 'sign-job-unknown.sh');
  symlinkSync(fileURLToPath(new URL('./mac-runner-hook.sh', import.meta.url)), link);
  const result = runHook(tree, null, {}, link);
  assert.equal(result.status, 2, result.log);
  assert.equal(result.security, '');
  assertUntouched(tree);
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
  assert.match(result.log, /::warning::Runner trash has 1 directories older than 60 minutes; oldest is \d+ minutes old; details are in cleanup\.log on the host/);
  assert.doesNotMatch(result.log, /line[1-6]/);
  assert.match(result.log, /::error::[^\n]*cleanup\.log[^\n]*RELEASING\.md/);
  assert.equal(result.security, '');
  assert.deepEqual(readdirSync(tree.workspace).sort(), ['.git', '.hidden', 'out', 'private-source']);
});

test('job-started warns about old trash without publishing cleanup.log at the exact disk floor', (t) => {
  const tree = hookTree(t);
  const old = join(tree.home, '.runner-trash', 'old');
  const oldest = join(tree.home, '.runner-trash', 'oldest');
  mkdirSync(old, { recursive: true });
  mkdirSync(oldest, { recursive: true });
  const timestamp = new Date(Date.now() - 61 * 60 * 1000);
  utimesSync(old, timestamp, timestamp);
  const oldestTimestamp = new Date(Date.now() - 125 * 60 * 1000);
  utimesSync(oldest, oldestTimestamp, oldestTimestamp);
  writeFileSync(join(tree.home, '.runner-trash', 'cleanup.log'), 'cleanup diagnostics\nprivate-source/connect-tray/secret-path\nanother private log line\n');
  const result = runHook(tree, 'job-started', { HOOK_AVAILABLE_KIB: String(20 * 1048576) });
  assert.equal(result.status, 0, result.log);
  assert.match(result.log, /::warning::Runner trash has 2 directories older than 60 minutes/);
  const age = result.log.match(/oldest is (\d+) minutes old; details are in cleanup\.log on the host/);
  assert.ok(age && Number(age[1]) >= 125, 'warning must report the oldest trash age in minutes');
  assert.doesNotMatch(result.log, /cleanup diagnostics|private-source\/connect-tray\/secret-path|another private log line/);
  assert.ok(!result.log.includes(tree.home), 'warning must not expose host paths');
  assert.equal(existsSync(old), true);
  assert.equal(existsSync(oldest), true);
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

test('an unknown role returns usage without touching the host, by symlink or by argument', (t) => {
  // A role that is not sign must never fall through to the build role's jobs or account.
  for (const name of ['deploy-job-started', 'admin-job-started', 'job-started']) {
    const tree = hookTree(t);
    const link = join(tree.bin, `${name}.sh`);
    symlinkSync(fileURLToPath(new URL('./mac-runner-hook.sh', import.meta.url)), link);
    const result = runHook(tree, null, { GITHUB_JOB: 'build-macos-unsigned', HOOK_USER: 'anyray-build' }, link);
    assert.equal(result.status, 2, `${name}: ${result.log}`);
    assert.equal(result.security, '');
    assertUntouched(tree);
  }
  const tree = hookTree(t);
  const result = spawnSync(existsSync('/bin/bash') ? '/bin/bash' : 'bash', [
    '--noprofile', '--norc', '-e', '-o', 'pipefail',
    fileURLToPath(new URL('./mac-runner-hook.sh', import.meta.url)), 'deploy', 'job-started',
  ], { encoding: 'utf8', timeout: 30_000, env: { ...tree.env, GITHUB_JOB: 'build-macos-unsigned', HOOK_USER: 'anyray-build' } });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(readFileSync(tree.securityLog, 'utf8'), '');
  assertUntouched(tree);
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
