// install / uninstall / doctor.
// The skill directory (skill/) is copied to ~/.claude/skills/harma and/or
// ~/.codex/skills/harma. Both hosts load <dir>/SKILL.md.
import { cpSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { which, run, HarmaError } from './util.mjs';
import { loadCatalog } from './catalog.mjs';
import { aaKey } from './rank.mjs';
import { HerdrBackend, HcBackend } from './backends.mjs';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_SRC = join(PKG_ROOT, 'skill');
const MARKER = '.installed-by-harma';

export function skillTargets(target, env = process.env) {
  const home = env.HOME || homedir();
  const all = {
    claude: join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'skills', 'harma'),
    codex: join(env.CODEX_HOME || join(home, '.codex'), 'skills', 'harma'),
  };
  if (target === 'both' || !target) return all;
  if (!all[target]) throw new HarmaError(`--target: claude | codex | both (non ${target})`);
  return { [target]: all[target] };
}

function version() {
  return JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version;
}

export async function cmdInstall(flags, opts = {}) {
  const out = opts.out ?? ((s) => process.stdout.write(s + '\n'));
  const env = opts.env ?? process.env;
  const lines = [];
  for (const [host, dest] of Object.entries(skillTargets(flags.target ?? 'both', env))) {
    if (existsSync(dest) && !existsSync(join(dest, MARKER)) && !flags.force) {
      lines.push(`${host}: ${dest} esiste e non è stato installato da harma — saltato (usa --force per sovrascrivere)`);
      continue;
    }
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(SKILL_SRC, dest, { recursive: true });
    writeFileSync(join(dest, MARKER), `harma ${version()}\n`);
    lines.push(`${host}: skill installata in ${dest}`);
  }
  lines.push('', 'Per la CLI: npm i -g harma-kit  (comando: harma; oppure npx harma-kit <comando>)', 'Poi, nel progetto: harma init --orchestrator <harness>:<model> --effort <level>');
  out(lines.join('\n'));
}

export async function cmdUninstall(flags, opts = {}) {
  const out = opts.out ?? ((s) => process.stdout.write(s + '\n'));
  const env = opts.env ?? process.env;
  const lines = [];
  for (const [host, dest] of Object.entries(skillTargets(flags.target ?? 'both', env))) {
    if (!existsSync(dest)) { lines.push(`${host}: non installata`); continue; }
    if (!existsSync(join(dest, MARKER)) && !flags.force) { lines.push(`${host}: ${dest} non è di harma — lasciata`); continue; }
    rmSync(dest, { recursive: true, force: true });
    lines.push(`${host}: rimossa ${dest}`);
  }
  out(lines.join('\n'));
}

export async function cmdDoctor(flags, opts = {}) {
  const out = opts.out ?? ((s) => process.stdout.write(s + '\n'));
  const env = opts.env ?? process.env;
  const checks = [];
  const add = (name, ok, detail, required = false) => checks.push({ name, ok, detail, required });

  const major = Number(process.versions.node.split('.')[0]);
  add('node >= 20', major >= 20, process.versions.node, true);

  const cat = loadCatalog({ env });
  add('catalogo modelli', Boolean(cat?.models && Object.keys(cat.models).length), cat ? `${Object.keys(cat.models).length} modelli, ${cat.origin} ${cat.generated_at}` : 'non leggibile', true);
  add('file della skill', existsSync(join(SKILL_SRC, 'SKILL.md')), SKILL_SRC, true);

  const herdr = await new HerdrBackend({ env }).available();
  const hc = await new HcBackend({ env }).available();
  add('backend herdr', herdr.ok, `${herdr.version ?? ''} ${herdr.detail}`.trim());
  add('backend hc (herdr-core)', hc.ok, `${hc.version ?? ''} ${hc.detail}`.trim());
  add('almeno un backend', herdr.ok || hc.ok, herdr.ok || hc.ok ? 'ok' : 'installa herdr o herdr-core per avviare agenti', true);

  const agentClis = ['claude', 'codex', 'agy', 'kimi', 'grok', 'muse', 'qwen'].filter((b) => which(b, env));
  add('CLI di agenti', agentClis.length > 0, agentClis.join(', ') || 'nessuna', true);

  const cb = which('codexbar', env);
  let cbDetail = 'non installato: crediti da budget dichiarati o stima dai log';
  if (cb) {
    const v = await run('codexbar', ['--version'], { env, timeout: 10_000 });
    cbDetail = v.stdout.trim().split('\n')[0] || 'presente';
  }
  add('codexbar (crediti)', Boolean(cb), cbDetail);
  add('chiave Artificial Analysis', Boolean(aaKey(env)), aaKey(env) ? 'presente (harma rank --refresh)' : 'assente: si usa lo snapshot incluso');

  for (const [host, dest] of Object.entries(skillTargets('both', env))) {
    add(`skill per ${host}`, existsSync(join(dest, 'SKILL.md')), existsSync(dest) ? dest : `non installata (npx harma-kit install --target ${host})`);
  }

  const failed = checks.filter((c) => c.required && !c.ok);
  if (flags.json) out(JSON.stringify({ ok: !failed.length, checks }, null, 2));
  else {
    out(checks.map((c) => `${c.ok ? 'ok  ' : c.required ? 'FAIL' : 'warn'}  ${c.name} — ${c.detail}`).join('\n'));
    out(failed.length ? `\n${failed.length} controlli obbligatori falliti.` : '\nharma è pronto.');
  }
  return { ok: !failed.length, checks, exitCode: failed.length ? 1 : 0 };
}
