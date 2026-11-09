# Changelog

All notable changes to harma, newest first. Versions follow [semantic versioning](https://semver.org/).

## 0.2.0 (unreleased)

You can now choose the models for each job yourself, or accept the orchestrator's proposals:

- **Selection screen**: `harma select` opens a terminal screen with the orchestrator and each job, showing the proposal next to your choice; every model and effort level shows its AA index, cost per task and credit state
- **Several models per job**: add, remove and reorder up to five models per job, in order of preference; the proposal pairs the best candidate with a backup on another CLI
- **Choice by credits**: at dispatch, harma takes the first model on your list whose CLI is installed and whose credits aren't exhausted, prefers a later model over one whose credits are low, and records which models it skipped and why
- **For agents**: `select --open --wait` opens the screen in a focused herdr tab (or an `hc` terminal) and returns your choices when you save
- **Without the screen**: `select --set "job=harness:model@effort|…"`, `--accept` and `--show`
- **Routing**: `route` shows your list and which model on it `dispatch` would use now; `dispatch --task-type` uses your list before the routing proposal
- **Docs**: the README is now a short overview, with guides and reference pages in `docs/`

A saved choice isn't consent to start an agent: each dispatch still asks. Choices saved by earlier builds, with one model per job, still work.

## 0.1.0 (2026-11-08)

First release:

- **`init`**: records the orchestrator model and effort for a project
- **`models`**: lists agent CLIs, models and effort levels; Codex models come from `~/.codex/models_cache.json`, the others from the catalog
- **`credits`**: reads CodexBar, falling back to a declared budget against an estimate from local logs
- **`rank`**: Artificial Analysis Intelligence Index for each model and effort; `--refresh` updates it from the AA API with a key
- **`route`**: profiles for planning, development, review (another vendor), debugging, research and extraction (cheapest)
- **`dispatch`, `send`, `read`**: run agents through herdr or herdr-core, with the `confirm` policy as the default; `dispatch` exits with code 4 when the agent waits on a dialog and the task wasn't sent
- **`status`, `costs`**: live state, estimated cost per agent and delegation advice
- **`cleanup`, `resume`**: save session IDs, close finished agents and reopen them with their context; `cleanup --workspace` closes harma's herdr workspace once no agent is open
- **`install`, `uninstall`, `doctor`**: install the skill for Claude Code and Codex and check the setup
