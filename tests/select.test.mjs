import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { main } from '../src/cli.mjs';
import { initState, reduce, render, modelList } from '../src/tui.mjs';
import { loadConfig, readEvents } from '../src/state.mjs';

const run = (sb, args, extra) => main(args, sb.opts(extra));
const press = (s, keys) => keys.reduce(reduce, s);

const MODELS = [
  { harness: 'claude', model: 'claude-opus-5-5', provider: 'anthropic', best: { effort: 'max', index: 58.4 }, credit: 'ampio', remaining: 89,
    efforts: [{ effort: 'low', index: 34.5, cost: 0.98 }, { effort: 'high', index: 51.7, cost: 3.46 }, { effort: 'max', index: 58.4, cost: 10.04 }] },
  { harness: 'codex', model: 'gpt-6.1-sol', provider: 'openai', best: { effort: 'max', index: 54.5 }, credit: 'ok', remaining: 25,
    efforts: [{ effort: 'low', index: 34.5, cost: 0.16 }, { effort: 'max', index: 54.5, cost: 1.27 }] },
];
const ROWS = () => [
  { type: 'orchestratore', label: 'orch', proposal: { harness: 'claude', model: 'claude-opus-5-5', effort: 'high' }, choice: { harness: 'claude', model: 'claude-opus-5-5', effort: 'high', source: 'utente' }, original: { harness: 'claude', model: 'claude-opus-5-5', effort: 'high' } },
  { type: 'sviluppo', label: 'dev', proposal: { harness: 'codex', model: 'gpt-6.1-sol', effort: 'max', why: 'indice 54.5' }, choice: null, original: null },
  { type: 'review', label: 'rev', proposal: { harness: 'claude', model: 'claude-opus-5-5', effort: 'high' }, choice: null, original: null },
];

test('TUI: accept one proposal, pick another model and effort, save', () => {
  let s = initState({ rows: ROWS(), models: MODELS });
  s = press(s, ['down', 'a']); // sviluppo: accept proposal
  assert.equal(s.rows[1].choice.source, 'proposta');
  s = press(s, ['down', 'return']); // review → model list (starts on the proposed model)
  assert.equal(s.view, 'model');
  assert.equal(modelList(s)[s.modelCursor].model, 'claude-opus-5-5');
  s = press(s, ['down', 'return']); // codex:gpt-6.1-sol → effort list
  assert.equal(s.view, 'effort');
  assert.equal(s.editModel.efforts[s.effortCursor].effort, 'max'); // starts on its best effort
  s = press(s, ['up', 'return']); // low
  assert.deepEqual(s.rows[2].choice, { harness: 'codex', model: 'gpt-6.1-sol', effort: 'low', source: 'utente' });
  assert.equal(s.view, 'list');
  s = reduce(s, 's');
  assert.equal(s.done, 'save');
});

test('TUI: "no model" for a job, A accepts all, x clears, quit asks when dirty', () => {
  let s = initState({ rows: ROWS(), models: MODELS });
  s = press(s, ['down', 'return']);
  s = press(s, ['up', 'up', 'up', 'return']); // top of list = "nessun modello"
  assert.deepEqual(s.rows[1].choice, { none: true, source: 'utente' });
  s = reduce(s, 'A');
  assert.ok(s.rows.every((r) => r.choice?.source === 'proposta'));
  assert.equal(s.cursor, 1);
  s = reduce(s, 'x');
  assert.equal(s.rows[1].choice, null);
  s = press(s, ['up', 'x']); // orchestrator cannot be cleared
  assert.ok(s.rows[0].choice);
  s = reduce(s, 'q');
  assert.equal(s.view, 'confirmQuit');
  assert.equal(reduce(s, 'q').done, 'cancel');
  assert.equal(reduce(s, 's').done, 'save');
  assert.equal(reduce(s, 'escape').view, 'list');
  // the orchestrator row has no "nessun modello" option
  assert.ok(modelList({ ...s, cursor: 0 }).every((m) => !m.none));
});

test('TUI: quitting with no changes ends at once; esc walks back one view', () => {
  let s = initState({ rows: ROWS(), models: MODELS });
  s = press(s, ['down', 'return', 'return']);
  assert.equal(s.view, 'effort');
  s = reduce(s, 'escape');
  assert.equal(s.view, 'model');
  s = reduce(s, 'escape');
  assert.equal(s.view, 'list');
  assert.equal(reduce(s, 'q').done, 'cancel');
});

test('TUI render shows proposals, choices and the effort table', () => {
  let s = initState({ rows: ROWS(), models: MODELS, title: 'harma' });
  s = press(s, ['down', 'a']);
  const list = render(s, { color: false, width: 120 });
  assert.match(list, /sviluppo\s+codex:gpt-6\.1-sol @ max\s+codex:gpt-6\.1-sol @ max  ✓ proposta/);
  assert.match(list, /review .*— da decidere/);
  s = press(s, ['return', 'return']);
  const eff = render(s, { color: false });
  assert.match(eff, /max\s+indice 54\.5\s+costo\/task \$1\.27 ← proposta/);
});

test('select --accept and --set save the roster; dispatch then uses the user choice', async () => {
  const sb = sandbox();
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high', '--backend', 'herdr']);
  assert.equal(await run(sb, ['select', '--accept', '--json']), 0);
  let cfg = loadConfig(sb.project);
  assert.equal(cfg.roster.sviluppo.source, 'proposta');
  assert.equal(await run(sb, ['select', '--set', 'sviluppo=codex:gpt-6-astra@high,review=none,orchestratore=codex:gpt-6.1-sol@max', '--json']), 0);
  cfg = loadConfig(sb.project);
  assert.deepEqual([cfg.roster.sviluppo.model, cfg.roster.sviluppo.effort, cfg.roster.sviluppo.source], ['gpt-6-astra', 'high', 'utente']);
  assert.equal(cfg.roster.review.none, true);
  assert.equal(cfg.orchestrator.model, 'gpt-6.1-sol');
  assert.ok(readEvents(sb.project).some((e) => e.type === 'roster'));

  sb.clear();
  assert.equal(await run(sb, ['dispatch', '--name', 'b1', '--task-type', 'sviluppo', '--json']), 3); // still needs consent
  const plan = JSON.parse(sb.output()).plan;
  assert.deepEqual([plan.model, plan.effort], ['gpt-6-astra', 'high']);
  assert.match(plan.why, /scelta dell'utente/);
  assert.equal(await main(['dispatch', '--name', 'r1', '--task-type', 'review', '--yes'], { ...sb.opts(), err: () => {} }), 1); // user chose none

  assert.equal(await main(['select', '--set', 'sviluppo=codex:gpt-6-astra@bogus'], { ...sb.opts(), err: () => {} }), 1);
  assert.equal(await main(['select', '--set', 'nonsense=codex:gpt-6-astra'], { ...sb.opts(), err: () => {} }), 1);
});

test('select without a terminal explains the alternatives', async () => {
  const sb = sandbox();
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high']);
  let msg = '';
  assert.equal(await main(['select'], { ...sb.opts(), input: { isTTY: false }, output: { isTTY: false }, err: (s) => { msg = s; } }), 1);
  assert.match(msg, /--open --wait/);
});

test('interactive select saves what the TUI returns (TUI injected)', async () => {
  const sb = sandbox();
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high']);
  const tty = { isTTY: true };
  const fakeTui = async (state) => press(state, ['down', 'a', 's']);
  assert.equal(await run(sb, ['select'], { input: tty, output: tty, runTui: fakeTui }), 0);
  assert.equal(loadConfig(sb.project).roster.pianificazione.source, 'proposta');
});

test('select --open --wait opens a focused herdr tab and returns the saved choice', async () => {
  const sb = sandbox();
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high', '--backend', 'herdr']);
  // Simulate the user saving in the TUI shortly after the tab opens.
  setTimeout(() => {
    const cfgPath = join(sb.project, '.harma', 'config.json');
    const cfg = loadConfig(sb.project);
    cfg.roster = { sviluppo: { harness: 'codex', model: 'gpt-6-astra', effort: 'high', source: 'utente' } };
    writeFileSync(cfgPath, JSON.stringify(cfg));
    mkdirSync(join(sb.project, '.harma', 'cache'), { recursive: true });
    writeFileSync(join(sb.project, '.harma', 'cache', 'select-status.json'), JSON.stringify({ state: 'saved', at: new Date().toISOString() }));
  }, 50); // earlier than the workspace bookkeeping: that write must not lose these choices
  sb.clear();
  assert.equal(await run(sb, ['select', '--open', '--wait', '--json', '--timeout', '10'], { pollMs: 50 }), 0);
  const res = JSON.parse(sb.output());
  assert.equal(res.saved, true);
  assert.equal(res.roster.sviluppo.model, 'gpt-6-astra');
  const calls = sb.state().herdr.calls;
  const create = calls.find((c) => c[0] === 'tab' && c[1] === 'create');
  assert.ok(create.includes('--focus'));
  const runCall = calls.find((c) => c[0] === 'pane' && c[1] === 'run');
  assert.match(runCall[3], /harma\.mjs select --close-tab$/);
});
