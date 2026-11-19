// Terminal backends. Both expose the same interface:
//   available()                         -> {ok, version, detail}
//   start({name, cwd, argv, env, harness, project}) -> {target, tab?, sessionId?}
//   list(project)                       -> [{target, name, status, cwd, sessionId, owned, raw}]
//   prompt(target, text, {wait, timeoutSec})
//   read(target, lines)                 -> text
//   close(target)                       -> {ok}
// herdr: the full app (workspaces, tabs, panes). Where an agent goes is the
// layout: inside herdr, next to the orchestrator (a tab in its workspace, or
// a split beside its pane); outside, a per-project workspace. An agent can
// also get its own git worktree, which herdr opens as a grouped workspace.
// hc (herdr-core): headless terminals; ownership through labels.
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { run, which, parseJson, HarmaError } from './util.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
import { meta } from './harness.mjs';
import { readTrustDialog } from './trust.mjs';

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
export const LAYOUTS = ['auto', 'workspace', 'tab', 'split'];

export class HerdrBackend {
  constructor({ bin = 'herdr', env = process.env, config = {} } = {}) {
    this.name = 'herdr';
    this.bin = bin;
    this.env = env;
    this.config = config; // project config (holds herdr.workspace_id)
    this.trustPolls = 30; // after answering a trust dialog: up to 30 × 500 ms
    this.trustPollMs = 500;
  }

  exec(args, opts = {}) { return run(this.bin, args, { env: this.env, ...opts }); }

  async available() {
    if (!which(this.bin, this.env)) return { ok: false, detail: 'herdr non è nel PATH' };
    const res = await this.exec(['status', 'server'], { timeout: 15_000 });
    const running = /status:\s*running/.test(res.stdout);
    const version = (res.stdout.match(/version:\s*(\S+)/) ?? [])[1] ?? null;
    return { ok: running, version, detail: running ? 'server attivo' : 'server herdr non attivo (avvia herdr)' };
  }

  /**
   * The project workspace. A new one comes with a first tab and root pane
   * (herdr docs: use that pane for the first process), returned as `root` so
   * the caller fills it instead of leaving an empty shell tab behind.
   */
  async ensureWorkspace(root, project, { focus = false } = {}) {
    const known = this.config.herdr?.workspace_id;
    if (known) {
      const got = await this.exec(['workspace', 'get', known]);
      if (got.ok) return { id: known, created: false, root: null };
    }
    const res = await this.exec(['workspace', 'create', '--cwd', root, '--label', `harma:${project}`, focus ? '--focus' : '--no-focus']);
    const data = okJson(res, 'herdr workspace create');
    const id = data?.result?.workspace?.workspace_id ?? data?.result?.workspace?.id;
    if (!id) throw new HarmaError('herdr workspace create: risposta senza workspace_id');
    const tabId = data?.result?.tab?.tab_id;
    const paneId = data?.result?.root_pane?.pane_id;
    return { id, created: true, root: tabId && paneId ? { tabId, paneId } : null };
  }

  /**
   * A tab for one process. In a workspace harma just created, the root tab is
   * reused (renamed) when it fits: same cwd and no extra env, since `--env`
   * only applies when a tab is created. Otherwise a new tab is created and the
   * fresh, empty root tab is closed, so no stray shell tab stays behind.
   */
  async placeTab(ws, { cwd, label, env = {}, focus = false }) {
    const fresh = ws.created ? ws.root : null;
    if (fresh && cwd === ws.cwd && !Object.keys(env).length) {
      okJson(await this.exec(['tab', 'rename', fresh.tabId, label]), 'herdr tab rename');
      if (focus) await this.exec(['tab', 'focus', fresh.tabId]);
      return { tabId: fresh.tabId, paneId: fresh.paneId };
    }
    const tabArgs = ['tab', 'create', '--workspace', ws.id, '--cwd', cwd, '--label', label, focus ? '--focus' : '--no-focus'];
    for (const [k, v] of Object.entries(env)) tabArgs.push('--env', `${k}=${v}`);
    const tab = okJson(await this.exec(tabArgs), 'herdr tab create');
    const tabId = tab?.result?.tab?.tab_id;
    const paneId = tab?.result?.root_pane?.pane_id;
    if (!tabId || !paneId) throw new HarmaError('herdr tab create: risposta senza tab_id/pane_id');
    if (fresh) await this.exec(['tab', 'close', fresh.tabId]);
    return { tabId, paneId };
  }

  /**
   * Where agents go. auto: inside herdr (HERDR_ENV=1 with a workspace id),
   * a tab in the orchestrator's workspace; outside, the project workspace.
   * Returns {mode, direction}.
   */
  layoutFor(layout = 'auto') {
    const inside = this.env.HERDR_ENV === '1' && Boolean(this.env.HERDR_WORKSPACE_ID);
    const [mode, direction = 'right'] = String(layout || 'auto').split(':');
    if (!LAYOUTS.includes(mode) || !['right', 'down'].includes(direction)) {
      throw new HarmaError(`Layout sconosciuto: ${layout}`, { hint: 'auto | workspace | tab | split | split:down' });
    }
    if (mode === 'auto') return { mode: inside ? 'tab' : 'workspace', direction };
    if ((mode === 'tab' || mode === 'split') && !inside) {
      throw new HarmaError(`Layout ${mode}: harma non gira dentro herdr`, { hint: 'Avvia l\'orchestratore in un pane herdr, oppure usa --layout workspace' });
    }
    if (mode === 'split' && !this.env.HERDR_PANE_ID) throw new HarmaError('Layout split: manca HERDR_PANE_ID');
    return { mode, direction };
  }

  /** A terminal for one process, per layout. Returns {tabId, paneId, layout, workspace, workspaceCreated}. */
  async place({ layout, root, project, cwd, label, env = {}, focus = false }) {
    const { mode, direction } = this.layoutFor(layout);
    if (mode === 'workspace') {
      const ws = { ...await this.ensureWorkspace(root, project, { focus }), cwd: root };
      const t = await this.placeTab(ws, { cwd, label, env, focus });
      return { ...t, layout: 'workspace', workspace: ws.id, workspaceCreated: ws.created };
    }
    if (mode === 'tab') {
      const t = await this.placeTab({ id: this.env.HERDR_WORKSPACE_ID, created: false }, { cwd, label, env, focus });
      return { ...t, layout: 'tab', workspace: this.env.HERDR_WORKSPACE_ID, workspaceCreated: false };
    }
    const args = ['pane', 'split', '--pane', this.env.HERDR_PANE_ID, '--direction', direction, '--cwd', cwd, focus ? '--focus' : '--no-focus'];
    for (const [k, v] of Object.entries(env)) args.push('--env', `${k}=${v}`);
    const pane = okJson(await this.exec(args), 'herdr pane split')?.result?.pane;
    if (!pane?.pane_id) throw new HarmaError('herdr pane split: risposta senza pane_id');
    await this.exec(['pane', 'rename', pane.pane_id, label]);
    return { tabId: pane.tab_id ?? null, paneId: pane.pane_id, layout: 'split', workspace: this.env.HERDR_WORKSPACE_ID, workspaceCreated: false };
  }

  /**
   * A git worktree for one agent: herdr creates the checkout and opens it as a
   * workspace grouped with the project's, whose root tab hosts the agent.
   */
  async worktree({ root, name, branch, env = {} }) {
    const res = okJson(await this.exec(['worktree', 'create', '--cwd', root, '--branch', branch, '--label', `harma:${name}`, '--no-focus']), 'herdr worktree create');
    const r = res?.result ?? {};
    const path = r.worktree?.path;
    const id = r.workspace?.workspace_id;
    if (!path || !id || !r.tab?.tab_id || !r.root_pane?.pane_id) throw new HarmaError('herdr worktree create: risposta incompleta');
    const ws = { id, created: true, cwd: path, root: { tabId: r.tab.tab_id, paneId: r.root_pane.pane_id } };
    const t = await this.placeTab(ws, { cwd: path, label: name, env });
    return { ...t, layout: 'worktree', workspace: id, workspaceCreated: false, worktree: { path, branch: r.worktree.branch ?? branch } };
  }

  async start({ name, cwd, argv, env = {}, harness, root, project, layout, worktree }) {
    checkAgentName(name);
    const kind = meta(harness).herdrKind;
    if (!kind) throw new HarmaError(`herdr non riconosce ${harness} come agente`, { hint: 'Usa --backend hc per questa CLI' });
    const at = worktree
      ? await this.worktree({ root, name, branch: worktree.branch, env })
      : await this.place({ layout, root, project, cwd, label: name, env });
    const startArgs = ['agent', 'start', name, '--kind', kind, '--pane', at.paneId, '--timeout', '60000'];
    if (argv.length > 1) startArgs.push('--', ...argv.slice(1));
    const started = await this.exec(startArgs, { timeout: 90_000 });
    let blocked = false;
    if (!started.ok) {
      const err = parseJson(started.stderr);
      // agent_not_ready keeps the agent: it is blocked at startup (e.g. trust dialog).
      if (err?.error?.code !== 'agent_not_ready') {
        await this.close({ tab: at.tabId, pane: at.paneId, layout: at.layout, target: name });
        okJson(started, 'herdr agent start');
      }
      blocked = true;
    }
    return {
      target: name, tab: at.tabId, pane: at.paneId, layout: at.layout, workspace: at.workspace,
      workspaceCreated: at.workspaceCreated, cwd: at.worktree?.path ?? cwd, worktree: at.worktree ?? null, blocked,
    };
  }

  /**
   * Answer the folder-trust dialog of a just-started agent: only when the
   * screen is that harness's dialog for `cwd`. Moves to the trust option,
   * checking the selection before each Enter. Returns {ok, detail}.
   */
  async answerTrust({ target, harness, cwd }) {
    const screen = async () => {
      const res = await this.exec(['agent', 'read', target, '--source', 'visible']);
      return res.ok ? (parseJson(res.stdout)?.result?.read?.text ?? res.stdout) : '';
    };
    let seen = readTrustDialog(harness, await screen(), cwd);
    if (!seen.dialog) return { ok: false, detail: 'sullo schermo non c\'è il dialogo di fiducia atteso' };
    if (!seen.path) return { ok: false, detail: `il dialogo non mostra la cartella ${cwd}` };
    for (let i = 0; i < 4 && !seen.selected; i++) {
      await this.exec(['agent', 'send-keys', target, 'down']);
      seen = readTrustDialog(harness, await screen(), cwd);
      if (!seen.dialog) return { ok: false, detail: 'il dialogo è cambiato mentre harma lo leggeva' };
    }
    if (!seen.selected) return { ok: false, detail: 'opzione di fiducia non trovata' };
    await this.exec(['agent', 'send-keys', target, 'enter']);
    // herdr may still report the old blocked state for a moment: first the
    // dialog must leave the screen, then the state must leave blocked.
    const status = async () => parseJson((await this.exec(['agent', 'get', target])).stdout)?.result?.agent?.agent_status ?? null;
    let last = null;
    for (let i = 0; i < this.trustPolls; i++) {
      if (i) await sleep(this.trustPollMs);
      if (readTrustDialog(harness, await screen(), cwd).dialog) continue;
      last = await status();
      if (last && last !== 'blocked') break;
    }
    if (!last || last === 'blocked') return { ok: false, detail: `dopo la fiducia l'agente è ${last ?? 'in stato sconosciuto'}` };
    return { ok: true, detail: `fiducia data a ${cwd}` };
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
    let res = await this.exec(['agent', 'read', target, '--source', 'recent-unwrapped', '--lines', String(lines)]);
    // Full-screen agents (Claude Code, OpenCode) keep history in the alternate
    // screen: herdr scrolls it only while idle and answers agent_not_idle
    // otherwise. The visible screen is still readable.
    if (!res.ok && parseJson(res.stderr)?.error?.code === 'agent_not_idle') {
      res = await this.exec(['agent', 'read', target, '--source', 'visible', '--lines', String(lines)]);
    }
    const data = parseJson(res.stdout);
    if (!res.ok) okJson(res, 'herdr agent read');
    return data?.result?.text ?? data?.result?.read?.text ?? data?.result?.content ?? res.stdout;
  }

  async close({ tab, pane, layout, target }) {
    if (layout === 'split' && pane) {
      const res = await this.exec(['pane', 'close', pane]);
      return { ok: res.ok, detail: res.ok ? 'pane chiuso' : res.stderr.trim() };
    }
    if (!tab) throw new HarmaError(`Nessun tab registrato per ${target}: harma chiude solo le finestre che ha creato`);
    const res = await this.exec(['tab', 'close', tab]);
    return { ok: res.ok, detail: res.ok ? 'tab chiuso' : res.stderr.trim() };
  }

  /** A focused tab in the project workspace running a shell command (used for the select TUI). */
  async openTab({ root, project, label, command, layout }) {
    const at = await this.place({ layout, root, project, cwd: root, label, focus: true });
    okJson(await this.exec(['pane', 'run', at.paneId, command]), 'herdr pane run');
    return { tab: at.tabId, pane: at.paneId, layout: at.layout, workspace: at.workspace, workspaceCreated: at.workspaceCreated };
  }

  /** Only for the workspace harma created for this project (config.herdr.workspace_id). */
  async closeWorkspace(id) {
    const res = await this.exec(['workspace', 'close', id]);
    // herdr closes a workspace with its last tab: already gone counts as closed.
    if (!res.ok && parseJson(res.stderr)?.error?.code === 'workspace_not_found') return { ok: true, detail: `workspace ${id} già chiuso` };
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
