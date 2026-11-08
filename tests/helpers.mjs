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
const a = process.argv.slice(2);
h.calls.push(a);
const save = () => fs.writeFileSync(S, JSON.stringify(st));
const ok = (result) => { save(); console.log(JSON.stringify({ id: 'cli', result })); process.exit(0); };
const fail = (code, message) => { save(); console.error(JSON.stringify({ error: { code, message } })); process.exit(1); };
const [g, c] = a;
if (g === 'status') { save(); console.log('server:\\n  status: running\\n  version: 0.9.5'); process.exit(0); }
if (g === 'workspace' && c === 'get') return (a[2] === 'w' + h.ws ? ok({ workspace: { workspace_id: a[2] } }) : fail('not_found', 'no ws'));
if (g === 'workspace' && c === 'create') { h.ws++; return ok({ workspace: { workspace_id: 'w' + h.ws }, tab: { tab_id: 'w' + h.ws + ':t0' }, root_pane: { pane_id: 'w' + h.ws + ':p0' } }); }
if (g === 'workspace' && c === 'close') { h.closedWorkspaces = [...(h.closedWorkspaces ?? []), a[2]]; return ok({ closed: a[2] }); }
if (g === 'tab' && c === 'create') { h.tab++; const ws = a[a.indexOf('--workspace') + 1]; return ok({ tab: { tab_id: ws + ':t' + h.tab }, root_pane: { pane_id: ws + ':p' + h.tab } }); }
if (g === 'pane' && c === 'run') return ok({ queued: true });
if (g === 'tab' && c === 'close') { h.agents = h.agents.filter((x) => x.tab_id !== a[2]); return ok({ closed: a[2] }); }
if (g === 'agent' && c === 'start') {
  const pane = a[a.indexOf('--pane') + 1];
  const kind = a[a.indexOf('--kind') + 1];
  const dd = a.indexOf('--');
  const args = dd >= 0 ? a.slice(dd + 1) : [];
  const si = args.indexOf('--session-id'); const ri = args.indexOf('--resume');
  const sid = si >= 0 ? args[si + 1] : ri >= 0 ? args[ri + 1] : (kind === 'codex' ? 'codex-' + h.tab : null);
  h.agents.push({ name: a[2], agent: kind, pane_id: pane, tab_id: pane.replace(':p', ':t'), agent_status: 'idle', cwd: '/x', agent_session: sid ? { value: sid } : null, args });
  return ok({ agent: a[2] });
}
if (g === 'agent' && c === 'list') { save(); console.log(JSON.stringify({ result: { agents: h.agents.map(({ args, ...x }) => x) } })); process.exit(0); }
if (g === 'agent' && c === 'prompt' && process.env.FAKE_PROMPT_BLOCKED) return fail('agent_blocked', 'agent ' + a[2] + ' is blocked and requires interactive input');
if (g === 'agent' && c === 'prompt') { const ag = h.agents.find((x) => x.name === a[2]); if (!ag) return fail('not_found', 'no agent'); ag.agent_status = process.env.FAKE_AFTER_PROMPT || 'done'; ag.last_prompt = a[3]; return ok({ submitted: true }); }
if (g === 'agent' && c === 'read') return ok({ text: 'output of ' + a[2] });
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
  const files = { herdr: FAKE_HERDR, hc: FAKE_HC, codexbar: fakeCodexbar(codexbar), claude: VERSION('claude'), codex: VERSION('codex-cli'), kimi: VERSION('kimi') };
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
