import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyProfile } from './verify-desktop-profile.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-profile-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const engine = join(dir, 'engine');
  writeFileSync(engine, 'synthetic engine');
  const before = join(dir, 'before.json');
  const current = join(dir, 'current.json');
  const profile = { name: 'existing', managedEnrollmentDisabled: true, nested: { enabled: true } };
  writeFileSync(before, JSON.stringify(profile));
  const adopted = { ...profile, engineOwner: 'app', engineOwnerPath: engine, engineOwnerObservedAt: '2026-09-08T11:10:50.343Z' };
  return { engine, before, current, adopted, check(value = adopted) {
    writeFileSync(current, JSON.stringify(value));
    verifyProfile(before, current, engine);
  } };
}

test('allows only app ownership adoption and canonical executable aliases', (t) => {
  const f = fixture(t);
  const alias = `${f.engine}-alias`;
  symlinkSync(f.engine, alias);
  f.check({ ...f.adopted, engineOwnerPath: alias });
});
for (const [field, value, message] of [
  ['name', 'changed', /settings changed/],
  ['nested', { enabled: false }, /settings changed/],
  ['unexpected', true, /settings changed/],
  ['managedEnrollmentDisabled', undefined, /settings changed/],
  ['engineOwner', 'durable', /ownership/],
  ['engineOwnerPath', 'relative-engine', /owner path/],
  ['engineOwnerObservedAt', 'invalid', /timestamp/],
]) {
  test(`rejects unexpected ${field}`, (t) => {
    const f = fixture(t);
    assert.throws(() => f.check({ ...f.adopted, [field]: value }), message);
  });
}
test('rejects a different existing engine', (t) => {
  const f = fixture(t);
  assert.throws(() => f.check({ ...f.adopted, engineOwnerPath: f.before }), /owner path/);
});

for (const timestamp of ['2026-02-30T11:10:50.343Z', '2026-02-29T11:10:50.343Z', '2026-09-08T24:00:00.000Z']) {
  test(`rejects normalized calendar overflow ${timestamp}`, (t) => {
    const f = fixture(t);
    assert.throws(() => f.check({ ...f.adopted, engineOwnerObservedAt: timestamp }), /timestamp/);
  });
}
test('accepts a valid leap day', (t) => {
  const f = fixture(t);
  f.check({ ...f.adopted, engineOwnerObservedAt: '2024-02-29T11:10:50.343Z' });
});
