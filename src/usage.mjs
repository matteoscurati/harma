// Token usage from the CLIs' own session logs, and an API-list-price estimate.
//   Claude Code: ~/.claude/projects/<slug>/<session-id>.jsonl, assistant
//                entries carry message.usage and message.model.
//   Codex:       ~/.codex/sessions/YYYY/MM/DD/rollout-*-<session-id>.jsonl,
//                session_meta.payload.id, turn_context.payload.model/effort,
//                event_msg token_count payload.info.total_token_usage (cumulative).
// For subscriptions this is what the tokens would cost at API list price,
// not what is billed.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readJsonl } from './util.mjs';

// Multipliers on the input price. Anthropic publishes these (cache write
// 1.25x for 5 min, 2x for 1 h, read 0.1x). For OpenAI the cached-input ratio
// is not in the catalog: 0.1x is an assumption and is reported as one.
export const PRICE_RULES = {
  anthropic: { cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, assumed: false },
  openai: { cacheRead: 0.1, assumed: true },
};

function files(dir, { suffix = '.jsonl', sinceMs = 0, match } = {}) {
  if (!existsSync(dir)) return [];
  let names;
  try { names = readdirSync(dir, { recursive: true }); } catch { return []; }
  const out = [];
  for (const n of names) {
    const name = String(n);
    if (!name.endsWith(suffix)) continue;
    if (match && !match(name)) continue;
    const p = join(dir, name);
    try { if (statSync(p).mtimeMs >= sinceMs) out.push(p); } catch { /* gone */ }
  }
  return out;
}

const home = (env) => env.HOME || homedir();

export function claudeUsage({ env = process.env, sessionIds, sinceMs = 0 } = {}) {
  const dir = join(home(env), '.claude', 'projects');
  const ids = sessionIds ? new Set(sessionIds) : null;
  const paths = files(dir, { sinceMs, match: ids ? (n) => ids.has(n.split('/').pop().replace(/\.jsonl$/, '')) : undefined });
  const bySession = {};
  for (const p of paths) {
    for (const e of readJsonl(p)) {
      const u = e?.message?.usage;
      if (e.type !== 'assistant' || !u) continue;
      if (Date.parse(e.timestamp ?? 0) < sinceMs) continue;
      const sid = e.sessionId ?? p.split('/').pop().replace(/\.jsonl$/, '');
      if (ids && !ids.has(sid)) continue;
      const s = (bySession[sid] ??= { harness: 'claude', session_id: sid, model: null, cwd: e.cwd ?? null, input: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, output: 0 });
      s.model = e.message.model ?? s.model;
      s.input += u.input_tokens ?? 0;
      const cc = u.cache_creation ?? {};
      const w1h = cc.ephemeral_1h_input_tokens ?? 0;
      s.cache_write_1h += w1h;
      s.cache_write_5m += (u.cache_creation_input_tokens ?? 0) - w1h;
      s.cache_read += u.cache_read_input_tokens ?? 0;
      s.output += u.output_tokens ?? 0;
    }
  }
  return Object.values(bySession);
}

export function codexUsage({ env = process.env, sessionIds, sinceMs = 0 } = {}) {
  const dir = join(home(env), '.codex', 'sessions');
  const ids = sessionIds ? new Set(sessionIds) : null;
  const paths = files(dir, { sinceMs, match: (n) => /rollout-.*\.jsonl$/.test(n) && (!ids || [...ids].some((id) => n.endsWith(`${id}.jsonl`))) });
  const out = [];
  for (const p of paths) {
    let s = null;
    for (const e of readJsonl(p)) {
      const pl = e.payload ?? {};
      if (e.type === 'session_meta') {
        s = { harness: 'codex', session_id: pl.id, model: null, effort: null, cwd: pl.cwd ?? null, started_at: pl.timestamp ?? e.timestamp, input: 0, cache_read: 0, output: 0, reasoning: 0 };
      } else if (s && e.type === 'turn_context') {
        s.model = pl.model ?? s.model;
        s.effort = pl.effort ?? s.effort;
      } else if (s && pl.type === 'token_count' && pl.info?.total_token_usage) {
        const t = pl.info.total_token_usage; // cumulative: last one wins
        s.input = (t.input_tokens ?? 0) - (t.cached_input_tokens ?? 0);
        s.cache_read = t.cached_input_tokens ?? 0;
        s.output = t.output_tokens ?? 0;
        s.reasoning = t.reasoning_output_tokens ?? 0;
      }
    }
    if (s && (!ids || ids.has(s.session_id))) out.push(s);
  }
  return out;
}

/** Codex session started in <cwd> at or after <sinceMs> (the first one). */
export function findCodexSession({ env = process.env, cwd, sinceMs }) {
  const sessions = codexUsage({ env, sinceMs: sinceMs - 60_000 })
    .filter((s) => s.cwd === cwd && Date.parse(s.started_at ?? 0) >= sinceMs - 5_000)
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  return sessions[0]?.session_id ?? null;
}

/** Estimated USD at API list price; null when the model has no price. */
export function estimateCost(session, catalog) {
  const model = catalog.models?.[session.model] ?? catalog.models?.[normalizeModel(session.model, catalog)];
  const price = model?.pricing;
  if (!price) return { usd: null, note: `prezzo sconosciuto per ${session.model ?? 'modello ignoto'}` };
  const rules = PRICE_RULES[model.provider] ?? { cacheRead: 1, assumed: true };
  const inP = price.input / 1e6;
  const outP = price.output / 1e6;
  let usd = (session.input ?? 0) * inP + (session.output ?? 0) * outP + (session.cache_read ?? 0) * inP * (rules.cacheRead ?? 1);
  usd += (session.cache_write_5m ?? 0) * inP * (rules.cacheWrite5m ?? 1);
  usd += (session.cache_write_1h ?? 0) * inP * (rules.cacheWrite1h ?? 1);
  return {
    usd: Math.round(usd * 100) / 100,
    note: `listino ${price.source} ${price.verified_on}${rules.assumed ? '; input in cache a 0.1× (ipotesi)' : ''}`,
  };
}

function normalizeModel(name, catalog) {
  if (!name) return null;
  // "claude-opus-5-5-20261001" or "claude-opus-5-5[1m]" -> catalog id
  return Object.keys(catalog.models ?? {}).find((id) => name.startsWith(id)) ?? null;
}

export function usageFor(harness, opts) {
  if (harness === 'claude') return claudeUsage(opts);
  if (harness === 'codex') return codexUsage(opts);
  return [];
}
