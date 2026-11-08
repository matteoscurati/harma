// Interactive selection (harma select). A pure state machine — reduce(state, key) —
// plus render(state) and a thin keyboard/terminal layer (runTui). No dependencies.
//
// Views: list → model → effort, and confirmQuit.
// Keys:  ↑/↓ (or k/j) move · enter choose · esc back · a accept proposal ·
//        A accept all proposals · x clear row · s save · q quit
import { emitKeypressEvents } from 'node:readline';
import { ORCHESTRATOR, describe, samePick } from './roster.mjs';

export function initState({ rows, models, title = 'harma', subtitle = '' }) {
  return { view: 'list', rows, models, title, subtitle, cursor: 0, modelCursor: 0, effortCursor: 0, editModel: null, message: '', done: null };
}

const dirty = (s) => s.rows.some((r) => !sameChoice(r.choice, r.original));
function sameChoice(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.none || b.none) return Boolean(a.none && b.none);
  return samePick(a, b);
}

/** Options shown in the model view: "no model" first for task rows. */
export function modelList(s) {
  const row = s.rows[s.cursor];
  return row.type === ORCHESTRATOR ? s.models : [{ none: true }, ...s.models];
}

const clamp = (n, len) => Math.max(0, Math.min(len - 1, n));

export function reduce(s, key) {
  const k = key === 'k' ? 'up' : key === 'j' ? 'down' : key;
  const next = { ...s, message: '' };
  const row = s.rows[s.cursor];

  if (k === 'ctrl-c') return { ...next, done: 'cancel' };

  if (s.view === 'confirmQuit') {
    if (k === 's') return { ...next, done: 'save' };
    if (k === 'q') return { ...next, done: 'cancel' };
    return { ...next, view: 'list' };
  }

  if (s.view === 'list') {
    switch (k) {
      case 'up': return { ...next, cursor: clamp(s.cursor - 1, s.rows.length) };
      case 'down': return { ...next, cursor: clamp(s.cursor + 1, s.rows.length) };
      case 'return': {
        const list = modelList(s);
        const cur = row.choice && !row.choice.none ? row.choice : row.proposal;
        const i = cur ? list.findIndex((m) => !m.none && m.harness === cur.harness && m.model === cur.model) : -1;
        return { ...next, view: 'model', modelCursor: i >= 0 ? i : 0 };
      }
      case 'a':
        if (!row.proposal) return { ...next, message: 'Nessuna proposta per questa riga: scegli tu con invio.' };
        return setRow(next, s.cursor, { ...row.proposal, source: 'proposta' }, `Accettata la proposta per ${row.type}.`);
      case 'A': {
        let st = next;
        let n = 0;
        s.rows.forEach((r, i) => { if (r.proposal) { st = setRow(st, i, { ...r.proposal, source: 'proposta' }); n++; } });
        return { ...st, message: `Accettate ${n} proposte. s per salvare.` };
      }
      case 'x':
        if (row.type === ORCHESTRATOR) return { ...next, message: 'L\'orchestratore non si può svuotare.' };
        return setRow(next, s.cursor, null, `${row.type}: da decidere.`);
      case 's': return { ...next, done: 'save' };
      case 'q': case 'escape':
        return dirty(s) ? { ...next, view: 'confirmQuit' } : { ...next, done: 'cancel' };
      default: return next;
    }
  }

  if (s.view === 'model') {
    const list = modelList(s);
    switch (k) {
      case 'up': return { ...next, modelCursor: clamp(s.modelCursor - 1, list.length) };
      case 'down': return { ...next, modelCursor: clamp(s.modelCursor + 1, list.length) };
      case 'escape': case 'q': return { ...next, view: 'list' };
      case 'return': {
        const m = list[s.modelCursor];
        if (m.none) return { ...setRow(next, s.cursor, { none: true, source: 'utente' }, `${row.type}: nessun modello.`), view: 'list' };
        const prefer = [row.choice, row.proposal].find((p) => p && !p.none && p.harness === m.harness && p.model === m.model)?.effort
          ?? m.best?.effort ?? m.default_effort;
        const i = m.efforts.findIndex((e) => e.effort === prefer);
        return { ...next, view: 'effort', editModel: m, effortCursor: i >= 0 ? i : 0 };
      }
      default: return next;
    }
  }

  if (s.view === 'effort') {
    const efforts = s.editModel.efforts;
    switch (k) {
      case 'up': return { ...next, effortCursor: clamp(s.effortCursor - 1, efforts.length) };
      case 'down': return { ...next, effortCursor: clamp(s.effortCursor + 1, efforts.length) };
      case 'escape': case 'q': return { ...next, view: 'model' };
      case 'return': {
        const m = s.editModel;
        const pick = { harness: m.harness, model: m.model, effort: efforts[s.effortCursor].effort };
        pick.source = samePick(pick, row.proposal) ? 'proposta' : 'utente';
        return { ...setRow(next, s.cursor, pick, `${row.type}: ${describe(pick)}.`), view: 'list', editModel: null };
      }
      default: return next;
    }
  }
  return next;
}

function setRow(s, i, choice, message) {
  const rows = s.rows.map((r, j) => (j === i ? { ...r, choice } : r));
  return { ...s, rows, message: message ?? s.message };
}

// ── rendering ──────────────────────────────────────────────────────────────
const ESC = '\x1b[';
const style = (on) => ({
  bold: (t) => (on ? `${ESC}1m${t}${ESC}0m` : t),
  dim: (t) => (on ? `${ESC}2m${t}${ESC}0m` : t),
  inv: (t) => (on ? `${ESC}7m${t}${ESC}0m` : t),
  green: (t) => (on ? `${ESC}32m${t}${ESC}0m` : t),
  yellow: (t) => (on ? `${ESC}33m${t}${ESC}0m` : t),
});

const fit = (t, w) => (t.length > w ? `${t.slice(0, Math.max(0, w - 1))}…` : t.padEnd(w));
const num = (x, pre = '') => (x === null || x === undefined ? '?' : `${pre}${x}`);

export function render(s, { width = 100, color = true } = {}) {
  const st = style(color);
  const W = Math.max(40, width);
  const narrow = W < 90;
  const lines = [st.bold(s.title), ...(s.subtitle ? [st.dim(s.subtitle)] : []), ''];

  if (s.view === 'list' || s.view === 'confirmQuit') {
    lines.push(st.dim(narrow
      ? '↑↓ invio:scegli a:accetta A:tutte x s:salva q:esci'
      : '↑↓ sposta · invio scegli modello ed effort · a accetta proposta · A accetta tutte · x svuota · s salva · q esci'), '');
    const cType = 16;
    const cCol = narrow ? 0 : Math.min(40, Math.floor((W - cType - 4) / 2));
    lines.push(st.dim(`  ${fit('lavoro', cType)}${narrow ? '' : fit('proposta', cCol)}scelta`));
    s.rows.forEach((r, i) => {
      const prop = describe(r.proposal);
      let ch = describe(r.choice);
      if (r.choice && samePick(r.choice, r.proposal)) ch = st.green(`${ch}  ${r.type === ORCHESTRATOR ? 'attuale' : '✓ proposta'}`);
      else if (r.choice && !r.choice.none) ch = st.yellow(`${ch}  (tua)`);
      else if (r.choice?.none) ch = st.yellow(ch);
      else ch = st.dim(ch);
      const changed = !sameChoice(r.choice, r.original) ? '*' : ' ';
      const line = `${fit(r.type, cType)}${narrow ? '' : fit(prop, cCol)}`;
      lines.push(i === s.cursor ? `${st.inv(`❯${changed}${line}`)}${ch}` : ` ${changed}${line}${ch}`);
    });
    const r = s.rows[s.cursor];
    lines.push('', st.dim(r.label));
    if (narrow && r.proposal) lines.push(`proposta: ${describe(r.proposal)}`);
    if (r.proposal?.why) lines.push(st.dim(`motivi: ${r.proposal.why}`));
    if (s.view === 'confirmQuit') lines.push('', st.bold('Modifiche non salvate — s salva ed esci · q esci senza salvare · altro tasto torna'));
  }

  if (s.view === 'model') {
    const r = s.rows[s.cursor];
    lines.push(st.dim(`Modello per ${r.type} · ↑↓ sposta · invio scegli · esc indietro`), '');
    const list = modelList(s);
    const height = 18;
    const start = clamp(s.modelCursor - Math.floor(height / 2), Math.max(1, list.length - height + 1));
    list.slice(start, start + height).forEach((m, j) => {
      const i = start + j;
      const text = m.none ? '— nessun modello per questo lavoro'
        : narrow
          ? `${fit(`${m.harness}:${m.model}`, Math.max(20, W - 24))} ${fit(`max ${num(m.best?.index)}`, 9)} ${m.credit}`
          : `${fit(`${m.harness}:${m.model}`, 34)} ${fit(`indice max ${num(m.best?.index)}${m.best ? ` @${m.best.effort}` : ''}`, 24)} crediti ${m.credit}${m.remaining !== null ? ` (${m.remaining}%)` : ''}`;
      const mark = !m.none && r.proposal && r.proposal.harness === m.harness && r.proposal.model === m.model ? ' ← proposta' : '';
      lines.push(i === s.modelCursor ? st.inv(`❯ ${text}${mark}`) : `  ${text}${st.dim(mark)}`);
    });
    if (list.length > height) lines.push(st.dim(`  … ${list.length} modelli`));
  }

  if (s.view === 'effort') {
    const r = s.rows[s.cursor];
    const m = s.editModel;
    lines.push(st.dim(`Effort per ${m.harness}:${m.model} (${r.type}) · ↑↓ sposta · invio conferma · esc indietro`), '');
    if (m.effort_fixed) lines.push(st.dim('  Questa CLI non permette di scegliere l\'effort: usa il suo default.'), '');
    m.efforts.forEach((e, i) => {
      const text = `${fit(e.effort ?? 'default', 10)} indice ${fit(num(e.index), 6)} costo/task ${num(e.cost, '$')}`;
      const isProp = r.proposal && samePick({ ...r.proposal }, { harness: m.harness, model: m.model, effort: e.effort });
      const mark = isProp ? ' ← proposta' : '';
      lines.push(i === s.effortCursor ? st.inv(`❯ ${text}${mark}`) : `  ${text}${st.dim(mark)}`);
    });
    lines.push('', st.dim('Indice: Artificial Analysis Intelligence Index; ? = non misurato.'));
  }

  if (s.message) lines.push('', s.message);
  return lines.map((l) => clip(l, W)).join('\n');
}

/** Cut a line to `width` visible characters, keeping ANSI escapes intact. */
export function clip(line, width) {
  let visible = 0;
  let out = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\x1b') {
      const m = line.slice(i).match(/^\x1b\[[0-9;?]*[A-Za-z]/);
      if (m) { out += m[0]; i += m[0].length - 1; continue; }
    }
    if (visible >= width) { out += '\x1b[0m'; break; }
    out += line[i];
    visible++;
  }
  return out;
}

// ── terminal I/O ───────────────────────────────────────────────────────────
export function keyName(str, key = {}) {
  if (key.ctrl && key.name === 'c') return 'ctrl-c';
  if (['up', 'down', 'return', 'escape', 'enter'].includes(key.name)) return key.name === 'enter' ? 'return' : key.name;
  return str ?? key.name ?? null;
}

/** Run the TUI on a TTY; resolves with the final state (done: 'save' | 'cancel'). */
export function runTui(state, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY) {
    return Promise.reject(new Error('harma select richiede un terminale interattivo'));
  }
  return new Promise((resolve) => {
    let s = state;
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    output.write(`${ESC}?1049h${ESC}?25l`); // alternate screen, hide cursor
    const draw = () => output.write(`${ESC}H${ESC}2J${render(s, { width: output.columns ?? 100 })}`);
    const onKey = (str, key) => {
      const name = keyName(str, key);
      if (!name) return;
      s = reduce(s, name);
      if (s.done) {
        input.off('keypress', onKey);
        output.off('resize', draw);
        input.setRawMode(false);
        input.pause();
        output.write(`${ESC}?25h${ESC}?1049l`);
        resolve(s);
        return;
      }
      draw();
    };
    input.on('keypress', onKey);
    output.on('resize', draw);
    draw();
  });
}
