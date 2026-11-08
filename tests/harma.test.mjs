import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, CODEX_MODELS_CACHE } from './helpers.mjs';
import { main, parseArgs } from '../src/cli.mjs';
import { loadCatalog } from '../src/catalog.mjs';
import { launchSpec, parseTarget } from '../src/harness.mjs';
import { rankRows, aaFamilies, refreshFromAA } from '../src/rank.mjs';
import { route } from '../src/route.mjs';
import { summarizeEntry, classify } from '../src/credits.mjs';
import { readEvents, agentsFromEvents, loadConfig } from '../src/state.mjs';
import { adviceFor } from '../src/commands.mjs';

const catalog = loadCatalog({ env: { HOME: '/nonexistent' } });
const run = (sb, args, extra) => main(args, sb.opts(extra));
const events = (sb) => readEvents(sb.project);
const agents = (sb) => agentsFromEvents(events(sb));
const THRESH = { low_remaining_pct: 20, exhausted_remaining_pct: 5, high_remaining_pct: 60 };

// ── 1. orchestrator ────────────────────────────────────────────────────────
test('init records the orchestrator and rejects an effort the model lacks', async () => {
  const sb = sandbox();
  assert.equal(await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high']), 0);
  const cfg = loadConfig(sb.project);
  assert.deepEqual([cfg.orchestrator.harness, cfg.orchestrator.model, cfg.orchestrator.effort], ['claude', 'claude-opus-5-5', 'high']);
  assert.equal(cfg.dispatch_policy, 'confirm');
  sb.clear();
  assert.equal(await run(sb, ['init', '--orchestrator', 'kimi:kimi-k3.1-pro', '--effort', 'medium']), 1);
});

test('a bare model id resolves to its only harness; unknown ids fail', () => {
  assert.deepEqual(parseTarget('gpt-6-astra', catalog), { harness: 'codex', model: 'gpt-6-astra' });
  assert.throws(() => parseTarget('no-such-model', catalog), /sconosciuto/);
});

// ── 2. inventory ───────────────────────────────────────────────────────────
test('models lists installed CLIs only, with codex models read from the machine', async () => {
  const sb = sandbox();
  sb.write('.codex/models_cache.json', CODEX_MODELS_CACHE);
  await run(sb, ['models', '--json']);
  const inv = JSON.parse(sb.output());
  const installed = inv.clis.filter((c) => c.state === 'installato').map((c) => c.harness);
  assert.deepEqual(installed.sort(), ['claude', 'codex']);
  const codex = inv.models.filter((m) => m.harness === 'codex');
  assert.deepEqual(codex.map((m) => m.model), ['gpt-6.1-sol', 'gpt-6-astra']); // hidden skipped
  assert.deepEqual(codex[0].efforts, ['low', 'high', 'max']);
  assert.match(codex[0].source, /models_cache/);
  assert.ok(inv.models.some((m) => m.harness === 'claude' && m.model === 'claude-opus-5-5' && /catalogo/.test(m.source)));
});

// ── 3. credits ─────────────────────────────────────────────────────────────
test('credits come from codexbar, without account identity, classified by threshold', async () => {
  const sb = sandbox();
  await run(sb, ['credits', '--json']);
  const text = sb.output();
  assert.doesNotMatch(text, /someone@example\.com|acct_123/);
  const rows = JSON.parse(text).rows;
  const by = Object.fromEntries(rows.map((r) => [r.harness, r]));
  assert.equal(by.claude.remaining_pct, 89);
  assert.equal(by.claude.status, 'ampio');
  assert.equal(by.codex.status, 'scarso');
  assert.match(by.codex.source, /codexbar/);
});

test('without codexbar a declared budget plus local logs gives the remaining share', async () => {
  const sb = sandbox({ bins: ['herdr', 'claude'] });
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high']);
  const cfgPath = join(sb.project, '.harma', 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.budgets = { claude: { limit: 100, currency: 'USD' } };
  (await import('node:fs')).writeFileSync(cfgPath, JSON.stringify(cfg));
  const ts = new Date().toISOString();
  sb.write('.claude/projects/p/s1.jsonl', JSON.stringify({ type: 'assistant', sessionId: 's1', timestamp: ts, message: { model: 'claude-opus-5-5', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } } }) + '\n');
  sb.clear();
  await run(sb, ['credits', '--json']);
  const row = JSON.parse(sb.output()).rows.find((r) => r.harness === 'claude');
  // opus 5.5: $4 in + $20 out per Mtok -> $24 of $100
  assert.equal(row.estimate.usd, 24);
  assert.equal(row.remaining_pct, 76);
  assert.match(row.source, /budget dichiarato/);
});

test('codexbar summaries keep the tightest window and errors stay unknown', () => {
  const s = summarizeEntry({ provider: 'x', usage: { primary: { usedPercent: 30 }, secondary: { usedPercent: 70 } } });
  assert.equal(s.remaining_pct, 30);
  assert.equal(classify(null, THRESH), 'sconosciuto');
  assert.equal(classify(3, THRESH), 'esaurito');
  const e = summarizeEntry({ provider: 'gemini', error: { message: 'boom' } });
  assert.equal(e.ok, false);
});

// ── 4. intelligence ────────────────────────────────────────────────────────
test('rank orders by AA index and leaves unmeasured efforts unknown', () => {
  const rows = rankRows(catalog, [
    { harness: 'claude', model: 'claude-opus-5-5', efforts: ['low', 'max'] },
    { harness: 'codex', model: 'not-in-catalog', efforts: ['high'] },
  ]);
  assert.equal(rows[0].effort, 'max');
  assert.ok(rows[0].index > rows[1].index);
  assert.equal(rows.at(-1).index, null);
});

test('AA refresh maps "(Max)" variants onto the family and writes the user catalog', async () => {
  const fams = aaFamilies([
    { name: 'Claude Opus 5.5 (Max)', slug: 'claude-opus-5-5-max', evaluations: { artificial_analysis_intelligence_index: 60 } },
    { name: 'Claude Opus 5.5 (Low)', slug: 'claude-opus-5-5', evaluations: { artificial_analysis_intelligence_index: 35 } },
  ]);
  assert.deepEqual(fams['claude-opus-5-5'], { max: 60, low: 35 });
  const sb = sandbox();
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [{ name: 'Claude Opus 5.5 (Max)', slug: 'claude-opus-5-5-max', evaluations: { artificial_analysis_intelligence_index: 61 } }] }) });
  const res = await refreshFromAA(catalog, { env: { ...sb.env, AA_API_KEY: 'k' }, fetchImpl });
  assert.ok(existsSync(res.dest));
  const fresh = loadCatalog({ env: sb.env });
  assert.equal(fresh.origin, 'user-refresh');
  assert.equal(fresh.models['claude-opus-5-5'].aa.index.max, 61);
  await assert.rejects(refreshFromAA(catalog, { env: sb.env }), /chiave/);
});

// ── 5. routing ─────────────────────────────────────────────────────────────
test('route: review avoids the author vendor, exhausted credits are skipped, extraction is cheapest', () => {
  const rows = rankRows(catalog, [
    { harness: 'claude', model: 'claude-opus-5-5', efforts: ['xhigh'] },
    { harness: 'codex', model: 'gpt-6.1-sol', efforts: ['low', 'max'] },
    { harness: 'kimi', model: 'kimi-k3.1-pro', efforts: ['high'] },
  ]);
  const credits = [{ harness: 'claude', status: 'ampio' }, { harness: 'codex', status: 'ok' }, { harness: 'kimi', status: 'esaurito' }];
  const rev = route('review', { rankRows: rows, credits, author: { provider: 'openai' } });
  assert.ok(rev.candidates.every((c) => c.provider !== 'openai'));
  assert.ok(rev.skipped.some((s) => /stesso vendor/.test(s.reason)));
  const dev = route('sviluppo', { rankRows: rows, credits });
  assert.ok(dev.candidates.every((c) => c.harness !== 'kimi'));
  const ext = route('estrazione', { rankRows: rows, credits });
  const costs = ext.candidates.map((c) => c.cost_per_task);
  assert.deepEqual(costs, [...costs].sort((a, b) => a - b));
  assert.equal(route('nonsense', { rankRows: rows }), null);
  assert.equal(route('planning', { rankRows: rows, credits }).profile.type, 'pianificazione');
});

test('launch spec passes model and effort the way each CLI expects', () => {
  const c = launchSpec({ harness: 'claude', model: 'claude-opus-5-5', effort: 'high' }, catalog);
  assert.deepEqual(c.argv.slice(0, 5), ['claude', '--model', 'claude-opus-5-5', '--effort', 'high']);
  assert.equal(c.argv[5], '--session-id');
  assert.match(c.sessionId, /^[0-9a-f-]{36}$/);
  const x = launchSpec({ harness: 'codex', model: 'gpt-6-astra', effort: 'xhigh' }, catalog);
  assert.deepEqual(x.argv, ['codex', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort="xhigh"']);
  const k = launchSpec({ harness: 'kimi', model: 'kimi-k3.1-pro', effort: 'max' }, catalog);
  assert.deepEqual(k.env, { KIMI_MODEL_THINKING_EFFORT: 'max' });
  assert.throws(() => launchSpec({ harness: 'codex', model: 'gpt-6-astra', effort: 'bogus' }, catalog), /non supportato/);
});

// ── 5b. dispatch policy ────────────────────────────────────────────────────
test('dispatch without consent starts nothing and exits 3', async () => {
  const sb = sandbox();
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high']);
  const before = events(sb).length;
  assert.equal(await run(sb, ['dispatch', '--name', 'builder', '--model', 'codex:gpt-6-astra', '--effort', 'high', '--prompt', 'x']), 3);
  assert.equal(events(sb).length, before);
  assert.equal(sb.state().herdr, undefined); // herdr never called
});

test('dispatch --yes on herdr opens one tab per agent, records the session and sends the task', async () => {
  const sb = sandbox();
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high', '--backend', 'herdr']);
  assert.equal(await run(sb, ['dispatch', '--name', 'planner', '--model', 'claude:claude-opus-5-5', '--effort', 'xhigh', '--prompt', 'plan it', '--yes']), 0);
  assert.equal(await run(sb, ['dispatch', '--name', 'builder', '--model', 'codex:gpt-6-astra', '--effort', 'high', '--yes']), 0);
  const [planner, builder] = agents(sb);
  assert.match(planner.session_id, /^[0-9a-f-]{36}$/);
  assert.equal(builder.session_id, 'codex-2'); // read back from herdr agent list
  assert.notEqual(planner.target.tab, builder.target.tab);
  const h = sb.state().herdr;
  assert.equal(h.agents.find((a) => a.name === 'planner').last_prompt, 'plan it');
  assert.deepEqual(h.agents.find((a) => a.name === 'builder').args, ['-m', 'gpt-6-astra', '-c', 'model_reasoning_effort="high"']);
  assert.equal(loadConfig(sb.project).herdr.workspace_id, 'w1');
  assert.equal(await run(sb, ['dispatch', '--name', 'planner', '--model', 'claude:claude-opus-5-5', '--yes']), 1); // name in use
});

test('auto-within-budget dispatches only when the provider has credit', async () => {
  const sb = sandbox();
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high', '--policy', 'auto-within-budget', '--backend', 'herdr']);
  assert.equal(await run(sb, ['dispatch', '--name', 'a1', '--model', 'claude:claude-sonnet-5-5', '--effort', 'high']), 0); // claude ampio
  assert.equal(await run(sb, ['dispatch', '--name', 'a2', '--model', 'codex:gpt-6-astra', '--effort', 'high']), 3); // codex scarso
});

// ── 6. monitoring ──────────────────────────────────────────────────────────
test('status shows each open agent with its live state', async () => {
  const sb = sandbox();
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high', '--backend', 'herdr']);
  await run(sb, ['dispatch', '--name', 'builder', '--model', 'codex:gpt-6-astra', '--effort', 'high', '--prompt', 'go', '--yes'], { });
  sb.clear();
  await run(sb, ['status', '--json']);
  const st = JSON.parse(sb.output());
  assert.equal(st.agents.length, 1);
  assert.equal(st.agents[0].agente, 'builder');
  assert.equal(st.agents[0].stato, 'done');
});

// ── 7. costs ───────────────────────────────────────────────────────────────
test('costs estimates per agent from its session log and advises on delegation', async () => {
  const sb = sandbox();
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high', '--backend', 'herdr']);
  await run(sb, ['dispatch', '--name', 'planner', '--model', 'claude:claude-opus-5-5', '--effort', 'high', '--yes']);
  const sid = agents(sb)[0].session_id;
  sb.write(`.claude/projects/p/${sid}.jsonl`, JSON.stringify({ type: 'assistant', sessionId: sid, timestamp: new Date().toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: 500_000, output_tokens: 100_000 } } }) + '\n');
  sb.clear();
  await run(sb, ['costs', '--json']);
  const c = JSON.parse(sb.output());
  assert.equal(c.agents[0].stima, '$4'); // 0.5M × $4 + 0.1M × $20
  assert.ok(c.advice.some((a) => /codex: crediti scarsi/.test(a)));
  assert.ok(c.advice.some((a) => /claude: margine ampio/.test(a)));
  const adv = adviceFor([{ harness: 'kimi', status: 'esaurito', windows: [{ resets_at: '2026-11-09' }] }, { harness: 'claude', status: 'ampio', remaining_pct: 90 }]);
  assert.match(adv[0], /fino a 2026-11-09.*sposta il lavoro su claude/);
});

// ── 8. cleanup and resume ──────────────────────────────────────────────────
test('cleanup saves session ids, closes finished tabs, keeps working agents', async () => {
  const sb = sandbox();
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high', '--backend', 'herdr']);
  await run(sb, ['dispatch', '--name', 'done1', '--model', 'claude:claude-sonnet-5-5', '--effort', 'high', '--prompt', 'x', '--yes']);
  await run(sb, ['dispatch', '--name', 'busy1', '--model', 'codex:gpt-6-astra', '--effort', 'high', '--prompt', 'y', '--yes'], { env: { ...sb.env, FAKE_AFTER_PROMPT: 'working' } });
  sb.clear();
  await run(sb, ['cleanup', '--dry-run', '--json']);
  assert.equal(sb.state().herdr.agents.length, 2); // dry run closed nothing
  sb.clear();
  await run(sb, ['cleanup', '--json']);
  const rep = Object.fromEntries(JSON.parse(sb.output()).report.map((r) => [r.agente, r]));
  assert.equal(rep.done1.azione, 'chiuso');
  assert.equal(rep.busy1.azione, 'tenuto');
  assert.deepEqual(sb.state().herdr.agents.map((a) => a.name), ['busy1']);
  const done1 = agents(sb).find((a) => a.name === 'done1');
  assert.equal(done1.state, 'closed');
  assert.ok(done1.session_id);
});

test('cleanup --workspace closes harma\'s own workspace only when no agent is open', async () => {
  const sb = sandbox();
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high', '--backend', 'herdr']);
  await run(sb, ['dispatch', '--name', 'busy1', '--model', 'codex:gpt-6-astra', '--effort', 'high', '--prompt', 'y', '--yes'], { env: { ...sb.env, FAKE_AFTER_PROMPT: 'working' } });
  await run(sb, ['cleanup', '--workspace']);
  assert.equal(sb.state().herdr.closedWorkspaces, undefined);
  await run(sb, ['cleanup', '--workspace', '--force']);
  assert.deepEqual(sb.state().herdr.closedWorkspaces, ['w1']);
  assert.equal(loadConfig(sb.project).herdr.workspace_id, undefined);
});

test('resume rebuilds the native command with model and effort, and reopens on consent', async () => {
  const sb = sandbox();
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high', '--backend', 'herdr']);
  await run(sb, ['dispatch', '--name', 'planner', '--model', 'claude:claude-opus-5-5', '--effort', 'xhigh', '--prompt', 'x', '--yes']);
  const sid = agents(sb)[0].session_id;
  await run(sb, ['cleanup']);
  sb.clear();
  assert.equal(await run(sb, ['resume', 'planner', '--json']), 3);
  assert.deepEqual(JSON.parse(sb.output()).argv, ['claude', '--resume', sid, '--model', 'claude-opus-5-5', '--effort', 'xhigh']);
  assert.equal(await run(sb, ['resume', 'planner', '--yes']), 0);
  const live = sb.state().herdr.agents.find((a) => a.name === 'planner');
  assert.deepEqual(live.args, ['--resume', sid, '--model', 'claude-opus-5-5', '--effort', 'xhigh']);
  assert.equal(agents(sb)[0].state, 'open');
});

test('codex resume keeps -m and the effort (regression: -m was dropped and the model became a prompt)', async () => {
  const sb = sandbox();
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high', '--backend', 'herdr']);
  await run(sb, ['dispatch', '--name', 'builder', '--model', 'codex:gpt-6.1-sol', '--effort', 'low', '--prompt', 'x', '--yes']);
  await run(sb, ['cleanup']);
  sb.clear();
  await run(sb, ['resume', 'builder', '--print-only', '--json', '--yes']);
  assert.deepEqual(JSON.parse(sb.output()).argv, ['codex', 'resume', 'codex-1', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="low"']);
  assert.equal(await run(sb, ['resume', 'builder', '--yes']), 0);
  const live = sb.state().herdr.agents.find((a) => a.name === 'builder');
  assert.deepEqual(live.args, ['resume', 'codex-1', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="low"']);
});

test('hc backend: labelled terminals, env-based effort, kill and rm on cleanup', async () => {
  const sb = sandbox({ bins: ['hc', 'codexbar', 'claude', 'kimi'] });
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high', '--backend', 'hc']);
  assert.equal(await run(sb, ['dispatch', '--name', 'clerk', '--model', 'claude:claude-haiku-5-5', '--effort', 'low', '--prompt', 'x', '--yes']), 0);
  assert.equal(await run(sb, ['dispatch', '--name', 'kimi1', '--model', 'kimi:kimi-k3.1-pro', '--effort', 'max', '--yes']), 0);
  const [term, kimi] = sb.state().hc.terms;
  assert.equal(term.labels['harma.agent'], 'clerk');
  assert.ok(term.labels['harma.project']);
  assert.deepEqual(kimi.argv.slice(0, 3), ['env', 'KIMI_MODEL_THINKING_EFFORT=max', 'kimi']);
  assert.ok(sb.state().hc.calls.some((c) => c[0] === 'run' && c.includes('--outlive-parent')));
  sb.clear();
  await run(sb, ['cleanup', '--agent', 'clerk', '--json']);
  assert.equal(JSON.parse(sb.output()).report[0].azione, 'chiuso');
  assert.deepEqual(sb.state().hc.terms.map((t) => t.name), ['kimi1']);
});

test('an agent blocked at startup stays recorded, exit 4, task not marked as sent', async () => {
  const sb = sandbox();
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high', '--backend', 'herdr']);
  const code = await run(sb, ['dispatch', '--name', 'stuck', '--model', 'claude:claude-haiku-5-5', '--effort', 'low', '--prompt', 'x', '--yes'], { env: { ...sb.env, FAKE_PROMPT_BLOCKED: '1' } });
  assert.equal(code, 4);
  assert.match(sb.output(), /BLOCCATO/);
  const types = events(sb).filter((e) => e.agent === 'stuck').map((e) => e.type);
  assert.deepEqual(types, ['started', 'blocked']);
  assert.equal(agents(sb)[0].state, 'open');
});

test('dispatch refuses a CLI that is not installed', async () => {
  const sb = sandbox({ bins: ['herdr', 'claude'] });
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high']);
  assert.equal(await main(['dispatch', '--name', 'x', '--model', 'codex:gpt-6-astra', '--yes'], { ...sb.opts(), err: () => {} }), 1);
});

// ── install / doctor / cli ─────────────────────────────────────────────────
test('install copies the skill for both hosts and uninstall removes only its own copy', async () => {
  const sb = sandbox();
  await run(sb, ['install']);
  const claude = join(sb.home, '.claude/skills/harma/SKILL.md');
  const codex = join(sb.home, '.codex/skills/harma/SKILL.md');
  assert.ok(existsSync(claude) && existsSync(codex));
  assert.match(readFileSync(claude, 'utf8'), /^---\nname: harma/);
  await run(sb, ['uninstall', '--target', 'codex']);
  assert.ok(existsSync(claude) && !existsSync(codex));
});

test('doctor passes with a backend and an agent CLI, fails without', async () => {
  assert.equal(await run(sandbox(), ['doctor']), 0);
  assert.equal(await run(sandbox({ bins: ['codexbar'] }), ['doctor']), 1);
});

test('argument parsing and unknown commands', async () => {
  assert.deepEqual(parseArgs(['route', 'review', '--author=codex:x', '--json']), { _: ['route', 'review'], author: 'codex:x', json: true });
  const sb = sandbox();
  assert.equal(await main(['bogus'], { ...sb.opts(), err: () => {} }), 2);
});
