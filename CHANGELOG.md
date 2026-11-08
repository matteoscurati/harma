# Changelog

## 0.2.0 — 2026-11-08

- `harma select`: a TUI where you accept the orchestrator's proposals or pick model and effort
  for the orchestrator and for each job. Each option shows its AA index, cost per task and credit
  state. Choices are saved in `.harma/config.json` → `roster`.
- `select --open --wait`: opens the TUI in a focused herdr tab (or an hc terminal) for an agent
  that has no terminal, and returns your choices when you save.
- `select --accept`, `--set "job=harness:model@effort,…"` (or `job=none`), `--show`: the same
  without a TUI.
- `route` shows your choice; `dispatch --task-type` uses it before the routing proposal. A saved
  choice is not consent to start an agent.

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
