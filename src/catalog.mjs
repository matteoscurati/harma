// The model catalog: models, efforts, prices, Artificial Analysis figures,
// and how each agent CLI takes a model and an effort.
// A local AA refresh supplies benchmark figures for the bundled snapshot.
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { readJson } from './util.mjs';

const BUNDLED = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'catalog.json');

export function aaCachePath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(base, 'harma', 'aa-benchmarks.json');
}

export function loadCatalog({ env = process.env, path } = {}) {
  if (path) return readJson(path);
  const bundled = readJson(BUNDLED);
  const catalog_fingerprint = createHash('sha256').update(JSON.stringify(bundled)).digest('hex');
  const catalog = { ...bundled, catalog_fingerprint, origin: 'bundled' };
  const user = readJson(aaCachePath(env));
  if (user?.catalog_fingerprint !== catalog_fingerprint ||
      (user.generated_at ?? '') < (bundled?.generated_at ?? '')) {
    return catalog;
  }
  const models = { ...catalog.models };
  for (const [id, benchmark] of Object.entries(user.benchmarks ?? {})) {
    if (!Object.hasOwn(models, id) || !models[id].aa || !benchmark?.date) continue;
    const { index, cost_per_task, date } = benchmark;
    const aa = { ...models[id].aa, index, cost_per_task, date, source: 'aa-api' };
    models[id] = { ...models[id], aa };
  }
  return { ...catalog, models, generated_at: user.generated_at, origin: 'user-refresh' };
}

/** "claude-cli" -> "claude"; "claude-cli-zai" -> "claude-zai". */
export function harnessName(tool) {
  return tool.replace(/-cli(-|$)/, (_, tail) => (tail ? '-' : ''));
}

/** Harnesses keyed by short name. */
export function harnesses(catalog) {
  const out = {};
  for (const [tool, h] of Object.entries(catalog.harnesses ?? {})) {
    out[harnessName(tool)] = { tool, ...h };
  }
  return out;
}

/** AA index for a model at an effort: exact effort, else the model's only/"default" row. */
export function aaIndex(model, effort) {
  const idx = model?.aa?.index;
  if (!idx) return null;
  if (idx[effort] !== undefined) return idx[effort];
  if (idx.default !== undefined && Object.keys(idx).length === 1) return idx.default;
  return null;
}

export function aaCost(model, effort) {
  const c = model?.aa?.cost_per_task;
  if (!c) return null;
  return c[effort] ?? (Object.keys(c).length === 1 ? Object.values(c)[0] : null);
}
