# harma command reference

Every command takes `--json`. Targets are `harness:model` (for example `claude:claude-opus-5-5`); `harma models --json` lists the valid ones.

## Commands

| Command | Use |
|---|---|
| `init --orchestrator h:m --effort e [--backend auto\|herdr\|hc] [--policy confirm\|auto-within-budget]` | Create `.harma/` and record the orchestrator. Don't pass `--policy auto-within-budget` unless the user asked for it |
| `models` | Agent CLIs on PATH, models, efforts, source of each row |
| `credits` | Remaining share and state per provider, with source and time |
| `rank [--refresh] [--top N]` | AA index and cost per task per model × effort |
| `route <job> [--author h:m] [--top N]` | Candidates for a job, the user's saved list (`user_choice`) and the model dispatch would take now (`user_pick`) |
| `select --open [--wait] [--timeout s]` | Selection screen in a focused herdr tab (or `hc` terminal); `--wait` returns the saved choices (default 900 s) |
| `select --set "job=h:m@e\|h:m@e,job=none"` | Record the user's choices; `\|` separates models in order of preference; the orchestrator takes one model; at most 5 per job |
| `select --accept` / `select --show` | Accept all proposals (only if the user said so) / print choices |
| `dispatch --name n (--model h:m [--effort e] \| --task-type job) [--prompt "…" \| --prompt-file f] [--cwd dir] [--layout auto\|workspace\|tab\|split[:right\|:down]] [--worktree [--branch b]] [--headless [--max-time s]] [--machine m --cwd dir] [--wait] [--timeout s] [--yes]` | Start an agent and send the task; `--headless`: one task, one answer; `--machine`: on another machine's herdr |
| `trust [off\|worktrees\|on]` | Show or set who answers folder-trust dialogs (default `worktrees`); change it only on the user's request |
| `worktree [--copy ".env,…"]` | Show or set the untracked files copied into each new worktree; set it only on the user's request |
| `answers [off\|questions\|permissions\|all]` | Show or set how far you may answer waiting agents (default `permissions`); change it only on the user's request |
| `send n "text" [--wait] [--timeout s] [--yes]` | More work for an open interactive agent (refused for a headless job) |
| `read n [--lines N]` | Recent screen output of an agent; for a headless job, its answer |
| `answer n --kind question\|permission (--option "text or number" [--text "…"] \| --text "…" \| --keys "down,enter") [--reason "…"] [--yes]` | Answer an agent that waits on a question or a permission; harma checks the selected option on screen before Enter |
| `status [--all]` | Open agents (all with `--all`): model, effort, live state, age, session id |
| `costs` | Estimated cost per agent, credits per provider, `advice` |
| `cleanup [--dry-run] [--agent n] [--force] [--workspace]` | Save session ids, close finished agents |
| `resume n [--print-only] [--yes]` | Reopen a closed agent's session (Claude Code and Codex) |
| `doctor` | Check the environment |

Jobs: `pianificazione` (planning), `sviluppo` (development), `review`, `debugging`, `ricerca` (research), `estrazione` (extraction). English aliases are accepted.

## Exit codes

- `0`: done
- `1`: error; the message has a hint
- `3`: needs the user's confirmation; nothing started or answered. Show the plan or the answer, ask, rerun with `--yes`
- `4`: the agent waits on a dialog: `dispatch` started it but the task wasn't sent, `send` wasn't delivered, or `answer` found no option to pick (see troubleshooting.md)

## Credit states

`ampio` (60% or more left), `ok`, `scarso` (below 20%), `esaurito` (below 5%), `sconosciuto` (not measured). The user can change the thresholds in `.harma/config.json` → `thresholds`.

## How dispatch picks from the user's list

In the user's order: skip a model whose CLI isn't installed or whose credits are `esaurito`; pass over a `scarso` model when a later one has more; take the first left. With none left, dispatch fails and lists each reason. The plan's `why` names the position taken and the models skipped.

## Backends and files

- **herdr**: inside herdr, a pane beside the orchestrator while there is room, then a tab; outside, one workspace per project (`harma:<project>`); headless jobs show up as agents named after the job
- **herdr-core (`hc`)**: headless terminals labelled `harma.project` and `harma.agent`; the user opens one with `hc attach <name>`
- **`.harma/config.json`**: orchestrator, backend, policy, budgets, thresholds, routing overrides, `roster` (the user's models per job)
- **`.harma/agents.jsonl`**: append-only events (started, session, prompted, blocked, answered, closed, resumed, roster)
- **`.harma/cache/`**: last inventory, credits, rank, selection status
