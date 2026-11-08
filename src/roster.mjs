// The roster: which model and effort the user wants for each kind of work,
// plus the orchestrator. Proposals come from route(); the user accepts or
// overrides them in the TUI (harma select) or with --accept / --set.
// Stored in .harma/config.json → roster, orchestrator.
import { route, TASK_PROFILES, taskProfile } from './route.mjs';
import { EFFORT_ORDER, HarmaError, now } from './util.mjs';

export const ORCHESTRATOR = 'orchestratore';
export const TASK_TYPES = Object.keys(TASK_PROFILES);

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

/** Rows for the selection: orchestrator first, then one per task type. */
export function selectionRows({ cfg, rankRowsArr, credits }) {
  const rows = [{
    type: ORCHESTRATOR,
    label: 'orchestratore (dirige il progetto)',
    proposal: cfg.orchestrator ? pickOf(cfg.orchestrator, 'configurato') : null,
    choice: cfg.orchestrator ? pickOf(cfg.orchestrator, 'utente') : null,
  }];
  for (const type of TASK_TYPES) {
    const p = taskProfile(type, cfg);
    const res = route(type, { rankRows: rankRowsArr, credits, config: cfg, top: 1 });
    const top = res?.candidates[0];
    const saved = cfg.roster?.[type];
    rows.push({
      type,
      label: p.label,
      proposal: top ? { harness: top.harness, model: top.model, effort: top.effort, why: top.why } : null,
      choice: saved ? (saved.none ? { none: true, source: saved.source } : pickOf(saved, saved.source ?? 'utente')) : null,
    });
  }
  for (const r of rows) r.original = r.choice ? { ...r.choice } : null;
  return rows;
}

function pickOf(x, source) {
  return { harness: x.harness, model: x.model, effort: x.effort ?? null, source };
}

export const samePick = (a, b) => Boolean(a && b && !a.none && !b.none
  && a.harness === b.harness && a.model === b.model && (a.effort ?? null) === (b.effort ?? null));

export function describe(p) {
  if (!p) return '— da decidere';
  if (p.none) return '— nessun modello';
  return `${p.harness}:${p.model} @ ${p.effort ?? 'default'}`;
}

/** "sviluppo=codex:gpt-6.1-sol@high,review=none,orchestratore=claude:claude-opus-5-5@high" */
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
    const [target, effort] = value.split('@');
    const t = parseTarget(target, catalog);
    const allowed = effortValues(t.harness, t.model, catalog);
    if (effort && allowed.length && !allowed.includes(effort)) {
      throw new HarmaError(`Effort ${effort} non supportato da ${t.harness}:${t.model}`, { hint: `Valori: ${allowed.join(', ')}` });
    }
    out[type] = { harness: t.harness, model: t.model, effort: effort || catalog.models?.[t.model]?.effort_default || null, source: 'utente' };
  }
  return out;
}

/** Write the rows' choices into cfg (roster + orchestrator). Returns the saved roster. */
export function applySelection(cfg, rows) {
  const at = now();
  const roster = { ...(cfg.roster ?? {}) };
  for (const r of rows) {
    if (r.type === ORCHESTRATOR) {
      if (r.choice && !r.choice.none) cfg.orchestrator = { harness: r.choice.harness, model: r.choice.model, effort: r.choice.effort, set_at: at };
      continue;
    }
    if (!r.choice) { delete roster[r.type]; continue; }
    const source = r.choice.none ? 'utente' : (samePick(r.choice, r.proposal) ? 'proposta' : 'utente');
    roster[r.type] = r.choice.none
      ? { none: true, source, at }
      : { harness: r.choice.harness, model: r.choice.model, effort: r.choice.effort, source, proposed: r.proposal ? describe(r.proposal) : null, at };
  }
  cfg.roster = roster;
  cfg.roster_updated_at = at;
  return roster;
}
