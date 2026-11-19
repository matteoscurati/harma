# Changelog

All notable changes to harma, newest first. Versions follow [semantic versioning](https://semver.org/).

## 0.3.2 (2026-11-19)

Fixes for agents in herdr:

- **Shell still starting**: `dispatch` failed with `herdr agent start fallito: pane … is not an available shell` when the new pane's shell had not reached its prompt yet, which happens most often in a new worktree. herdr refuses that start without launching anything, so harma now repeats it for up to 20 seconds and starts the agent as soon as the shell is ready
- **Worktree left behind**: when the agent of a `--worktree` dispatch did not start, its empty checkout stayed on disk and the same dispatch then failed with "already exists". harma now asks herdr to remove that checkout (never forced) and keeps the branch

## 0.3.1 (2026-11-19)

New model:

- **Gemini 4 Neon** in Antigravity (`agy:gemini-4-neon`) at low, medium, high and xhigh, with prices from Google's official page and Artificial Analysis Intelligence Index v5.0.1 per effort. `harma models` lists only the efforts `agy models` shows for your account, and `dispatch` checks the exact model ID again before starting the agent

## 0.3.0 (2026-11-19)

Interactive agents on herdr, closer to herdr's own way of running subagents:

- **Agents next to the orchestrator**: when the orchestrator runs inside herdr, new agents open as tabs in its own workspace instead of a separate `harma:<project>` workspace. `--layout split` puts one in a pane beside the orchestrator; `--layout workspace` keeps the old behaviour, which stays the default outside herdr. `harma init --layout` sets the project default
- **Worktrees**: `dispatch --worktree` gives an agent its own git checkout on branch `harma/<name>`, opened by herdr as a workspace grouped with the project's. harma never deletes it; `cleanup` says where it is
- **Folder trust**: `harma trust on` (or `init --trust-project`) lets harma answer the "trust this folder?" dialog of Claude Code, Codex and Antigravity, for the project folder and its worktrees only, after matching the dialog's exact text and folder. Off by default; tool permissions are never answered
- **Score refresh cache**: `harma rank --refresh` now stores only Artificial Analysis figures, in `~/.config/harma/aa-benchmarks.json`, and applies them to the bundled catalog they were fetched for; models, prices and CLI settings always come from the bundled catalog. Run the refresh again after upgrading

## 0.2.2 (2026-11-18)

herdr backend, checked against the herdr 0.9.5 documentation:

- **No empty tab**: a new `harma:<project>` workspace no longer keeps herdr's first tab as an idle shell next to the agents. The first agent, or the selection screen, runs in that tab; when it needs another folder or its own environment, harma opens a new tab and closes the empty one. herdr closes the workspace with its last agent, and the next dispatch creates a new one
- **`harma read` while working**: reading a working Claude Code agent failed with `agent_not_idle`; harma now falls back to the visible screen
- **`cleanup --workspace`**: a workspace herdr already closed counts as closed, so harma forgets its ID instead of reporting an error

## 0.2.1 (2026-11-18)

New models and a fix for score refresh:

- **New models**: GPT-6.2 Astra and GPT-6.2 Sol (Codex), Qwen4 Max (Qwen Code, and Claude Code on QwenCloud as `claude-qwencloud`), Claude Fable 5.2 and Gemini 4 Hydrogen, with prices from the official pages and Artificial Analysis Intelligence Index v5.0.1 per effort
- **Score refresh**: Artificial Analysis retired the endpoint `harma rank --refresh` used on 2026-11-04, so the command stopped working; it now reads the free `/api/v2/language/models/free` endpoint, follows every page and updates cost per task as well as the index
- **Catalog**: rebuilt from the controller-models registry on 2026-11-18
- **Examples**: the docs use `gpt-6.2-sol` in place of `gpt-6.1-sol`

## 0.2.0 (2026-11-09)

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
