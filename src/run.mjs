// harma _run <job.json>: one headless job, run in the terminal it was typed
// in. It starts the CLI in its print mode, copies the answer to the screen
// and to <run_dir>/output.md, and writes <run_dir>/result.json at the end.
// Under herdr it reports its own lifecycle (working, then idle) on the pane
// and takes the agent's name, so herdr lists it like any agent; it then stays
// open, so the result stays visible until harma closes the pane.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, createWriteStream, openSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { run, HarmaError, now } from './util.mjs';

const KILL_GRACE_MS = 5000;

export async function cmdRun(flags, opts = {}) {
  const env = opts.env ?? process.env;
  const jobPath = flags._[0];
  if (!jobPath) throw new HarmaError('Uso: harma _run <job.json>');
  const job = JSON.parse(readFileSync(jobPath, 'utf8'));
  const out = opts.stdout ?? process.stdout;
  // The pane can go away under us (cleanup closes it): never crash on a dead terminal.
  out.on?.('error', () => {});
  const pane = job.report && env.HERDR_ENV === '1' ? env.HERDR_PANE_ID : null;
  const herdr = (args) => run(env.HERDR_BIN_PATH || 'herdr', args, { env });
  const label = `harma-${job.harness}`;
  const report = async (state) => { if (pane) await herdr(['pane', 'report-agent', '--source', 'harma', '--agent', label, '--state', state, pane]); };
  const reportSession = async (id) => {
    if (pane && id) await herdr(['pane', 'report-agent-session', '--source', 'harma', '--agent', label, '--agent-session-id', id, pane, ...(job.resume_argv ? ['--', ...job.resume_argv] : [])]);
  };

  await report('working');
  if (pane) await herdr(['agent', 'rename', pane, job.name]);
  await reportSession(job.session_id);

  const prompt = readFileSync(job.prompt_file, 'utf8');
  const argv = [...job.argv];
  if (job.prompt.via === 'flag') argv.push(job.prompt.flag, prompt);
  if (job.prompt.via === 'file') argv.push(job.prompt.flag, job.prompt_file);
  const stdin = job.prompt.via === 'stdin' ? openSync(job.prompt_file, 'r') : 'ignore';
  // The agent's own herdr hooks would report over harma's state: hide herdr from it.
  const childEnv = { ...env, ...job.env };
  delete childEnv.HERDR_ENV;
  delete childEnv.HERDR_PANE_ID;

  out.write(`harma: ${job.name} · ${job.harness}:${job.model} · lavoro non interattivo\n\n`);
  const answer = createWriteStream(join(job.run_dir, 'output.md'));
  const errors = createWriteStream(join(job.run_dir, 'stderr.log'));
  const pattern = job.session_pattern ? new RegExp(job.session_pattern, 'i') : null;
  let sessionId = job.session_id ?? null;
  let seen = '';
  let sessionReported = null;
  const scan = (chunk) => {
    if (sessionId || !pattern) return;
    seen = (seen + chunk.toString()).slice(-4096);
    sessionId = seen.match(pattern)?.[1] ?? null;
    if (sessionId) sessionReported = reportSession(sessionId);
  };

  let stopped = false;
  const result = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: job.cwd ?? process.cwd(), env: childEnv, stdio: [stdin, 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ exit_code: null, signal: null, error: e.message });
      return;
    }
    let timedOut = false;
    const timer = job.timeout_sec ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
    }, job.timeout_sec * 1000) : null;
    const stop = () => { stopped = true; child.kill('SIGTERM'); };
    process.once('SIGTERM', stop);
    process.once('SIGHUP', stop);
    child.stdout.on('data', (d) => { out.write(d); answer.write(d); scan(d); });
    child.stderr.on('data', (d) => { (opts.stderr ?? process.stderr).write(d); errors.write(d); scan(d); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ exit_code: null, signal: null, error: e.message }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      process.off('SIGTERM', stop);
      process.off('SIGHUP', stop);
      resolve({ exit_code: code, signal, timed_out: timedOut });
    });
  });
  await Promise.all([new Promise((r) => answer.end(r)), new Promise((r) => errors.end(r))]);

  const final = { ...result, session_id: sessionId, ended_at: now() };
  // Write then rename: whoever polls result.json never reads half a file.
  const tmp = join(job.run_dir, 'result.json.tmp');
  writeFileSync(tmp, JSON.stringify(final, null, 2) + '\n');
  renameSync(tmp, join(job.run_dir, 'result.json'));
  await sessionReported;
  await report('idle');

  const how = final.error ? `non partito: ${final.error}`
    : final.timed_out ? `fermato dopo ${job.timeout_sec} s`
      : final.exit_code === 0 ? 'finito' : `finito con errore (exit ${final.exit_code ?? final.signal})`;
  out.write(`\n\nharma: ${job.name} ${how}. Risposta in ${join(job.run_dir, 'output.md')}\n`);
  if (!job.keep_alive || stopped) return { exitCode: final.exit_code ?? 1 };
  out.write('harma: il pane resta aperto finché harma cleanup non lo chiude.\n');
  // Stay in the foreground: herdr keeps listing the agent (done) until cleanup closes the pane.
  await new Promise((resolve) => {
    const keep = setInterval(() => {}, 60_000);
    const end = () => { clearInterval(keep); resolve(); };
    process.once('SIGTERM', end);
    process.once('SIGHUP', end);
    process.once('SIGINT', end);
  });
  return { exitCode: 0 };
}
