// Project state lives in <project>/.harma/:
//   config.json   orchestrator, dispatch policy, budgets, thresholds, backend
//   agents.jsonl  append-only lifecycle events (started, session, closed, ...)
//   cache/*.json  inventory, credits, rank — each with fetchedAt and source
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { readJson, readJsonl, now, HarmaError } from './util.mjs';

export const STATE_DIR = '.harma';

export const DEFAULT_CONFIG = {
  schema_version: 1,
  orchestrator: null, // {harness, model, effort}
  backend: 'auto', // auto | herdr | hc
  dispatch_policy: 'confirm', // confirm | auto-within-budget
  budgets: {}, // provider -> {limit, currency, period}
  thresholds: {
    low_remaining_pct: 20, // under this, delegate less to the provider
    exhausted_remaining_pct: 5, // under this, do not route to it
    high_remaining_pct: 60, // over this, the provider can take more work
  },
  routing: {}, // task type -> overrides, see route.mjs
};

/** Find the project root: the nearest ancestor holding .harma, else cwd. */
export function projectRoot(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, STATE_DIR, 'config.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(start);
    dir = up;
  }
}

export function statePath(root, ...parts) {
  return join(root, STATE_DIR, ...parts);
}

export function loadConfig(root, { required = false } = {}) {
  const cfg = readJson(statePath(root, 'config.json'));
  if (!cfg && required) {
    throw new HarmaError('Nessun progetto harma qui.', { hint: 'Esegui prima: harma init --orchestrator <harness>:<model> --effort <level>' });
  }
  return mergeDeep(structuredClone(DEFAULT_CONFIG), cfg ?? {});
}

export function saveConfig(root, cfg) {
  mkdirSync(statePath(root), { recursive: true });
  writeFileSync(statePath(root, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
  ensureGitignore(root);
}

function ensureGitignore(root) {
  const p = statePath(root, '.gitignore');
  if (!existsSync(p)) writeFileSync(p, 'cache/\n');
}

export function appendEvent(root, event) {
  mkdirSync(statePath(root), { recursive: true });
  const rec = { at: now(), ...event };
  appendFileSync(statePath(root, 'agents.jsonl'), JSON.stringify(rec) + '\n');
  return rec;
}

export function readEvents(root) {
  return readJsonl(statePath(root, 'agents.jsonl'));
}

/** Fold the event log into one record per agent name. */
export function agentsFromEvents(events) {
  const agents = new Map();
  for (const e of events) {
    if (!e.agent) continue;
    const cur = agents.get(e.agent) ?? { name: e.agent, history: [] };
    cur.history.push(e.type);
    switch (e.type) {
      case 'started':
        Object.assign(cur, {
          harness: e.harness, model: e.model, effort: e.effort, task_type: e.task_type,
          backend: e.backend, target: e.target, cwd: e.cwd, started_at: e.at,
          session_id: e.session_id ?? cur.session_id ?? null, closed_at: null, state: 'open',
        });
        break;
      case 'session':
        cur.session_id = e.session_id;
        cur.session_source = e.source;
        break;
      case 'closed':
        cur.closed_at = e.at;
        cur.state = 'closed';
        cur.result = e.result ?? cur.result;
        break;
      case 'resumed':
        cur.state = 'open';
        cur.closed_at = null;
        cur.target = e.target ?? cur.target;
        cur.backend = e.backend ?? cur.backend;
        break;
      default:
        break;
    }
    agents.set(e.agent, cur);
  }
  return [...agents.values()];
}

export function writeCache(root, name, data) {
  mkdirSync(statePath(root, 'cache'), { recursive: true });
  writeFileSync(statePath(root, 'cache', `${name}.json`), JSON.stringify(data, null, 2) + '\n');
}

export function readCache(root, name) {
  return readJson(statePath(root, 'cache', `${name}.json`));
}

export function hasProject(root) {
  return existsSync(statePath(root, 'config.json'));
}

function mergeDeep(base, extra) {
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      base[k] = mergeDeep(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

export function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}
