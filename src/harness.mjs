// How harma drives each agent CLI ("harness"): launch argv for a model and an
// effort, which CodexBar provider meters it, which herdr agent kind it is,
// how its native session id is obtained and how a session is resumed.
import { randomUUID } from 'node:crypto';
import { harnesses } from './catalog.mjs';
import { HarmaError } from './util.mjs';

// Facts not in the model catalog. Session/resume syntax verified with
// `claude --help` (2.1.319) and `codex resume --help` (codex-cli 0.167.0).
export const HARNESS_META = {
  claude: { herdrKind: 'claude', codexbar: 'claude', logs: 'claude', presetSession: '--session-id', resume: (id) => ['claude', '--resume', id] },
  codex: { herdrKind: 'codex', codexbar: 'codex', logs: 'codex', resume: (id) => ['codex', 'resume', id] },
  agy: { herdrKind: 'agy', codexbar: 'antigravity' },
  kimi: { herdrKind: 'kimi', codexbar: 'kimi' },
  grok: { herdrKind: 'grok', codexbar: 'grok' },
  muse: { herdrKind: 'muse', codexbar: 'muse', interactiveBinary: 'muse' },
  qwen: { herdrKind: 'qwen', codexbar: 'qwencloud' },
  mmx: { codexbar: 'minimax' },
  vibe: { codexbar: 'mistral' },
  // Claude Code pointed at another provider: needs that provider's env set up.
  'claude-moonshot': { codexbar: 'moonshot', variantOf: 'claude' },
  'claude-zai': { codexbar: 'zai', variantOf: 'claude' },
};

export function meta(name) {
  return HARNESS_META[name] ?? {};
}

/** Parse "codex:gpt-6-astra" or a bare model id (harness inferred from the catalog). */
export function parseTarget(spec, catalog) {
  if (!spec) throw new HarmaError('Manca il modello: usa <harness>:<model>, es. codex:gpt-6-astra');
  const hs = harnesses(catalog);
  if (spec.includes(':')) {
    const [harness, model] = spec.split(/:(.*)/s);
    if (!hs[harness]) throw new HarmaError(`Harness sconosciuto: ${harness}`, { hint: `Noti: ${Object.keys(hs).join(', ')}` });
    return { harness, model };
  }
  const owners = Object.entries(hs).filter(([n, h]) => h.models?.[spec] && !meta(n).variantOf).map(([n]) => n);
  if (owners.length === 1) return { harness: owners[0], model: spec };
  if (owners.length > 1) throw new HarmaError(`Il modello ${spec} gira su più CLI: ${owners.join(', ')}`, { hint: 'Specifica <harness>:<model>' });
  throw new HarmaError(`Modello sconosciuto: ${spec}`, { hint: 'Vedi `harma models`' });
}

export function effortValues(harness, model, catalog) {
  const h = harnesses(catalog)[harness];
  return h?.models?.[model]?.effort_values ?? h?.effort_values ?? catalog.models?.[model]?.efforts ?? [];
}

/**
 * The argv and env that start <harness> on <model> at <effort>.
 * Returns {argv, env, effortApplied, sessionId, notes}.
 */
export function launchSpec({ harness, model, effort }, catalog, { sessionId } = {}) {
  const h = harnesses(catalog)[harness];
  if (!h) throw new HarmaError(`Harness sconosciuto: ${harness}`);
  const m = meta(harness);
  const hm = h.models?.[model];
  if (!hm) throw new HarmaError(`${harness} non serve il modello ${model}`, { hint: `Modelli: ${Object.keys(h.models ?? {}).join(', ')}` });

  const allowed = effortValues(harness, model, catalog);
  if (effort && allowed.length && !allowed.includes(effort)) {
    throw new HarmaError(`Effort ${effort} non supportato da ${harness}:${model}`, { hint: `Valori: ${allowed.join(', ')}` });
  }

  const binary = m.interactiveBinary ?? h.binary.split(' ')[0];
  const name = (effort && hm.names?.[effort]) || hm.name || model;
  const argv = [binary];
  const env = {};
  const notes = [];
  if (h.model_flag) argv.push(h.model_flag, name);
  else notes.push('questa CLI non ha un flag per il modello: usa quello configurato');

  let effortApplied = false;
  if (effort && h.effort_via) {
    const [kind, key] = h.effort_via.split(/:(.*)/s);
    if (kind === 'flag') { argv.push(key, effort); effortApplied = true; }
    else if (kind === 'config') { argv.push('-c', `${key}="${effort}"`); effortApplied = true; }
    else if (kind === 'env') { env[key] = effort; effortApplied = true; }
  }
  if (effort && !effortApplied) notes.push(`effort ${effort} non impostabile per ${harness}: resta il default della CLI`);

  let sid = null;
  if (m.presetSession) {
    sid = sessionId ?? randomUUID();
    argv.push(m.presetSession, sid);
  }
  return { argv, env, effortApplied, sessionId: sid, notes, billing: h.billing };
}

export function resumeArgv(harness, sessionId) {
  const m = meta(harness);
  if (!sessionId) return null;
  return m.resume ? m.resume(sessionId) : null;
}
