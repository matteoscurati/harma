import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, CODEXBAR_FIXTURE } from './helpers.mjs';
import { main } from '../src/cli.mjs';
import { initState, reduce, render, modelList } from '../src/tui.mjs';
import { choosePick, rosterPicks } from '../src/roster.mjs';
import { loadConfig, readEvents } from '../src/state.mjs';

const run = (sb, args, extra) => main(args, sb.opts(extra));
const press = (s, keys) => keys.reduce(reduce, s);

const MODELS = [
  { harness: 'claude', model: 'claude-opus-5-5', provider: 'anthropic', best: { effort: 'max', index: 58.4 }, credit: 'ampio', remaining: 89,
    efforts: [{ effort: 'low', index: 34.5, cost: 0.98 }, { effort: 'high', index: 51.7, cost: 3.46 }, { effort: 'max', index: 58.4, cost: 10.04 }] },
  { harness: 'codex', model: 'gpt-6.1-sol', provider: 'openai', best: { effort: 'max', index: 54.5 }, credit: 'ok', remaining: 25,
    efforts: [{ effort: 'low', index: 34.5, cost: 0.16 }, { effort: 'max', index: 54.5, cost: 1.27 }] },
];
const one = (harness, model, effort) => ({ harness, model, effort });
const ROWS = () => [
  { type: 'orchestratore', label: 'orch', single: true, proposal: { picks: [one('claude', 'claude-opus-5-5', 'high')] }, choice: { picks: [one('claude', 'claude-opus-5-5', 'high')], source: 'configurato' }, original: { picks: [one('claude', 'claude-opus-5-5', 'high')] } },
  { type: 'sviluppo', label: 'dev', proposal: { picks: [one('codex', 'gpt-6.1-sol', 'max'), one('claude', 'claude-opus-5-5', 'high')], why: 'indice 54.5' }, choice: null, original: null },
  { type: 'review', label: 'rev', proposal: { picks: [one('claude', 'claude-opus-5-5', 'high')] }, choice: null, original: null },
];

test('TUI: accept one proposal, pick another model and effort, save', () => {
  let s = initState({ rows: ROWS(), models: MODELS });
  s = press(s, ['down', 'a']); // sviluppo: accept proposal (main + backup)
  assert.deepEqual(s.rows[1].choice, { picks: [one('codex', 'gpt-6.1-sol', 'max'), one('claude', 'claude-opus-5-5', 'high')], source: 'proposta' });
  s = press(s, ['down', 'return']); // review is empty → straight to the model list (on the proposed model)
  assert.equal(s.view, 'model');
  assert.equal(modelList(s)[s.modelCursor].model, 'claude-opus-5-5');
  s = press(s, ['down', 'return']); // codex:gpt-6.1-sol → effort list
  assert.equal(s.view, 'effort');
  assert.equal(s.editModel.efforts[s.effortCursor].effort, 'max'); // starts on its best effort
  s = press(s, ['up', 'return']); // low
  assert.deepEqual(s.rows[2].choice, { picks: [one('codex', 'gpt-6.1-sol', 'low')], source: 'utente' });
  assert.equal(s.view, 'picks'); // back on the job's list, ready to add more
  s = press(s, ['escape', 's']);
  assert.equal(s.done, 'save');
});

test('TUI: several models per job — add, reorder, change, remove, no duplicates', () => {
  let s = initState({ rows: ROWS(), models: MODELS });
  s = press(s, ['down', 'down', 'return', 'return', 'return']); // review: claude opus @ high (proposal)
  assert.equal(s.rows[2].choice.source, 'proposta');
  s = press(s, ['+', 'return', 'return']); // add: opens on the first model not in the list (codex:gpt-6.1-sol) @ max
  assert.deepEqual(s.rows[2].choice.picks.map((p) => p.model), ['claude-opus-5-5', 'gpt-6.1-sol']);
  assert.equal(s.rows[2].choice.source, 'utente');
  assert.equal(s.pickCursor, 1);
  s = reduce(s, 'K'); // move it up
  assert.deepEqual(s.rows[2].choice.picks.map((p) => p.model), ['gpt-6.1-sol', 'claude-opus-5-5']);
  assert.equal(s.pickCursor, 0);
  s = reduce(s, 'shift-down');
  assert.deepEqual(s.rows[2].choice.picks.map((p) => p.model), ['claude-opus-5-5', 'gpt-6.1-sol']);
  // adding the same model+effort again is refused
  s = press(s, ['down', 'down', 'return']); // "+ aggiungi" line
  assert.equal(s.view, 'model');
  s = press(s, ['up', 'up', 'up', 'down', 'down', 'return']); // codex:gpt-6.1-sol
  s = press(s, ['return']); // max (already n.2)
  assert.equal(s.view, 'picks');
  assert.match(s.message, /già nella lista \(n\.2\)/);
  assert.equal(s.rows[2].choice.picks.length, 2);
  // change n.1's effort
  s = press(s, ['up', 'return', 'return', 'up', 'return']); // opus: high → low
  assert.deepEqual(s.rows[2].choice.picks[0], one('claude', 'claude-opus-5-5', 'low'));
  // remove both: the row becomes undecided and the view returns to the list
  s = press(s, ['d', 'd']);
  assert.equal(s.rows[2].choice, null);
  assert.equal(s.view, 'list');
  const shot = render({ ...press(s, ['a', 'return']) }, { color: false, width: 120 });
  assert.match(shot, /1\. claude:claude-opus-5-5 @ high\s+indice 51\.7\s+costo\/task \$3\.46\s+crediti ampio \(89%\)/);
  assert.match(shot, /\+ aggiungi un modello/);
});

test('TUI: "no model" for a job, A accepts all, x clears, quit asks when dirty', () => {
  let s = initState({ rows: ROWS(), models: MODELS });
  s = press(s, ['down', 'return']);
  s = press(s, ['up', 'up', 'up', 'return']); // top of list = "nessun modello"
  assert.deepEqual(s.rows[1].choice, { none: true, source: 'utente' });
  assert.equal(s.view, 'list');
  s = reduce(s, 'A');
  assert.ok(s.rows.slice(1).every((r) => r.choice?.source === 'proposta'));
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
  const list = render(s, { color: false, width: 160 });
  assert.match(list, /sviluppo\s+codex:gpt-6\.1-sol @ max \+1\s+codex:gpt-6\.1-sol @ max → claude:claude-opus-5-5 @ high  ✓ proposta/);
  assert.match(list, /review .*— da decidere/);
  s = press(s, ['return', 'return', 'return']); // picks → model (n.1) → effort
  const eff = render(s, { color: false });
  assert.match(eff, /max\s+indice 54\.5\s+costo\/task \$1\.27 ← proposta/);
});

test('choosePick: user order first, skip exhausted or missing, prefer a later pick over "scarso"', () => {
  const picks = [one('codex', 'gpt-6.1-sol', 'high'), one('claude', 'claude-opus-5-5', 'high'), one('kimi', 'kimi-k3', null)];
  const credit = (codex, claude) => [{ harness: 'codex', status: codex }, { harness: 'claude', status: claude }];
  assert.equal(choosePick(picks, credit('ok', 'ampio')).pick.harness, 'codex');
  let r = choosePick(picks, credit('scarso', 'ok'));
  assert.equal(r.pick.harness, 'claude');
  assert.match(r.notes[0], /n\.1 codex:gpt-6\.1-sol @ high saltato: crediti scarso/);
  assert.equal(choosePick(picks, credit('esaurito', 'scarso')).pick.harness, 'kimi'); // unknown credits beat "scarso"
  assert.equal(choosePick(picks, credit('scarso', 'scarso'), { installed: (h) => h !== 'kimi' }).pick.harness, 'codex');
  r = choosePick(picks, credit('esaurito', 'esaurito'), { installed: (h) => h !== 'kimi' });
  assert.equal(r.pick, null);
  assert.deepEqual(r.rated.map((x) => x.skip), ['crediti esauriti', 'crediti esauriti', 'CLI non installata']);
  assert.deepEqual(rosterPicks({ harness: 'codex', model: 'm', effort: 'high', source: 'utente' }), [one('codex', 'm', 'high')]); // 0.2.0 shape
});

test('select --accept and --set save the roster; dispatch then uses the user choice', async () => {
  const codexOk = CODEXBAR_FIXTURE.map((e) => (e.provider === 'codex' ? { ...e, usage: { secondary: { usedPercent: 20 } } } : e));
  const sb = sandbox({ codexbar: codexOk });
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high', '--backend', 'herdr']);
  assert.equal(await run(sb, ['select', '--accept', '--json']), 0);
  let cfg = loadConfig(sb.project);
  assert.equal(cfg.roster.sviluppo.source, 'proposta');
  assert.equal(cfg.roster.sviluppo.picks.length, 2); // main + backup on another CLI
  assert.notEqual(cfg.roster.sviluppo.picks[0].harness, cfg.roster.sviluppo.picks[1].harness);
  assert.equal(await run(sb, ['select', '--set', 'sviluppo=codex:gpt-6-astra@high|claude:claude-sonnet-5-5@high,review=none,orchestratore=codex:gpt-6.1-sol@max', '--json']), 0);
  cfg = loadConfig(sb.project);
  assert.deepEqual(cfg.roster.sviluppo.picks, [one('codex', 'gpt-6-astra', 'high'), one('claude', 'claude-sonnet-5-5', 'high')]);
  assert.equal(cfg.roster.sviluppo.source, 'utente');
  assert.equal(cfg.roster.review.none, true);
  assert.equal(cfg.orchestrator.model, 'gpt-6.1-sol');
  assert.ok(readEvents(sb.project).some((e) => e.type === 'roster'));

  sb.clear();
  assert.equal(await run(sb, ['dispatch', '--name', 'b1', '--task-type', 'sviluppo', '--json']), 3); // still needs consent
  const plan = JSON.parse(sb.output()).plan;
  assert.deepEqual([plan.model, plan.effort], ['gpt-6-astra', 'high']);
  assert.match(plan.why, /scelta dell'utente.*n\.1 di 2/);
  assert.equal(await main(['dispatch', '--name', 'r1', '--task-type', 'review', '--yes'], { ...sb.opts(), err: () => {} }), 1); // user chose none

  const err = () => {};
  assert.equal(await main(['select', '--set', 'sviluppo=codex:gpt-6-astra@bogus'], { ...sb.opts(), err }), 1);
  assert.equal(await main(['select', '--set', 'nonsense=codex:gpt-6-astra'], { ...sb.opts(), err }), 1);
  assert.equal(await main(['select', '--set', 'orchestratore=codex:gpt-6-astra|claude:claude-opus-5-5'], { ...sb.opts(), err }), 1);
  assert.equal(await main(['select', '--set', 'sviluppo=codex:gpt-6-astra@high|codex:gpt-6-astra@high'], { ...sb.opts(), err }), 1);
});

test('dispatch moves to the next chosen model when the first is low on credits', async () => {
  const sb = sandbox(); // fixture: codex 15% left (scarso), claude 89% (ampio)
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high', '--backend', 'herdr']);
  await run(sb, ['select', '--set', 'sviluppo=codex:gpt-6-astra@high|claude:claude-sonnet-5-5@high', '--json']);
  sb.clear();
  assert.equal(await run(sb, ['dispatch', '--name', 'b1', '--task-type', 'sviluppo', '--json']), 3);
  const plan = JSON.parse(sb.output()).plan;
  assert.equal(plan.model, 'claude-sonnet-5-5');
  assert.match(plan.why, /n\.2 di 2.*n\.1 codex:gpt-6-astra @ high saltato: crediti (scarso|esaurito)/);
  sb.clear();
  assert.equal(await run(sb, ['route', 'sviluppo', '--json']), 0);
  assert.equal(JSON.parse(sb.output()).user_pick.model, 'claude-sonnet-5-5');
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
