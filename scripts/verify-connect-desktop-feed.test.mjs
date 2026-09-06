import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { test } from 'node:test';
import { compareVersions, publishFeed } from './publish-desktop-feed.mjs';

const names = ['connect-desktop-staging.json', 'connect-desktop-staging.json.asc'];
function fixture(t, { current = '1.0.0', fail = () => false, exists = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'feed-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = { version: '2.0.0', tag: 'connect-desktop-staging-v2.0.0-abcdef' };
  for (const name of names) writeFileSync(join(directory, name), JSON.stringify(manifest));
  const assets = names.map((name, index) => ({ id: index + 1, name }));
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (fail(args)) throw new Error('simulated failure');
    if (args[0] === 'release') {
      if (args[1] === 'upload') {
        for (const path of args.slice(5)) assets.push({ id: assets.length + 1, name: basename(path) });
      }
      return '';
    }
    const path = args[1];
    if (path.endsWith('/releases')) return JSON.stringify([exists ? [{ id: 10, tag_name: 'connect-desktop-staging', prerelease: true }] : []]);
    if (path.endsWith('/10/assets')) return JSON.stringify([assets]);
    const id = Number(path.split('/').at(-1));
    const asset = assets.find((item) => item.id === id);
    assert.ok(asset);
    if (args.includes('PATCH')) {
      const name = args.at(-1).slice(5);
      assert.ok(!assets.some((item) => item.id !== id && item.name === name), 'duplicate asset name');
      asset.name = name;
      return '{}';
    }
    if (args.includes('DELETE')) {
      assets.splice(assets.indexOf(asset), 1);
      return '';
    }
    return JSON.stringify(id === 1 ? { version: current } : manifest);
  };
  return { assets, calls, publish: () => publishFeed({ repo: 'anyrayHQ/install', version: manifest.version,
    tag: manifest.tag, assetsDir: directory }, run) };
}

test('version comparison is numeric and rejects missing/malformed versions', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  for (const value of [null, undefined, 0, '', '1.0', '1.0.0-beta', 'v1.0.0']) {
    assert.throws(() => compareVersions(value, '2.0.0'));
  }
});

for (const current of ['3.0.0', null, 'bad']) {
  test(`invalid or newer feed ${current} aborts before writes`, (t) => {
    const f = fixture(t, { current });
    assert.throws(f.publish);
    assert.ok(f.calls.every((args) => args[0] === 'api' && !args.includes('-X')));
  });
}

for (const endpoint of ['/releases', '/releases/assets/1']) {
  test(`lookup failure at ${endpoint} aborts before writes`, (t) => {
    const f = fixture(t, { fail: (args) => args[1].endsWith(endpoint) });
    assert.throws(f.publish);
    assert.deepEqual(f.assets.map((asset) => asset.name), names);
    assert.ok(!f.calls.some((args) => args[0] === 'release'));
  });
}

test('upload failure leaves both original assets untouched', (t) => {
  const f = fixture(t, { fail: (args) => args[1] === 'upload' });
  assert.throws(f.publish);
  assert.deepEqual(f.assets.map((asset) => asset.name), names);
});

test('successful switch stages both files before renaming and removes backups last', (t) => {
  const f = fixture(t);
  f.publish();
  assert.deepEqual(f.assets.map((asset) => asset.name), names);
  assert.ok(f.assets.every((asset) => asset.id > 2));
  assert.ok(f.calls.findIndex((args) => args[1] === 'upload') < f.calls.findIndex((args) => args.includes('PATCH')));
  assert.ok(f.calls.findIndex((args) => args[1] === 'edit') < f.calls.findIndex((args) => args.includes('DELETE')));
});

test('failed switch restores old names and retains candidates for recovery', (t) => {
  let failed = false;
  const f = fixture(t, { fail: (args) => {
    if (!failed && args.includes('PATCH') && args[1].endsWith('/4')) { failed = true; return true; }
    return false;
  } });
  assert.throws(f.publish);
  assert.deepEqual(f.assets.slice(0, 2).map((asset) => asset.name), names);
  assert.ok(f.assets.slice(2).every((asset) => asset.name.endsWith('.pending')));
  assert.throws(f.publish, /Incomplete feed publication/);
});

test('first publication requires a successful empty release listing', (t) => {
  const f = fixture(t, { exists: false });
  f.publish();
  assert.ok(f.calls.some((args) => args[1] === 'create' && args.includes('--latest=false')));
});

test('partial upload preserves the live pair and blocks unattended retry', (t) => {
  const f = fixture(t, { fail: (args) => {
    if (args[1] !== 'upload') return false;
    f.assets.push({ id: 3, name: `${names[0]}.pending` });
    return true;
  } });
  assert.throws(f.publish);
  assert.deepEqual(f.assets.slice(0, 2).map((asset) => asset.name), names);
  assert.throws(f.publish, /Incomplete feed publication/);
});

test('failed rollback retains old bytes and blocks subsequent publication', (t) => {
  let switchingFailed = false;
  const f = fixture(t, { fail: (args) => {
    if (!args.includes('PATCH')) return false;
    if (args[1].endsWith('/4')) switchingFailed = true;
    return switchingFailed;
  } });
  assert.throws(f.publish, /Feed rollback failed/);
  assert.ok(f.assets.some((asset) => asset.id === 1 && asset.name.endsWith('.previous')));
  assert.ok(f.assets.some((asset) => asset.id === 2 && asset.name.endsWith('.previous')));
  assert.throws(f.publish, /Incomplete feed publication/);
});

test('failure after switching both assets rolls back the complete pair', (t) => {
  const f = fixture(t, { fail: (args) => args[1] === 'edit' });
  assert.throws(f.publish);
  assert.deepEqual(f.assets.slice(0, 2).map((asset) => asset.name), names);
  assert.ok(!f.calls.some((args) => args.includes('DELETE')));
});

test('a failed candidate rollback does not skip restoring the remaining old assets', (t) => {
  const f = fixture(t, { fail: (args) => args.includes('PATCH') && args[1].endsWith('/4') });
  assert.throws(f.publish, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    return true;
  });
  assert.deepEqual(f.assets.slice(0, 2).map((asset) => asset.name), names);
  assert.deepEqual(f.calls.filter((args) => args.includes('PATCH')).slice(-4)
    .map((args) => Number(args[1].split('/').at(-1))), [4, 2, 3, 1]);
  assert.ok(!f.calls.some((args) => args.includes('DELETE')));
});

test('rollback reports every failure after attempting every restoration', (t) => {
  let failed = false;
  const f = fixture(t, { fail: (args) => {
    if (!args.includes('PATCH')) return false;
    if (args[1].endsWith('/4')) failed = true;
    return failed;
  } });
  assert.throws(f.publish, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 5); // Publication error and all four rollback errors.
    return true;
  });
  assert.deepEqual(f.calls.filter((args) => args.includes('PATCH')).slice(-4)
    .map((args) => Number(args[1].split('/').at(-1))), [4, 2, 3, 1]);
});
