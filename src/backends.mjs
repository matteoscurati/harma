// Terminal backends. Both expose the same interface:
//   available()                         -> {ok, version, detail}
//   start({name, cwd, argv, env, harness, project}) -> {target, tab?, sessionId?}
//   list(project)                       -> [{target, name, status, cwd, sessionId, owned, raw}]
//   prompt(target, text, {wait, timeoutSec})
//   read(target, lines)                 -> text
//   close(target)                       -> {ok}
// herdr: the full app (workspaces, tabs, panes); one tab per agent in a
// per-project workspace, so closing an agent closes its window.
// hc (herdr-core): headless terminals; ownership through labels.
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { run, which, parseJson, HarmaError } from './util.mjs';
import { meta } from './harness.mjs';

export function projectId(root) {
  return `${basename(root).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 20)}-${createHash('sha1').update(root).digest('hex').slice(0, 6)}`;
}

const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
export function checkAgentName(name) {
  if (!AGENT_NAME.test(name ?? '')) {
    throw new HarmaError(`Nome agente non valido: ${name}`, { hint: 'Usa [a-z][a-z0-9_-]{0,31}, es. builder, review-1' });
  }
}

function okJson(res, what) {
  const data = parseJson(res.stdout);
  if (!res.ok) {
    const err = parseJson(res.stderr);
    const e = new HarmaError(`${what} fallito: ${err?.error?.message ?? err?.message ?? (res.stderr.trim() || res.error || `exit ${res.code}`)}`);
    e.code = err?.error?.code ?? null;
    if (!e.code && /\bblocked\b/i.test(res.stderr)) e.code = 'agent_blocked';
    throw e;
  }
  return data;
}

// ---------------------------------------------------------------- herdr
export class HerdrBackend {
  constructor({ bin = 'herdr', env = process.env, config = {} } = {}) {
    this.name = 'herdr';
    this.bin = bin;
    this.env = env;
    this.config = config; // project config (holds herdr.workspace_id)
  }

  exec(args, opts = {}) { return run(this.bin, args, { env: this.env, ...opts }); }

  async available() {
    if (!which(this.bin, this.env)) return { ok: false, detail: 'herdr non è nel PATH' };
    const res = await this.exec(['status', 'server'], { timeout: 15_000 });
    const running = /status:\s*running/.test(res.stdout);
    const version = (res.stdout.match(/version:\s*(\S+)/) ?? [])[1] ?? null;
    return { ok: running, version, detail: running ? 'server attivo' : 'server herdr non attivo (avvia herdr)' };
  }

  async ensureWorkspace(root, project) {
    const known = this.config.herdr?.workspace_id;
    if (known) {
      const got = await this.exec(['workspace', 'get', known]);
      if (got.ok) return { id: known, created: false };
    }
    const res = await this.exec(['workspace', 'create', '--cwd', root, '--label', `harma:${project}`, '--no-focus']);
    const data = okJson(res, 'herdr workspace create');
    const id = data?.result?.workspace?.workspace_id ?? data?.result?.workspace?.id;
    if (!id) throw new HarmaError('herdr workspace create: risposta senza workspace_id');
    return { id, created: true };
  }

  async start({ name, cwd, argv, env = {}, harness, root, project }) {
    checkAgentName(name);
    const kind = meta(harness).herdrKind;
    if (!kind) throw new HarmaError(`herdr non riconosce ${harness} come agente`, { hint: 'Usa --backend hc per questa CLI' });
    const ws = await this.ensureWorkspace(root, project);
    const tabArgs = ['tab', 'create', '--workspace', ws.id, '--cwd', cwd, '--label', name, '--no-focus'];
    for (const [k, v] of Object.entries(env)) tabArgs.push('--env', `${k}=${v}`);
    const tab = okJson(await this.exec(tabArgs), 'herdr tab create');
    const tabId = tab?.result?.tab?.tab_id;
    const paneId = tab?.result?.root_pane?.pane_id;
    if (!tabId || !paneId) throw new HarmaError('herdr tab create: risposta senza tab_id/pane_id');
    const startArgs = ['agent', 'start', name, '--kind', kind, '--pane', paneId, '--timeout', '60000'];
    if (argv.length > 1) startArgs.push('--', ...argv.slice(1));
    const started = await this.exec(startArgs, { timeout: 90_000 });
    if (!started.ok) {
      const err = parseJson(started.stderr);
      // agent_not_ready keeps the agent: it is blocked at startup (e.g. trust dialog).
      if (err?.error?.code !== 'agent_not_ready') {
        await this.exec(['tab', 'close', tabId]);
        okJson(started, 'herdr agent start');
      }
    }
    return { target: name, tab: tabId, pane: paneId, workspace: ws.id, workspaceCreated: ws.created };
  }

  async list() {
    const data = okJson(await this.exec(['agent', 'list']), 'herdr agent list');
    return (data?.result?.agents ?? []).map((a) => ({
      target: a.name ?? a.pane_id,
      name: a.name ?? null,
      kind: a.agent,
      status: a.agent_status ?? null,
      cwd: a.cwd,
      tab: a.tab_id,
      pane: a.pane_id,
      sessionId: a.agent_session?.value ?? null,
      raw: a,
    }));
  }

  async prompt(target, text, { wait = false, timeoutSec = 600 } = {}) {
    const args = ['agent', 'prompt', target, text];
    if (wait) args.push('--wait', '--timeout', String(timeoutSec * 1000));
    return okJson(await this.exec(args, { timeout: (timeoutSec + 30) * 1000 }), 'herdr agent prompt');
  }

  async read(target, lines = 120) {
    const res = await this.exec(['agent', 'read', target, '--source', 'recent-unwrapped', '--lines', String(lines)]);
    const data = parseJson(res.stdout);
    if (!res.ok) okJson(res, 'herdr agent read');
    return data?.result?.text ?? data?.result?.content ?? res.stdout;
  }

  async close({ tab, target }) {
    if (!tab) throw new HarmaError(`Nessun tab registrato per ${target}: harma chiude solo le finestre che ha creato`);
    const res = await this.exec(['tab', 'close', tab]);
    return { ok: res.ok, detail: res.ok ? 'tab chiuso' : res.stderr.trim() };
  }

  /** Only for the workspace harma created for this project (config.herdr.workspace_id). */
  async closeWorkspace(id) {
    const res = await this.exec(['workspace', 'close', id]);
    return { ok: res.ok, detail: res.ok ? `workspace ${id} chiuso` : res.stderr.trim() };
  }
}

// ---------------------------------------------------------------- hc
export class HcBackend {
  constructor({ bin = 'hc', env = process.env } = {}) {
    this.name = 'hc';
    this.bin = bin;
    this.env = env;
  }

  exec(args, opts = {}) { return run(this.bin, args, { env: this.env, ...opts }); }

  async available() {
    if (!which(this.bin, this.env)) {
      return { ok: false, detail: 'hc non è nel PATH (installa herdr-core: https://github.com/herdrdev/herdr-core)' };
    }
    const v = await this.exec(['--version'], { timeout: 10_000 });
    const st = await this.exec(['server', 'status', '--json'], { timeout: 15_000 });
    return { ok: st.ok, version: v.stdout.trim().split(/\s+/).pop() || null, detail: st.ok ? 'core attivo' : 'core non raggiungibile (hc server start)' };
  }

  async start({ name, cwd, argv, env = {}, project }) {
    checkAgentName(name);
    const args = ['run', '--bg', '--json', '--name', name, '--cwd', cwd,
      '--label', `harma.project=${project}`, '--label', `harma.agent=${name}`, '--outlive-parent'];
    const envPairs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    args.push('--', ...(envPairs.length ? ['env', ...envPairs] : []), ...argv);
    const data = okJson(await this.exec(args, { timeout: 60_000 }), 'hc run');
    const t = data?.terminal ?? data?.result ?? data;
    return { target: t?.name ?? name, address: t?.address ?? null };
  }

  async list(project) {
    const args = ['ls', '--json', '--all'];
    if (project) args.push('--label', `harma.project=${project}`);
    const data = okJson(await this.exec(args), 'hc ls');
    const terms = Array.isArray(data) ? data : (data?.terminals ?? []);
    return terms.map((t) => ({
      target: t.name ?? t.address,
      name: t.name ?? null,
      address: t.address,
      status: t.state === 'finished' ? 'finished' : (t.status?.status ?? (typeof t.status === 'string' ? t.status : null)),
      cwd: t.foreground?.cwd ?? t.cwd,
      sessionId: null,
      labels: t.labels ?? {},
      raw: t,
    }));
  }

  async prompt(target, text, { wait = false, timeoutSec = 600 } = {}) {
    const args = ['send', '--json', target, text];
    if (wait) args.push('--wait', '--timeout', String(timeoutSec));
    return okJson(await this.exec(args, { timeout: (timeoutSec + 30) * 1000 }), 'hc send');
  }

  async read(target, lines = 120) {
    const res = await this.exec(['read', target, '--lines', String(lines)]);
    if (!res.ok) okJson(res, 'hc read');
    return res.stdout;
  }

  async close({ target }) {
    const k = await this.exec(['kill', '--json', target]);
    const r = await this.exec(['rm', '--json', target]);
    return { ok: k.ok || r.ok, detail: [k.ok ? 'terminato' : k.stderr.trim(), r.ok ? 'rimosso' : r.stderr.trim()].filter(Boolean).join('; ') };
  }
}

/** Pick the backend: explicit, else configured, else the first that is running (herdr, then hc). */
export async function selectBackend({ choice, config = {}, env = process.env } = {}) {
  const want = choice ?? (config.backend && config.backend !== 'auto' ? config.backend : null);
  const make = (n) => (n === 'herdr' ? new HerdrBackend({ env, config }) : new HcBackend({ env }));
  if (want) {
    if (!['herdr', 'hc'].includes(want)) throw new HarmaError(`Backend sconosciuto: ${want}`, { hint: 'herdr | hc' });
    const b = make(want);
    const a = await b.available();
    if (!a.ok) throw new HarmaError(`Backend ${want} non disponibile: ${a.detail}`);
    return b;
  }
  const reasons = [];
  for (const n of ['herdr', 'hc']) {
    const b = make(n);
    const a = await b.available();
    if (a.ok) return b;
    reasons.push(`${n}: ${a.detail}`);
  }
  throw new HarmaError('Nessun backend di terminali disponibile', { hint: reasons.join(' · ') });
}
