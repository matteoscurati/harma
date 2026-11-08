# harma

One orchestrator model runs your project; the other models on your machine do the work.

harma is a skill for **Claude Code** and **Codex** plus a small CLI. You name the model (and
effort) responsible for a project. It then:

1. sees which agent CLIs, models and effort levels this machine has;
2. reads how much credit each provider has left (via [CodexBar](https://github.com/steipete/CodexBar),
   a declared budget, or local session logs);
3. ranks every model × effort by the [Artificial Analysis](https://artificialanalysis.ai/models)
   Intelligence Index and cost per task;
4. proposes which model takes planning, development, review, debugging, research or extraction;
5. starts agents in [herdr](https://herdr.dev) tabs or [herdr-core](https://github.com/herdrdev/herdr-core)
   terminals, **only after you say yes**;
6. shows what each agent is doing;
7. tracks cost per agent and tells you where to delegate more or less;
8. closes finished agents after saving their native session ids, so `harma resume <name>` brings
   one back with its full context.

## Install

```sh
npx harma-kit install        # skill for Claude Code and Codex (~/.claude/skills, ~/.codex/skills)
npx harma-kit install --target codex
npm i -g harma-kit           # optional: the CLI without npx
npx harma-kit doctor         # checks Node, backends, agent CLIs, CodexBar, AA key
```

You need Node ≥ 20, at least one agent CLI (`claude`, `codex`, `agy`, `kimi`, `grok`, `muse`,
`qwen`, …) and a terminal backend: **herdr** or **herdr-core (`hc`)**.

## Use it from your agent

In a project, tell Claude or Codex something like:

> Use harma. You are the orchestrator, Opus 5.5 at high effort. Check which models we have and
> how much credit is left, then plan the auth refactor with the best planner and have the
> builder implement it. Ask me before starting each agent.

The skill turns that into:

```sh
harma init --orchestrator claude:claude-opus-5-5 --effort high
harma models && harma credits && harma rank --top 15
harma route pianificazione
harma dispatch --name planner --task-type pianificazione --prompt-file brief.md   # exit 3: asks you
harma dispatch --name planner --task-type pianificazione --prompt-file brief.md --yes
harma status
harma costs
harma cleanup
harma resume planner --yes
```

## Commands

| Command | What it does |
|---|---|
| `init --orchestrator h:m --effort e` | Sets the orchestrator; options `--backend auto\|herdr\|hc`, `--policy confirm\|auto-within-budget` |
| `models` | Agent CLIs on PATH, their models and efforts, with the source of each row |
| `credits` | Remaining share per provider: `ampio`, `ok`, `scarso`, `esaurito` or `sconosciuto` |
| `rank [--refresh]` | AA index and cost per task per model × effort; `--refresh` uses `AA_API_KEY` |
| `route <type> [--author h:m]` | Top candidates for `pianificazione`, `sviluppo`, `review`, `debugging`, `ricerca` or `estrazione` |
| `dispatch --name n (--model h:m \| --task-type t)` | Starts an agent; needs `--yes` under the `confirm` policy |
| `send n "text"` / `read n` | Gives an open agent more work / reads its screen |
| `status` | Every open agent: model, effort, live state, age, session id |
| `costs` | Estimated cost per agent, credits per provider, delegation advice |
| `cleanup [--dry-run] [--workspace]` | Saves session ids, then closes finished agents' tabs or terminals; `--workspace` also closes harma's herdr workspace when no agent is open |
| `resume n [--print-only]` | Reopens a saved session with its model and effort |

Every command takes `--json`. Exit code 3 means "needs the user's confirmation". Exit code 4
from `dispatch` means the agent started but is waiting on a dialog (for example "trust this
folder?"), so the task was not sent.

## How it decides

- **Intelligence.** The bundled catalog holds the Artificial Analysis Intelligence Index v5.0
  per model × effort and cost per task (snapshot of 2026-10-28). `harma rank --refresh` updates
  the index from the AA API into `~/.config/harma/catalog.json`. Missing scores stay unknown.
- **Routing.** `score = index − weight × cost per task ± credit adjustment`, above a minimum
  index per task type. Review excludes the author's vendor. Extraction takes the cheapest model
  above the floor. An unknown cost counts as the highest known one. Override the profiles in
  `.harma/config.json` → `routing`.
- **Credits.** CodexBar first, with account identity removed. If CodexBar doesn't cover a
  provider, harma uses a budget you declare (`budgets.<provider>`) against an estimate from local
  logs. Otherwise the credit state is unknown. For a subscription, the "estimate" is tokens × API
  list price, not what you pay.
- **Consent.** The default policy `confirm` refuses to start or instruct any agent without
  `--yes`. Under `auto-within-budget`, which you must set yourself, harma dispatches without
  asking only when the provider's credits are `ok` or `ampio`.

## Backends

- **herdr.** One workspace per project and one tab per agent, so closing an agent closes its
  window. The session id comes from herdr's agent detection, or from `--session-id` for Claude.
- **herdr-core (`hc`).** Headless terminals labelled `harma.project` and `harma.agent`, started
  with `--outlive-parent`. Codex session ids are read from `~/.codex/sessions`.

harma only closes what it started, as recorded in `.harma/agents.jsonl`.

## Project files

```
.harma/config.json    orchestrator, policy, budgets, thresholds, routing overrides
.harma/agents.jsonl   append-only: started, session, prompted, closed, resumed
.harma/cache/         last inventory, credits, rank (cache/ is git-ignored)
```

## Maintainers

`node scripts/import-catalog.mjs <controller-models>` regenerates `data/catalog.json`. `npm test`
runs the suite with fake `herdr`, `hc`, `codexbar` and agent CLIs.

Intelligence Index and cost per task: [Artificial Analysis](https://artificialanalysis.ai/).
herdr and herdr-core are projects of their authors; harma is not affiliated with them.

## License

MIT
