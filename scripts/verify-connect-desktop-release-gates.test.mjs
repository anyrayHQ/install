import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// GitHub gives a job with no status function in its `if` an implicit success(), and that
// success() is false when ANY ancestor was skipped, however far up. validate-desktop skips
// for a CLI-only or staging run, so every job that leaned on the implicit check skipped
// too: a `version=latest` dry run built the CLI and signed nothing (2026-10-24). A job
// below a conditional one names the results it needs instead.
const RELEASE_WORKFLOWS = ['release-connect-binaries.yml', 'release-connect-desktop.yml'];
const WORKFLOW_DIR = new URL('../.github/workflows/', import.meta.url);
const STATUS_FUNCTION = /\b(always|cancelled|success|failure)\(\)/;

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

function needsOf(job) {
  const inline = /^ {4}needs: *(\[[^\]]*\]|[a-z0-9-]+) *$/m.exec(job);
  if (inline) return inline[1].replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  const block = /^ {4}needs: *\n((?: {6}- *[a-z0-9-]+ *\n)+)/m.exec(job);
  return block ? [...block[1].matchAll(/- *([a-z0-9-]+)/g)].map((m) => m[1]) : [];
}

function ifOf(job) {
  return /^ {4}if: *(.+)$/m.exec(job)?.[1] ?? null;
}

// A conditional job whose skip is meant to carry down: release-connect-desktop's
// validate-source skips only in publish mode, and nothing below it builds in publish mode.
const INTENDED_SKIPS = new Set(['validate-source']);

// Jobs that rely on the implicit success() while some ancestor carries an `if`.
function implicitBelowConditional(text) {
  const all = jobs(text);
  const ancestors = (name, seen = new Set()) => {
    for (const parent of needsOf(all[name] ?? '')) {
      if (!seen.has(parent)) { seen.add(parent); ancestors(parent, seen); }
    }
    return seen;
  };
  return Object.keys(all).filter((name) => {
    const own = ifOf(all[name]);
    if (own && STATUS_FUNCTION.test(own)) return false;
    return [...ancestors(name)].some((a) => ifOf(all[a] ?? '') !== null && !INTENDED_SKIPS.has(a));
  });
}

for (const file of RELEASE_WORKFLOWS) {
  test(`${file}: no job below a conditional job relies on the implicit success()`, () => {
    assert.deepEqual(implicitBelowConditional(readWorkflow(file)), []);
  });
}

test('the check sees a skip two jobs up, and accepts an explicit status check', () => {
  const wf = (leafIf) => `name: t\non: push\njobs:\n  gate:\n    if: \${{ inputs.x }}\n    runs-on: a\n  build:\n    needs: gate\n    if: \${{ !cancelled() }}\n    runs-on: a\n  leaf:\n    needs: [build]\n${leafIf}    runs-on: a\n`;
  assert.deepEqual(implicitBelowConditional(wf('')), ['leaf']);
  assert.deepEqual(implicitBelowConditional(wf("    if: ${{ !cancelled() && needs.build.result == 'success' }}\n")), []);
});

// connect's build script runs bare `pnpm` (`pnpm --filter @anyray/admin-mcp build`).
// `corepack pnpm` alone puts no pnpm on PATH, so every engine build from source failed with
// `pnpm: command not found` (desktop staging dry run, 2026-10-24). Each one installs the
// corepack shim into a run-local directory on PATH first.
test('every engine build from source puts a pnpm shim on PATH before building connect', () => {
  const text = readWorkflow('release-connect-desktop.yml');
  const builds = [...text.matchAll(/corepack pnpm --filter anyray-connect build/g)];
  assert.ok(builds.length >= 3, `found ${builds.length} engine builds`);
  for (const build of builds) {
    const step = text.slice(text.lastIndexOf('\n      - name:', build.index), build.index);
    assert.match(step, /corepack enable pnpm --install-directory/, step.split('\n')[1]);
    assert.match(step, /PATH *= *"\$pnpm_shims[:;]/, step.split('\n')[1]);
  }
});
