# Changelog

## 0.2.0 — 2026-11-08

- `harma select`: a TUI where you accept the orchestrator's proposals or pick model and effort
  for the orchestrator and for each job. Each option shows its AA index, cost per task and credit
  state. Choices are saved per project in `.harma/config.json` → `roster`.
- Several models per job, in order of preference: add, remove and reorder them in the TUI, or use
  `--set "job=h:m@e|h:m@e"`. The proposal pairs the best candidate with a backup on another CLI.
  At dispatch harma takes the first model whose CLI is installed and whose credits are not
  exhausted. It passes over one with `scarso` credits for a later one with more, and records
  which models it skipped and why.
- `select --open --wait`: opens the TUI in a focused herdr tab (or an hc terminal) for an agent
  that has no terminal, and returns your choices when you save.
- `select --accept`, `--set "job=harness:model@effort,…"` (or `job=none`), `--show`: the same
  without a TUI.
- `route` shows your list and which model on it dispatch would use now; `dispatch --task-type`
  uses it before the routing proposal. A saved choice is not consent to start an agent.

## 0.1.0 — 2026-11-08

First release.

- `init`: names the orchestrator model and effort for a project.
- `models`: lists agent CLIs, models and efforts. Codex comes from `~/.codex/models_cache.json`,
  the others from the catalog.
- `credits`: reads CodexBar, with the declared budget and local-log estimate as fallbacks.
- `rank`: Artificial Analysis Intelligence Index per model × effort; refreshes from the AA API
  with a key.
- `route`: profiles for planning, development, review (another vendor), debugging, research and
  extraction (cheapest).
- `dispatch` / `send` / `read`: work through herdr or herdr-core. The `confirm` policy is the
  default.
- `status`, `costs`: live state, estimated cost per agent and delegation advice.
- `cleanup`, `resume`: save session ids, close finished agents, reopen them with their context.
  `cleanup --workspace` closes harma's herdr workspace once no agent is open.
- `dispatch` exits 4 when the agent starts but waits on a dialog; the task is not marked as sent.
- `install` / `uninstall` / `doctor`: install the skill for Claude Code and Codex.
