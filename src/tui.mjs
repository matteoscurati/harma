// Interactive selection (harma select). A pure state machine — reduce(state, key) —
// plus render(state) and a thin keyboard/terminal layer (runTui). No dependencies.
//
// Views: list → picks (a job's models, in order) → model → effort, and confirmQuit.
// The orchestrator row has one model: list → model → effort.
// Keys (list):  ↑/↓ (k/j) move · enter open · a accept proposal · A accept all ·
//               x clear row · s save · q quit
// Keys (picks): ↑/↓ move · enter change · + add · d remove · K/J (shift ↑/↓) move the
//               model up/down · a proposal · esc back
import { emitKeypressEvents } from 'node:readline';
import { ORCHESTRATOR, MAX_PICKS, describe, describePick, samePick, sameChoice } from './roster.mjs';

export function initState({ rows, models, title = 'harma', subtitle = '' }) {
  return { view: 'list', rows, models, title, subtitle, cursor: 0, pickCursor: 0, modelCursor: 0, effortCursor: 0, editIndex: 0, editModel: null, message: '', done: null };
}

const dirty = (s) => s.rows.some((r) => !sameChoice(r.choice, r.original));
const picksOf = (row) => (row.choice && !row.choice.none ? row.choice.picks ?? [] : []);

/** Options shown in the model view: "no model" first for task rows. */
export function modelList(s) {
  const row = s.rows[s.cursor];
  return row.single ? s.models : [{ none: true }, ...s.models];
}

const clamp = (n, len) => Math.max(0, Math.min(len - 1, n));
const sourceFor = (row, picks) => (row.proposal && sameChoice({ picks }, row.proposal) ? 'proposta' : 'utente');

/** Open the model list to replace pick `index` (or add one when index === picks.length). */
function openModel(s, next, index) {
  const row = s.rows[s.cursor];
  const picks = picksOf(row);
  const list = modelList(s);
  const target = picks[index]
    ?? row.proposal?.picks.find((p) => !picks.some((q) => q.harness === p.harness && q.model === p.model));
  let i = target ? list.findIndex((m) => !m.none && m.harness === target.harness && m.model === target.model) : -1;
  // Otherwise the first model not already in the list.
  if (i < 0) i = list.findIndex((m) => !m.none && !picks.some((q) => q.harness === m.harness && q.model === m.model));
  return { ...next, view: 'model', editIndex: index, modelCursor: i >= 0 ? i : 0 };
}

function setPicks(s, row, picks, message) {
  const choice = picks.length ? { picks, source: sourceFor(row, picks) } : null;
  return setRow(s, s.cursor, choice, message);
}

export function reduce(s, key) {
  const k = key === 'k' ? 'up' : key === 'j' ? 'down' : key === 'shift-up' ? 'K' : key === 'shift-down' ? 'J' : key;
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
      case 'return':
        // A job with models opens its ordered list; otherwise go straight to the first model.
        if (row.single || !picksOf(row).length) return openModel(s, next, 0);
        return { ...next, view: 'picks', pickCursor: 0 };
      case 'a':
        if (!row.proposal) return { ...next, message: 'Nessuna proposta per questa riga: scegli tu con invio.' };
        return setRow(next, s.cursor, { picks: [...row.proposal.picks], source: 'proposta' }, `Accettata la proposta per ${row.type}.`);
      case 'A': {
        let st = next;
        let n = 0;
        s.rows.forEach((r, i) => { if (r.proposal) { st = setRow(st, i, { picks: [...r.proposal.picks], source: 'proposta' }); n++; } });
        return { ...st, message: `Accettate ${n} proposte. s per salvare.` };
      }
      case 'x':
        if (row.single) return { ...next, message: 'L\'orchestratore non si può svuotare.' };
        return setRow(next, s.cursor, null, `${row.type}: da decidere.`);
      case 's': return { ...next, done: 'save' };
      case 'q': case 'escape':
        return dirty(s) ? { ...next, view: 'confirmQuit' } : { ...next, done: 'cancel' };
      default: return next;
    }
  }

  if (s.view === 'picks') {
    const picks = picksOf(row);
    const n = picks.length + 1; // the last line is "+ aggiungi"
    const at = s.pickCursor;
    switch (k) {
      case 'up': return { ...next, pickCursor: clamp(at - 1, n) };
      case 'down': return { ...next, pickCursor: clamp(at + 1, n) };
      case 'escape': case 'q': return { ...next, view: 'list' };
      case 'return':
        if (at < picks.length) return openModel(s, next, at);
        // fall through: the "+ aggiungi" line
      case '+': case '=':
        if (picks.length >= MAX_PICKS) return { ...next, message: `Al massimo ${MAX_PICKS} modelli per lavoro.` };
        return openModel(s, next, picks.length);
      case 'd': case 'x': case 'backspace': case 'delete': {
        if (at >= picks.length) return next;
        const left = picks.filter((_, i) => i !== at);
        const st = setPicks(next, row, left, `Tolto ${describePick(picks[at])}.`);
        return left.length ? { ...st, pickCursor: clamp(at, left.length + 1) } : { ...st, view: 'list' };
      }
      case 'K': case 'J': {
        const to = k === 'K' ? at - 1 : at + 1;
        if (at >= picks.length || to < 0 || to >= picks.length) return next;
        const moved = [...picks];
        [moved[at], moved[to]] = [moved[to], moved[at]];
        return { ...setPicks(next, row, moved), pickCursor: to };
      }
      case 'a':
        if (!row.proposal) return { ...next, message: 'Nessuna proposta per questo lavoro.' };
        return { ...setRow(next, s.cursor, { picks: [...row.proposal.picks], source: 'proposta' }, 'Lista sostituita con la proposta.'), pickCursor: 0 };
      default: return next;
    }
  }

  if (s.view === 'model') {
    const list = modelList(s);
    const back = row.single || !picksOf(row).length ? 'list' : 'picks';
    switch (k) {
      case 'up': return { ...next, modelCursor: clamp(s.modelCursor - 1, list.length) };
      case 'down': return { ...next, modelCursor: clamp(s.modelCursor + 1, list.length) };
      case 'escape': case 'q': return { ...next, view: back };
      case 'return': {
        const m = list[s.modelCursor];
        if (m.none) return { ...setRow(next, s.cursor, { none: true, source: 'utente' }, `${row.type}: nessun modello.`), view: 'list' };
        const same = (p) => p && p.harness === m.harness && p.model === m.model;
        const prefer = [picksOf(row)[s.editIndex], ...(row.proposal?.picks ?? [])].find(same)?.effort
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
        if (row.single) {
          return { ...setRow(next, s.cursor, { picks: [pick], source: 'utente' }, `${row.type}: ${describePick(pick)}.`), view: 'list', editModel: null };
        }
        const picks = picksOf(row);
        const dup = picks.findIndex((p, i) => i !== s.editIndex && samePick(p, pick));
        if (dup >= 0) return { ...next, view: 'picks', editModel: null, pickCursor: dup, message: `${describePick(pick)} è già nella lista (n.${dup + 1}).` };
        const updated = [...picks];
        updated[s.editIndex] = pick;
        const verb = s.editIndex < picks.length ? 'Cambiato' : 'Aggiunto';
        return { ...setPicks(next, row, updated, `${verb}: ${describePick(pick)} (n.${s.editIndex + 1}).`), view: 'picks', editModel: null, pickCursor: s.editIndex };
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
const creditText = (m) => (m ? `crediti ${m.credit}${m.remaining !== null && m.remaining !== undefined ? ` (${m.remaining}%)` : ''}` : 'crediti ?');

export function render(s, { width = 100, color = true } = {}) {
  const st = style(color);
  const W = Math.max(40, width);
  const narrow = W < 90;
  const lines = [st.bold(s.title), ...(s.subtitle ? [st.dim(s.subtitle)] : []), ''];
  const row = s.rows[s.cursor];

  if (s.view === 'list' || s.view === 'confirmQuit') {
    lines.push(st.dim(narrow
      ? '↑↓ invio:apri a:accetta A:tutte x s:salva q:esci'
      : '↑↓ sposta · invio apri (modelli ed effort) · a accetta proposta · A accetta tutte · x svuota · s salva · q esci'), '');
    const cType = 16;
    const cCol = narrow ? 0 : Math.min(40, Math.floor((W - cType - 4) / 2));
    lines.push(st.dim(`  ${fit('lavoro', cType)}${narrow ? '' : fit('proposta', cCol)}scelta (in ordine di preferenza)`));
    s.rows.forEach((r, i) => {
      const pp = r.proposal?.picks ?? [];
      const prop = pp.length > 1 ? `${describePick(pp[0])} +${pp.length - 1}` : describe(r.proposal);
      let ch = describe(r.choice);
      if (r.choice && !r.choice.none && r.proposal && sameChoice(r.choice, r.proposal)) ch = st.green(`${ch}  ${r.single ? 'attuale' : '✓ proposta'}`);
      else if (r.choice && !r.choice.none) ch = st.yellow(`${ch}  ${r.choice.source === 'proposta' ? '(proposta precedente)' : '(tua)'}`);
      else if (r.choice?.none) ch = st.yellow(ch);
      else ch = st.dim(ch);
      const changed = !sameChoice(r.choice, r.original) ? '*' : ' ';
      const line = `${fit(r.type, cType)}${narrow ? '' : `${fit(prop, cCol - 1)} `}`;
      lines.push(i === s.cursor ? `${st.inv(`❯${changed}${line}`)}${ch}` : ` ${changed}${line}${ch}`);
    });
    lines.push('', st.dim(row.label));
    if (row.proposal) lines.push(...wrap(`proposta: ${describe(row.proposal)}`, W));
    if (row.proposal?.why) lines.push(...wrap(`motivi: ${row.proposal.why}`, W).map(st.dim));
    if (!row.single) lines.push(...wrap('Invio apre la lista dei modelli del lavoro: puoi metterne più di uno, in ordine; al dispatch harma usa il primo con crediti utilizzabili.', W).map(st.dim));
    if (s.view === 'confirmQuit') lines.push('', st.bold('Modifiche non salvate — s salva ed esci · q esci senza salvare · altro tasto torna'));
  }

  if (s.view === 'picks') {
    const picks = picksOf(row);
    lines.push(st.bold(`Modelli per ${row.type}, in ordine di preferenza`), st.dim(narrow
      ? 'invio:cambia +:aggiungi d:togli K/J:sposta a:proposta esc'
      : '↑↓ sposta · invio cambia · + aggiungi · d togli · K/J (shift ↑↓) sposta su/giù · a proposta · esc indietro'), '');
    picks.forEach((p, i) => {
      const m = s.models.find((x) => x.harness === p.harness && x.model === p.model);
      const e = m?.efforts.find((x) => x.effort === p.effort);
      const text = narrow
        ? `${i + 1}. ${describePick(p)}  ${m?.credit ?? '?'}`
        : `${i + 1}. ${fit(describePick(p), 40)} indice ${fit(num(e?.index), 6)} ${fit(`costo/task ${num(e?.cost, '$')}`, 18)} ${creditText(m)}`;
      lines.push(i === s.pickCursor ? st.inv(`❯ ${text}`) : `  ${text}`);
    });
    const add = picks.length >= MAX_PICKS ? st.dim(`(massimo ${MAX_PICKS} modelli)`) : '+ aggiungi un modello';
    lines.push(s.pickCursor === picks.length ? st.inv(`❯ ${add}`) : `  ${add}`);
    lines.push('', ...wrap('Al dispatch harma prende il primo della lista. Salta un modello se la sua CLI manca o i crediti sono esauriti, e preferisce uno dopo se i crediti del primo sono "scarso" e quelli dell\'altro no.', W).map(st.dim));
    if (row.proposal) lines.push('', ...wrap(`proposta: ${describe(row.proposal)}`, W).map(st.dim));
  }

  if (s.view === 'model') {
    const adding = !row.single && s.editIndex >= picksOf(row).length;
    lines.push(st.dim(`${row.single ? 'Modello' : adding ? `Aggiungi il modello n.${s.editIndex + 1}` : `Cambia il modello n.${s.editIndex + 1}`} per ${row.type} · ↑↓ sposta · invio scegli · esc indietro`), '');
    const list = modelList(s);
    const height = 18;
    const start = clamp(s.modelCursor - Math.floor(height / 2), Math.max(1, list.length - height + 1));
    const proposed = row.proposal?.picks ?? [];
    const taken = picksOf(row);
    list.slice(start, start + height).forEach((m, j) => {
      const i = start + j;
      const text = m.none ? '— nessun modello per questo lavoro'
        : narrow
          ? `${fit(`${m.harness}:${m.model}`, Math.min(30, W - 30))} ${fit(`max ${num(m.best?.index)}`, 9)} ${m.credit}`
          : `${fit(`${m.harness}:${m.model}`, 34)} ${fit(`indice max ${num(m.best?.index)}${m.best ? ` @${m.best.effort}` : ''}`, 24)} ${creditText(m)}`;
      const pi = m.none ? -1 : proposed.findIndex((p) => p.harness === m.harness && p.model === m.model);
      const ti = m.none ? -1 : taken.findIndex((p) => p.harness === m.harness && p.model === m.model);
      const mark = narrow
        ? `${ti >= 0 ? ` n.${ti + 1}` : ''}${pi === 0 ? ' ←prop.' : pi > 0 ? ' ←ris.' : ''}`
        : `${ti >= 0 ? ` · già n.${ti + 1}` : ''}${pi === 0 ? ' ← proposta' : pi > 0 ? ' ← riserva proposta' : ''}`;
      lines.push(i === s.modelCursor ? st.inv(`❯ ${text}${mark}`) : `  ${text}${st.dim(mark)}`);
    });
    if (list.length > height) lines.push(st.dim(`  … ${list.length} modelli`));
  }

  if (s.view === 'effort') {
    const m = s.editModel;
    lines.push(st.dim(`Effort per ${m.harness}:${m.model} (${row.type}) · ↑↓ sposta · invio conferma · esc indietro`), '');
    if (m.effort_fixed) lines.push(st.dim('  Questa CLI non permette di scegliere l\'effort: usa il suo default.'), '');
    m.efforts.forEach((e, i) => {
      const text = `${fit(e.effort ?? 'default', 10)} indice ${fit(num(e.index), 6)} costo/task ${num(e.cost, '$')}`;
      const isProp = (row.proposal?.picks ?? []).some((p) => samePick(p, { harness: m.harness, model: m.model, effort: e.effort }));
      const mark = isProp ? ' ← proposta' : '';
      lines.push(i === s.effortCursor ? st.inv(`❯ ${text}${mark}`) : `  ${text}${st.dim(mark)}`);
    });
    lines.push('', st.dim('Indice: Artificial Analysis Intelligence Index; ? = non misurato.'));
  }

  if (s.message) lines.push('', s.message);
  return lines.map((l) => clip(l, W)).join('\n');
}

/** Word-wrap plain text to `width` columns. */
export function wrap(text, width) {
  const out = [];
  let line = '';
  for (const word of String(text).split(' ')) {
    if (line && line.length + 1 + word.length > width) { out.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
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
  if (key.shift && (key.name === 'up' || key.name === 'down')) return `shift-${key.name}`;
  if (['up', 'down', 'return', 'escape', 'enter', 'backspace', 'delete'].includes(key.name)) return key.name === 'enter' ? 'return' : key.name;
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
