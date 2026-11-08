// Credits and limits per provider.
// Primary source: CodexBar (`codexbar usage --format json --provider all`).
// Fallbacks, in order: a budget the user declared in .harma/config.json,
// then the local-log estimate (claude, codex). Otherwise "sconosciuto".
import { run, which, parseJson, stripIdentity, now } from './util.mjs';
import { HARNESS_META } from './harness.mjs';
import { usageFor, estimateCost } from './usage.mjs';

export async function readCodexbar({ env = process.env, bin = 'codexbar', timeoutSec = 120 } = {}) {
  if (!which(bin, env)) return { ok: false, detail: 'codexbar non installato (https://github.com/steipete/CodexBar)', entries: [] };
  const res = await run(bin, ['usage', '--format', 'json', '--provider', 'all', '--no-color'], { env, timeout: timeoutSec * 1000 });
  const data = parseJson(res.stdout);
  if (!Array.isArray(data)) {
    return { ok: false, detail: `codexbar non ha restituito JSON (exit ${res.code})`, entries: [] };
  }
  return { ok: true, entries: data.map(stripIdentity) };
}

/** Collapse one CodexBar entry to the figures harma uses. */
export function summarizeEntry(e) {
  const u = e.usage ?? {};
  const windows = ['primary', 'secondary', 'tertiary']
    .map((k) => (u[k] && typeof u[k].usedPercent === 'number' ? { window: k, used_pct: round(u[k].usedPercent), resets_at: u[k].resetsAt ?? null, minutes: u[k].windowMinutes ?? null } : null))
    .filter(Boolean);
  const maxUsed = windows.length ? Math.max(...windows.map((w) => w.used_pct)) : null;
  const pc = u.providerCost;
  const cost = pc && (pc.used !== undefined || pc.limit !== undefined) ? {
    used: pc.used ?? null, limit: pc.limit ?? null, currency: pc.currencyCode ?? null, period: pc.period ?? null,
  } : null;
  let remaining = maxUsed === null ? null : round(100 - maxUsed);
  if (remaining === null && cost?.limit) remaining = round(100 - (100 * (cost.used ?? 0)) / cost.limit);
  return {
    provider: e.provider,
    ok: !e.error && !!e.usage,
    error: e.error ? (e.error.message ?? String(e.error)).slice(0, 160) : null,
    source: `codexbar:${e.source ?? '?'}`,
    updated_at: u.updatedAt ?? null,
    windows,
    remaining_pct: remaining,
    credits_remaining: e.credits?.remaining ?? null,
    cost,
  };
}

export function classify(remaining, thresholds) {
  if (remaining === null || remaining === undefined) return 'sconosciuto';
  if (remaining < thresholds.exhausted_remaining_pct) return 'esaurito';
  if (remaining < thresholds.low_remaining_pct) return 'scarso';
  if (remaining >= thresholds.high_remaining_pct) return 'ampio';
  return 'ok';
}

/**
 * One row per harness: its provider's credit state with source and time.
 * `harnessNames` are the harnesses to report (normally the installed ones).
 */
export async function collectCredits({ harnessNames, config, catalog, env = process.env, codexbar, windowDays = 7 }) {
  const cb = codexbar ?? await readCodexbar({ env });
  const byProvider = new Map(cb.entries.map((e) => [e.provider, summarizeEntry(e)]));
  const sinceMs = Date.now() - windowDays * 86_400_000;
  const rows = [];
  for (const h of harnessNames) {
    const provider = HARNESS_META[h]?.codexbar ?? null;
    const s = provider ? byProvider.get(provider) : null;
    const row = {
      harness: h, provider, fetched_at: now(),
      source: null, remaining_pct: null, status: 'sconosciuto', detail: null, windows: [], cost: null, estimate: null,
    };
    if (s?.ok) {
      Object.assign(row, { source: s.source, remaining_pct: s.remaining_pct, windows: s.windows, cost: s.cost, credits_remaining: s.credits_remaining, updated_at: s.updated_at });
    } else if (s?.error) {
      row.detail = `codexbar: ${s.error}`;
    } else if (!cb.ok) {
      row.detail = cb.detail;
    } else if (provider) {
      row.detail = `codexbar non riporta ${provider} (attivalo nell'app CodexBar)`;
    }
    const spent = HARNESS_META[h]?.logs ? estimateSpend(h, catalog, env, sinceMs) : null;
    if (spent !== null) {
      row.estimate = { usd: spent, window_days: windowDays, note: 'stima a listino API dai log locali; non è l\'addebito di un abbonamento' };
    }
    const budget = provider ? config.budgets?.[provider] : null;
    if (row.remaining_pct === null && budget?.limit && spent !== null) {
      row.remaining_pct = round(100 - (100 * spent) / budget.limit);
      row.source = `budget dichiarato (${budget.limit} ${budget.currency ?? 'USD'}) − stima log locali ${windowDays}g`;
    }
    row.status = classify(row.remaining_pct, config.thresholds);
    rows.push(row);
  }
  return { fetched_at: now(), codexbar: cb.ok ? 'ok' : cb.detail, rows };
}

function estimateSpend(harness, catalog, env, sinceMs) {
  const sessions = usageFor(harness, { env, sinceMs });
  if (!sessions.length) return null;
  let total = 0;
  for (const s of sessions) total += estimateCost(s, catalog).usd ?? 0;
  return Math.round(total * 100) / 100;
}

function round(n) { return Math.round(n * 10) / 10; }
