import {
  cmdInit, cmdModels, cmdCredits, cmdRank, cmdRoute, cmdDispatch, cmdSend, cmdRead,
  cmdStatus, cmdCosts, cmdCleanup, cmdResume,
} from './commands.mjs';
import { cmdInstall, cmdUninstall, cmdDoctor } from './install.mjs';
import { HarmaError } from './util.mjs';

const BOOLEAN = new Set(['json', 'yes', 'wait', 'refresh', 'dry-run', 'force', 'all', 'print-only', 'help', 'version', 'workspace']);

export function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { flags._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      if (inline !== undefined) flags[k] = inline;
      else if (BOOLEAN.has(k)) flags[k] = true;
      else if (i + 1 < argv.length) flags[k] = argv[++i];
      else throw new HarmaError(`--${k} richiede un valore`);
    } else if (a === '-h') flags.help = true;
    else flags._.push(a);
  }
  return flags;
}

export const HELP = `harma — un modello orchestratore che dirige gli altri agenti del progetto

Uso: harma <comando> [opzioni]   (--json su ogni comando per output leggibile da un agente)

Progetto
  init --orchestrator <harness>:<model> --effort <level> [--backend auto|herdr|hc] [--policy confirm|auto-within-budget]

Conoscere le risorse
  models                         CLI di agenti, modelli ed effort su questa macchina
  credits                        crediti e limiti per provider (CodexBar, budget, stima dai log)
  rank [--refresh] [--top N]     intelligenza per modello × effort (Artificial Analysis)
  route <tipo> [--author h:m]    classifica per: pianificazione, sviluppo, review, debugging, ricerca, estrazione

Delegare (con policy "confirm" serve --yes, dopo il consenso dell'utente)
  dispatch --name <n> (--model h:m [--effort e] | --task-type <tipo>) [--prompt "…" | --prompt-file f] [--wait] [--yes]
  send <nome> "<testo>" [--wait] [--yes]
  read <nome> [--lines N]

Sorvegliare
  status [--all]                 stato di ogni agente aperto
  costs                          costo per agente, crediti per provider, indicazioni di delega

Pulire e riprendere
  cleanup [--dry-run] [--agent <nome>] [--force] [--workspace]   salva l'id di sessione e chiude le finestre finite
  resume <nome> [--yes] [--print-only]             riapre la sessione salvata con il suo contesto

Installazione
  install [--target claude|codex|both] [--force]   installa la skill
  uninstall [--target …]
  doctor                                           controlla l'ambiente
`;

const COMMANDS = {
  init: cmdInit, models: cmdModels, credits: cmdCredits, rank: cmdRank, route: cmdRoute,
  dispatch: cmdDispatch, send: cmdSend, read: cmdRead, status: cmdStatus, costs: cmdCosts,
  cleanup: cmdCleanup, resume: cmdResume, install: cmdInstall, uninstall: cmdUninstall, doctor: cmdDoctor,
};

export async function main(argv, opts = {}) {
  const out = opts.out ?? ((s) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s) => process.stderr.write(s + '\n'));
  let flags;
  try { flags = parseArgs(argv); } catch (e) { err(`harma: ${e.message}`); return 2; }
  const [cmd, ...rest] = flags._;
  if (flags.version || cmd === 'version') {
    const { readFileSync } = await import('node:fs');
    out(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    return 0;
  }
  if (!cmd || flags.help || cmd === 'help') { out(HELP); return 0; }
  const fn = COMMANDS[cmd];
  if (!fn) { err(`harma: comando sconosciuto "${cmd}"\n\n${HELP}`); return 2; }
  flags._ = rest;
  try {
    const res = await fn(flags, { ...opts, out });
    return res?.exitCode ?? 0;
  } catch (e) {
    if (e instanceof HarmaError) {
      if (flags.json) out(JSON.stringify({ error: e.message, hint: e.hint ?? null }));
      else err(`harma: ${e.message}${e.hint ? `\n  → ${e.hint}` : ''}`);
      return e.exitCode ?? 1;
    }
    err(`harma: errore inatteso: ${e.stack ?? e}`);
    return 1;
  }
}
