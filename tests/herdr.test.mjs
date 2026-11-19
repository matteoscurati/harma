// herdr placement (layout, worktree) and the folder-trust policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.mjs';
import { main } from '../src/cli.mjs';
import { readEvents, agentsFromEvents, loadConfig } from '../src/state.mjs';
import { readTrustDialog, trustableFolder } from '../src/trust.mjs';
import { HerdrBackend } from '../src/backends.mjs';

const run = (sb, args, extra) => main(args, sb.opts(extra));
const events = (sb) => readEvents(sb.project);
const agents = (sb) => agentsFromEvents(events(sb));
const calls = (sb, g, c) => sb.state().herdr.calls.filter((x) => x[0] === g && x[1] === c);
// What herdr injects into every pane it manages.
const INSIDE = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w9', HERDR_TAB_ID: 'w9:t1', HERDR_PANE_ID: 'w9:p1' };

async function project({ inside = false, trust = false } = {}) {
  const sb = sandbox();
  if (inside) Object.assign(sb.env, INSIDE);
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high', '--backend', 'herdr', ...(trust ? ['--trust-project'] : [])]);
  sb.clear();
  return sb;
}
const dispatch = (sb, name, model, extra = [], env = {}) =>
  run(sb, ['dispatch', '--name', name, '--model', model, '--prompt', 'go', '--yes', ...extra], { env: { ...sb.env, ...env } });

// ── layout ────────────────────────────────────────────────────────────────
test('inside herdr, agents open in the orchestrator\'s workspace (a tab when its pane size is unknown), not a new workspace', async () => {
  const sb = await project({ inside: true });
  assert.equal(await dispatch(sb, 'builder', 'codex:gpt-6.2-sol'), 0);
  assert.equal(calls(sb, 'workspace', 'create').length, 0);
  const [create] = calls(sb, 'tab', 'create');
  assert.equal(create[create.indexOf('--workspace') + 1], 'w9');
  assert.ok(create.includes('--no-focus'));
  assert.equal(agents(sb)[0].target.layout, 'tab');
  assert.equal(loadConfig(sb.project).herdr?.workspace_id, undefined);
  assert.match(sb.output(), /nel workspace dell'orchestratore/);
});

test('outside herdr, auto keeps the per-project workspace; tab and split need herdr', async () => {
  const sb = await project();
  assert.equal(await dispatch(sb, 'builder', 'codex:gpt-6.2-sol'), 0);
  assert.equal(calls(sb, 'workspace', 'create').length, 1);
  assert.equal(agents(sb)[0].target.layout, 'workspace');
  sb.clear();
  assert.equal(await dispatch(sb, 'other', 'codex:gpt-6.2-sol', ['--layout', 'split']), 1);
  assert.equal(sb.state().herdr.splits, undefined);
  assert.equal(agents(sb).length, 1); // nothing recorded for the refused one
});

test('--layout split opens a pane beside the orchestrator, and cleanup closes that pane', async () => {
  const sb = await project({ inside: true });
  assert.equal(await dispatch(sb, 'reviewer', 'claude:claude-sonnet-5-5', ['--layout', 'split:down']), 0);
  const [split] = sb.state().herdr.splits;
  assert.deepEqual([split.from, split.direction], ['w9:p1', 'down']);
  assert.equal(sb.state().herdr.labels[split.id], 'reviewer');
  assert.equal(await run(sb, ['cleanup']), 0);
  assert.deepEqual(sb.state().herdr.closedPanes, [split.id]);
  assert.equal(calls(sb, 'tab', 'close').length, 0); // never the orchestrator's tab
});

test('init --layout sets the project default; select --open uses it', async () => {
  const sb = sandbox();
  Object.assign(sb.env, INSIDE);
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high', '--backend', 'herdr', '--layout', 'split']);
  assert.equal(loadConfig(sb.project).herdr.layout, 'split');
  assert.equal(await dispatch(sb, 'builder', 'codex:gpt-6.2-sol'), 0);
  assert.equal(sb.state().herdr.splits.length, 1);
  assert.equal(await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--layout', 'grid']), 1);
});

// ── worktree ──────────────────────────────────────────────────────────────
test('--worktree gives the agent its own checkout in a grouped herdr workspace', async () => {
  const sb = await project({ inside: true });
  assert.equal(await dispatch(sb, 'builder', 'codex:gpt-6.2-sol', ['--worktree']), 0);
  const [wt] = sb.state().herdr.worktrees;
  assert.equal(wt.branch, 'harma/builder');
  const a = agents(sb)[0];
  assert.equal(a.cwd, wt.path);
  assert.deepEqual(a.worktree, { path: wt.path, branch: 'harma/builder' });
  assert.equal(a.target.layout, 'worktree');
  assert.equal(sb.state().herdr.labels['w1:t0'], 'builder'); // the worktree's root tab hosts the agent
  assert.match(sb.output(), /Worktree: .*harma\/builder/);
  sb.clear();
  assert.equal(await dispatch(sb, 'fix', 'codex:gpt-6.2-sol', ['--worktree', '--branch', 'fix/login']), 0);
  assert.equal(sb.state().herdr.worktrees[1].branch, 'fix/login');
  sb.clear();
  await run(sb, ['cleanup', '--agent', 'builder', '--json']);
  assert.match(JSON.parse(sb.output()).report[0].motivo, /worktree lasciato in .*harma-builder.*git worktree remove/);
});

test('a new worktree whose shell is still starting: harma waits for the prompt, then starts the agent', async () => {
  const sb = await project({ inside: true });
  assert.equal(await dispatch(sb, 'review-api', 'codex:gpt-6.2-sol', ['--worktree'], { FAKE_PANE_BUSY: '2' }), 0);
  assert.equal(calls(sb, 'agent', 'start').length, 3); // two refusals while the shell starts, then the start
  const [ag] = sb.state().herdr.agents;
  assert.deepEqual([ag.name, ag.last_prompt], ['review-api', 'go']);
  assert.equal(sb.state().herdr.removedWorktrees, undefined);
});

test('a shell that never reaches its prompt: no agent, the empty worktree is removed, the same dispatch runs again', async () => {
  const sb = await project({ inside: true });
  const backend = new HerdrBackend({ env: { ...sb.env, FAKE_PANE_BUSY: '99' } });
  backend.shellWaitMs = 0;
  let msg = '';
  const args = ['dispatch', '--name', 'review-api', '--model', 'codex:gpt-6.2-sol', '--prompt', 'go', '--yes', '--worktree'];
  assert.equal(await run(sb, args, { backend, err: (s) => { msg += s; } }), 1);
  assert.match(msg, /shell del pane non è arrivata al prompt.*nessun agente è stato avviato/);
  assert.deepEqual(sb.state().herdr.removedWorktrees, [`${sb.project}-wt/harma-review-api`]);
  assert.equal(agents(sb).length, 0);
  assert.equal(await dispatch(sb, 'review-api', 'codex:gpt-6.2-sol', ['--worktree']), 0);
  assert.equal(sb.state().herdr.worktrees.length, 1);
});

// ── trust ─────────────────────────────────────────────────────────────────
test('default policy: a trust dialog in the project folder is left to the user, no key is sent', async () => {
  const sb = await project();
  assert.equal(await dispatch(sb, 'planner', 'claude:claude-opus-5-5', [], { FAKE_START_BLOCKED: 'claude' }), 4);
  assert.equal(sb.state().herdr.keys, undefined);
  assert.match(sb.output(), /BLOCCATO/);
});

for (const [harness, model, keys] of [
  ['claude', 'claude:claude-opus-5-5', ['down', 'enter']], // Claude's cursor starts on "No, exit"
  ['codex', 'codex:gpt-6.2-sol', ['enter']],
  ['agy', 'agy:gemini-4-argon', ['enter']],
]) {
  test(`trust policy on: harma answers ${harness}'s trust dialog and delivers the task`, async () => {
    const sb = sandbox({ bins: ['herdr', 'codexbar', 'claude', 'codex', 'agy'] });
    await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high', '--backend', 'herdr']);
    assert.equal(await run(sb, ['trust', 'on']), 0);
    sb.clear();
    assert.equal(await dispatch(sb, 'agent1', model, [], { FAKE_START_BLOCKED: harness }), 0);
    const h = sb.state().herdr;
    assert.deepEqual(h.keys, keys);
    assert.deepEqual(h.trusted, ['agent1']);
    assert.equal(h.agents[0].last_prompt, 'go');
    const types = events(sb).map((e) => e.type);
    assert.ok(types.includes('trust_policy') && types.includes('trusted'));
  });
}

test('trust policy on, but the dialog names another folder: harma does not answer', async () => {
  const sb = await project({ trust: true });
  assert.equal(await dispatch(sb, 'planner', 'claude:claude-opus-5-5', [], { FAKE_START_BLOCKED: 'claude', FAKE_DIALOG_PATH: '/somewhere/else' }), 4);
  assert.equal(sb.state().herdr.keys, undefined);
  assert.match(sb.output(), /non data — il dialogo non mostra la cartella/);
  assert.equal(events(sb).find((e) => e.type === 'trust_skipped').agent, 'planner');
});

test('trust policy on, folder outside the project: not answered', async () => {
  const sb = await project({ trust: true });
  assert.equal(await dispatch(sb, 'planner', 'claude:claude-opus-5-5', ['--cwd', sb.home], { FAKE_START_BLOCKED: 'claude' }), 4);
  assert.equal(sb.state().herdr.keys, undefined);
  assert.match(sb.output(), /fuori dal progetto/);
  assert.match(events(sb).find((e) => e.type === 'trust_skipped').detail, /fuori dal progetto/);
});

test('trust policy on: an agent in its own worktree is trusted for that worktree', async () => {
  const sb = await project({ trust: true });
  assert.equal(await dispatch(sb, 'builder', 'codex:gpt-6.2-sol', ['--worktree'], { FAKE_START_BLOCKED: 'codex' }), 0);
  assert.deepEqual(sb.state().herdr.trusted, ['builder']);
  assert.equal(events(sb).find((e) => e.type === 'trusted').cwd, sb.state().herdr.worktrees[0].path);
});

test('harma trust shows and changes the policy, and records who changed it', async () => {
  const sb = await project();
  await run(sb, ['trust', '--json']);
  assert.equal(JSON.parse(sb.output()).trust, 'worktrees'); // the default
  for (const level of ['on', 'off', 'worktrees']) {
    assert.equal(await run(sb, ['trust', level]), 0);
    assert.equal(loadConfig(sb.project).trust, level);
  }
  assert.deepEqual(events(sb).filter((e) => e.type === 'trust_policy').map((e) => [e.value, e.by]),
    [['on', 'utente (harma trust on)'], ['off', 'utente (harma trust off)'], ['worktrees', 'utente (harma trust worktrees)']]);
  assert.equal(await run(sb, ['trust', 'maybe']), 1);
});

test('default policy: harma answers the trust dialog of a worktree it just created; trust off leaves it to the user', async () => {
  const sb = await project();
  assert.equal(await dispatch(sb, 'builder', 'codex:gpt-6.2-sol', ['--worktree'], { FAKE_START_BLOCKED: 'codex' }), 0);
  assert.deepEqual(sb.state().herdr.trusted, ['builder']);
  assert.equal(events(sb).find((e) => e.type === 'trusted').by, 'policy trust worktrees');
  await run(sb, ['trust', 'off']);
  assert.equal(await dispatch(sb, 'other', 'codex:gpt-6.2-sol', ['--worktree'], { FAKE_START_BLOCKED: 'codex' }), 4);
  assert.deepEqual(sb.state().herdr.trusted, ['builder']);
});

test('older projects keep their trust choice: trust_project true is on, a recorded trust off stays off', async () => {
  const { trustPolicy } = await import('../src/trust.mjs');
  assert.equal(trustPolicy({ trust_project: true }), 'on');
  assert.equal(trustPolicy({ trust_project: false }, [{ type: 'trust_policy', value: true }, { type: 'trust_policy', value: false }]), 'off');
  assert.equal(trustPolicy({ trust_project: false }), 'worktrees');
  assert.equal(trustPolicy({ trust: 'off', trust_project: true }), 'off');
});

// ── the real dialogs, as captured under herdr 0.9.5 ────────────────────────
const P = '/private/tmp/claude-501/scratchpad/trustprobe/repo';
const REAL = {
  claude: [
    '───────────────────────────────────────────────',
    ' Accessing workspace:',
    ` ${P.slice(0, 30)}`, ` ${P.slice(30)}`,
    ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
    ' project, or work from your team). If not, take a moment to review what\'s in this folder first.',
    ' Claude Code\'ll be able to read, edit, and execute files here.',
    ' Security guide',
    ' ❯ No, exit',
    '   Yes, I trust this folder',
    ' Enter to confirm · Esc to cancel',
  ].join('\n'),
  codex: [
    '  Folder access',
    `  ${P.slice(0, 25)}`, `  ${P.slice(25)}`,
    '  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings',
    '  can run code automatically, even without a model request. Continue only if you trust these files. Your trust',
    '  decision will be saved.',
    '› 1. Trust and continue',
    '  2. Back to Agent Command Center',
    '  enter continue · esc back',
  ].join('\n'),
  agy: [
    'Accessing workspace:',
    `${P.slice(0, 20)}`, `${P.slice(20)}`,
    'Do you trust the contents of this project?',
    'Antigravity CLI requires permission to read, edit, and execute files here.',
    '> Yes, I trust this folder',
    '  No, exit',
    '  ↑/↓ Navigate · enter Confirm',
    '                                                   auto · Gemini 4 Argon · high',
  ].join('\n'),
};

test('readTrustDialog recognizes the real dialogs, the wrapped path and the selected option', () => {
  assert.deepEqual(readTrustDialog('claude', REAL.claude, P), { dialog: true, path: true, selected: false, line: 'No, exit' });
  assert.deepEqual(readTrustDialog('codex', REAL.codex, P), { dialog: true, path: true, selected: true, line: '1. Trust and continue' });
  assert.deepEqual(readTrustDialog('agy', REAL.agy, P), { dialog: true, path: true, selected: true, line: 'Yes, I trust this folder' });
  const moved = REAL.claude.replace(' ❯ No, exit', '   No, exit').replace('   Yes, I trust', ' ❯ Yes, I trust');
  assert.equal(readTrustDialog('claude', moved, P).selected, true);
  assert.equal(readTrustDialog('claude', REAL.claude, '/other/repo').path, false);
  assert.equal(readTrustDialog('codex', REAL.claude, P).dialog, false); // another CLI's dialog
  assert.equal(readTrustDialog('kimi', REAL.claude, P).dialog, false); // no known dialog
  assert.equal(readTrustDialog('codex', '› Ask Codex to do anything', P).dialog, false); // the normal prompt
});

test('trustableFolder: the project, folders under it, or the agent\'s worktree only', () => {
  assert.ok(trustableFolder('/p/app', '/p/app'));
  assert.ok(trustableFolder('/p/app/web', '/p/app'));
  assert.ok(!trustableFolder('/p/application', '/p/app'));
  assert.ok(!trustableFolder('/p', '/p/app'));
  assert.ok(trustableFolder('/wt/app/builder', '/p/app', '/wt/app/builder'));
});

// ── what a worktree lacks ─────────────────────────────────────────────────
import { symlinkSync, writeFileSync as write, readFileSync as read, existsSync as exists } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join as pjoin } from 'node:path';

/** A project that is a git repository, with one commit. */
async function gitProject() {
  const sb = await project({ inside: true });
  symlinkSync('/usr/bin/git', pjoin(sb.bin, 'git'));
  const git = (...args) => execFileSync('git', ['-C', sb.project, ...args], { env: { ...sb.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });
  git('init', '-q');
  write(pjoin(sb.project, '.gitignore'), '.env\n');
  write(pjoin(sb.project, 'app.js'), 'v1\n');
  git('add', '.gitignore', 'app.js');
  git('commit', '-q', '-m', 'init');
  return sb;
}

test('--worktree warns about uncommitted work and .env files the agent will not find', async () => {
  const sb = await gitProject();
  write(pjoin(sb.project, 'app.js'), 'v2\n');
  write(pjoin(sb.project, 'notes.md'), 'draft\n');
  write(pjoin(sb.project, '.env'), 'KEY=1\n');
  assert.equal(await run(sb, ['dispatch', '--name', 'builder', '--model', 'codex:gpt-6.2-sol', '--prompt', 'go', '--worktree', '--json']), 3);
  const { plan } = JSON.parse(sb.output());
  assert.deepEqual(plan.uncommitted, { changed: 1, untracked: 1 }); // harma's own .harma/ does not count
  assert.match(plan.notes.join('\n'), /1 file modificati e 1 file nuovi non committati non ci saranno/);
  assert.match(plan.notes.join('\n'), /\.env: git non li traccia[\s\S]*harma worktree --copy "\.env"/);
});

test('harma worktree --copy: those files go into each new worktree before the agent starts', async () => {
  const sb = await gitProject();
  write(pjoin(sb.project, '.env'), 'KEY=1\n');
  assert.equal(await run(sb, ['worktree', '--copy', '.env,missing.txt,app.js']), 0);
  assert.deepEqual(loadConfig(sb.project).worktree_copy, ['.env', 'missing.txt', 'app.js']);
  // app.js is tracked: the fake checkout gets it as git would, and harma must not overwrite it.
  const wt = `${sb.project}-wt/harma-builder`;
  execFileSync('mkdir', ['-p', wt]);
  write(pjoin(wt, 'app.js'), 'from git\n');
  sb.clear();
  assert.equal(await dispatch(sb, 'builder', 'codex:gpt-6.2-sol', ['--worktree']), 0);
  assert.equal(read(pjoin(wt, '.env'), 'utf8'), 'KEY=1\n');
  assert.equal(read(pjoin(wt, 'app.js'), 'utf8'), 'from git\n');
  assert.match(sb.output(), /Copiati nel worktree: \.env\nNon copiati: missing\.txt \(non c'è nel progetto\); app\.js \(già nel worktree\)/);
  assert.equal(agents(sb)[0].worktree.copy.copied[0], '.env');
  const e = { text: '' };
  assert.equal(await run(sb, ['worktree', '--copy', '../secrets'], { err: (s) => { e.text += s; } }), 1);
  assert.match(e.text, /non è un percorso dentro il progetto/);
  assert.equal(await run(sb, ['worktree', '--copy', '']), 0);
  assert.deepEqual(loadConfig(sb.project).worktree_copy, []);
  assert.ok(exists(wt));
});
