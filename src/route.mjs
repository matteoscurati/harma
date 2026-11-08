// Which model for which job. A score per (harness, model, effort):
//   score = index − cost_weight × cost_per_task + credit adjustment
// filtered by min_index, by installed CLIs and by credit state. The profiles
// below are defaults; .harma/config.json "routing" overrides them per task type.

export const TASK_PROFILES = {
  pianificazione: { min_index: 45, cost_weight: 0.5, label: 'pianificazione: massima intelligenza, il costo conta poco' },
  sviluppo: { min_index: 40, cost_weight: 1.5, label: 'sviluppo: intelligenza alta a costo ragionevole' },
  review: { min_index: 42, cost_weight: 1, different_vendor: true, label: 'review: vendor diverso da chi ha scritto il codice' },
  debugging: { min_index: 45, cost_weight: 0.75, label: 'debugging: intelligenza alta, il costo conta poco' },
  ricerca: { min_index: 35, cost_weight: 1.5, label: 'ricerca: buona intelligenza, costo contenuto' },
  estrazione: { min_index: 30, mode: 'cheapest', label: 'estrazione: il più economico con indice ≥ soglia' },
};

export const TASK_ALIASES = {
  planning: 'pianificazione', plan: 'pianificazione',
  development: 'sviluppo', dev: 'sviluppo', build: 'sviluppo', implementazione: 'sviluppo',
  revisione: 'review', 'code-review': 'review',
  debug: 'debugging', 'problem-solving': 'debugging', problemi: 'debugging',
  research: 'ricerca',
  extraction: 'estrazione', clerk: 'estrazione',
};

export function taskProfile(type, config = {}) {
  const key = TASK_PROFILES[type] ? type : TASK_ALIASES[type];
  if (!key) return null;
  return { type: key, ...TASK_PROFILES[key], ...(config.routing?.[key] ?? {}) };
}

const CREDIT_ADJUST = { ampio: 2, ok: 0, scarso: -8, sconosciuto: -1 };

/**
 * rankRows: from rank.mjs. credits: rows from credits.mjs (by harness).
 * author: {harness, model, provider} of the code under review, for review.
 */
export function route(type, { rankRows, credits = [], config = {}, author = null, top = 5 }) {
  const p = taskProfile(type, config);
  if (!p) return null;
  const creditBy = new Map(credits.map((c) => [c.harness, c]));
  // Unknown cost is never treated as cheap: assume the highest known cost.
  const knownCosts = rankRows.map((r) => r.cost_per_task).filter((x) => x !== null);
  const worstCost = knownCosts.length ? Math.max(...knownCosts) : 0;
  const out = [];
  const skipped = [];
  for (const r of rankRows) {
    const c = creditBy.get(r.harness);
    const status = c?.status ?? 'sconosciuto';
    const why = [];
    if (r.index === null) { skipped.push({ ...r, reason: 'indice AA sconosciuto' }); continue; }
    if (r.index < p.min_index) { skipped.push({ ...r, reason: `indice ${r.index} < ${p.min_index}` }); continue; }
    if (status === 'esaurito') { skipped.push({ ...r, reason: `crediti ${r.harness} esauriti` }); continue; }
    if (p.different_vendor && author && r.provider && r.provider === author.provider) {
      skipped.push({ ...r, reason: `stesso vendor dell'autore (${author.provider})` });
      continue;
    }
    const cost = r.cost_per_task ?? worstCost;
    const adj = CREDIT_ADJUST[status] ?? 0;
    // cheapest: order by cost; the credit adjustment only breaks ties.
    const score = p.mode === 'cheapest'
      ? Math.round((-cost + adj / 1000) * 1000) / 1000
      : Math.round((r.index - p.cost_weight * cost + adj) * 10) / 10;
    why.push(`indice ${r.index}`);
    why.push(r.cost_per_task === null ? `costo/task sconosciuto (assunto il più alto: $${worstCost})` : `costo/task $${r.cost_per_task}`);
    why.push(`crediti ${status}${c?.remaining_pct !== null && c?.remaining_pct !== undefined ? ` (${c.remaining_pct}% residuo)` : ''}`);
    out.push({ ...r, score, credit: status, why: why.join(' · ') });
  }
  out.sort((a, b) => b.score - a.score || b.index - a.index);
  return { profile: p, candidates: out.slice(0, top), skipped };
}
