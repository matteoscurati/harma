// The roster: which models (in order of preference) the user wants for each
// kind of work, plus the orchestrator. Proposals come from route(); the user
// accepts or overrides them in the TUI (harma select) or with --accept / --set.
// Stored in .harma/config.json → roster, orchestrator.
//
// A row's choice is null (undecided), { none: true } (no model for this job) or
// { picks: [{harness, model, effort}, …] } in order of preference. At dispatch
// choosePick() takes the first pick with usable credits.
import { route, TASK_PROFILES, taskProfile } from './route.mjs';
import { EFFORT_ORDER, HarmaError, now } from './util.mjs';

export const ORCHESTRATOR = 'orchestratore';
export const TASK_TYPES = Object.keys(TASK_PROFILES);
export const MAX_PICKS = 5;

/** One option per installed harness:model, with every effort's index and cost. */
export function modelOptions(invModels, rankRowsArr, credits = []) {
  const creditBy = new Map(credits.map((c) => [c.harness, c]));
  const out = [];
  for (const m of invModels) {
    const rows = rankRowsArr.filter((r) => r.harness === m.harness && r.model === m.model);
    const efforts = (m.efforts?.length ? m.efforts : [null]).map((e) => {
      const r = rows.find((x) => x.effort === e);
      return { effort: e, index: r?.index ?? null, cost: r?.cost_per_task ?? null };
    }).sort((a, b) => EFFORT_ORDER.indexOf(a.effort) - EFFORT_ORDER.indexOf(b.effort));
    const known = efforts.filter((e) => e.index !== null);
    const best = known.length ? known.reduce((a, b) => (b.index > a.index ? b : a)) : null;
    const c = creditBy.get(m.harness);
    out.push({
      harness: m.harness, model: m.model, provider: rows[0]?.provider ?? null,
      efforts, best, default_effort: m.default_effort ?? null, effort_fixed: Boolean(m.effort_fixed),
      credit: c?.status ?? 'sconosciuto', remaining: c?.remaining_pct ?? null,
    });
  }
  return out.sort((a, b) => (b.best?.index ?? -1) - (a.best?.index ?? -1));
}

/** Picks of a saved roster entry; reads the 0.2.0 single-model shape too. */
export function rosterPicks(entry) {
  if (!entry || entry.none) return [];
  if (Array.isArray(entry.picks)) return entry.picks.map(bare);
  return entry.harness ? [bare(entry)] : [];
}

const bare = (x) => ({ harness: x.harness, model: x.model, effort: x.effort ?? null });

/** Rows for the selection: orchestrator first, then one per task type. */
export function selectionRows({ cfg, rankRowsArr, credits }) {
  const rows = [{
    type: ORCHESTRATOR,
    label: 'orchestratore (dirige il progetto)',
    single: true,
    proposal: cfg.orchestrator ? { picks: [bare(cfg.orchestrator)] } : null,
    choice: cfg.orchestrator ? { picks: [bare(cfg.orchestrator)], source: 'configurato' } : null,
  }];
  for (const type of TASK_TYPES) {
    const p = taskProfile(type, cfg);
    const res = route(type, { rankRows: rankRowsArr, credits, config: cfg, top: 1000 });
    const cands = res?.candidates ?? [];
    const first = cands[0];
    // A backup on another CLI, so a job still has a model when one provider runs low.
    const backup = first && cands.find((c) => c.harness !== first.harness);
    const saved = cfg.roster?.[type];
    rows.push({
      type,
      label: p.label,
      proposal: first ? {
        picks: [first, backup].filter(Boolean).map(bare),
        why: `${first.why}${backup ? ` · riserva su un'altra CLI: ${describePick(backup)}` : ''}`,
      } : null,
      choice: !saved ? null : saved.none ? { none: true, source: saved.source } : { picks: rosterPicks(saved), source: saved.source ?? 'utente' },
    });
  }
  for (const r of rows) r.original = r.choice ? structuredClone(r.choice) : null;
  return rows;
}

export const samePick = (a, b) => Boolean(a && b && !a.none && !b.none
  && a.harness === b.harness && a.model === b.model && (a.effort ?? null) === (b.effort ?? null));

/** Same choice: both undecided, both "none", or the same picks in the same order. */
export function sameChoice(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.none || b.none) return Boolean(a.none && b.none);
  const pa = a.picks ?? [a];
  const pb = b.picks ?? [b];
  return pa.length === pb.length && pa.every((p, i) => samePick(p, pb[i]));
}

export const describePick = (p) => `${p.harness}:${p.model} @ ${p.effort ?? 'default'}`;

/** A single pick, a choice with picks, a saved roster entry, "none" or nothing. */
export function describe(p) {
  if (!p) return '— da decidere';
  if (p.none) return '— nessun modello';
  const picks = p.picks ?? (p.harness ? [p] : []);
  if (!picks.length) return '— da decidere';
  return picks.map(describePick).join(' → ');
}

const CREDIT_RANK = { ampio: 0, ok: 0, sconosciuto: 0, scarso: 1 };

/**
 * Which of the user's picks to use now. The user's order wins; a pick is skipped
 * when its CLI is missing or its credits are exhausted, and passed over for a
 * later one when its credits are low ("scarso") and a later one's are not.
 */
export function choosePick(picks, credits = [], { installed = () => true } = {}) {
  const by = new Map(credits.map((c) => [c.harness, c]));
  const rated = picks.map((p, i) => {
    const c = by.get(p.harness);
    const credit = c?.status ?? 'sconosciuto';
    const skip = !installed(p.harness) ? 'CLI non installata' : credit === 'esaurito' ? 'crediti esauriti' : null;
    return { ...bare(p), position: i + 1, credit, remaining: c?.remaining_pct ?? null, skip };
  });
  const usable = rated.filter((p) => !p.skip);
  const best = usable.reduce((a, p) => (a === null || CREDIT_RANK[p.credit] < CREDIT_RANK[a.credit] ? p : a), null);
  const notes = rated.filter((p) => p !== best && best && p.position < best.position)
    .map((p) => `n.${p.position} ${describePick(p)} saltato: ${p.skip ?? `crediti ${p.credit}`}`);
  return { pick: best, rated, notes };
}

/** "sviluppo=codex:gpt-6.1-sol@high|claude:claude-sonnet-5-5@high,review=none,orchestratore=claude:claude-opus-5-5@high" */
export function parseSetSpec(spec, { catalog, parseTarget, effortValues }) {
  const out = {};
  for (const part of String(spec).split(',').map((s) => s.trim()).filter(Boolean)) {
    const [rawType, value] = part.split(/=(.*)/s);
    const type = rawType === ORCHESTRATOR || TASK_PROFILES[rawType] ? rawType : taskProfile(rawType)?.type;
    if (!type) throw new HarmaError(`Tipo di lavoro sconosciuto in --set: ${rawType}`, { hint: `Tipi: ${[ORCHESTRATOR, ...TASK_TYPES].join(', ')}` });
    if (!value) throw new HarmaError(`--set ${rawType}: manca il modello (tipo=harness:modello@effort)`);
    if (value === 'none') {
      if (type === ORCHESTRATOR) throw new HarmaError('L\'orchestratore non può essere "none"');
      out[type] = { none: true, source: 'utente' };
      continue;
    }
    const picks = value.split('|').map((s) => s.trim()).filter(Boolean).map((v) => {
      const [target, effort] = v.split('@');
      const t = parseTarget(target, catalog);
      const allowed = effortValues(t.harness, t.model, catalog);
      if (effort && allowed.length && !allowed.includes(effort)) {
        throw new HarmaError(`Effort ${effort} non supportato da ${t.harness}:${t.model}`, { hint: `Valori: ${allowed.join(', ')}` });
      }
      return { harness: t.harness, model: t.model, effort: effort || catalog.models?.[t.model]?.effort_default || null };
    });
    if (type === ORCHESTRATOR && picks.length > 1) throw new HarmaError('L\'orchestratore è un solo modello');
    if (picks.length > MAX_PICKS) throw new HarmaError(`Al massimo ${MAX_PICKS} modelli per lavoro`);
    const dup = picks.find((p, i) => picks.findIndex((q) => samePick(p, q)) !== i);
    if (dup) throw new HarmaError(`--set ${type}: ${describePick(dup)} compare due volte`);
    out[type] = { picks, source: 'utente' };
  }
  return out;
}

/** Write the rows' choices into cfg (roster + orchestrator). Returns the saved roster. */
export function applySelection(cfg, rows) {
  const at = now();
  const roster = { ...(cfg.roster ?? {}) };
  for (const r of rows) {
    if (r.type === ORCHESTRATOR) {
      const o = r.choice?.picks?.[0];
      if (o && !sameChoice(r.choice, r.original)) cfg.orchestrator = { ...bare(o), set_at: at };
      continue;
    }
    if (!r.choice || (!r.choice.none && !r.choice.picks?.length)) { delete roster[r.type]; continue; }
    if (r.choice.none) { roster[r.type] = { none: true, source: 'utente', at }; continue; }
    roster[r.type] = {
      picks: r.choice.picks.map(bare),
      source: r.proposal && sameChoice(r.choice, r.proposal) ? 'proposta' : 'utente',
      proposed: r.proposal ? describe(r.proposal) : null,
      at,
    };
  }
  cfg.roster = roster;
  cfg.roster_updated_at = at;
  return roster;
}
