import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runFleet(t, action, fleetStatus) {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-fleet-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'aws'), `#!/bin/bash
printf '%s\\n' "$*" >> "$FLEET_TEST_LOG"
case "$*" in
  *batch-get-fleets*status.statusCode*) echo "$FLEET_TEST_STATUS" ;;
  *batch-get-fleets*) echo arn:aws:codebuild:test:fleet/example ;;
  *batch-get-projects*) echo None ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(dir, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const result = spawnSync('bash', [fileURLToPath(new URL('./mac-fleet.sh', import.meta.url)), action], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, AWS_ACCOUNT_ID: '000000000000',
      FLEET_TEST_LOG: join(dir, 'calls'), FLEET_TEST_STATUS: fleetStatus },
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
