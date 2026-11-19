// Test sandbox: a temp HOME, a project dir, and fake executables on PATH
// (herdr, hc, codexbar, claude, codex) that record calls in a state file.
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const FAKE_HERDR = `#!/usr/bin/env node
const fs = require('fs');
const S = process.env.FAKE_STATE;
const st = fs.existsSync(S) ? JSON.parse(fs.readFileSync(S, 'utf8')) : {};
st.herdr ??= { ws: 0, tab: 0, agents: [], calls: [] };
const h = st.herdr;
let a = process.argv.slice(2);
h.calls.push(a);
if (a[0] === '--machine') { h.machines = [...(h.machines ?? []), a[1]]; a = a.slice(2); }
const save = () => fs.writeFileSync(S, JSON.stringify(st));
const ok = (result) => { save(); console.log(JSON.stringify({ id: 'cli', result })); process.exit(0); };
const fail = (code, message) => { save(); console.error(JSON.stringify({ error: { code, message } })); process.exit(1); };
const [g, c] = a;
if (g === 'status') { save(); console.log('server:\\n  status: running\\n  version: 0.9.5'); process.exit(0); }
// Like herdr: a workspace starts with a root tab; closing its last tab closes it; ids are never reused.
h.tabs ??= {}; h.open ??= [];
const wsOf = (tab) => h.tabs[tab];
const closeTab = (tab) => {
  const ws = wsOf(tab); delete h.tabs[tab];
  h.agents = h.agents.filter((x) => x.tab_id !== tab);
  if (ws && !Object.values(h.tabs).includes(ws)) h.open = h.open.filter((w) => w !== ws);
};
if (g === 'workspace' && c === 'get') return (h.open.includes(a[2]) ? ok({ workspace: { workspace_id: a[2] } }) : fail('workspace_not_found', 'workspace ' + a[2] + ' not found'));
h.paneCwd ??= {};
const arg = (f) => (a.indexOf(f) >= 0 ? a[a.indexOf(f) + 1] : null);
if (g === 'workspace' && c === 'create') { h.ws++; const w = 'w' + h.ws; h.open.push(w); h.paneCwd[w + ':p0'] = arg('--cwd'); h.tabs[w + ':t0'] = w; h.labels = { ...h.labels, [w + ':t0']: '1' }; return ok({ workspace: { workspace_id: w }, tab: { tab_id: w + ':t0' }, root_pane: { pane_id: w + ':p0' } }); }
if (g === 'workspace' && c === 'close') {
  if (!h.open.includes(a[2])) return fail('workspace_not_found', 'workspace ' + a[2] + ' not found');
  h.open = h.open.filter((w) => w !== a[2]); for (const t of Object.keys(h.tabs)) if (h.tabs[t] === a[2]) delete h.tabs[t];
  h.closedWorkspaces = [...(h.closedWorkspaces ?? []), a[2]]; return ok({ closed: a[2] });
}
if (g === 'tab' && c === 'create') { h.tab++; const ws = a[a.indexOf('--workspace') + 1]; const t = ws + ':t' + h.tab; h.tabs[t] = ws; h.paneCwd[ws + ':p' + h.tab] = arg('--cwd'); h.labels = { ...h.labels, [t]: a[a.indexOf('--label') + 1] }; return ok({ tab: { tab_id: t }, root_pane: { pane_id: ws + ':p' + h.tab } }); }
if (g === 'tab' && c === 'rename') { if (!wsOf(a[2])) return fail('tab_not_found', 'no tab'); h.labels[a[2]] = a[3]; return ok({ tab: { tab_id: a[2], label: a[3] } }); }
if (g === 'tab' && c === 'focus') { h.focused = a[2]; return ok({ tab: { tab_id: a[2] } }); }
if (g === 'pane' && c === 'split') {
  h.tab++; const from = arg('--pane'); const ws = from.split(':')[0]; const id = ws + ':p' + h.tab;
  h.paneCwd[id] = arg('--cwd'); h.splits = [...(h.splits ?? []), { from, id, direction: arg('--direction'), env: a.filter((x, i) => a[i - 1] === '--env') }];
  const r = h.paneSize?.[from]; if (r) { if (arg('--direction') === 'right') r.width = Math.floor(r.width / 2); else r.height = Math.floor(r.height / 2); }
  return ok({ pane: { pane_id: id, tab_id: from.replace(/:p.*/, ':t1'), workspace_id: ws } });
}
if (g === 'pane' && c === 'rename') { h.labels = { ...h.labels, [a[2]]: a[3] }; return ok({ pane: { pane_id: a[2] } }); }
if (g === 'pane' && c === 'close') { h.agents = h.agents.filter((x) => x.pane_id !== a[2]); h.closedPanes = [...(h.closedPanes ?? []), a[2]]; return ok({ closed: a[2] }); }
if (g === 'worktree' && c === 'create') {
  const path = arg('--cwd') + '-wt/' + arg('--branch').split('/').join('-');
  if ((h.worktrees ?? []).some((x) => x.path === path)) return fail('worktree_create_failed', "fatal: '" + path + "' already exists");
  h.ws++; const w = 'w' + h.ws; h.open.push(w); h.tabs[w + ':t0'] = w; h.labels = { ...h.labels, [w + ':t0']: '1' };
  h.paneCwd[w + ':p0'] = path;
  h.worktrees = [...(h.worktrees ?? []), { path, branch: arg('--branch'), label: arg('--label'), ws: w }];
  return ok({ type: 'worktree_created', workspace: { workspace_id: w, label: arg('--label') }, tab: { tab_id: w + ':t0' }, root_pane: { pane_id: w + ':p0', tab_id: w + ':t0' }, worktree: { path, branch: arg('--branch') } });
}
// Like herdr: removes the checkout and closes its workspace; the branch stays.
if (g === 'worktree' && c === 'remove') {
  const w = arg('--workspace'); const wt = (h.worktrees ?? []).find((x) => x.ws === w);
  if (!wt || !h.open.includes(w)) return fail('workspace_not_found', 'workspace ' + w + ' not found');
  for (const t of Object.keys(h.tabs)) if (h.tabs[t] === w) closeTab(t);
  h.worktrees = h.worktrees.filter((x) => x !== wt); h.removedWorktrees = [...(h.removedWorktrees ?? []), wt.path];
  return ok({ type: 'worktree_removed', path: wt.path, workspace_id: w });
}
// Geometry: FAKE_PANE_SIZE=WxH is the orchestrator's pane; each split halves the pane it splits.
h.paneSize ??= {};
const sizeOf = (pane) => {
  if (!h.paneSize[pane] && process.env.FAKE_PANE_SIZE) { const [w, hh] = process.env.FAKE_PANE_SIZE.split('x').map(Number); h.paneSize[pane] = { width: w, height: hh }; }
  return h.paneSize[pane];
};
if (g === 'pane' && c === 'layout') {
  const pane = arg('--pane'); const r = sizeOf(pane);
  if (!r) return fail('unknown', 'fake herdr: no geometry');
  return ok({ layout: { panes: [{ pane_id: pane, rect: { x: 0, y: 0, ...r } }] } });
}
// FAKE_SHELL_STARTING=n: the first n looks at a new pane find its startup files still running.
if (g === 'pane' && c === 'process-info') {
  h.infoCalls = (h.infoCalls ?? 0) + 1;
  const busy = h.infoCalls <= Number(process.env.FAKE_SHELL_STARTING ?? 0);
  return ok({ process_info: { pane_id: arg('--pane'), shell_pid: 100, foreground_processes: busy ? [{ pid: 101, name: 'git' }, { pid: 100, name: 'zsh' }] : [{ pid: 100, name: 'zsh' }] } });
}
// pane run of "harma _run <job>": the runner names itself after the job (unless FAKE_RUN_DEAD);
// FAKE_RUN_FINISH=1 also lets it finish at once, writing its answer and result.
if (g === 'pane' && c === 'run' && / _run /.test(a[3] ?? '')) {
  h.runs = [...(h.runs ?? []), { pane: a[2], command: a[3] }];
  if (process.env.FAKE_RUN_DEAD) return ok({ queued: true });
  const jobPath = a[3].split(' ').pop().replace(/^'|'$/g, '');
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  const done = Boolean(process.env.FAKE_RUN_FINISH);
  h.agents.push({ name: job.name, agent: 'harma-' + job.harness, pane_id: a[2], tab_id: a[2].replace(':p', ':t'), agent_status: done ? 'done' : 'working', cwd: '/x', agent_session: null });
  if (done) {
    fs.writeFileSync(job.run_dir + '/output.md', 'risposta a: ' + fs.readFileSync(job.prompt_file, 'utf8') + String.fromCharCode(10));
    fs.writeFileSync(job.run_dir + '/result.json', JSON.stringify({ exit_code: 0, signal: null, session_id: job.session_id ?? 'run-sess-1', ended_at: 'now' }));
  }
  return ok({ queued: true });
}
if (g === 'pane' && c === 'run') return ok({ queued: true });
if (g === 'pane' && c === 'read') { save(); console.log('~ ❯ node harma _run job.json' + String.fromCharCode(10) + 'zsh: command not found: node'); process.exit(0); }
// The runner's own reports, as herdr records them on the pane.
if (g === 'pane' && c === 'report-agent') {
  const pane = a[a.length - 1]; let ag = h.agents.find((x) => x.pane_id === pane);
  if (!ag) { ag = { name: null, agent: arg('--agent'), pane_id: pane, tab_id: pane.replace(':p', ':t'), cwd: '/x', agent_session: null }; h.agents.push(ag); }
  ag.agent_status = arg('--state') === 'idle' && ag.agent_status === 'working' ? 'done' : arg('--state');
  h.reports = [...(h.reports ?? []), arg('--state')];
  return ok({ type: 'ok' });
}
if (g === 'pane' && c === 'report-agent-session') {
  const dd = a.indexOf('--'); const pane = a[dd >= 0 ? dd - 1 : a.length - 1];
  const ag = h.agents.find((x) => x.pane_id === pane); if (ag) ag.agent_session = { value: arg('--agent-session-id') };
  h.sessionReports = [...(h.sessionReports ?? []), { id: arg('--agent-session-id'), resume: dd >= 0 ? a.slice(dd + 1) : null }];
  return ok({ type: 'ok' });
}
if (g === 'agent' && c === 'rename') { const ag = h.agents.find((x) => x.pane_id === a[2] || x.name === a[2]); if (!ag) return fail('agent_not_found', 'no agent'); ag.name = a[3]; return ok({ agent: ag }); }
// FAKE_PANE_BUSY=n: the pane's shell is still starting for the first n agent start calls.
if (g === 'agent' && c === 'start' && (h.startCalls = (h.startCalls ?? 0) + 1) <= Number(process.env.FAKE_PANE_BUSY ?? 0)) {
  return fail('agent_pane_busy', 'agent target pane ' + arg('--pane') + ' is not an available shell');
}
if (g === 'tab' && c === 'close') { closeTab(a[2]); return ok({ closed: a[2] }); }
if (g === 'agent' && c === 'start') {
  const pane = a[a.indexOf('--pane') + 1];
  const kind = a[a.indexOf('--kind') + 1];
  h.starts = (h.starts ?? 0) + 1;
  const dd = a.indexOf('--');
  const args = dd >= 0 ? a.slice(dd + 1) : [];
  const si = args.indexOf('--session-id'); const ri = args.indexOf('--resume');
  const sid = si >= 0 ? args[si + 1] : ri >= 0 ? args[ri + 1] : (kind === 'codex' ? 'codex-' + h.starts : null);
  const blocked = process.env.FAKE_START_BLOCKED === kind;
  h.agents.push({ name: a[2], agent: kind, pane_id: pane, tab_id: pane.replace(':p', ':t'), agent_status: blocked ? 'blocked' : 'idle', cwd: '/x', agent_session: sid ? { value: sid } : null, args, dialog: blocked ? { sel: 0, path: process.env.FAKE_DIALOG_PATH || h.paneCwd[pane] || '/x' } : null });
  if (blocked) return fail('agent_not_ready', 'agent ' + a[2] + ' is blocked during startup and is not ready for prompts');
  return ok({ agent: a[2] });
}
if (g === 'agent' && c === 'list') { save(); console.log(JSON.stringify({ result: { agents: h.agents.map(({ args, dialog, ...x }) => x) } })); process.exit(0); }
if (g === 'agent' && c === 'prompt' && process.env.FAKE_PROMPT_BLOCKED) return fail('agent_blocked', 'agent ' + a[2] + ' is blocked and requires interactive input');
if (g === 'agent' && c === 'prompt') { const ag = h.agents.find((x) => x.name === a[2]); if (!ag) return fail('not_found', 'no agent'); if (ag.agent_status === 'blocked') return fail('agent_blocked', 'agent ' + a[2] + ' is blocked and requires interactive input'); ag.agent_status = process.env.FAKE_AFTER_PROMPT || 'done'; ag.last_prompt = a[3]; return ok({ submitted: true }); }
// The three folder-trust dialogs, as captured from the real CLIs (path wrapped at 40 columns).
const DIALOGS = {
  claude: { head: ['Accessing workspace:'], q: ' Quick safety check: Is this a project you created or one you trust? (Like your own code)', mark: '❯', options: ['No, exit', 'Yes, I trust this folder'], trust: 1 },
  codex: { head: ['  Folder access'], q: '  Trust this folder? Codex can read, edit, and run files here.', mark: '›', options: ['1. Trust and continue', '2. Back to Agent Command Center'], trust: 0 },
  agy: { head: ['Accessing workspace:'], q: 'Do you trust the contents of this project?', mark: '>', options: ['Yes, I trust this folder', 'No, exit'], trust: 0 },
};
const screenOf = (ag) => {
  const d = DIALOGS[ag.agent]; const p = ag.dialog.path;
  return [...d.head, ...p.match(/.{1,40}/g), d.q, ...d.options.map((o, i) => (i === ag.dialog.sel ? ' ' + d.mark + ' ' : '   ') + o), 'enter Confirm'].join(String.fromCharCode(10));
};
if (g === 'agent' && c === 'read' && a.includes('visible') && h.agents.find((x) => x.name === a[2])?.dialog) {
  save(); console.log(screenOf(h.agents.find((x) => x.name === a[2]))); process.exit(0);
}
if (g === 'agent' && c === 'send-keys') {
  const ag = h.agents.find((x) => x.name === a[2]); if (!ag) return fail('not_found', 'no agent');
  h.keys = [...(h.keys ?? []), ...a.slice(3)];
  for (const k of a.slice(3)) {
    if (!ag.dialog) continue;
    const d = DIALOGS[ag.agent];
    if (k === 'down') ag.dialog.sel = Math.min(ag.dialog.sel + 1, d.options.length - 1);
    if (k === 'enter') {
      if (ag.dialog.sel === d.trust) { ag.dialog = null; ag.agent_status = 'idle'; h.trusted = [...(h.trusted ?? []), ag.name]; }
      else { h.agents = h.agents.filter((x) => x !== ag); h.exited = [...(h.exited ?? []), ag.name]; }
    }
  }
  return ok({ type: 'ok' });
}
if (g === 'agent' && c === 'get') { const ag = h.agents.find((x) => x.name === a[2] || x.pane_id === a[2]); if (!ag) return fail('agent_not_found', 'gone'); return ok({ agent: { name: ag.name, agent_status: ag.agent_status } }); }
if (g === 'agent' && c === 'wait') { const ag = h.agents.find((x) => x.name === a[2]); if (!ag) return fail('agent_not_running', 'gone'); return ok({ agent: { name: ag.name, agent_status: ag.agent_status } }); }
if (g === 'agent' && c === 'read' && process.env.FAKE_READ_NOT_IDLE && a.includes('recent-unwrapped')) return fail('agent_not_idle', 'agent ' + a[2] + ' is working');
if (g === 'agent' && c === 'read') { save(); console.log('output of ' + a[2] + ' (' + a[a.indexOf('--source') + 1] + ')'); process.exit(0); }
fail('unknown', 'fake herdr: ' + a.join(' '));
`;

const FAKE_HC = `#!/usr/bin/env node
const fs = require('fs');
const S = process.env.FAKE_STATE;
const st = fs.existsSync(S) ? JSON.parse(fs.readFileSync(S, 'utf8')) : {};
st.hc ??= { n: 0, terms: [], calls: [] };
const h = st.hc;
const a = process.argv.slice(2);
h.calls.push(a);
const save = () => fs.writeFileSync(S, JSON.stringify(st));
const out = (o) => { save(); console.log(JSON.stringify(o)); process.exit(0); };
const [g] = a;
if (g === '--version') { save(); console.log('hc 0.1.19'); process.exit(0); }
if (g === 'server') out({ running: true });
if (g === 'run') {
  h.n++;
  const labels = {}; a.forEach((x, i) => { if (x === '--label') { const [k, v] = a[i + 1].split('='); labels[k] = v; } });
  const t = { address: 't' + h.n, name: a[a.indexOf('--name') + 1], cwd: a[a.indexOf('--cwd') + 1], labels, state: 'running', status: { status: 'idle' }, argv: a.slice(a.indexOf('--') + 1) };
  h.terms.push(t); out(t);
}
if (g === 'ls') { const lab = a.includes('--label') ? a[a.indexOf('--label') + 1].split('=') : null; out({ terminals: h.terms.filter((t) => !lab || t.labels[lab[0]] === lab[1]) }); }
if (g === 'send') { const t = h.terms.find((x) => x.name === a[2]); t.status = { status: 'done' }; out({ sent: true }); }
if (g === 'read') { save(); console.log('screen of ' + a[1]); process.exit(0); }
if (g === 'kill') { const t = h.terms.find((x) => x.name === a[2]); if (t) t.state = 'finished'; out({ killed: a[2] }); }
if (g === 'rm') { h.terms = h.terms.filter((x) => x.name !== a[2]); out({ removed: a[2] }); }
save(); console.error('fake hc: ' + a.join(' ')); process.exit(2);
`;

const fakeCodexbar = (json) => `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('CodexBar 0.84.0'); process.exit(0); }
console.log(${JSON.stringify(JSON.stringify(json))});
`;

const VERSION = (name) => `#!/usr/bin/env node
console.log('${name} 9.9.9');
`;

const FAKE_AGY = `#!/usr/bin/env node
if (process.argv[2] === 'models') console.log(process.env.FAKE_AGY_MODELS ?? '');
else if (process.argv[2] === '--version') console.log('agy 1.5.12');
else process.exit(1);
`;

export const CODEXBAR_FIXTURE = [
  { provider: 'claude', source: 'web', usage: { secondary: { usedPercent: 11, resetsAt: '2026-11-10T00:00:00Z' }, accountEmail: 'someone@example.com', identity: { accountEmail: 'someone@example.com' } } },
  { provider: 'codex', source: 'oauth', usage: { secondary: { usedPercent: 85, resetsAt: '2026-11-09T00:00:00Z' } }, openaiDashboard: { signedInEmail: 'someone@example.com', accountID: 'acct_123' }, credits: { remaining: 40 } },
  { provider: 'kimi', source: 'api', usage: { primary: { usedPercent: 98 } } },
  { provider: 'gemini', source: 'auto', error: { kind: 'provider', message: 'OAuth not supported' } },
];

export function sandbox({ codexbar = CODEXBAR_FIXTURE, bins = ['herdr', 'hc', 'codexbar', 'claude', 'codex'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'harma-test-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const project = join(root, 'project');
  for (const d of [home, bin, project]) mkdirSync(d, { recursive: true });
  const files = { herdr: FAKE_HERDR, hc: FAKE_HC, codexbar: fakeCodexbar(codexbar), claude: VERSION('claude'), codex: VERSION('codex-cli'), kimi: VERSION('kimi'), agy: FAKE_AGY, mmx: VERSION('mmx') };
  for (const name of bins) {
    const p = join(bin, name);
    writeFileSync(p, files[name]);
    chmodSync(p, 0o755);
  }
  // Only the fakes and node itself on PATH: real agent CLIs must stay invisible.
  symlinkSync(process.execPath, join(bin, 'node'));
  const statePath = join(root, 'fake-state.json');
  const env = {
    HOME: home,
    PATH: bin,
    FAKE_STATE: statePath,
    XDG_CONFIG_HOME: join(home, '.config'),
  };
  const lines = [];
  return {
    root, home, bin, project, env, statePath,
    out: (s) => lines.push(s),
    output: () => lines.join('\n'),
    clear: () => { lines.length = 0; },
    state: () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}),
    write(rel, content) {
      const p = join(home, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
      return p;
    },
    opts(extra = {}) { return { env, cwd: project, out: (s) => lines.push(s), ...extra }; },
  };
}

export const CODEX_MODELS_CACHE = {
  fetched_at: '2026-11-08T10:00:00Z',
  models: [
    { slug: 'gpt-6.1-sol', default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'max' }] },
    { slug: 'gpt-6-astra', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }] },
    { slug: 'gpt-hidden', visibility: 'hidden', supported_reasoning_levels: [] },
  ],
};
