// Intelligence per model x effort: the Artificial Analysis Intelligence Index.
// From the catalog snapshot, or refreshed from the AA API when a key exists
// (AA_API_KEY, or the delegation-kit key file). Missing scores stay null and
// are printed as "sconosciuto"; nothing is interpolated.
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { aaIndex, aaCost, userCatalogPath } from './catalog.mjs';
import { EFFORT_ORDER, HarmaError } from './util.mjs';

export function rankRows(catalog, inventoryModels) {
  const rows = [];
  for (const m of inventoryModels) {
    const model = catalog.models?.[m.model];
    const efforts = m.efforts?.length ? m.efforts : [null];
    for (const effort of efforts) {
      rows.push({
        harness: m.harness,
        model: m.model,
        effort,
        index: model ? aaIndex(model, effort) : null,
        cost_per_task: model ? aaCost(model, effort) : null,
        provider: model?.provider ?? null,
        aa_date: model?.aa?.date ?? null,
        index_version: model?.aa?.index_version ?? null,
      });
    }
  }
  return rows.sort((a, b) => (b.index ?? -1) - (a.index ?? -1)
    || EFFORT_ORDER.indexOf(a.effort) - EFFORT_ORDER.indexOf(b.effort));
}

const VARIANT = /^(.*?)\s*\(([^()]*)\)\s*$/;
const VARIANT_WORDS = new Set([...EFFORT_ORDER, 'non-reasoning', 'reasoning', 'thinking']);

/**
 * AA rows -> family slug -> variant -> index. Same rule as controller-models:
 * the variant is the first effort word in the name's parenthetical
 * ("Claude Opus 5.5 (Max)") and the family slug drops "-<variant>".
 */
export function aaFamilies(rows) {
  const out = {};
  for (const r of rows) {
    const name = r.name ?? '';
    const slug = r.slug ?? '';
    const index = r.evaluations?.artificial_analysis_intelligence_index ?? null;
    let variant = null;
    const m = name.match(VARIANT);
    if (m) variant = m[2].split(',').map((p) => p.trim().toLowerCase()).find((p) => VARIANT_WORDS.has(p)) ?? null;
    const family = variant && slug.endsWith(`-${variant}`) ? slug.slice(0, -variant.length - 1) : slug;
    (out[family] ??= {})[variant ?? 'default'] = index;
  }
  return out;
}

export function aaKey(env = process.env) {
  if (env.AA_API_KEY) return env.AA_API_KEY;
  const file = join(env.HOME || homedir(), '.local/share/delegation-kit/config/artificial-analysis.env');
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('AA_API_KEY=')) return line.slice(11).trim().replace(/^['"]|['"]$/g, '');
  }
  return null;
}

/** Fetch AA and write a refreshed catalog to the user config dir. Returns a change list. */
export async function refreshFromAA(catalog, { env = process.env, fetchImpl = fetch } = {}) {
  const key = aaKey(env);
  if (!key) {
    throw new HarmaError('Nessuna chiave Artificial Analysis', { hint: 'Imposta AA_API_KEY (gratuita su artificialanalysis.ai). Senza chiave harma usa lo snapshot incluso.' });
  }
  let res;
  try {
    res = await fetchImpl(catalog.aa_api_url, { headers: { 'x-api-key': key, Accept: 'application/json', 'User-Agent': 'harma' } });
  } catch (e) {
    throw new HarmaError(`Artificial Analysis non raggiungibile: ${e.name}`);
  }
  if (!res.ok) throw new HarmaError(`Artificial Analysis ha risposto HTTP ${res.status}`);
  const body = await res.json();
  const rows = Array.isArray(body) ? body : body?.data;
  if (!Array.isArray(rows)) throw new HarmaError('Risposta Artificial Analysis inattesa');
  const fams = aaFamilies(rows);
  const today = new Date().toISOString().slice(0, 10);
  const next = structuredClone(catalog);
  delete next.origin;
  const changes = [];
  for (const [id, m] of Object.entries(next.models)) {
    const fam = m.aa?.slug ? fams[m.aa.slug] : null;
    if (!fam) { changes.push({ model: id, change: m.aa?.slug ? 'non trovato su AA' : 'senza slug AA' }); continue; }
    const index = Object.fromEntries(Object.entries(fam).filter(([, v]) => v !== null && v !== undefined));
    if (JSON.stringify(index) !== JSON.stringify(m.aa.index)) changes.push({ model: id, change: 'indice aggiornato', old: m.aa.index, new: index });
    m.aa.index = Object.keys(index).length ? index : null;
    m.aa.date = today;
    m.aa.source = 'aa-api';
  }
  next.generated_at = today;
  next.source = 'Artificial Analysis API (refresh harma) su catalogo ' + (catalog.registry_updated ?? '');
  const dest = userCatalogPath(env);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(next, null, 2) + '\n');
  return { dest, changes };
}
