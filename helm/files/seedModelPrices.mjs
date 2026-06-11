#!/usr/bin/env node
/**
 * Seed Anyray model-price definitions for the models the gateway records —
 * the Claude family AND the Bedrock models this deployment actually routes to
 * (the OpenAI open-weight `gpt-oss` models + Amazon Nova).
 *
 * Why: the console's Cost tiles read the observability backend's daily
 * `totalCost`, computed per-observation by matching the generation's `model`
 * name against its model-price table. The backend ships prices for first-party
 * OpenAI models but not for newer Claude models (e.g. `claude-opus-4-8`) NOR
 * for the Bedrock ids the gateway emits (`openai.gpt-oss-120b-1:0`,
 * `eu.amazon.nova-micro-v1:0`, …), so that token-heavy traffic shows tokens but
 * $0.00 cost. Registering a matching model definition makes the backend price it.
 *
 * Scope: affects observations ingested AFTER it runs (the backend prices at
 * ingestion time) — it does not retroactively re-cost historical traces.
 *
 * Runs as a one-shot init container on every `docker compose up` / deploy
 * (see the `model-seeder` service). Safe to re-run: it waits for the backend
 * API to come up, then skips any model already registered with the same
 * matchPattern (idempotent).
 *
 * Standalone usage (reads the same env the gateway uses):
 *   ANYRAY_OBSERVABILITY_BASEURL=http://localhost:3000 \
 *   ANYRAY_OBSERVABILITY_PUBLIC_KEY=pk-lf-... \
 *   ANYRAY_OBSERVABILITY_SECRET_KEY=sk-lf-... \
 *   node observability/scripts/seedModelPrices.mjs
 *
 * Pricing is USD per 1M tokens (Claude 4.x + Bedrock list prices); converted
 * to per-token `inputPrice`/`outputPrice`. Bedrock list prices move
 * occasionally — adjust the gpt-oss / Nova numbers if AWS changes them.
 */

const BASE_URL = process.env.ANYRAY_OBSERVABILITY_BASEURL;
const PUBLIC_KEY = process.env.ANYRAY_OBSERVABILITY_PUBLIC_KEY;
const SECRET_KEY = process.env.ANYRAY_OBSERVABILITY_SECRET_KEY;
// How long to wait for the observability API + bootstrapped keys to come up.
const READY_TIMEOUT_MS = Number(process.env.SEED_READY_TIMEOUT_MS || 180_000);

if (!BASE_URL || !PUBLIC_KEY || !SECRET_KEY) {
  console.error(
    '[model-seeder] missing config: set ANYRAY_OBSERVABILITY_BASEURL, ' +
      'ANYRAY_OBSERVABILITY_PUBLIC_KEY and ANYRAY_OBSERVABILITY_SECRET_KEY.'
  );
  process.exit(1);
}

const auth =
  'Basic ' + Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString('base64');

const perMillion = (input, output) => ({
  inputPrice: input / 1_000_000,
  outputPrice: output / 1_000_000,
});

// Default Claude matchPattern: anchored to the family, tolerating a Bedrock
// `anthropic.` prefix and a `-DATE`/`:version` suffix, so first-party and
// Bedrock ids resolve to the same price.
const matchPatternFor = (name) =>
  `(?i)^(anthropic\\.)?${name}($|[-:].*)$`;

// Region-agnostic matcher for the Bedrock OSS/Nova ids the gateway emits:
// swallows any provider/region prefix (`openai.`, `us.amazon.`, `eu.amazon.`)
// and any `-version`/`:version` suffix, anchored on the model core.
const bedrockMatch = (core) => `(?i)^(.+\\.)?${core}([-:].*)?$`;

// modelName + per-1M list price (USD). Claude entries derive their matchPattern
// from the name; Bedrock entries carry an explicit region-agnostic one.
// Keep in sync with provider list prices.
const MODELS = [
  // Anthropic Claude (first-party + Bedrock `anthropic.*`).
  { name: 'claude-opus-4-8', price: perMillion(5, 25) },
  { name: 'claude-opus-4-7', price: perMillion(5, 25) },
  { name: 'claude-opus-4-6', price: perMillion(5, 25) },
  { name: 'claude-sonnet-4-6', price: perMillion(3, 15) },
  { name: 'claude-sonnet-4-5', price: perMillion(3, 15) },
  { name: 'claude-haiku-4-5', price: perMillion(1, 5) },
  // Bedrock OpenAI open-weight gpt-oss (this deployment's default route).
  { name: 'gpt-oss-120b', matchPattern: bedrockMatch('gpt-oss-120b'), price: perMillion(0.15, 0.6) },
  { name: 'gpt-oss-20b', matchPattern: bedrockMatch('gpt-oss-20b'), price: perMillion(0.07, 0.3) },
  // Amazon Nova (Bedrock).
  { name: 'nova-micro', matchPattern: bedrockMatch('nova-micro'), price: perMillion(0.035, 0.14) },
  { name: 'nova-lite', matchPattern: bedrockMatch('nova-lite'), price: perMillion(0.06, 0.24) },
  { name: 'nova-pro', matchPattern: bedrockMatch('nova-pro'), price: perMillion(0.8, 3.2) },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll GET /models until it returns 200 — this proves both that the API is up
// AND that the ANYRAY_INIT_* bootstrap created the project keys (else 401s).
async function waitForApi() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastStatus = 'no response';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/public/models?limit=1`, {
        headers: { Authorization: auth },
      });
      if (res.ok) return;
      lastStatus = `HTTP ${res.status}`;
    } catch (e) {
      lastStatus = e?.message ?? String(e);
    }
    await sleep(3000);
  }
  throw new Error(
    `Observability API not ready after ${READY_TIMEOUT_MS}ms (last: ${lastStatus})`
  );
}

// Fetch every registered model (paginated) so we can skip ones already seeded.
async function fetchExisting() {
  const existing = new Set();
  for (let page = 1; ; page++) {
    const res = await fetch(
      `${BASE_URL}/api/public/models?limit=100&page=${page}`,
      { headers: { Authorization: auth } }
    );
    if (!res.ok) throw new Error(`list models failed: HTTP ${res.status}`);
    const { data = [] } = await res.json();
    for (const m of data) existing.add(`${m.modelName}::${m.matchPattern}`);
    if (data.length < 100) break;
  }
  return existing;
}

async function seed() {
  await waitForApi();
  const existing = await fetchExisting();

  let created = 0;
  let skipped = 0;
  for (const { name, price, matchPattern: mp } of MODELS) {
    const matchPattern = mp ?? matchPatternFor(name);
    if (existing.has(`${name}::${matchPattern}`)) {
      console.log(`[model-seeder] skip ${name} (already registered)`);
      skipped++;
      continue;
    }
    const res = await fetch(`${BASE_URL}/api/public/models`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelName: name,
        matchPattern,
        unit: 'TOKENS',
        inputPrice: price.inputPrice,
        outputPrice: price.outputPrice,
      }),
    });
    if (res.ok) {
      console.log(
        `[model-seeder] ok   ${name}  in=$${price.inputPrice * 1e6}/M ` +
          `out=$${price.outputPrice * 1e6}/M`
      );
      created++;
    } else {
      console.error(
        `[model-seeder] FAIL ${name}  HTTP ${res.status}  ${await res.text()}`
      );
    }
  }
  console.log(
    `[model-seeder] done: ${created} created, ${skipped} already present`
  );
}

seed().catch((e) => {
  console.error('[model-seeder]', e?.message ?? e);
  process.exit(1);
});
