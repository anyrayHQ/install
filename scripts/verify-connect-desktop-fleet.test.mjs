import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runFleet(t, action, fleetStatus, { connections = ['arn:aws:codeconnections:test:connection/example'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-fleet-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // `list-connections` returns tab-separated ARNs with --output text, and an
  // empty line when there are none — mirror both, since the script's
  // zero/one/several branches are selected entirely by that shape.
  writeFileSync(join(dir, 'aws'), `#!/bin/bash
printf '%s\\n' "$*" >> "$FLEET_TEST_LOG"
case "$*" in
  *batch-get-fleets*status.statusCode*) echo "$FLEET_TEST_STATUS" ;;
  *batch-get-fleets*) echo arn:aws:codebuild:test:fleet/example ;;
  *batch-get-projects*) echo None ;;
  *codeconnections*list-connections*) printf '%s\\n' "$FLEET_TEST_CONNECTIONS" ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(dir, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const result = spawnSync('bash', [fileURLToPath(new URL('./mac-fleet.sh', import.meta.url)), action], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, AWS_ACCOUNT_ID: '000000000000',
      FLEET_TEST_LOG: join(dir, 'calls'), FLEET_TEST_STATUS: fleetStatus,
      FLEET_TEST_CONNECTIONS: connections.join('\t'),
      // Never inherit a real override from the developer's shell: it would skip
      // discovery entirely and quietly pass the tests that exercise it.
      ANYRAY_CODECONNECTION_ARN: '' },
  });
  return { ...result, calls: readFileSync(join(dir, 'calls'), 'utf8') };
}

test('fleet readiness timeout fails without creating a runner project', (t) => {
  const result = runFleet(t, 'up', 'CREATING');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /did not become usable/);
  assert.doesNotMatch(result.calls, /create-project|create-webhook/);
});

test('a pending-deletion fleet can be reused inside its remaining paid window', (t) => {
  const result = runFleet(t, 'up', 'PENDING_DELETION');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.calls, /create-fleet/);
  assert.match(result.calls, /create-project/);
  assert.match(result.calls, /ACTOR_ACCOUNT_ID/);
});

test('cleanup requests fleet deletion even when the project is already absent', (t) => {
  const result = runFleet(t, 'down', 'ACTIVE');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /delete-fleet/);
});

// The connection is resolved, not hardcoded, so the resolution itself needs
// coverage: each branch below was a way this script could strand a macOS job.
test('the resolved connection is what the runner project is bound to', (t) => {
  const result = runFleet(t, 'up', 'PENDING_DELETION', {
    connections: ['arn:aws:codeconnections:test:connection/discovered'],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /resource=arn:aws:codeconnections:test:connection\/discovered/);
});

test('no available connection fails loudly instead of creating a bound-to-nothing project', (t) => {
  const result = runFleet(t, 'up', 'PENDING_DELETION', { connections: [] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no AVAILABLE GitHub CodeConnection/);
  assert.doesNotMatch(result.calls, /create-project/);
});

test('several connections refuse to guess', (t) => {
  const result = runFleet(t, 'up', 'PENDING_DELETION', {
    connections: ['arn:aws:codeconnections:test:connection/a', 'arn:aws:codeconnections:test:connection/b'],
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /set ANYRAY_CODECONNECTION_ARN/);
  assert.doesNotMatch(result.calls, /create-project/);
});

test('teardown needs no connection at all', (t) => {
  // `down` deletes; resolving a connection there would make teardown fail in
  // exactly the situation teardown exists for.
  const result = runFleet(t, 'down', 'ACTIVE', { connections: [] });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.calls, /list-connections/);
});
