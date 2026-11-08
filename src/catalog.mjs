// The model catalog: models, efforts, prices, Artificial Analysis figures,
// and how each agent CLI takes a model and an effort.
// The bundled snapshot (data/catalog.json) is overridden by a user-level
// refresh (~/.config/harma/catalog.json) when that one is newer.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { readJson } from './util.mjs';

const BUNDLED = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'catalog.json');

export function userCatalogPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(base, 'harma', 'catalog.json');
}

export function loadCatalog({ env = process.env, path } = {}) {
  if (path) return readJson(path);
  const bundled = readJson(BUNDLED);
  const user = readJson(userCatalogPath(env));
  if (user && (user.generated_at ?? '') >= (bundled?.generated_at ?? '')) {
    return { ...user, origin: 'user-refresh' };
  }
  return { ...bundled, origin: 'bundled' };
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
