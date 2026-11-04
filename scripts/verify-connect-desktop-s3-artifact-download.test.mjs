import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Runs the action's own script against a scripted `aws`, so a listing the CLI could not
// finish is told apart from a prefix the producer never wrote (run 41794404528: the
// Windows bundle job read a hidden CLI error as "nothing uploaded").
const action = readFileSync(new URL('../.github/actions/s3-artifact-download/action.yml', import.meta.url), 'utf8');
const bash = existsSync('/bin/bash') ? '/bin/bash' : 'bash';

function runScript() {
  const lines = action.split('\n');
  const start = lines.findIndex((line) => line === '      run: |');
  assert.notEqual(start, -1, 'the Download from S3 step has no run block');
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.startsWith('        ')) break;
    body.push(line.slice(8));
  }
  return body.join('\n');
}

// Each `aws s3 ls` call takes the next plan line: `list`, `empty` (what the CLI does for
// a prefix with no keys: exit 1, no output), or `fail <exit> <message>` (`failcrlf` ends
// its lines the way the Windows CLI does).
const FAKE_AWS = `#!/bin/bash
dir="$FAKE_AWS_DIR"
printf '%s\\n' "$*" >> "$dir/calls"
if [ "$1 $2" = "s3 ls" ]; then
  n=$(( $(cat "$dir/n" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$dir/n"
  line="$(sed -n "\${n}p" "$dir/plan")"
  case "$line" in
    list) printf '2026-11-04 08:04:43     101 a.exe\\n2026-11-04 08:04:44     202 b.exe\\n'; exit 0 ;;
    empty) exit 1 ;;
    fail\\ *|failcrlf\\ *)
      rest="\${line#* }"; rc="\${rest%% *}"; message="\${rest#* }"
      if [ "\${line%% *}" = failcrlf ]; then printf '\\r\\n%s\\r\\n' "$message" >&2; else printf '\\n%s\\n' "$message" >&2; fi
      exit "$rc" ;;
    *) echo "fake aws: no plan line $n" >&2; exit 99 ;;
  esac
fi
if [ "$1 $2" = "s3 cp" ]; then mkdir -p "$4"; : > "$4/copied"; exit 0; fi
exit 98
`;

function run(t, plan, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 's3-download-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'aws'), FAKE_AWS);
  writeFileSync(join(bin, 'sleep'), '#!/bin/bash\nprintf \'%s\\n\' "$1" >> "$FAKE_AWS_DIR/sleeps"\n');
  chmodSync(join(bin, 'aws'), 0o755);
  chmodSync(join(bin, 'sleep'), 0o755);
  writeFileSync(join(dir, 'plan'), `${plan.join('\n')}\n`);
  const dest = join(dir, 'dest');
  const result = spawnSync(bash, ['-c', runScript()], {
    cwd: dir, encoding: 'utf8', timeout: 20_000,
    env: {
      PATH: `${bin}:${process.env.PATH}`, FAKE_AWS_DIR: dir, BUCKET: 'ci-bucket', ARTIFACT_NAME: 'inner-signed',
      DEST_PATH: dest, GITHUB_REPOSITORY: 'anyrayHQ/install', GITHUB_RUN_ID: '777', GITHUB_RUN_ATTEMPT: '1', ...env,
    },
  });
  const lines = (file) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8').trim().split('\n') : []);
  return {
    status: result.status, log: result.stdout + result.stderr,
    calls: lines('calls'), sleeps: lines('sleeps'), copied: existsSync(join(dest, 'copied')),
  };
}

const lists = (calls) => calls.filter((call) => call.startsWith('s3 ls '));

test('a transient CLI failure is retried with backoff and its error is printed, not swallowed', (t) => {
  const r = run(t, ['fail 255 Could not connect to the endpoint URL: "https://ci-bucket.s3.eu-central-1.amazonaws.com/"', 'list']);
  assert.equal(r.status, 0, r.log);
  assert.equal(lists(r.calls).length, 2);
  assert.deepEqual(r.sleeps, ['2']);
  assert.ok(r.copied, 'the download must run once the listing succeeds');
  assert.match(r.log, /Could not connect to the endpoint URL/);
  assert.match(r.log, /exit 255/);
});

test('a CLI that keeps failing is reported as a CLI failure, never as a missing upload', (t) => {
  const error = 'An error occurred (ExpiredToken) when calling the ListObjectsV2 operation: The provided token has expired.';
  const r = run(t, Array.from({ length: 5 }, () => `fail 254 ${error}`));
  assert.equal(r.status, 1, r.log);
  assert.equal(lists(r.calls).length, 5);
  assert.deepEqual(r.sleeps, ['2', '4', '8', '16']);
  assert.ok(!r.copied);
  assert.doesNotMatch(r.log, /No objects under/);
  assert.doesNotMatch(r.log, /did not run or wrote nothing/);
  // The annotation itself carries the CLI's last error line, so the run summary names the fault.
  assert.match(r.log, /::error::Could not list s3:\/\/ci-bucket\/install\/777-1\/inner-signed[^\n]*exit 254: An error occurred \(ExpiredToken\)/);
});

test('an empty prefix is the CLI answering, so it fails at once with the missing-upload message', (t) => {
  const r = run(t, ['empty']);
  assert.equal(r.status, 1, r.log);
  assert.equal(lists(r.calls).length, 1, 'an answered listing is not retried');
  assert.deepEqual(r.sleeps, []);
  assert.ok(!r.copied);
  assert.match(r.log, /::error::No objects under s3:\/\/ci-bucket\/install\/777-1\/inner-signed/);
});

test('a re-run consumer still names the earlier attempt that holds the bytes', (t) => {
  const r = run(t, ['empty', 'list'], { GITHUB_RUN_ATTEMPT: '2' });
  assert.equal(r.status, 1, r.log);
  assert.deepEqual(lists(r.calls), ['s3 ls s3://ci-bucket/install/777-2/inner-signed/', 's3 ls s3://ci-bucket/install/777-1/inner-signed/']);
  assert.match(r.log, /'inner-signed' exists under attempt 1 but not attempt 2/);
});

test('a CLI failure while scanning earlier attempts is reported as that failure', (t) => {
  const plan = ['empty', ...Array.from({ length: 5 }, () => 'fail 255 Could not connect to the endpoint URL')];
  const r = run(t, plan, { GITHUB_RUN_ATTEMPT: '2' });
  assert.equal(r.status, 1, r.log);
  assert.match(r.log, /::error::Could not list s3:\/\/ci-bucket\/install\/777-1\/inner-signed/);
  assert.doesNotMatch(r.log, /No objects under/);
});

test('a Windows CRLF error with a percent sign still makes one well-formed annotation', (t) => {
  const r = run(t, Array.from({ length: 5 }, () => 'failcrlf 255 Read timeout on endpoint URL after 100% of retries'));
  assert.equal(r.status, 1, r.log);
  const annotation = r.log.split('\n').find((line) => line.startsWith('::error::'));
  assert.ok(annotation, r.log);
  assert.match(annotation, /exit 255: Read timeout on endpoint URL after 100%25 of retries\)/);
  assert.doesNotMatch(annotation, /\r/);
});
