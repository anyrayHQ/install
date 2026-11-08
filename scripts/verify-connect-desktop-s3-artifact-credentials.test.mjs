import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Windows Git Bash turns an env value starting with `/` into a Windows path for native aws.exe.
function stepEnv(actionName) {
  const action = readFileSync(new URL(`../.github/actions/${actionName}/action.yml`, import.meta.url), 'utf8');
  const lines = action.split('\n');
  const start = lines.findIndex((line) => line === '      env:');
  assert.notEqual(start, -1, `${actionName} has no step env block`);
  const env = {};
  for (const line of lines.slice(start + 1)) {
    if (/^ {8}#/.test(line)) continue;
    const entry = line.match(/^ {8}([A-Z0-9_]+): (.*)$/);
    if (!entry) break;
    env[entry[1]] = entry[2];
  }
  return env;
}

for (const actionName of ['s3-artifact-download', 's3-artifact-upload']) {
  test(`${actionName} keeps Git Bash from rewriting AWS credentials for the native CLI`, () => {
    assert.equal(stepEnv(actionName).MSYS2_ENV_CONV_EXCL, 'AWS_');
  });
}
