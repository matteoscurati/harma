import { execFile } from 'node:child_process';
import { readFileSync, existsSync, accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export const now = () => new Date().toISOString();

/** Run a program without a shell. Never throws: returns {ok, code, stdout, stderr}. */
export function run(cmd, args = [], { timeout = 60_000, env, cwd, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, {
      timeout, env: env ?? process.env, cwd, maxBuffer: 64 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
        error: err && typeof err.code === 'string' ? err.code : undefined,
      });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

/** Absolute path of a program on PATH, or null. */
export function which(bin, env = process.env) {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    try { accessSync(p, constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

export function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

export function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** Read a JSONL file into an array of objects, skipping bad lines. */
export function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

/** Minimal fixed-width table for terminal output. */
export function table(rows, columns) {
  if (!rows.length) return '(nessuna riga)';
  const cols = columns ?? Object.keys(rows[0]);
  const cell = (v) => (v === null || v === undefined ? '—' : String(v));
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (vals) => vals.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  return [line(cols), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(cols.map((c) => cell(r[c]))))].join('\n');
}

export const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** Keys that identify a person or account; stripped from anything harma stores or prints. */
const IDENTITY_KEYS = new Set([
  'accountEmail', 'signedInEmail', 'email', 'accountID', 'accountId', 'identity',
  'userId', 'user_id', 'organizationId', 'orgId', 'apiKey', 'api_key', 'token', 'cookie',
]);

export function stripIdentity(value) {
  if (Array.isArray(value)) return value.map(stripIdentity);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (IDENTITY_KEYS.has(k)) continue;
      out[k] = stripIdentity(v);
    }
    return out;
  }
  return value;
}

export class HarmaError extends Error {
  constructor(message, { exitCode = 1, hint } = {}) {
    super(message);
    this.exitCode = exitCode;
    this.hint = hint;
  }
}
