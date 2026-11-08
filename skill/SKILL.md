---
name: harma
description: Run a project as the orchestrator model over other coding agents with the harma CLI — inventory the models and efforts on this machine, read their credits, rank them by Artificial Analysis intelligence per effort, route planning/development/review/debugging/research/extraction to the best fit, monitor agents, track cost, and close finished agents after saving their session ids so they can be resumed. Use when the user names an orchestrator for a project, asks which models are available or how much credit is left, asks to delegate work across models, to check on or clean up agents, or to resume an agent's session. Do not use for a single-model task the user did not ask to delegate.
---

# harma

You are, or are about to become, the **orchestrator** of this project: the model that decides which
agent does which job, watches them, and keeps the workspace clean. The `harma` CLI does the
mechanics; you do the judgement and talk to the user.

Run it as `harma <command>` if installed globally, otherwise `npx -y harma <command>`.
Add `--json` whenever you will read the output yourself.

## Hard rules

1. **No agent starts without the user's consent.** `dispatch`, `send` and `resume --yes` start or
   instruct another agent. With the default policy `confirm`, harma refuses without `--yes` and
   exits with code 3, printing the plan. Show that plan to the user, ask, and rerun with `--yes`
   only after an explicit yes for *that* dispatch. Consent does not carry over to retries,
   reviewers, extra workers or later turns. If the user's own instructions (CLAUDE.md, AGENTS.md)
   are stricter, follow them.
   The policy `auto-within-budget` exists for users who set it themselves in `.harma/config.json`;
   never set it on your own.
2. **Never invent numbers.** Models, efforts, credits, prices and scores come from harma's output,
   each with its source and date. When harma says `sconosciuto` (unknown), say unknown.
3. **Close only what harma opened.** `cleanup` touches only terminals/tabs recorded in
   `.harma/agents.jsonl`. Do not close other panes, tabs, workspaces or servers.
4. **Do not hand off your own role.** You stay the orchestrator; agents report to you, you verify
   their results before telling the user something is done.

## Workflow

### 1. Set the orchestrator
When the user names the model (and effort) responsible for the project:
```
harma init --orchestrator <harness>:<model> --effort <level>
```
`harness` is the CLI that runs the model (`claude`, `codex`, `agy`, `kimi`, `grok`, `muse`, `qwen`…).
If the user names you, use your own harness and model id. `harma models` lists valid pairs.

### 2. Know what is available
```
harma models --json     # CLIs on PATH, models, supported efforts, source of each row
harma credits --json    # remaining % per provider, status (ampio/ok/scarso/esaurito/sconosciuto), source
harma rank --json       # AA Intelligence Index per model × effort, cost per task, date
```
- Credits come from CodexBar when installed. Without it, or for providers it does not cover,
  harma uses a budget the user declared in `.harma/config.json` → `budgets.<provider>`
  (`{"limit": 100, "currency": "USD"}`) against an estimate from local session logs, otherwise
  reports unknown. Suggest the user enable the provider in CodexBar or declare a budget.
- The "stima 7g" figure is local tokens × API list price. For a subscription it is **not** what the
  user pays; say so when you quote it.
- `harma rank --refresh` updates the scores from the Artificial Analysis API when `AA_API_KEY` is
  set. Mention the snapshot date when you rely on the bundled data.

### 3. Route work
```
harma route <pianificazione|sviluppo|review|debugging|ricerca|estrazione> --json
harma route review --author <harness>:<model> --json   # reviewer from another vendor
```
Present the top candidates with their reasons (index, cost per task, credit state) and your
recommendation. Typical split: planning and hard debugging on the strongest model; development
on a strong model at reasonable cost; review on a different vendor from the author; extraction
and summaries on the cheapest model above the floor.

Then propose the dispatch and, after consent:
```
harma dispatch --name <agent-name> --model <harness>:<model> --effort <e> --task-type <tipo> \
  --prompt-file <brief.md> --yes
```
Agent names: lowercase, `[a-z][a-z0-9_-]{0,31}`, unique among open agents (`planner`, `builder`,
`review-1`). Write a self-contained brief: goal, files, constraints, what "done" means, and how to
report back (e.g. "write your result to `.harma/out/<name>.md`").

### 4. Monitor
```
harma status --json         # each open agent: model, effort, live status, since, session id
harma read <name> --lines 120
harma send <name> "<follow-up>" --yes   # after consent
```
Status values come from the terminal backend: `working`, `idle`, `done`, `blocked`, `unknown`,
`finished`. `blocked` means the agent waits on a question or approval: read it and ask the user;
never answer an approval dialog on the user's behalf. `idle`/`done` does not prove the task is
done: read the output and check the work.

### 5. Watch cost
```
harma costs --json
```
Use `advice` to rebalance: delegate more to providers with `ampio` margin, less to `scarso`,
nothing to `esaurito` until its reset. Tell the user when you shift work and why.

### 6. Keep it clean
At each step boundary, and before ending your turn on a finished task:
```
harma cleanup --dry-run --json   # what would close, with session ids
harma cleanup --json             # saves session ids, closes finished agents' tabs/terminals
```
harma keeps agents that are `working` or `blocked`, and agents whose session id it cannot find
(closing them would lose their context). `--force` overrides both; use it only when the user asks.
When the project's work is over, `harma cleanup --workspace` also closes the herdr workspace
harma created for it (only once no harma agent is open).

Later, to continue an agent's work with its full context:
```
harma resume <name> --print-only   # shows the native resume command
harma resume <name> --yes          # after consent: reopens it in a new terminal
```

## Backends

harma drives terminals through **herdr** (workspace → one tab per agent) or **herdr-core**
(`hc`, headless terminals labelled `harma.project=<id>`). `--backend herdr|hc` forces one;
otherwise harma uses whichever is running, herdr first. If neither is available, `harma doctor`
says what to install. Do not start, stop or restart a herdr/hc server yourself.

## Files

- `.harma/config.json` — orchestrator, policy, budgets, thresholds, routing overrides.
- `.harma/agents.jsonl` — append-only log: started, session, prompted, closed, resumed.
- `.harma/cache/` — last inventory, credits, rank (each with `fetched_at`).

## Troubleshooting

`harma doctor` checks Node, the catalog, backends, agent CLIs, CodexBar, the AA key and the skill
install. Exit code 3 from any command means "needs the user's confirmation", not an error.
Exit code 4 from `dispatch` means the agent started but waits on a dialog (often "trust this
folder?" in a new directory) and the task was **not** delivered: `harma read <name>`, ask the
user to answer it in their terminal, then `harma send <name> "<task>" --yes`. Never answer a
trust or approval dialog yourself.
