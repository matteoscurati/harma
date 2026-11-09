import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadCatalog, harnesses } from './catalog.mjs';
import { parseTarget, effortValues, launchSpec, resumeArgv, meta } from './harness.mjs';
import {
  projectRoot, loadConfig, saveConfig, appendEvent, readEvents, agentsFromEvents,
  writeCache, readCache, hasProject, DEFAULT_CONFIG,
} from './state.mjs';
import { inventory } from './inventory.mjs';
import { collectCredits } from './credits.mjs';
import { rankRows, refreshFromAA } from './rank.mjs';
import { route, taskProfile, TASK_PROFILES } from './route.mjs';
import { selectBackend, HerdrBackend, HcBackend, projectId, checkAgentName } from './backends.mjs';
import { usageFor, estimateCost, findCodexSession } from './usage.mjs';
import { table, HarmaError, now, which, readJson, run } from './util.mjs';
import { modelOptions, selectionRows, applySelection, parseSetSpec, describe, describePick, ORCHESTRATOR, rosterPicks, choosePick } from './roster.mjs';
import { initState, runTui } from './tui.mjs';
import { statePath } from './state.mjs';
import { fileURLToPath } from 'node:url';

export const EXIT_NEEDS_CONFIRM = 3;
export const EXIT_BLOCKED = 4; // agent started, waiting on a dialog; task not delivered
const CREDIT_TTL_MS = 15 * 60_000;

function ctx(opts) {
  const env = opts.env ?? process.env;
  const root = projectRoot(opts.cwd ?? process.cwd());
  const catalog = loadCatalog({ env });
  return { env, root, catalog, out: opts.out ?? ((s) => process.stdout.write(s + '\n')) };
}

/** Is the CLI that runs this harness on PATH? */
function installedHarness(c, harness) {
  const h = harnesses(c.catalog)[harness];
  if (!h) return false;
  return Boolean(which(meta(harness).interactiveBinary ?? h.binary.split(' ')[0], c.env));
}

const emit = (c, flags, data, text) => c.out(flags.json ? JSON.stringify(data, null, 2) : text());

// 1 ─ orchestrator ─────────────────────────────────────────────────────────
export async function cmdInit(flags, opts = {}) {
  const c = ctx(opts);
  const root = resolve(opts.cwd ?? process.cwd());
  const cfg = loadConfig(root);
  if (!flags.orchestrator) throw new HarmaError('Manca --orchestrator <harness>:<model>', { hint: 'es. harma init --orchestrator claude:claude-opus-5-5 --effort high' });
  const t = parseTarget(flags.orchestrator, c.catalog);
  const allowed = effortValues(t.harness, t.model, c.catalog);
  const effort = flags.effort ?? c.catalog.models?.[t.model]?.effort_default ?? null;
  if (effort && allowed.length && !allowed.includes(effort)) {
    throw new HarmaError(`Effort ${effort} non supportato da ${t.harness}:${t.model}`, { hint: `Valori: ${allowed.join(', ')}` });
  }
  cfg.orchestrator = { harness: t.harness, model: t.model, effort, set_at: now() };
  if (flags.backend) cfg.backend = flags.backend;
  if (flags.policy) {
    if (!['confirm', 'auto-within-budget'].includes(flags.policy)) throw new HarmaError('--policy: confirm | auto-within-budget');
    cfg.dispatch_policy = flags.policy;
  }
  saveConfig(root, cfg);
  appendEvent(root, { type: 'orchestrator', ...cfg.orchestrator });
  emit({ ...c, root }, flags, cfg, () => [
    `Progetto harma: ${root}`,
    `Orchestratore: ${t.harness}:${t.model} @ ${effort ?? 'default'}`,
    `Backend: ${cfg.backend} · Policy di delega: ${cfg.dispatch_policy}`,
    'Prossimi passi: harma models · harma credits · harma rank',
  ].join('\n'));
  return cfg;
}

// 2 ─ inventory ────────────────────────────────────────────────────────────
export async function cmdModels(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root);
  const inv = await inventory({ catalog: c.catalog, env: c.env, config: cfg });
  if (hasProject(c.root)) writeCache(c.root, 'inventory', inv);
  emit(c, flags, inv, () => [
    'CLI di agenti',
    table(inv.clis, ['harness', 'state', 'version', 'billing', 'effort_via']),
    '',
    'Modelli utilizzabili',
    table(inv.models.map((m) => ({ ...m, efforts: m.efforts.join(','), in_catalog: m.in_catalog ? 'sì' : 'no' })),
      ['harness', 'model', 'efforts', 'default_effort', 'in_catalog', 'source']),
  ].join('\n'));
  return inv;
}

async function currentInventory(c, cfg, { fresh = false } = {}) {
  const cached = !fresh && hasProject(c.root) ? readCache(c.root, 'inventory') : null;
  return cached ?? inventory({ catalog: c.catalog, env: c.env, config: cfg, versions: false });
}

// 3 ─ credits ──────────────────────────────────────────────────────────────
export async function cmdCredits(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root);
  const inv = await currentInventory(c, cfg);
  const names = inv.clis.filter((x) => x.state === 'installato').map((x) => x.harness);
  const credits = await collectCredits({ harnessNames: names, config: cfg, catalog: c.catalog, env: c.env, codexbar: opts.codexbar });
  if (hasProject(c.root)) writeCache(c.root, 'credits', credits);
  emit(c, flags, credits, () => [
    `Crediti (${credits.fetched_at}; codexbar: ${credits.codexbar})`,
    table(credits.rows.map((r) => ({
      harness: r.harness,
      provider: r.provider,
      residuo: r.remaining_pct === null ? 'sconosciuto' : `${r.remaining_pct}%`,
      stato: r.status,
      finestre: r.windows.map((w) => `${w.window} ${w.used_pct}%`).join(' ') || null,
      'stima 7g': r.estimate ? `$${r.estimate.usd}` : null,
      fonte: r.source ?? r.detail,
    }))),
    '',
    'Stima 7g = token dei log locali × listino API: per un abbonamento non è l\'addebito reale.',
  ].join('\n'));
  return credits;
}

async function currentCredits(c, cfg, inv, opts) {
  const cached = hasProject(c.root) ? readCache(c.root, 'credits') : null;
  if (cached && Date.now() - Date.parse(cached.fetched_at) < CREDIT_TTL_MS) return cached;
  const names = inv.clis.filter((x) => x.state === 'installato').map((x) => x.harness);
  const credits = await collectCredits({ harnessNames: names, config: cfg, catalog: c.catalog, env: c.env, codexbar: opts.codexbar });
  if (hasProject(c.root)) writeCache(c.root, 'credits', credits);
  return credits;
}

// 4 ─ intelligence ─────────────────────────────────────────────────────────
export async function cmdRank(flags, opts = {}) {
  let c = ctx(opts);
  let refresh = null;
  if (flags.refresh) {
    refresh = await refreshFromAA(c.catalog, { env: c.env, fetchImpl: opts.fetchImpl });
    c = ctx(opts);
  }
  const cfg = loadConfig(c.root);
  const inv = await currentInventory(c, cfg);
  const rows = rankRows(c.catalog, inv.models);
  const top = Number(flags.top ?? rows.length);
  const data = { catalog: { origin: c.catalog.origin, generated_at: c.catalog.generated_at, attribution: c.catalog.attribution }, refresh, rows: rows.slice(0, top) };
  if (hasProject(c.root)) writeCache(c.root, 'rank', { fetched_at: now(), ...data });
  emit(c, flags, data, () => [
    `Intelligenza per modello × effort — ${c.catalog.attribution}`,
    `Catalogo: ${c.catalog.origin === 'bundled' ? `snapshot incluso (registro ${c.catalog.registry_updated})` : `aggiornato da AA il ${c.catalog.generated_at}`}${refresh ? ` · aggiornati ${refresh.changes.filter((x) => x.change === 'indice aggiornato').length} modelli` : ''}`,
    table(rows.slice(0, top).map((r) => ({
      harness: r.harness, model: r.model, effort: r.effort,
      indice: r.index ?? 'sconosciuto', 'costo/task': r.cost_per_task === null ? '—' : `$${r.cost_per_task}`, 'data AA': r.aa_date,
    }))),
  ].join('\n'));
  return data;
}

// 5 ─ routing ──────────────────────────────────────────────────────────────
export async function cmdRoute(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root);
  const type = flags._[0];
  if (!type) throw new HarmaError('Manca il tipo di lavoro', { hint: `Tipi: ${Object.keys(TASK_PROFILES).join(', ')}` });
  const inv = await currentInventory(c, cfg);
  const credits = await currentCredits(c, cfg, inv, opts);
  const author = flags.author ? authorOf(flags.author, c.catalog) : null;
  const res = route(type, { rankRows: rankRows(c.catalog, inv.models), credits: credits.rows, config: cfg, author, top: Number(flags.top ?? 5) });
  if (!res) throw new HarmaError(`Tipo di lavoro sconosciuto: ${type}`, { hint: `Tipi: ${Object.keys(TASK_PROFILES).join(', ')}` });
  res.user_choice = cfg.roster?.[res.profile.type] ?? null;
  if (res.user_choice && !res.user_choice.none) {
    const chosen = choosePick(rosterPicks(res.user_choice), credits.rows, { installed: (h) => installedHarness(c, h) });
    res.user_pick = chosen.pick ? { ...chosen.pick, notes: chosen.notes } : null;
  }
  emit(c, flags, res, () => [
    `Routing — ${res.profile.label}`,
    !res.user_choice ? 'Nessuna scelta dell\'utente per questo lavoro: proponila con harma select.'
      : res.user_choice.none ? 'L\'utente ha scelto: nessun modello per questo lavoro.'
        : `Scelta dell'utente (harma select): ${describe(res.user_choice)}\n  ora dispatch --task-type ${res.profile.type} userebbe: ${res.user_pick ? `${describePick(res.user_pick)} (n.${res.user_pick.position})${res.user_pick.notes.length ? ` — ${res.user_pick.notes.join('; ')}` : ''}` : 'nessuno: tutti i modelli scelti sono senza crediti o non installati'}`,
    table(res.candidates.map((r, i) => ({ '#': i + 1, modello: `${r.harness}:${r.model}`, effort: r.effort, punteggio: r.score, motivi: r.why }))),
    res.candidates.length ? `\nPer avviarlo: harma dispatch --name <nome> --task-type ${res.profile.type} --model ${res.candidates[0].harness}:${res.candidates[0].model} --effort ${res.candidates[0].effort} --prompt "<compito>"` : '\nNessun candidato: abbassa min_index in .harma/config.json routing o controlla crediti e CLI.',
  ].join('\n'));
  return res;
}

function authorOf(spec, catalog) {
  const t = parseTarget(spec, catalog);
  return { ...t, provider: catalog.models?.[t.model]?.provider ?? null };
}

// 5b ─ dispatch ────────────────────────────────────────────────────────────
export async function cmdDispatch(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root, { required: true });
  checkAgentName(flags.name);
  const existing = agentsFromEvents(readEvents(c.root)).find((a) => a.name === flags.name && a.state === 'open');
  if (existing) throw new HarmaError(`L'agente ${flags.name} è già aperto`, { hint: 'Scegli un altro nome, o `harma send` per dargli altro lavoro' });

  let pick;
  if (flags.model) {
    const t = parseTarget(flags.model, c.catalog);
    pick = { harness: t.harness, model: t.model, effort: flags.effort ?? c.catalog.models?.[t.model]?.effort_default ?? null, why: 'scelto esplicitamente' };
  } else if (flags['task-type'] && cfg.roster?.[taskProfile(flags['task-type'], cfg)?.type]) {
    const type = taskProfile(flags['task-type'], cfg).type;
    const chosen = cfg.roster[type];
    if (chosen.none) throw new HarmaError(`Per ${type} l'utente ha scelto di non usare nessun modello`, { hint: 'Cambia la scelta con harma select, o passa --model esplicitamente' });
    const picks = rosterPicks(chosen);
    const inv = await currentInventory(c, cfg);
    const credits = await currentCredits(c, cfg, inv, opts);
    const { pick: p, rated, notes } = choosePick(picks, credits.rows, { installed: (h) => installedHarness(c, h) });
    if (!p) {
      throw new HarmaError(`Nessuno dei modelli scelti per ${type} è utilizzabile ora`, {
        hint: `${rated.map((r) => `n.${r.position} ${describePick(r)}: ${r.skip}`).join('; ')} — cambia la lista con harma select, o passa --model esplicitamente`,
      });
    }
    const where = picks.length > 1 ? `n.${p.position} di ${picks.length}` : 'unica';
    pick = { harness: p.harness, model: p.model, effort: flags.effort ?? p.effort, why: `scelta dell'utente per ${type} (harma select, ${chosen.source}; ${where}, crediti ${p.credit})${notes.length ? ` — ${notes.join('; ')}` : ''}` };
  } else {
    if (!flags['task-type']) throw new HarmaError('Serve --model <harness>:<model> oppure --task-type <tipo>');
    const inv = await currentInventory(c, cfg);
    const credits = await currentCredits(c, cfg, inv, opts);
    const res = route(flags['task-type'], { rankRows: rankRows(c.catalog, inv.models), credits: credits.rows, config: cfg, author: flags.author ? authorOf(flags.author, c.catalog) : null, top: 1 });
    if (!res?.candidates.length) throw new HarmaError(`Nessun modello adatto per ${flags['task-type']}`);
    pick = { ...res.candidates[0], why: `routing ${res.profile.type}: ${res.candidates[0].why}` };
  }
  const prompt = flags['prompt-file'] ? readFileSync(flags['prompt-file'], 'utf8') : flags.prompt ?? null;
  const cwd = resolve(flags.cwd ?? c.root);
  const spec = launchSpec(pick, c.catalog);
  if (!which(spec.argv[0], c.env)) {
    throw new HarmaError(`${spec.argv[0]} non è installato su questa macchina`, { hint: 'Vedi harma models per le CLI disponibili' });
  }
  const plan = {
    agent: flags.name, task_type: flags['task-type'] ?? null,
    harness: pick.harness, model: pick.model, effort: pick.effort, why: pick.why,
    cwd, argv: spec.argv, env: spec.env, notes: spec.notes,
    prompt_chars: prompt?.length ?? 0, policy: cfg.dispatch_policy,
  };

  const gate = await dispatchGate(c, cfg, pick.harness, flags, opts);
  if (!gate.allowed) {
    emit(c, flags, { needs_confirmation: true, reason: gate.reason, plan }, () => [
      'CONFERMA RICHIESTA — nessun agente è stato avviato.',
      `Motivo: ${gate.reason}`,
      `Agente ${plan.agent}: ${plan.harness}:${plan.model} @ ${plan.effort ?? 'default'} (${plan.why})`,
      `Comando: ${plan.argv.join(' ')}${Object.keys(plan.env).length ? `  env ${JSON.stringify(plan.env)}` : ''}`,
      ...plan.notes.map((n) => `Nota: ${n}`),
      'Se l\'utente approva, ripeti lo stesso comando con --yes.',
    ].join('\n'));
    return { needsConfirmation: true, plan, exitCode: EXIT_NEEDS_CONFIRM };
  }

  const backend = opts.backend ?? await selectBackend({ choice: flags.backend, config: cfg, env: c.env });
  const project = projectId(c.root);
  const startedMs = Date.now();
  const started = await backend.start({ name: flags.name, cwd, argv: spec.argv, env: spec.env, harness: pick.harness, root: c.root, project });
  if (started.workspaceCreated) { cfg.herdr = { ...(cfg.herdr ?? {}), workspace_id: started.workspace }; saveConfig(c.root, cfg); }
  appendEvent(c.root, {
    type: 'started', agent: flags.name, harness: pick.harness, model: pick.model, effort: pick.effort,
    task_type: flags['task-type'] ?? null, backend: backend.name, target: { name: started.target, tab: started.tab ?? null, pane: started.pane ?? null, address: started.address ?? null },
    cwd, session_id: spec.sessionId, why: pick.why, confirmed_by: gate.by, started_ms: startedMs,
  });
  let sid = spec.sessionId ?? await discoverSession(backend, { name: started.target, harness: pick.harness, cwd, sinceMs: startedMs, env: c.env });
  if (sid && sid !== spec.sessionId) appendEvent(c.root, { type: 'session', agent: flags.name, session_id: sid, source: backend.name });
  let promptState = prompt ? 'sent' : 'none';
  if (prompt) {
    try {
      await backend.prompt(started.target, prompt, { wait: Boolean(flags.wait), timeoutSec: Number(flags.timeout ?? 600) });
      appendEvent(c.root, { type: 'prompted', agent: flags.name, chars: prompt.length });
    } catch (e) {
      if (e.code !== 'agent_blocked') throw e;
      // Started and recorded, but waiting on a dialog (e.g. folder trust): the user must answer it.
      promptState = 'blocked';
      appendEvent(c.root, { type: 'blocked', agent: flags.name, detail: 'prompt non inviato: l\'agente aspetta un input' });
    }
  }
  if (!sid && promptState === 'sent') {
    // Codex registers its session on the first turn: look again now.
    sid = await discoverSession(backend, { name: started.target, harness: pick.harness, cwd, sinceMs: startedMs, env: c.env });
    if (sid) appendEvent(c.root, { type: 'session', agent: flags.name, session_id: sid, source: backend.name });
  }
  const result = { started: true, plan, target: started, session_id: sid ?? null, prompt: promptState, exitCode: promptState === 'blocked' ? EXIT_BLOCKED : 0 };
  emit(c, flags, result, () => [
    `Avviato ${flags.name}: ${pick.harness}:${pick.model} @ ${pick.effort ?? 'default'} su ${backend.name} (${started.tab ?? started.address ?? started.target})`,
    `Sessione: ${sid ?? 'non ancora nota (verrà letta alla chiusura)'}`,
    promptState === 'sent' ? `Compito inviato (${prompt.length} caratteri)${flags.wait ? '; atteso fino a stato stabile' : ''}.`
      : promptState === 'blocked' ? `BLOCCATO: ${flags.name} aspetta una risposta (es. fiducia nella cartella) e il compito NON è stato inviato.\nLeggi con: harma read ${flags.name} — chiedi all'utente di rispondere nel suo terminale, poi: harma send ${flags.name} "<compito>" --yes`
        : 'Nessun compito inviato: usa harma send.',
    ...plan.notes.map((n) => `Nota: ${n}`),
  ].join('\n'));
  return result;
}

/** Policy check. confirm: only --yes. auto-within-budget: provider credits ok/ampio. */
async function dispatchGate(c, cfg, harness, flags, opts) {
  if (flags.yes) return { allowed: true, by: 'utente (--yes)' };
  if (cfg.dispatch_policy !== 'auto-within-budget') {
    return { allowed: false, reason: 'policy "confirm": ogni avvio di agente richiede il consenso esplicito dell\'utente' };
  }
  const inv = await currentInventory(c, cfg);
  const credits = await currentCredits(c, cfg, inv, opts);
  const row = credits.rows.find((r) => r.harness === harness);
  if (row && ['ok', 'ampio'].includes(row.status)) return { allowed: true, by: `policy auto-within-budget (crediti ${row.status})` };
  return { allowed: false, reason: `policy auto-within-budget: crediti ${harness} ${row?.status ?? 'sconosciuti'}` };
}

async function discoverSession(backend, { name, harness, cwd, sinceMs, env }) {
  if (backend.name === 'herdr') {
    try {
      const live = (await backend.list()).find((a) => a.name === name || a.target === name);
      if (live?.sessionId) return live.sessionId;
    } catch { /* fall through */ }
  }
  if (harness === 'codex') return findCodexSession({ env, cwd, sinceMs });
  return null;
}

// send / read ──────────────────────────────────────────────────────────────
export async function cmdSend(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root, { required: true });
  const [name, ...rest] = flags._;
  const text = flags['prompt-file'] ? readFileSync(flags['prompt-file'], 'utf8') : rest.join(' ');
  const agent = openAgent(c, name);
  if (!text) throw new HarmaError('Manca il testo da inviare');
  const gate = await dispatchGate(c, cfg, agent.harness, flags, opts);
  if (!gate.allowed) {
    emit(c, flags, { needs_confirmation: true, reason: gate.reason, agent: name, chars: text.length }, () =>
      `CONFERMA RICHIESTA — nulla è stato inviato a ${name}.\nMotivo: ${gate.reason}\nSe l'utente approva, ripeti con --yes.`);
    return { needsConfirmation: true, exitCode: EXIT_NEEDS_CONFIRM };
  }
  const backend = opts.backend ?? backendFor(agent, cfg, c.env);
  await backend.prompt(agent.target?.name ?? name, text, { wait: Boolean(flags.wait), timeoutSec: Number(flags.timeout ?? 600) });
  appendEvent(c.root, { type: 'prompted', agent: name, chars: text.length, confirmed_by: gate.by });
  c.out(flags.json ? JSON.stringify({ sent: true }) : `Inviato a ${name} (${text.length} caratteri).`);
  return { sent: true };
}

export async function cmdRead(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root, { required: true });
  const agent = openAgent(c, flags._[0]);
  const backend = opts.backend ?? backendFor(agent, cfg, c.env);
  const text = await backend.read(agent.target?.name ?? agent.name, Number(flags.lines ?? 120));
  c.out(text);
  return text;
}

function openAgent(c, name) {
  if (!name) throw new HarmaError('Manca il nome dell\'agente');
  const a = agentsFromEvents(readEvents(c.root)).find((x) => x.name === name);
  if (!a) throw new HarmaError(`Agente sconosciuto: ${name}`, { hint: 'Vedi harma status' });
  if (a.state !== 'open') throw new HarmaError(`L'agente ${name} è chiuso`, { hint: `harma resume ${name}` });
  return a;
}

function backendFor(agent, cfg, env) {
  return agent.backend === 'hc' ? new HcBackend({ env }) : new HerdrBackend({ env, config: cfg });
}

// 6 ─ monitoring ───────────────────────────────────────────────────────────
export async function cmdStatus(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root, { required: true });
  const agents = agentsFromEvents(readEvents(c.root));
  const live = await liveByBackend(c, cfg, agents, opts);
  const rows = agents.filter((a) => flags.all || a.state === 'open').map((a) => {
    const l = findLive(a, live[a.backend]);
    return {
      agente: a.name,
      modello: `${a.harness}:${a.model}`,
      effort: a.effort,
      lavoro: a.task_type,
      registro: a.state === 'open' ? 'aperto' : 'chiuso',
      stato: a.state === 'closed' ? '—' : (l ? (l.status ?? 'nessuno stato') : (live[a.backend] ? 'non trovato' : 'backend non raggiungibile')),
      backend: `${a.backend} ${a.target?.tab ?? a.target?.address ?? ''}`.trim(),
      da: a.started_at ? ago(a.started_at) : null,
      sessione: a.session_id ? a.session_id.slice(0, 8) + '…' : (l?.sessionId ? l.sessionId.slice(0, 8) + '…' : null),
    };
  });
  const data = { orchestrator: cfg.orchestrator, policy: cfg.dispatch_policy, agents: rows };
  emit(c, flags, data, () => [
    `Orchestratore: ${cfg.orchestrator ? `${cfg.orchestrator.harness}:${cfg.orchestrator.model} @ ${cfg.orchestrator.effort}` : 'non impostato'} · policy ${cfg.dispatch_policy}`,
    table(rows),
  ].join('\n'));
  return data;
}

async function liveByBackend(c, cfg, agents, opts) {
  const out = {};
  const used = new Set(agents.filter((a) => a.state === 'open').map((a) => a.backend));
  for (const name of used) {
    const b = opts.backend?.name === name ? opts.backend : (name === 'hc' ? new HcBackend({ env: c.env }) : new HerdrBackend({ env: c.env, config: cfg }));
    try { out[name] = await b.list(projectId(c.root)); } catch { out[name] = null; }
  }
  return out;
}

/** Drop `flag` and the value after it; with no flag, return args unchanged. */
export function withoutFlag(args, flag) {
  if (!flag) return [...args];
  const i = args.indexOf(flag);
  return i < 0 ? [...args] : [...args.slice(0, i), ...args.slice(i + 2)];
}

/** The live terminal of a registered agent: by pane (herdr), address (hc), then name. */
export function findLive(a, list) {
  if (!list) return null;
  const t = a.target ?? {};
  return list.find((x) => t.pane && x.pane === t.pane)
    ?? list.find((x) => t.address && x.address === t.address)
    ?? list.find((x) => x.name && x.name === (t.name ?? a.name))
    ?? null;
}

function ago(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} g`;
}

// 7 ─ costs ────────────────────────────────────────────────────────────────
export async function cmdCosts(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root, { required: true });
  const agents = agentsFromEvents(readEvents(c.root));
  // An open agent's id may be known to the backend before harma records it.
  const live = await liveByBackend(c, cfg, agents.filter((a) => !a.session_id), opts);
  for (const a of agents) {
    if (!a.session_id && a.state === 'open') a.session_id = findLive(a, live[a.backend])?.sessionId ?? null;
  }
  const perAgent = [];
  for (const a of agents) {
    if (!a.session_id || !meta(a.harness).logs) {
      perAgent.push({ agente: a.name, modello: `${a.harness}:${a.model}`, token: null, stima: null, nota: a.session_id ? `nessun log locale per ${a.harness}` : 'id di sessione non ancora noto' });
      continue;
    }
    const s = usageFor(a.harness, { env: c.env, sessionIds: [a.session_id] })[0];
    if (!s) { perAgent.push({ agente: a.name, modello: `${a.harness}:${a.model}`, token: 0, stima: null, nota: 'sessione senza consumi registrati' }); continue; }
    const est = estimateCost(s, c.catalog);
    const tokens = (s.input ?? 0) + (s.output ?? 0) + (s.cache_read ?? 0) + (s.cache_write_5m ?? 0) + (s.cache_write_1h ?? 0);
    perAgent.push({ agente: a.name, modello: `${a.harness}:${s.model ?? a.model}`, token: tokens, stima: est.usd === null ? null : `$${est.usd}`, nota: est.note });
  }
  const inv = await currentInventory(c, cfg);
  const credits = await currentCredits(c, cfg, inv, opts);
  const advice = adviceFor(credits.rows, agents);
  const data = { agents: perAgent, providers: credits.rows, advice };
  emit(c, flags, data, () => [
    'Costo per agente (stima a listino API dai log locali)',
    table(perAgent),
    '',
    'Crediti per provider',
    table(credits.rows.map((r) => ({ harness: r.harness, residuo: r.remaining_pct === null ? 'sconosciuto' : `${r.remaining_pct}%`, stato: r.status, fonte: r.source ?? r.detail }))),
    '',
    'Indicazioni di delega',
    ...advice.map((x) => `- ${x}`),
  ].join('\n'));
  return data;
}

export function adviceFor(rows, agents = []) {
  const open = new Map();
  for (const a of agents) if (a.state === 'open') open.set(a.harness, (open.get(a.harness) ?? 0) + 1);
  const roomy = rows.filter((r) => r.status === 'ampio').map((r) => r.harness);
  const out = [];
  for (const r of rows) {
    const n = open.get(r.harness) ?? 0;
    const busy = n ? ` (agenti aperti: ${n})` : '';
    if (r.status === 'esaurito') {
      const reset = r.windows?.map((w) => w.resets_at).filter(Boolean).sort()[0];
      out.push(`${r.harness}: crediti esauriti${busy} — non delegare${reset ? ` fino a ${reset}` : ''}${roomy.length ? `; sposta il lavoro su ${roomy.join(', ')}` : ''}.`);
    } else if (r.status === 'scarso') {
      out.push(`${r.harness}: crediti scarsi (${r.remaining_pct}%)${busy} — delega di meno${roomy.length ? `; preferisci ${roomy.join(', ')}` : ''}.`);
    } else if (r.status === 'ampio') {
      out.push(`${r.harness}: margine ampio (${r.remaining_pct}%)${busy} — può prendere più lavoro.`);
    } else if (r.status === 'sconosciuto') {
      out.push(`${r.harness}: crediti sconosciuti — attiva ${r.provider ?? 'il provider'} in CodexBar o dichiara un budget in .harma/config.json → budgets.${r.provider ?? '<provider>'}.`);
    }
  }
  return out;
}

// 8 ─ cleanup and resume ───────────────────────────────────────────────────
export async function cmdCleanup(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root, { required: true });
  const agents = agentsFromEvents(readEvents(c.root)).filter((a) => a.state === 'open' && (!flags.agent || a.name === flags.agent));
  const live = await liveByBackend(c, cfg, agents, opts);
  const report = [];
  for (const a of agents) {
    const l = findLive(a, live[a.backend]);
    const status = l?.status ?? (live[a.backend] ? 'non trovato' : 'backend non raggiungibile');
    if (!live[a.backend]) { report.push({ agente: a.name, azione: 'saltato', motivo: status }); continue; }
    if (['working', 'blocked'].includes(status) && !flags.force) {
      report.push({ agente: a.name, azione: 'tenuto', motivo: status === 'working' ? 'sta lavorando' : 'aspetta una risposta (blocked): leggilo con harma read' });
      continue;
    }
    let sid = a.session_id ?? l?.sessionId ?? null;
    let source = a.session_id ? 'registro' : (l?.sessionId ? a.backend : null);
    if (!sid && a.harness === 'codex') { sid = findCodexSession({ env: c.env, cwd: a.cwd, sinceMs: Date.parse(a.started_at) }); source = sid ? 'log codex' : null; }
    if (!sid && !flags.force && status !== 'non trovato') {
      report.push({ agente: a.name, azione: 'tenuto', motivo: 'id di sessione non trovato: chiudendo si perde il contesto (usa --force per chiudere comunque)' });
      continue;
    }
    if (flags['dry-run']) { report.push({ agente: a.name, azione: 'da chiudere', motivo: status, sessione: sid }); continue; }
    if (sid && sid !== a.session_id) appendEvent(c.root, { type: 'session', agent: a.name, session_id: sid, source });
    let closed = { ok: true, detail: 'già chiuso nel backend' };
    if (status !== 'non trovato') {
      const b = opts.backend?.name === a.backend ? opts.backend : backendFor(a, cfg, c.env);
      closed = await b.close({ target: a.target?.name ?? a.name, tab: a.target?.tab });
    }
    if (closed.ok) appendEvent(c.root, { type: 'closed', agent: a.name, session_id: sid, last_status: status });
    report.push({ agente: a.name, azione: closed.ok ? 'chiuso' : 'errore', motivo: closed.detail, sessione: sid });
  }
  // --workspace: close harma's own herdr workspace once no harma agent is open.
  if (flags.workspace && !flags['dry-run'] && cfg.herdr?.workspace_id) {
    const stillOpen = agentsFromEvents(readEvents(c.root)).filter((a) => a.state === 'open');
    if (stillOpen.length) {
      report.push({ agente: '(workspace)', azione: 'tenuto', motivo: `agenti ancora aperti: ${stillOpen.map((a) => a.name).join(', ')}` });
    } else {
      const b = opts.backend?.name === 'herdr' ? opts.backend : new HerdrBackend({ env: c.env, config: cfg });
      const res = await b.closeWorkspace(cfg.herdr.workspace_id);
      if (res.ok) { delete cfg.herdr.workspace_id; saveConfig(c.root, cfg); }
      report.push({ agente: '(workspace)', azione: res.ok ? 'chiuso' : 'errore', motivo: res.detail });
    }
  }
  emit(c, flags, { report }, () => [
    flags['dry-run'] ? 'Anteprima pulizia (nulla è stato chiuso)' : 'Pulizia agenti',
    table(report),
    'harma chiude solo terminali e tab che ha creato; ogni id di sessione resta in .harma/agents.jsonl.',
  ].join('\n'));
  return { report };
}

export async function cmdResume(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root, { required: true });
  const name = flags._[0];
  const a = agentsFromEvents(readEvents(c.root)).find((x) => x.name === name);
  if (!a) throw new HarmaError(`Agente sconosciuto: ${name}`);
  if (a.state === 'open') throw new HarmaError(`${name} è già aperto`, { hint: `harma read ${name}` });
  if (!a.session_id) throw new HarmaError(`Nessun id di sessione salvato per ${name}`);
  const base = resumeArgv(a.harness, a.session_id);
  if (!base) throw new HarmaError(`Non so riprendere sessioni di ${a.harness}`, { hint: `id salvato: ${a.session_id}` });
  const spec = launchSpec({ harness: a.harness, model: a.model, effort: a.effort }, c.catalog, { sessionId: a.session_id });
  // resume argv + model/effort flags, without the "new session id" flag and its value
  const flagsOnly = withoutFlag(spec.argv.slice(1), meta(a.harness).presetSession);
  const argv = [...base, ...flagsOnly];
  const gate = await dispatchGate(c, cfg, a.harness, flags, opts);
  if (!gate.allowed || flags['print-only']) {
    emit(c, flags, { needs_confirmation: !gate.allowed, argv, cwd: a.cwd }, () => [
      gate.allowed ? 'Comando di ripresa:' : `CONFERMA RICHIESTA — ${gate.reason}`,
      `cd ${a.cwd} && ${argv.join(' ')}`,
      gate.allowed ? '' : 'Se l\'utente approva, ripeti con --yes per riaprirlo in un nuovo terminale.',
    ].join('\n').trim());
    return { needsConfirmation: !gate.allowed, argv, exitCode: gate.allowed ? 0 : EXIT_NEEDS_CONFIRM };
  }
  const backend = opts.backend ?? await selectBackend({ choice: flags.backend ?? a.backend, config: cfg, env: c.env });
  const started = await backend.start({ name, cwd: a.cwd, argv, env: spec.env, harness: a.harness, root: c.root, project: projectId(c.root) });
  if (started.workspaceCreated) { cfg.herdr = { ...(cfg.herdr ?? {}), workspace_id: started.workspace }; saveConfig(c.root, cfg); }
  appendEvent(c.root, { type: 'resumed', agent: name, session_id: a.session_id, backend: backend.name, target: { name: started.target, tab: started.tab ?? null, pane: started.pane ?? null, address: started.address ?? null }, confirmed_by: gate.by });
  c.out(flags.json ? JSON.stringify({ resumed: true, argv }) : `Ripreso ${name} (sessione ${a.session_id}) su ${backend.name}.`);
  return { resumed: true, argv };
}

// select ─ the user validates or picks model + effort per job ─────────────
const BIN = fileURLToPath(new URL('../bin/harma.mjs', import.meta.url));

export async function cmdSelect(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root, { required: true });
  if (flags.open) return openSelect(c, cfg, flags, opts);

  if (!flags.json && !flags.show) c.out('Carico modelli, crediti e proposte…');
  const inv = await currentInventory(c, cfg);
  const credits = await currentCredits(c, cfg, inv, opts);
  const rr = rankRows(c.catalog, inv.models);
  const rows = selectionRows({ cfg, rankRowsArr: rr, credits: credits.rows });
  const models = modelOptions(inv.models, rr, credits.rows);

  if (flags.show) return showSelection(c, flags, rows);

  let outcome;
  let finalRows = rows;
  if (flags.accept || flags.set) {
    if (flags.accept) {
      finalRows = finalRows.map((r) => (r.proposal ? { ...r, choice: { picks: [...r.proposal.picks], source: 'proposta' } } : r));
    }
    if (flags.set) {
      const parsed = parseSetSpec(flags.set, { catalog: c.catalog, parseTarget, effortValues });
      finalRows = finalRows.map((r) => (parsed[r.type] ? { ...r, choice: parsed[r.type] } : r));
    }
    outcome = 'save';
  } else {
    const input = opts.input ?? process.stdin;
    const output = opts.output ?? process.stdout;
    if (!input.isTTY || !output.isTTY) {
      throw new HarmaError('harma select è interattivo e qui non c\'è un terminale', {
        hint: 'Apri la TUI in un tab herdr con: harma select --open --wait · oppure senza TUI: harma select --accept | --set "sviluppo=codex:gpt-6.1-sol@high,…" | --show',
      });
    }
    const orch = cfg.orchestrator ? describe(cfg.orchestrator) : 'non impostato';
    const end = await (opts.runTui ?? runTui)(initState({ rows, models, title: 'harma · modelli del progetto', subtitle: `orchestratore ${orch} · ${c.root}` }), { input, output });
    outcome = end.done;
    finalRows = end.rows;
  }

  if (outcome !== 'save') {
    writeCache(c.root, 'select-status', { state: 'cancelled', at: now() });
    c.out(flags.json ? JSON.stringify({ saved: false }) : 'Nessuna modifica salvata.');
    await closeOwnTab(flags, c.env);
    return { saved: false };
  }
  const roster = applySelection(cfg, finalRows);
  saveConfig(c.root, cfg);
  appendEvent(c.root, { type: 'roster', orchestrator: cfg.orchestrator, roster });
  writeCache(c.root, 'select-status', { state: 'saved', at: cfg.roster_updated_at });
  showSelection(c, flags, finalRows, 'Scelte salvate in .harma/config.json');
  await closeOwnTab(flags, c.env);
  return { saved: true, orchestrator: cfg.orchestrator, roster };
}

function showSelection(c, flags, rows, heading = 'Modelli per lavoro') {
  const data = rows.map((r) => ({
    lavoro: r.type,
    proposta: describe(r.proposal),
    scelta: describe(r.choice),
    fonte: !r.choice ? '—' : r.type === ORCHESTRATOR ? 'configurato' : (r.choice.none ? 'utente' : r.choice.source === 'proposta' ? 'proposta accettata' : 'utente'),
  }));
  // One block per job: the choice can be several models long, a table would wrap.
  emit(c, flags, { rows: data }, () => [heading, ...data.flatMap((d) => [
    `${d.lavoro}: ${d.scelta}${d.fonte !== '—' ? `  (${d.fonte})` : ''}`,
    ...(d.proposta !== d.scelta ? [`  proposta: ${d.proposta}`] : []),
  ])].join('\n'));
  return { rows: data };
}

/** Inside a herdr tab opened by --open: close it when the TUI ends. */
async function closeOwnTab(flags, env) {
  if (flags['close-tab'] && env.HERDR_TAB_ID) await run('herdr', ['tab', 'close', env.HERDR_TAB_ID], { env });
}

/** Open the TUI where the user can see it (a focused herdr tab, or an hc terminal); optionally wait. */
async function openSelect(c, cfg, flags, opts) {
  const startedAt = now();
  const cmd = [process.execPath, BIN, 'select', '--close-tab'].map(shq).join(' ');
  const backend = opts.backend ?? await selectBackend({ choice: flags.backend, config: cfg, env: c.env });
  let where;
  if (backend.name === 'herdr') {
    const tab = await backend.openTab({ root: c.root, project: projectId(c.root), label: 'harma-select', command: cmd });
    if (tab.workspaceCreated) {
      // Re-read: the TUI may already have saved choices into config.json.
      const fresh = loadConfig(c.root);
      fresh.herdr = { ...(fresh.herdr ?? {}), workspace_id: tab.workspace };
      saveConfig(c.root, fresh);
    }
    where = `tab herdr ${tab.tab} (in primo piano)`;
  } else {
    await backend.exec(['run', '--bg', '--json', '--name', 'harma-select', '--cwd', c.root, '--no-parent', '--', process.execPath, BIN, 'select']);
    where = 'terminale hc "harma-select": aprilo con  hc attach harma-select';
  }
  if (!flags.wait) {
    emit(c, flags, { opened: true, where }, () => `Selezione aperta nel ${where}. Quando l'utente salva: harma select --show`);
    return { opened: true };
  }
  if (!flags.json) c.out(`Selezione aperta nel ${where}. Attendo che l'utente salvi o esca…`);
  const timeoutMs = Number(flags.timeout ?? 900) * 1000;
  const deadline = Date.now() + timeoutMs;
  const poll = opts.pollMs ?? 1500;
  while (Date.now() < deadline) {
    const st = readJson(statePath(c.root, 'cache', 'select-status.json'));
    if (st && st.at > startedAt) {
      if (st.state !== 'saved') {
        emit(c, flags, { saved: false }, () => 'L\'utente è uscito senza salvare.');
        return { saved: false };
      }
      const fresh = loadConfig(c.root);
      const data = { saved: true, orchestrator: fresh.orchestrator, roster: fresh.roster };
      emit(c, flags, data, () => ['Scelte dell\'utente:', `orchestratore: ${describe(fresh.orchestrator)}`,
        ...Object.entries(fresh.roster ?? {}).map(([t, v]) => `${t}: ${describe(v)} (${v.source})`)].join('\n'));
      return data;
    }
    await new Promise((r) => setTimeout(r, poll));
  }
  throw new HarmaError(`Nessuna risposta dalla selezione entro ${timeoutMs / 1000}s`, { hint: 'Il tab resta aperto: riprova con harma select --show più tardi' });
}

const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

export { DEFAULT_CONFIG, taskProfile };
