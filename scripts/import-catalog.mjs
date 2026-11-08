#!/usr/bin/env node
// Maintainer-only: rebuild data/catalog.json from a controller-models checkout.
// Usage: node scripts/import-catalog.mjs [path/to/controller-models]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = process.argv[2] || process.env.HARMA_CONTROLLER_MODELS
  || join(homedir(), 'work/reasance.ai/controller-models');
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const models = read('registry/models.json');
const transports = read('registry/transports.json');
const sources = read('registry/sources.json');

const out = {
  schema_version: 1,
  generated_at: new Date().toISOString().slice(0, 10),
  registry_updated: models.updated,
  source: 'controller-models registry',
  attribution: 'Intelligence Index and cost per task: Artificial Analysis (https://artificialanalysis.ai/)',
  aa_api_url: sources.sources['aa-api']?.url ?? 'https://artificialanalysis.ai/api/v2/data/llms/models',
  models: {},
  harnesses: {},
};

for (const [id, m] of Object.entries(models.models)) {
  if (m.status !== 'active') continue;
  const aa = m.benchmarks?.aa ?? {};
  out.models[id] = {
    provider: m.provider,
    display_name: m.display_name,
    efforts: m.efforts?.values ?? [],
    effort_default: m.efforts?.default ?? null,
    pricing: m.pricing ? {
      input: m.pricing.input, output: m.pricing.output,
      source: m.pricing.source, verified_on: m.pricing.verified_on,
    } : null,
    aa: {
      slug: aa.slug ?? null,
      index: aa.index ?? null,
      cost_per_task: aa.cost_per_task && Object.keys(aa.cost_per_task).length ? aa.cost_per_task : null,
      date: aa.date ?? null,
      index_version: aa.index_version ?? null,
    },
  };
}

for (const t of transports.transports) {
  if (t.kind !== 'cli' || !t.binary) continue;
  out.harnesses[t.tool] = {
    binary: t.binary,
    model_flag: t.model_flag ?? null,
    effort_via: t.effort_via ?? null,
    effort_values: t.effort_values ?? null,
    billing: t.billing ?? null,
    notes: t.notes ?? null,
    source: t.source, verified_on: t.verified_on,
    models: Object.fromEntries(Object.entries(t.models ?? {}).map(([id, v]) => [id, {
      name: v.name ?? null,
      names: v.names ?? null,
      effort_values: v.effort_values ?? null,
    }])),
  };
}

const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'catalog.json');
writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(`catalog: ${Object.keys(out.models).length} models, ${Object.keys(out.harnesses).length} harnesses -> ${dest}`);
