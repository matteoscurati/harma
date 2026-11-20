// harma answer / harma answers: the orchestrator answers an agent that waits
// on a question or a permission request, as far as the project's policy goes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { sandbox } from './helpers.mjs';
import { main } from '../src/cli.mjs';
import { readEvents, loadConfig } from '../src/state.mjs';
import { HerdrBackend } from '../src/backends.mjs';
import { selectedOption, pickOption, answerGate, standingGrant, answerPolicy } from '../src/answers.mjs';

const run = (sb, args, extra) => main(args, sb.opts(extra));
const events = (sb, type) => readEvents(sb.project).filter((e) => e.type === type);

async function project() {
  const sb = sandbox();
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high', '--backend', 'herdr']);
  assert.equal(await run(sb, ['dispatch', '--name', 'trend', '--model', 'codex:gpt-6.2-sol', '--prompt', 'go', '--yes']), 0);
  sb.clear();
  return sb;
}

const CURRENCY = ['1. Omit and list the currency', '2. Convert at today\'s rate', '3. Stop and ask me'];
const PERMISSION = ['1. Yes, proceed (y)', '2. Yes, and don\'t ask again for npm test (a)', '3. No, and tell Codex what to do differently (esc)'];

/** Put the fake agent in front of a dialog, the cursor on `sel`. */
function ask(sb, options, extra = {}) {
  const st = sb.state();
  const ag = st.herdr.agents.find((x) => x.name === 'trend');
  ag.agent_status = 'blocked';
  ag.ask = { q: 'How should a foreign currency be handled?', mark: '›', options, sel: 0, wrap: false, ...extra };
  writeFileSync(sb.statePath, JSON.stringify(st));
}

// Polls without waiting: the fake herdr answers at once.
const fast = (sb) => { const b = new HerdrBackend({ env: sb.env }); b.trustPollMs = 0; return { backend: b }; };
const answer = (sb, args) => run(sb, ['answer', 'trend', ...args], fast(sb));

test('a question answered by the option\'s text: the selection is checked on screen, then Enter', async () => {
  const sb = await project();
  ask(sb, CURRENCY);
  assert.equal(await answer(sb, ['--kind', 'question', '--option', 'Convert at today\'s rate', '--reason', 'the contract says amounts are in EUR']), 0);
  const h = sb.state().herdr;
  assert.deepEqual(h.answers, [{ agent: 'trend', option: CURRENCY[1], text: null }]);
  assert.equal(h.keys.filter((k) => k === 'enter').length, 1);
  assert.equal(h.agents[0].agent_status, 'working');
  const [e] = events(sb, 'answered');
  assert.equal(e.option, CURRENCY[1]);
  assert.equal(e.kind, 'question');
  assert.equal(e.reason, 'the contract says amounts are in EUR');
  assert.equal(e.by, 'policy answers permissions');
  assert.match(sb.output(), /Risposto a trend \(domanda/);
  assert.match(sb.output(), /Ora trend è working/);
  assert.match(sb.output(), /Di' all'utente/);
});

test('by number, from a cursor not on the first option, in a list that wraps', async () => {
  const sb = await project();
  ask(sb, CURRENCY, { sel: 2, wrap: true });
  assert.equal(await answer(sb, ['--kind', 'question', '--option', '1']), 0);
  assert.equal(sb.state().herdr.answers[0].option, CURRENCY[0]);
});

test('a one-time permission is approved by default; one that lasts needs the user', async () => {
  const sb = await project();
  ask(sb, PERMISSION, { sel: 1 });
  assert.equal(await answer(sb, ['--kind', 'permission', '--option', 'Yes']), 4); // two options start with "Yes": nothing sent
  assert.equal(sb.state().herdr.answers, undefined);
  assert.equal(await answer(sb, ['--kind', 'permission', '--option', 'Yes, proceed']), 0);
  assert.equal(sb.state().herdr.answers[0].option, PERMISSION[0]);

  ask(sb, PERMISSION);
  sb.clear();
  assert.equal(await answer(sb, ['--kind', 'permission', '--option', '2']), 3);
  assert.equal(sb.state().herdr.answers.length, 1); // no Enter
  assert.match(sb.output(), /CONFERMA RICHIESTA[\s\S]*dà un permesso che resta/);
  assert.equal(sb.state().herdr.agents[0].agent_status, 'blocked');

  assert.equal(await answer(sb, ['--kind', 'permission', '--option', '2', '--yes']), 0);
  assert.equal(sb.state().herdr.answers[1].option, PERMISSION[1]);
  assert.equal(events(sb, 'answered').at(-1).by, 'utente (--yes)');
});

test('harma answers sets the policy; questions keeps permissions with the user, off keeps everything', async () => {
  const sb = await project();
  await run(sb, ['answers', '--json']);
  assert.equal(JSON.parse(sb.output()).answers, 'permissions');
  assert.equal(await run(sb, ['answers', 'questions']), 0);
  assert.equal(loadConfig(sb.project).answers, 'questions');
  ask(sb, PERMISSION);
  assert.equal(await answer(sb, ['--kind', 'permission', '--option', '1']), 3);
  assert.equal(sb.state().herdr.keys, undefined); // refused before touching the agent
  assert.equal(await answer(sb, ['--kind', 'question', '--option', '1']), 0);

  await run(sb, ['answers', 'off']);
  ask(sb, CURRENCY);
  assert.equal(await answer(sb, ['--kind', 'question', '--option', '1']), 3);
  assert.equal(await run(sb, ['answers', 'maybe']), 1);
  assert.deepEqual(events(sb, 'answer_policy').map((e) => [e.value, e.by]),
    [['questions', 'utente (harma answers questions)'], ['off', 'utente (harma answers off)']]);
});

test('a free answer is typed in the agent\'s pane, after the option that asks for it', async () => {
  const sb = await project();
  ask(sb, ['1. Use EUR', '2. Other (type your answer)']);
  assert.equal(await answer(sb, ['--kind', 'question', '--option', 'Other', '--text', 'Use the group currency']), 0);
  const h = sb.state().herdr;
  assert.deepEqual(h.texts, ['Use the group currency']);
  assert.deepEqual(h.answers, [{ agent: 'trend', option: '2. Other (type your answer)', text: 'Use the group currency' }]);
});

test('after the answer another question appears: harma says so and shows it', async () => {
  const sb = await project();
  ask(sb, CURRENCY, { next: { q: 'Which test covers it?', mark: '›', options: ['1. API test', '2. Unit test'], sel: 0 } });
  assert.equal(await answer(sb, ['--kind', 'question', '--option', '1', '--json']), 0);
  const out = JSON.parse(sb.output());
  assert.equal(out.still_blocked, true);
  assert.match(out.screen, /Which test covers it\?/);
});

test('nothing is sent when the agent is not waiting, or the option is not on screen', async () => {
  const sb = await project();
  assert.equal(await answer(sb, ['--kind', 'question', '--option', '1', '--json']), 1);
  assert.match(JSON.parse(sb.output()).error, /non aspetta una risposta \(stato done\)/);
  assert.equal(sb.state().herdr.keys, undefined);

  ask(sb, CURRENCY);
  sb.clear();
  assert.equal(await answer(sb, ['--kind', 'question', '--option', 'Round to the cent', '--json']), 4);
  const err = JSON.parse(sb.output());
  assert.match(err.error, /nessuna opzione corrisponde/);
  assert.match(err.hint, /Omit and list the currency \| 2\. Convert/);
  assert.equal(sb.state().herdr.answers, undefined);
});

test('the folder-trust dialog is not answered this way: it follows harma trust', async () => {
  const sb = sandbox();
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high', '--backend', 'herdr']);
  assert.equal(await run(sb, ['dispatch', '--name', 'trend', '--model', 'claude:claude-opus-5-5', '--prompt', 'go', '--yes'], { env: { ...sb.env, FAKE_START_BLOCKED: 'claude' } }), 4);
  assert.match(sb.output(), /harma answer trend/);
  sb.clear();
  assert.equal(await answer(sb, ['--kind', 'permission', '--option', 'Yes, I trust this folder']), 3);
  assert.match(sb.output(), /dialogo di fiducia nella cartella/);
  assert.equal(sb.state().herdr.trusted, undefined);
});

test('send to a waiting agent says to answer it first', async () => {
  const sb = await project();
  ask(sb, CURRENCY);
  assert.equal(await run(sb, ['send', 'trend', 'align to the contract', '--yes', '--json']), 4);
  assert.match(JSON.parse(sb.output()).hint, /harma answer trend/);
});

test('usage errors: kind, an answer, --keys alone', async () => {
  const sb = await project();
  ask(sb, CURRENCY);
  assert.equal(await answer(sb, ['--option', '1']), 1);
  assert.equal(await answer(sb, ['--kind', 'question']), 1);
  assert.equal(await answer(sb, ['--kind', 'question', '--option', '1', '--keys', 'enter']), 1);
  assert.equal(await answer(sb, ['--kind', 'permission', '--keys', 'enter']), 3); // harma can't read what it approves
  assert.equal(await answer(sb, ['--kind', 'question', '--keys', 'down,enter']), 0);
  assert.equal(sb.state().herdr.answers[0].option, CURRENCY[1]);
});

// ── reading the screen ────────────────────────────────────────────────────
test('selectedOption takes the last marked line: a dialog sits under the history', () => {
  const screen = ['› an earlier message', 'Question?', '   1. A', ' › 2. B', '   3. C'].join('\n');
  assert.equal(selectedOption(screen), '2. B');
  assert.equal(selectedOption('❯ Yes, I trust this folder'), 'Yes, I trust this folder');
  assert.equal(selectedOption('● Allow once'), 'Allow once');
  assert.equal(selectedOption('no choices here'), null);
  assert.equal(selectedOption('│ > typed text │'), null); // Claude Code's input box
});

test('pickOption: number, exact label, prefix, contains, a wrapped label; ambiguity is an error', () => {
  assert.equal(pickOption(PERMISSION, '3').index, 2);
  assert.match(pickOption(PERMISSION, 'yes').error, /più opzioni/);
  assert.equal(pickOption(PERMISSION, 'yes, proceed').index, 0);
  assert.equal(pickOption(['Yes', 'Yes, and don\'t ask again'], 'yes').index, 0); // the exact label wins
  assert.equal(pickOption(PERMISSION, '2. Yes, and don\'t ask again for npm test (a)').index, 1);
  assert.equal(pickOption(CURRENCY, 'omit').index, 0);
  assert.equal(pickOption(CURRENCY, 'today').index, 1);
  assert.equal(pickOption(['1. Omit and list the curr'], 'Omit and list the currency').index, 0);
  assert.match(pickOption(['Yes, once', 'Yes, always'], 'yes').error, /più opzioni/);
  assert.match(pickOption(['Allow once', 'No'], '1').error, /non sono numerate/);
  assert.match(pickOption(CURRENCY, '7').error, /nessuna opzione numero 7/);
});

test('answerGate and standingGrant follow the levels', () => {
  for (const o of ['Yes, and don\'t ask again for npm test', 'Yes, allow always', 'Yes, allow all edits during this session', 'Allow for this session']) assert.ok(standingGrant(o), o);
  for (const o of ['Yes, proceed (y)', 'Allow once', 'No, and tell Codex what to do differently', 'Always round to the cent']) assert.ok(!standingGrant(o), o);
  assert.equal(answerPolicy({}), 'permissions');
  assert.equal(answerPolicy({ answers: 'nope' }), 'permissions');
  assert.equal(answerGate('all', { kind: 'permission', option: 'Allow always' }).allowed, true);
  assert.equal(answerGate('permissions', { kind: 'question', option: 'Always use EUR' }).allowed, true);
  assert.equal(answerGate('permissions', { kind: 'question', option: 'Yes, and don\'t ask again' }).allowed, false); // a permission, whatever --kind says
  assert.equal(answerGate('questions', { kind: 'permission' }).allowed, false);
  assert.equal(answerGate('off', { kind: 'question', confirmed: true }).allowed, true);
});
