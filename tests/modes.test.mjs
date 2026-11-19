// Where and how agents run: split by size, another machine, headless jobs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { main } from '../src/cli.mjs';
import { cmdRun } from '../src/run.mjs';
import { readEvents, agentsFromEvents, loadConfig } from '../src/state.mjs';
import { loadCatalog } from '../src/catalog.mjs';
import { launchSpec } from '../src/harness.mjs';

const run = (sb, args, extra) => main(args, sb.opts(extra));
const agents = (sb) => agentsFromEvents(readEvents(sb.project));
const calls = (sb, g, c) => sb.state().herdr.calls.filter((x) => x[0] === g && x[1] === c);
const INSIDE = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w9', HERDR_TAB_ID: 'w9:t1', HERDR_PANE_ID: 'w9:p1' };

async function project({ inside = true, bins } = {}) {
  const sb = sandbox(bins ? { bins } : {});
  if (inside) Object.assign(sb.env, INSIDE);
  await run(sb, ['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high', '--backend', 'herdr']);
  sb.clear();
  return sb;
}
const dispatch = (sb, name, model, extra = [], env = {}, opts = {}) =>
  run(sb, ['dispatch', '--name', name, '--model', model, '--prompt', 'riassumi il diff', '--yes', ...extra], { env: { ...sb.env, ...env }, ...opts });
const capture = () => { let text = ''; return { err: (s) => { text += s; }, text: () => text }; };

// ── split by size ─────────────────────────────────────────────────────────
test('auto inside herdr: a pane beside the orchestrator while both stay usable, then a tab', async () => {
  const sb = await project();
  const wide = { FAKE_PANE_SIZE: '159x54' };
  assert.equal(await dispatch(sb, 'one', 'codex:gpt-6.2-sol', [], wide), 0);
  assert.equal(await dispatch(sb, 'two', 'codex:gpt-6.2-sol', [], wide), 0);
  assert.equal(await dispatch(sb, 'three', 'codex:gpt-6.2-sol', [], wide), 0);
  // 159x54 is wide: right; the 79x54 left is tall: down; 79x27 has no room either way.
  assert.deepEqual(sb.state().herdr.splits.map((x) => [x.from, x.direction]), [['w9:p1', 'right'], ['w9:p1', 'down']]);
  assert.deepEqual(agents(sb).map((a) => a.target.layout), ['split', 'split', 'tab']);
  assert.equal(calls(sb, 'workspace', 'create').length, 0);
});

test('without the pane\'s geometry, auto opens a tab; an explicit split always splits', async () => {
  const sb = await project();
  assert.equal(await dispatch(sb, 'one', 'codex:gpt-6.2-sol'), 0);
  assert.equal(agents(sb)[0].target.layout, 'tab');
  assert.equal(await dispatch(sb, 'two', 'codex:gpt-6.2-sol', ['--layout', 'split'], { FAKE_PANE_SIZE: '70x20' }), 0);
  assert.equal(await dispatch(sb, 'three', 'codex:gpt-6.2-sol', ['--layout', 'split:down'], { FAKE_PANE_SIZE: '159x54' }), 0);
  assert.deepEqual(sb.state().herdr.splits.map((x) => x.direction), ['right', 'down']); // 70x20 is small but wide
});

test('select --open still opens a tab inside herdr, where the selection screen has room', async () => {
  const sb = await project();
  setTimeout(() => {
    mkdirSync(join(sb.project, '.harma', 'cache'), { recursive: true });
    writeFileSync(join(sb.project, '.harma', 'cache', 'select-status.json'), JSON.stringify({ state: 'cancelled', at: new Date().toISOString() }));
  }, 50);
  assert.equal(await run(sb, ['select', '--open', '--wait', '--timeout', '10'], { pollMs: 50, env: { ...sb.env, FAKE_PANE_SIZE: '159x54' } }), 0);
  assert.equal(sb.state().herdr.splits, undefined);
  assert.equal(calls(sb, 'tab', 'create').length, 1);
});

// ── another machine ───────────────────────────────────────────────────────
test('--machine: every herdr call goes to that machine, in its own project workspace', async () => {
  const sb = await project();
  // agy is not installed here: on another machine harma does not check local CLIs.
  assert.equal(await dispatch(sb, 'far', 'agy:gemini-4-hydrogen', ['--machine', 'Omarchy', '--cwd', '~/work/app']), 0);
  const herdrCalls = sb.state().herdr.calls.filter((x) => x[0] !== 'status');
  assert.ok(herdrCalls.length && herdrCalls.every((x) => x[0] === '--machine' && x[1] === 'Omarchy'));
  const create = herdrCalls.find((x) => x[2] === 'workspace' && x[3] === 'create');
  assert.equal(create[create.indexOf('--cwd') + 1], '~/work/app');
  assert.equal(loadConfig(sb.project).herdr.machines.Omarchy.workspace_id, 'w1');
  assert.equal(loadConfig(sb.project).herdr.workspace_id, undefined);
  const [a] = agents(sb);
  assert.deepEqual([a.target.machine, a.cwd], ['Omarchy', '~/work/app']);
  assert.match(sb.output(), /su Omarchy[\s\S]*CLI e modelli non verificati su Omarchy/);

  sb.clear();
  assert.equal(await run(sb, ['status', '--json']), 0);
  const row = JSON.parse(sb.output()).agents[0];
  assert.deepEqual([row.stato, row.backend.split(' ')[0]], ['done', 'herdr@Omarchy']);
  sb.clear();
  assert.equal(await run(sb, ['cleanup', '--force', '--workspace']), 0);
  const tail = sb.state().herdr.calls.slice(-2);
  assert.deepEqual(tail.map((x) => x.slice(0, 4)), [['--machine', 'Omarchy', 'tab', 'close'], ['--machine', 'Omarchy', 'workspace', 'close']]);
  assert.equal(loadConfig(sb.project).herdr.machines.Omarchy, undefined);
});

test('--machine needs the folder over there and the herdr backend; tab, split and headless stay local', async () => {
  const sb = await project();
  const cases = [
    [['--machine', 'Omarchy'], /richiede --cwd/],
    [['--machine', 'Omarchy', '--cwd', 'app'], /richiede --cwd/],
    [['--machine', 'Omarchy', '--cwd', '/srv/app', '--layout', 'split'], /si aprono nel workspace del progetto/],
    [['--machine', 'Omarchy', '--cwd', '/srv/app', '--headless'], /non supporta i lavori non interattivi/],
  ];
  for (const [extra, msg] of cases) {
    const e = capture();
    assert.equal(await dispatch(sb, 'far', 'codex:gpt-6.2-sol', extra, {}, { err: e.err }), 1, extra.join(' '));
    assert.match(e.text(), msg);
  }
  assert.equal(agents(sb).length, 0);
});

// ── headless ──────────────────────────────────────────────────────────────
test('--headless: harma types its runner in a pane once the shell is ready, and the job takes the agent\'s name', async () => {
  const sb = await project();
  assert.equal(await dispatch(sb, 'scout', 'claude:claude-sonnet-5-5', ['--headless'], { FAKE_SHELL_STARTING: '2' }), 0);
  const { runs, agents: live } = sb.state().herdr;
  assert.equal(runs.length, 1);
  assert.match(runs[0].command, / _run .*job\.json'?$/);
  assert.ok(calls(sb, 'pane', 'process-info').length >= 3); // waited out the startup files
  assert.equal(calls(sb, 'agent', 'start').length, 0);
  assert.equal(live[0].name, 'scout');
  const [a] = agents(sb);
  assert.equal(a.mode, 'headless');
  const job = JSON.parse(readFileSync(join(a.run_dir, 'job.json'), 'utf8'));
  assert.equal(job.argv.at(-1), '-p');
  assert.deepEqual(job.prompt, { via: 'stdin' });
  assert.equal(readFileSync(job.prompt_file, 'utf8'), 'riassumi il diff');
  assert.equal(job.session_id, a.session_id); // Claude's session id is chosen up front
  assert.deepEqual([job.report, job.keep_alive], [true, true]);
  assert.match(readFileSync(join(sb.project, '.harma', '.gitignore'), 'utf8'), /^cache\/\nruns\/\n$/);

  sb.clear();
  await run(sb, ['status', '--json']);
  const row = JSON.parse(sb.output()).agents[0];
  assert.deepEqual([row.modo, row.stato], ['non interattivo', 'working']);
  sb.clear();
  assert.equal(await run(sb, ['cleanup']), 0);
  assert.match(sb.output(), /tenuto.*sta lavorando/);
});

test('--headless --wait returns the answer; read shows it, send is refused, cleanup needs no session', async () => {
  const sb = await project();
  assert.equal(await dispatch(sb, 'scout', 'codex:gpt-6.2-sol', ['--headless', '--wait', '--json'], { FAKE_RUN_FINISH: '1' }, { pollMs: 10 }), 0);
  const res = JSON.parse(sb.output());
  assert.equal(res.answer, 'risposta a: riassumi il diff\n');
  assert.equal(res.result.exit_code, 0);
  const job = JSON.parse(readFileSync(join(agents(sb)[0].run_dir, 'job.json'), 'utf8'));
  assert.deepEqual(job.argv.slice(0, 2), ['codex', 'exec']);
  assert.equal(job.argv.at(-1), '-');

  sb.clear();
  assert.equal(await run(sb, ['read', 'scout']), 0);
  assert.match(sb.output(), /scout: done[\s\S]*risposta a: riassumi il diff/);
  const e = capture();
  assert.equal(await run(sb, ['send', 'scout', 'altro', '--yes'], { err: e.err }), 1);
  assert.match(e.text(), /lavoro non interattivo/);
  sb.clear();
  assert.equal(await run(sb, ['cleanup', '--json']), 0);
  const [r] = JSON.parse(sb.output()).report;
  assert.equal(r.azione, 'chiuso');
  assert.match(r.motivo, /risposta in .*output\.md/);
  assert.equal(agents(sb)[0].session_id, 'run-sess-1'); // read back from result.json
});

test('a CLI herdr does not recognize runs headless; one with no prompt cannot start', async () => {
  const sb = await project({ bins: ['herdr', 'hc', 'codexbar', 'claude', 'codex', 'mmx'] });
  assert.equal(await dispatch(sb, 'chat', 'mmx:minimax-m3.1-flash'), 0);
  assert.match(sb.output(), /herdr non riconosce mmx come agente: lavoro non interattivo/);
  const job = JSON.parse(readFileSync(join(agents(sb)[0].run_dir, 'job.json'), 'utf8'));
  assert.deepEqual(job.argv.slice(0, 3), ['mmx', 'text', 'chat']);
  assert.ok(job.argv.includes('--non-interactive'));
  assert.deepEqual(job.prompt, { via: 'flag', flag: '--message' });
  const e = capture();
  assert.equal(await run(sb, ['dispatch', '--name', 'empty', '--model', 'codex:gpt-6.2-sol', '--headless', '--yes'], { err: e.err }), 1);
  assert.match(e.text(), /parte con il suo compito/);
});

test('a runner that never starts: the pane is closed and the error shows what the shell said', async () => {
  const sb = await project();
  const { HerdrBackend } = await import('../src/backends.mjs');
  const backend = new HerdrBackend({ env: { ...sb.env, FAKE_RUN_DEAD: '1' } });
  backend.shellWaitMs = 0;
  const e = capture();
  assert.equal(await dispatch(sb, 'scout', 'codex:gpt-6.2-sol', ['--headless'], {}, { backend, err: e.err }), 1);
  assert.match(e.text(), /harma _run non è partito[\s\S]*command not found: node/);
  assert.equal(calls(sb, 'tab', 'close').length, 1);
});

test('Claude Code on another provider is still Claude Code to herdr', async () => {
  const sb = await project();
  assert.equal(await dispatch(sb, 'glm', 'claude-zai:glm-5.3-flash'), 0);
  const [start] = calls(sb, 'agent', 'start');
  assert.equal(start[start.indexOf('--kind') + 1], 'claude');
});

test('Mistral Vibe takes its model from VIBE_ACTIVE_MODEL, not from a flag', () => {
  const spec = launchSpec({ harness: 'vibe', model: 'mistral-medium-3.5', effort: null }, loadCatalog({ env: {} }));
  assert.deepEqual(spec.argv, ['vibe']);
  assert.equal(spec.env.VIBE_ACTIVE_MODEL, 'mistral-medium-3.5');
});

// ── the runner ────────────────────────────────────────────────────────────
function runnerJob(sb, extra = {}) {
  const dir = join(sb.root, 'run');
  mkdirSync(dir, { recursive: true });
  const cli = join(sb.bin, 'fakecli');
  // Echoes its arguments and stdin, prints a session id on stderr like codex exec.
  writeFileSync(cli, `#!/usr/bin/env node
const args = process.argv.slice(2);
let input = ''; process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (args.includes('--sleep')) { setInterval(() => {}, 1000); return; }
  console.error('session id: 0b0c0d0e-1111-2222-3333-444455556666');
  console.log('args=' + args.join(' ') + ' stdin=' + input + ' model=' + process.env.FAKE_MODEL + ' herdr=' + (process.env.HERDR_ENV ?? 'none'));
  process.exit(args.includes('--fail') ? 3 : 0);
});
`, { mode: 0o755 });
  writeFileSync(join(dir, 'prompt.md'), 'trova i bug');
  const job = {
    name: 'scout', harness: 'codex', model: 'gpt-6.2-sol', argv: ['fakecli', 'exec', '-'], env: { FAKE_MODEL: 'sol' },
    prompt: { via: 'stdin' }, prompt_file: join(dir, 'prompt.md'), run_dir: dir, cwd: null,
    report: true, keep_alive: false, session_id: null, resume_argv: null, session_pattern: 'session id:\\s*([0-9a-f-]{36})', timeout_sec: 30, ...extra,
  };
  writeFileSync(join(dir, 'job.json'), JSON.stringify(job));
  return { dir, path: join(dir, 'job.json') };
}
const quiet = { write() {}, on() {} };

test('runner: the prompt on stdin, the answer in output.md, the session from the output, herdr told each step', async () => {
  const sb = sandbox();
  const { dir, path } = runnerJob(sb);
  const res = await cmdRun({ _: [path] }, { env: { ...sb.env, HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' }, stdout: quiet, stderr: quiet });
  assert.equal(res.exitCode, 0);
  // The agent's own herdr hooks must not see herdr (herdr=none): harma reports for it.
  assert.equal(readFileSync(join(dir, 'output.md'), 'utf8'), 'args=exec - stdin=trova i bug model=sol herdr=none\n');
  const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
  assert.deepEqual([result.exit_code, result.session_id], [0, '0b0c0d0e-1111-2222-3333-444455556666']);
  const h = sb.state().herdr;
  assert.deepEqual(h.reports, ['working', 'idle']);
  assert.equal(h.agents[0].name, 'scout');
  assert.equal(h.agents[0].agent_status, 'done');
  assert.equal(h.sessionReports[0].id, result.session_id);
});

test('runner: a prompt passed as a flag, a failing CLI, and no herdr outside it', async () => {
  const sb = sandbox();
  const { dir, path } = runnerJob(sb, { prompt: { via: 'flag', flag: '-p' }, argv: ['fakecli', '--fail'], session_pattern: null });
  const res = await cmdRun({ _: [path] }, { env: sb.env, stdout: quiet, stderr: quiet });
  assert.equal(res.exitCode, 3);
  assert.match(readFileSync(join(dir, 'output.md'), 'utf8'), /^args=--fail -p trova i bug/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')).exit_code, 3);
  assert.equal(sb.state().herdr, undefined); // not in a herdr pane: nothing reported
});

test('runner: a job past its time limit is stopped and says so', async () => {
  const sb = sandbox();
  const { dir, path } = runnerJob(sb, { argv: ['fakecli', '--sleep'], prompt: { via: 'flag', flag: '-p' }, timeout_sec: 0.3 });
  await cmdRun({ _: [path] }, { env: sb.env, stdout: quiet, stderr: quiet });
  const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
  assert.equal(result.timed_out, true);
  assert.ok(existsSync(join(dir, 'output.md')));
});
