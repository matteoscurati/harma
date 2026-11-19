// Terminal backends. Both expose the same interface:
//   available()                         -> {ok, version, detail}
//   start({name, cwd, argv, env, harness, project}) -> {target, tab?, sessionId?}
//   list(project)                       -> [{target, name, status, cwd, sessionId, owned, raw}]
//   prompt(target, text, {wait, timeoutSec})
//   read(target, lines)                 -> text
//   close(target)                       -> {ok}
// herdr: the full app (workspaces, tabs, panes). Where an agent goes is the
// layout: inside herdr, next to the orchestrator (a pane beside its pane
// while there is room, then a tab in its workspace); outside, a per-project
// workspace. An agent can also get its own git worktree, which herdr opens as
// a grouped workspace, or run on another machine's herdr (--machine).
// hc (herdr-core): headless terminals; ownership through labels.
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { run, which, parseJson, HarmaError, shq } from './util.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
import { herdrKind } from './harness.mjs';
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
// A split must leave both panes usable: at least this many columns side by
// side, or rows one above the other. Cells are about twice as tall as wide.
const MIN_COLS = 60;
const MIN_ROWS = 15;

export class HerdrBackend {
  constructor({ bin = 'herdr', env = process.env, config = {}, machine = null } = {}) {
    this.name = 'herdr';
    this.bin = bin;
    this.env = env;
    this.config = config; // project config (holds herdr.workspace_id, and one per machine)
    this.machine = machine; // a saved herdr machine profile: every call goes to its server
    this.trustPolls = 30; // after answering a trust dialog: up to 30 × 500 ms
    this.trustPollMs = 500;
    this.shellWaitMs = 20_000; // a new pane's shell may still be starting: retry agent start this long
    this.shellPollMs = 250;
  }

  exec(args, opts = {}) { return run(this.bin, this.machine ? ['--machine', this.machine, ...args] : args, { env: this.env, ...opts }); }

  /** Inside herdr: the orchestrator runs in a herdr pane on this machine. */
  inside() { return !this.machine && this.env.HERDR_ENV === '1' && Boolean(this.env.HERDR_WORKSPACE_ID); }

  async available() {
    if (!which(this.bin, this.env)) return { ok: false, detail: 'herdr non è nel PATH' };
    const res = await this.exec(['status', 'server'], { timeout: 30_000 });
    const running = /status:\s*running/.test(res.stdout);
    const version = (res.stdout.match(/version:\s*(\S+)/) ?? [])[1] ?? null;
    if (this.machine) {
      return { ok: running, version, detail: running ? `server attivo su ${this.machine}` : `server herdr su ${this.machine} non raggiungibile: ${res.stderr.trim() || 'controlla herdr machine status'}` };
    }
    return { ok: running, version, detail: running ? 'server attivo' : 'server herdr non attivo (avvia herdr)' };
  }

  /**
   * The project workspace. A new one comes with a first tab and root pane
   * (herdr docs: use that pane for the first process), returned as `root` so
   * the caller fills it instead of leaving an empty shell tab behind.
   */
  async ensureWorkspace(root, project, { focus = false } = {}) {
    const known = this.machine ? this.config.herdr?.machines?.[this.machine]?.workspace_id : this.config.herdr?.workspace_id;
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
   * Where agents go. auto inside herdr (HERDR_ENV=1 with a workspace id): a
   * pane beside the orchestrator while both stay usable, else a tab in its
   * workspace; outside herdr, or on another machine, the project workspace.
   * Returns {mode, direction, fallback}: direction null means "pick by size".
   */
  layoutFor(layout = 'auto') {
    const [mode, direction = null] = String(layout || 'auto').split(':');
    if (!LAYOUTS.includes(mode) || ![null, 'right', 'down'].includes(direction)) {
      throw new HarmaError(`Layout sconosciuto: ${layout}`, { hint: 'auto | workspace | tab | split | split:right | split:down' });
    }
    if (this.machine) {
      if (mode === 'auto' || mode === 'workspace') return { mode: 'workspace' };
      throw new HarmaError(`Layout ${mode}: su ${this.machine} gli agenti si aprono nel workspace del progetto`, { hint: 'Ometti --layout, o usa --layout workspace' });
    }
    const inside = this.inside();
    if (mode === 'auto') return inside ? { mode: 'split', direction: null, fallback: 'tab' } : { mode: 'workspace' };
    if ((mode === 'tab' || mode === 'split') && !inside) {
      throw new HarmaError(`Layout ${mode}: harma non gira dentro herdr`, { hint: 'Avvia l\'orchestratore in un pane herdr, oppure usa --layout workspace' });
    }
    if (mode === 'split' && !this.env.HERDR_PANE_ID) throw new HarmaError('Layout split: manca HERDR_PANE_ID');
    return { mode, direction, fallback: null };
  }

  /**
   * Which way to split the orchestrator's pane, as herdr advises: a wide pane
   * to the right, a narrow or tall one down. null when neither way leaves two
   * usable panes and a fallback exists; with no fallback (an explicit
   * --layout split), the preferred way anyway.
   */
  async splitDirection(fallback) {
    const pane = this.env.HERDR_PANE_ID;
    const data = parseJson((await this.exec(['pane', 'layout', '--pane', pane])).stdout);
    const rect = data?.result?.layout?.panes?.find((p) => p.pane_id === pane)?.rect;
    if (!rect) return fallback ? null : 'right';
    const prefer = rect.width >= 2 * rect.height ? 'right' : 'down';
    const room = { right: rect.width >= 2 * MIN_COLS, down: rect.height >= 2 * MIN_ROWS };
    if (room[prefer]) return prefer;
    const other = prefer === 'right' ? 'down' : 'right';
    if (room[other]) return other;
    return fallback ? null : prefer;
  }

  /** A terminal for one process, per layout. Returns {tabId, paneId, layout, workspace, workspaceCreated}. */
  async place({ layout, root, project, cwd, label, env = {}, focus = false }) {
    const { mode, direction, fallback } = this.layoutFor(layout);
    if (mode === 'workspace') {
      // On another machine the project root is a local path: the workspace opens in the agent's folder there.
      const home = this.machine ? cwd : root;
      const ws = { ...await this.ensureWorkspace(home, project, { focus }), cwd: home };
      const t = await this.placeTab(ws, { cwd, label, env, focus });
      return { ...t, layout: 'workspace', workspace: ws.id, workspaceCreated: ws.created, machine: this.machine };
    }
    const way = mode === 'split' ? direction ?? await this.splitDirection(fallback) : null;
    if (mode === 'tab' || !way) {
      const t = await this.placeTab({ id: this.env.HERDR_WORKSPACE_ID, created: false }, { cwd, label, env, focus });
      return { ...t, layout: 'tab', workspace: this.env.HERDR_WORKSPACE_ID, workspaceCreated: false };
    }
    const args = ['pane', 'split', '--pane', this.env.HERDR_PANE_ID, '--direction', way, '--cwd', cwd, focus ? '--focus' : '--no-focus'];
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
    const kind = herdrKind(harness);
    if (!kind) throw new HarmaError(`herdr non riconosce ${harness} come agente interattivo`, { hint: 'Usa --headless (lavoro non interattivo) o --backend hc' });
    const at = worktree
      ? await this.worktree({ root: this.machine ? cwd : root, name, branch: worktree.branch, env })
      : await this.place({ layout, root, project, cwd, label: name, env });
    const startArgs = ['agent', 'start', name, '--kind', kind, '--pane', at.paneId, '--timeout', '60000'];
    if (argv.length > 1) startArgs.push('--', ...argv.slice(1));
    const started = await this.startWhenShellReady(startArgs);
    let blocked = false;
    if (!started.ok) {
      const code = parseJson(started.stderr)?.error?.code;
      // agent_not_ready keeps the agent: it is blocked at startup (e.g. trust dialog).
      if (code !== 'agent_not_ready') {
        await this.discard(at, name);
        if (code === 'agent_pane_busy') {
          throw new HarmaError(`herdr agent start: la shell del pane non è arrivata al prompt entro ${this.shellWaitMs / 1000} s; nessun agente è stato avviato`, {
            hint: `Apri una tab in ${at.worktree?.path ?? cwd} e guarda cosa fa la shell all'avvio (.zshrc, hook di git o di node), poi riprova`,
          });
        }
        okJson(started, 'herdr agent start');
      }
      blocked = true;
    }
    return {
      target: name, tab: at.tabId, pane: at.paneId, layout: at.layout, workspace: at.workspace,
      workspaceCreated: at.workspaceCreated, cwd: at.worktree?.path ?? cwd, worktree: at.worktree ?? null, blocked, machine: this.machine,
    };
  }

  /**
   * A headless job: a terminal placed like an agent's, where `command`
   * (harma _run <job>) starts once the shell is at its prompt. The runner
   * reports to herdr and takes the agent's name; harma waits for that name to
   * know the job started. Returns what start() returns.
   */
  async startHeadless({ name, cwd, root, project, layout, worktree, command }) {
    checkAgentName(name);
    const at = worktree
      ? await this.worktree({ root, name, branch: worktree.branch })
      : await this.place({ layout, root, project, cwd, label: name });
    if (!await this.waitForShell(at.paneId)) {
      await this.discard(at, name);
      throw new HarmaError(`la shell del pane non è arrivata al prompt entro ${this.shellWaitMs / 1000} s; il lavoro non è partito`);
    }
    okJson(await this.exec(['pane', 'run', at.paneId, command.map(shq).join(' ')]), 'herdr pane run');
    const deadline = Date.now() + this.shellWaitMs;
    while (!(await this.exec(['agent', 'get', name])).ok) {
      if (Date.now() >= deadline) {
        const screen = (await this.exec(['pane', 'read', at.paneId, '--source', 'recent', '--lines', '20'])).stdout; // plain text
        await this.discard(at, name);
        throw new HarmaError(`harma _run non è partito nel pane ${at.paneId}`, { hint: screen.trim().split('\n').slice(-5).join(' · ') || 'nessun output nel pane' });
      }
      await sleep(this.shellPollMs);
    }
    return {
      target: name, tab: at.tabId, pane: at.paneId, layout: at.layout, workspace: at.workspace,
      workspaceCreated: at.workspaceCreated, cwd: at.worktree?.path ?? cwd, worktree: at.worktree ?? null, blocked: false, machine: this.machine,
    };
  }

  /**
   * Wait until the pane's shell is at its prompt: the shell alone in the
   * foreground, which is how herdr defines an available shell. False after
   * shellWaitMs. Text typed earlier could reach a startup script instead.
   */
  async waitForShell(pane) {
    const deadline = Date.now() + this.shellWaitMs;
    for (;;) {
      const info = parseJson((await this.exec(['pane', 'process-info', '--pane', pane])).stdout)?.result?.process_info;
      const fg = info?.foreground_processes ?? [];
      if (info && fg.length && fg.every((p) => p.pid === info.shell_pid)) return true;
      if (Date.now() >= deadline) return false;
      await sleep(this.shellPollMs);
    }
  }

  /**
   * `agent start` needs the pane's shell at its prompt. A new pane, above all
   * in a new worktree, may still be running its startup files: herdr then
   * answers agent_pane_busy without starting anything, so the same call is
   * repeated until the shell is ready or shellWaitMs runs out.
   */
  async startWhenShellReady(args) {
    const deadline = Date.now() + this.shellWaitMs;
    for (;;) {
      const res = await this.exec(args, { timeout: 90_000 });
      if (res.ok || parseJson(res.stderr)?.error?.code !== 'agent_pane_busy' || Date.now() >= deadline) return res;
      await sleep(this.shellPollMs);
    }
  }

  /**
   * Undo a placement whose agent did not start. A worktree harma just created
   * holds no work yet: herdr removes the checkout (never forced, so a changed
   * one stays) and keeps the branch, so the same dispatch can run again.
   */
  async discard(at, name) {
    if (at.layout === 'worktree') {
      const res = await this.exec(['worktree', 'remove', '--workspace', at.workspace]);
      if (res.ok) return;
    }
    await this.close({ tab: at.tabId, pane: at.paneId, layout: at.layout, target: name });
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
    // The selection screen wants room: by default a tab, not a split.
    const where = (layout ?? 'auto') === 'auto' && this.inside() ? 'tab' : layout;
    const at = await this.place({ layout: where, root, project, cwd: root, label, focus: true });
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

  /** A headless job: `command` (harma _run <job>) in a background terminal. */
  async startHeadless({ name, cwd, command, project }) {
    return this.start({ name, cwd, argv: command, project });
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
export async function selectBackend({ choice, config = {}, env = process.env, machine = null } = {}) {
  const want = choice ?? (config.backend && config.backend !== 'auto' ? config.backend : null);
  const make = (n) => (n === 'herdr' ? new HerdrBackend({ env, config, machine }) : new HcBackend({ env }));
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
