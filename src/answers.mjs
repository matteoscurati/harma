// An agent that waits on a question or a permission request (herdr state
// "blocked") can be answered by the orchestrator: `harma answer`. The
// project's policy (`harma answers <level>`, the user's choice) says how far
// the orchestrator may go, and harma reads the choice on screen so that Enter
// lands on the option the orchestrator named.

// off: nothing; questions: questions about the work; permissions (default):
// also one-time permissions; all: also options that grant a lasting permission.
export const ANSWER_LEVELS = ['off', 'questions', 'permissions', 'all'];
export const ANSWER_KINDS = ['question', 'permission'];

export function answerPolicy(cfg) {
  return ANSWER_LEVELS.includes(cfg?.answers) ? cfg.answers : 'permissions';
}

// Options that grant more than the request on screen, as worded by Claude
// Code ("Yes, and don't ask again…", "allow all edits during this session"),
// Codex ("Yes, and don't ask again for this command") and Gemini-family CLIs
// ("Yes, allow always", "Allow for this session"). Checked on every answer:
// an option worded like this is a permission, whatever --kind says.
const STANDING = /don'?t ask again|allow always|always allow|for (?:this|the) session|during this session|\ballow all\b|non chiedere più|consenti sempre|per (?:questa|la) sessione/i;

export const standingGrant = (option) => STANDING.test(option ?? '');

/**
 * May the orchestrator give this answer? With --yes the user approved it.
 * `option` is the text of the option about to be confirmed, when known.
 * Returns {allowed, by} or {allowed: false, reason}.
 */
export function answerGate(level, { kind, option = null, keys = false, confirmed = false }) {
  if (confirmed) return { allowed: true, by: 'utente (--yes)' };
  if (level === 'off') return { allowed: false, reason: 'policy answers off: alle domande degli agenti risponde l\'utente' };
  if (kind === 'permission' && level === 'questions') return { allowed: false, reason: 'policy answers questions: i permessi li dà l\'utente' };
  if (level === 'all') return { allowed: true, by: 'policy answers all' };
  if (kind === 'permission' && keys) return { allowed: false, reason: 'un permesso dato con --keys: harma non può leggere che cosa viene approvato' };
  if (standingGrant(option)) return { allowed: false, reason: `«${option}» dà un permesso che resta oltre questa richiesta` };
  return { allowed: true, by: `policy answers ${level}` };
}

// The selected line of a choice list: Claude Code marks it with ❯, Codex
// with ›, Antigravity with >, Gemini-family CLIs with ●.
const MARK = /^\s*[❯›>●▶▸]\s+(.*\S)\s*$/;

/** The selected option on a screen: the last marked line (dialogs sit at the bottom). */
export function selectedOption(screen) {
  const lines = String(screen ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(MARK);
    if (m) return m[1];
  }
  return null;
}

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
const NUMBER = /^(\d+)[.)]\s*/;
const label = (s) => norm(s).replace(NUMBER, '');

/**
 * Which of `options` (as read on screen) the orchestrator means by `want`:
 * a number ("2", matched to "2. …"), else the option whose label equals,
 * starts with, or contains the text. Returns {index} or {error}.
 */
export function pickOption(options, want) {
  const w = norm(want);
  if (/^\d+$/.test(w)) {
    if (!options.some((o) => NUMBER.test(norm(o)))) return { error: 'le opzioni sullo schermo non sono numerate: indica il testo dell\'opzione' };
    const i = options.findIndex((o) => norm(o).match(NUMBER)?.[1] === w);
    return i >= 0 ? { index: i } : { error: `nessuna opzione numero ${w}` };
  }
  const wl = w.replace(NUMBER, '');
  const tiers = [
    (l) => l === wl,
    (l) => l.startsWith(wl),
    (l) => l.includes(wl),
    // A long label wraps: the screen shows only its first part.
    (l) => l.length >= 8 && wl.startsWith(l),
  ];
  for (const fits of tiers) {
    const hits = options.map((o, i) => (fits(label(o)) ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 1) return { index: hits[0] };
    if (hits.length > 1) return { error: `«${want}» corrisponde a più opzioni: ${hits.map((i) => options[i]).join(' | ')}` };
  }
  return { error: `nessuna opzione corrisponde a «${want}»` };
}
