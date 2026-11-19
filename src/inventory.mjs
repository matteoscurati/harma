// What this machine can run: agent CLIs on PATH, their models, their efforts.
// Codex lists its models and efforts in ~/.codex/models_cache.json (machine
// source). Neon also requires an exact match in the Antigravity account's
// model inventory. Other models come from the catalog.
import { join } from 'node:path';
import { homedir } from 'node:os';
import { which, run, readJson, now } from './util.mjs';
import { harnesses } from './catalog.mjs';
import { meta } from './harness.mjs';

export const AGY_NEON = 'gemini-4-neon';

export async function agyModelIds(binary, env) {
  const result = await run(binary, ['models'], { env, timeout: 10_000 });
  return new Set(result.ok ? result.stdout.split('\n').map((line) => line.split('\t', 1)[0].trim()) : []);
}

export async function inventory({ catalog, env = process.env, config = {}, versions = true } = {}) {
  const hs = harnesses(catalog);
  const clis = [];
  const rows = [];
  for (const [name, h] of Object.entries(hs)) {
    const m = meta(name);
    const bin = h.binary.split(' ')[0];
    const path = which(bin, env);
    let state = path ? 'installato' : 'assente';
    if (path && m.variantOf && !config.harnesses?.[name]?.enabled) {
      state = 'richiede configurazione';
    }
    let version = null;
    if (path && versions && !m.variantOf) {
      const v = await run(bin, ['--version'], { env, timeout: 10_000 });
      version = v.ok ? v.stdout.trim().split('\n')[0].slice(0, 60) : null;
    }
    clis.push({ harness: name, binary: bin, state, version, billing: h.billing, effort_via: h.effort_via });
    if (state !== 'installato') continue;

    const machine = name === 'codex' ? codexModels(env) : null;
    const hasNeon = name === 'agy' && h.models?.[AGY_NEON];
    const agyIds = hasNeon ? await agyModelIds(path, env) : null;
    const models = machine ?? Object.keys(h.models ?? {}).map((id) => {
      const def = catalog.models?.[id]?.effort_default ?? null;
      // A CLI with no effort control runs at its own default: list only that.
      if (!h.effort_via) {
        return { model: id, efforts: def ? [def] : [], effort_fixed: true, default: def, source: `catalogo (${h.source}, ${h.verified_on}); effort non impostabile dalla CLI` };
      }
      return {
        model: id,
        efforts: h.models[id].effort_values ?? h.effort_values ?? catalog.models?.[id]?.efforts ?? [],
        default: def,
        source: `catalogo (${h.source}, ${h.verified_on})`,
      };
    });
    for (const mm of models) {
      if (agyIds && mm.model === AGY_NEON) {
        mm.efforts = mm.efforts.filter((effort) => agyIds.has(h.models[AGY_NEON].names?.[effort]));
        if (!mm.efforts.length) continue;
        if (!mm.efforts.includes(mm.default)) mm.default = null;
        mm.source = 'agy models';
      }
      rows.push({
        harness: name,
        model: mm.model,
        efforts: mm.efforts,
        effort_fixed: Boolean(mm.effort_fixed),
        default_effort: mm.default ?? null,
        in_catalog: Boolean(catalog.models?.[mm.model]),
        source: mm.source,
      });
    }
  }
  return { fetched_at: now(), clis, models: rows };
}

function codexModels(env) {
  const path = join(env.HOME || homedir(), '.codex', 'models_cache.json');
  const data = readJson(path);
  if (!Array.isArray(data?.models)) return null;
  return data.models
    .filter((m) => m.slug && m.visibility !== 'hidden')
    .map((m) => ({
      model: m.slug,
      efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort).filter(Boolean),
      default: m.default_reasoning_level ?? null,
      source: `~/.codex/models_cache.json (${(data.fetched_at ?? '').slice(0, 10)})`,
    }));
}
