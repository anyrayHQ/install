import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Connect 0.11.565 and 0.11.575 failed the macOS verify at the self-serve uninstaller with
// only "An error occurred while running scripts from the package": Installer writes a pkg
// script's output to /var/log/install.log, never to the installer CLI's stdout.
const bash = existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const helper = fileURLToPath(new URL('./pkg-diagnostics.sh', import.meta.url));
const workflow = readFileSync(new URL('../.github/workflows/release-connect-desktop.yml', import.meta.url), 'utf8');

// Shapes copied from a real /var/log/install.log.
const stamp = '2026-11-04 08:07:40+00 runner-mac';
const scriptLine = (text) => `${stamp} package_script_service[5120]: ./postinstall: ${text}`;
const PRIOR_RUN = [
  `${stamp} installer[4800]: Product archive /Users/runner/work/_temp/connect-desktop-plist-fleet.pkg trustLevel=0`,
  scriptLine('PRIOR-RUN-OUTPUT'),
].join('\n');
const UNINSTALLER_RUN = [
  `${stamp} installer[5101]: Product archive /usr/local/lib/anyray-connect/Uninstall Anyray Connect.pkg trustLevel=350`,
  `${stamp} installer[5101]: Starting installation:`,
  `${stamp} installd[400]: PackageKit: Extracting file:///usr/local/lib/anyray-connect/Uninstall%20Anyray%20Connect.pkg`,
  `${stamp} package_script_service[5120]: PackageKit: Executing script "postinstall" in /tmp/PKInstallSandbox.Ab12/Scripts/ai.anyray.connect-tray.uninstaller.Cd34`,
  scriptLine('{"uninstall":{"user":"partial(tray_exit)","residue":"skipped_no_gui","loginItem":"error","at":"2026-11-04T08:07:40.100Z"}}'),
  scriptLine('Anyray Connect user cleanup failed for runner; continuing with machine cleanup'),
  scriptLine('Anyray Connect uninstall kept the helpers and engine for retry; user cleanup failed for:'),
  `${stamp} package_script_service[5120]: Responsibility set back to self.`,
  `${stamp} install_monitor[5130]: Re-included: /Applications, /Library, /System`,
  `${stamp} installd[400]: PackageKit: Install Failed: Error Domain=PKInstallErrorDomain Code=112 "An error occurred while running scripts from the package"`,
].join('\n');

function tree(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-diagnostics-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'Users'));
  return dir;
}

function fakePs(dir, table, status = 0) {
  writeFileSync(join(dir, 'ps-table'), table);
  writeFileSync(join(dir, 'bin', 'ps'), `#!/bin/bash\ncat "${join(dir, 'ps-table')}"\nexit ${status}\n`);
  chmodSync(join(dir, 'bin', 'ps'), 0o755);
}

function run(dir, start, log = join(dir, 'install.log')) {
  const result = spawnSync(bash, [helper, log, String(start), join(dir, 'Users')], {
    encoding: 'utf8', timeout: 10_000, env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
  });
  return { status: result.status, out: result.stdout, log: result.stdout + result.stderr };
}

function withLog(t, before, after) {
  const dir = tree(t);
  fakePs(dir, '');
  const head = `${before}\n`;
  writeFileSync(join(dir, 'install.log'), `${head}${after}\n`);
  return { dir, start: Buffer.byteLength(head) };
}

test("prints the failing pkg script's output that this step appended, and nothing before it", (t) => {
  const { dir, start } = withLog(t, PRIOR_RUN, UNINSTALLER_RUN);
  const r = run(dir, start);
  assert.equal(r.status, 0, r.log);
  assert.match(r.out, /Product archive \/usr\/local\/lib\/anyray-connect\/Uninstall Anyray Connect\.pkg/);
  assert.match(r.out, /"user":"partial\(tray_exit\)"/);
  assert.match(r.out, /user cleanup failed for runner/);
  assert.match(r.out, /Install Failed: Error Domain=PKInstallErrorDomain Code=112/);
  assert.doesNotMatch(r.out, /PRIOR-RUN-OUTPUT/);
  assert.doesNotMatch(r.out, /install_monitor|Extracting file/);
});

test('bounds the script output to its last 150 lines of at most 600 characters', (t) => {
  const many = Array.from({ length: 400 }, (_, i) => scriptLine(`line-${i} ${'x'.repeat(2000)}`)).join('\n');
  const { dir, start } = withLog(t, PRIOR_RUN, many);
  const r = run(dir, start);
  assert.equal(r.status, 0, r.log);
  const shown = r.out.split('\n').filter((line) => line.includes('package_script_service['));
  assert.equal(shown.length, 150);
  assert.match(shown.at(-1), /line-399 /);
  assert.match(r.out, /line-250 /);
  assert.doesNotMatch(r.out, /line-249 /);
  assert.ok(shown.every((line) => line.length <= 600));
});

test('falls back to the raw tail when no script line was logged', (t) => {
  const plain = Array.from({ length: 100 }, (_, i) => `${stamp} installd[400]: entry-${i}`).join('\n');
  const { dir, start } = withLog(t, PRIOR_RUN, plain);
  const r = run(dir, start);
  assert.equal(r.status, 0, r.log);
  assert.match(r.out, /entry-60\n/);
  assert.match(r.out, /entry-99\n/);
  assert.doesNotMatch(r.out, /entry-59\n/);
});

test('reads the whole log when it is shorter than the recorded start (rotated)', (t) => {
  const dir = tree(t);
  fakePs(dir, '');
  writeFileSync(join(dir, 'install.log'), `${UNINSTALLER_RUN}\n`);
  const r = run(dir, 10_000_000);
  assert.equal(r.status, 0, r.log);
  assert.match(r.out, /user cleanup failed for runner/);
});

test('a missing log and a failing ps never fail the diagnostics', (t) => {
  const dir = tree(t);
  fakePs(dir, '', 1);
  const r = run(dir, 0, join(dir, 'missing.log'));
  assert.equal(r.status, 0, r.log);
  assert.match(r.out, /install log .*missing\.log is not readable/);
});

test('a start that is not a byte count reads the whole log', (t) => {
  const { dir } = withLog(t, PRIOR_RUN, UNINSTALLER_RUN);
  const r = run(dir, '12abc');
  assert.equal(r.status, 0, r.log);
  assert.match(r.out, /PRIOR-RUN-OUTPUT/);
  assert.match(r.out, /user cleanup failed for runner/);
});

test("names each account's ~/.anyray and its last per-user uninstall result", (t) => {
  const { dir, start } = withLog(t, PRIOR_RUN, UNINSTALLER_RUN);
  const receipt = join(dir, 'Users', 'runner', 'Library', 'Application Support', 'Anyray Connect');
  mkdirSync(join(dir, 'Users', 'runner', '.anyray'), { recursive: true });
  mkdirSync(receipt, { recursive: true });
  writeFileSync(join(receipt, 'uninstall.json'), `${JSON.stringify({ user: 'partial(processes)', residue: 'skipped_no_gui', loginItem: 'unregistered', at: '2026-11-04T08:07:40.000Z', pad: 'p'.repeat(9000) })}\n`);
  mkdirSync(join(dir, 'Users', 'anyray-smoke'));
  const r = run(dir, start);
  assert.equal(r.status, 0, r.log);
  const runner = r.out.split('\n').find((line) => line.startsWith('runner: '));
  assert.match(runner, /^runner: ~\/\.anyray present; last uninstall result: \{"user":"partial\(processes\)"/);
  assert.ok(runner.length < 4200, 'the result file is bounded');
  assert.match(r.out, /^anyray-smoke: ~\/\.anyray absent; last uninstall result: none$/m);
});

test('lists only the Anyray processes still running, with uid and elapsed time', (t) => {
  const { dir, start } = withLog(t, PRIOR_RUN, UNINSTALLER_RUN);
  fakePs(dir, [
    '  611     1   501      00:13 /Applications/Anyray Connect.app/Contents/MacOS/connect-tray',
    '  615   611   501      00:12 /Applications/Anyray Connect.app/Contents/MacOS/anyray-connect resident',
    '  702   690   501      00:10 /private/var/tmp/anyray-engine.Ab12Cd/anyray-connect uninstall --user --json',
    '  330     1     0   01:02:03 /usr/sbin/cfprefsd daemon',
  ].join('\n'));
  const r = run(dir, start);
  assert.equal(r.status, 0, r.log);
  assert.match(r.out, /611 +1 +501 +00:13 \/Applications\/Anyray Connect\.app\/Contents\/MacOS\/connect-tray/);
  assert.match(r.out, /615 +611 +501 +00:12 .*anyray-connect resident/);
  assert.match(r.out, /702 .*anyray-engine\.Ab12Cd\/anyray-connect uninstall/);
  assert.doesNotMatch(r.out, /cfprefsd/);
});

// The verify step's own text: after the ec2 exit, a failure re-arms the ERR trap so it
// also prints the diagnostics, starting from the install log's size before any pkg ran.
function verifyRun() {
  const job = workflow.slice(workflow.indexOf('\n  verify-macos-signed:\n'));
  const start = job.indexOf('      - name: Verify signed installation, sweep cases and uninstall\n');
  const marker = '        run: |\n';
  const body = job.slice(job.indexOf(marker, start) + marker.length).split('\n');
  const end = body.findIndex((line) => line.trim() && !line.startsWith('          '));
  return body.slice(0, end).map((line) => line.slice(10)).join('\n');
}

test('the verify step arms the diagnostics after the ec2 exit and before any pkg install', () => {
  const run = verifyRun();
  const ec2End = run.indexOf('\n  exit 0\nfi\n');
  const arm = run.indexOf('trap \'echo "::error::macOS verification failed at script line $LINENO"; sudo ./scripts/pkg-diagnostics.sh /var/log/install.log "$install_log_start" /Users || true\' ERR');
  const start = run.indexOf('install_log_start="$(/usr/bin/stat -f %z /var/log/install.log 2>/dev/null || echo 0)"');
  assert.ok(ec2End > 0, 'the ec2 block is absent');
  assert.ok(start > ec2End && arm > start, 'the start offset and the trap come after the ec2 exit');
  assert.ok(arm < run.indexOf('sudo installer -pkg'), 'armed before the first pkg install');
  assert.ok(arm < run.indexOf('sudo installer -pkg "$uninstaller" -target /'));
});

test('a failure after arming prints the line and runs the diagnostics with the recorded offset', (t) => {
  const run = verifyRun();
  const from = run.indexOf('install_log_start=');
  const to = run.indexOf('\n', run.indexOf('/Users || true\' ERR'));
  const dir = tree(t);
  // The diagnostics failing too must not change how the step fails.
  writeFileSync(join(dir, 'bin', 'sudo'), `#!/bin/bash\nprintf '%s\\n' "$*" > "${join(dir, 'sudo-args')}"\nexit 7\n`);
  // BSD stat's size of the install log; GNU stat reads `-f` differently, so it is stubbed.
  writeFileSync(join(dir, 'bin', 'stat'), '#!/bin/bash\n[ "$*" = "-f %z /var/log/install.log" ] && echo 4242\n');
  chmodSync(join(dir, 'bin', 'sudo'), 0o755);
  chmodSync(join(dir, 'bin', 'stat'), 0o755);
  const block = run.slice(from, to).replaceAll('/usr/bin/stat ', `${join(dir, 'bin', 'stat')} `);
  const script = `set -euo pipefail\n${block}\nsh -c 'exit 3'\necho unreachable\n`;
  const result = spawnSync(bash, ['-c', script], {
    cwd: dir, encoding: 'utf8', timeout: 10_000, env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
  });
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stdout, /::error::macOS verification failed at script line \d+/);
  assert.doesNotMatch(result.stdout, /unreachable/);
  assert.equal(readFileSync(join(dir, 'sudo-args'), 'utf8'), './scripts/pkg-diagnostics.sh /var/log/install.log 4242 /Users\n');
});
