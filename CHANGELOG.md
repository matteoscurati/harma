# Changelog

All notable changes to harma, newest first. Versions follow [semantic versioning](https://semver.org/).

## 0.6.0 (2026-11-20)

The orchestrator answers agents that wait:

- **`harma answer`**: when an agent stops on a question or a permission request (herdr state `blocked`), the orchestrator answers it instead of sending you to the agent's tab. It names the option by its text or its number; harma walks the list on screen, moves to that option, reads the selection again and only then presses Enter. Text that fits more than one option, or none, sends nothing and lists the options. `--text` types a free answer, `--keys` sends keys as given. Each answer is recorded in `.harma/agents.jsonl` with its reason
- **`harma answers off|questions|permissions|all`**: how far the orchestrator may go. The default, `permissions`, covers questions about the work and permissions for the one request on screen; an option that keeps a permission ("don't ask again", "allow always") still needs your yes. The skill tells the orchestrator to approve only actions inside the agent's task and folder, to leave a push, a deploy, deletions outside the folder, payments and credentials to you, and to tell you what it answered and why
- **`harma send` to a waiting agent** exits with code 4 and says to answer first, instead of passing on herdr's error

Until now the skill told the orchestrator never to answer and to send you to the agent's tab, so a question stopped that agent until you got there. Existing projects get the new default, `permissions`; `harma answers off` brings back the old behavior. The folder-trust dialog still follows `harma trust`.

## 0.5.0 (2026-11-20)

Worktrees without surprises:

- **Folder trust in worktrees**: Antigravity asks "do you trust this folder?" for every new worktree, and Codex once per repository. The trust policy now has three levels, and the new default `worktrees` lets harma answer that dialog in the worktrees it just created, which hold the project's committed files; the project folder stays with you. `harma trust on` adds the project folder, `harma trust off` turns it off. Projects that ran `trust on` or `trust off` keep their choice
- **What a worktree lacks**: before a `--worktree` dispatch, the plan counts the uncommitted changes the agent won't see, since the worktree starts from the last commit, and names the `.env` files git doesn't track
- **Copy into worktrees**: `harma worktree --copy ".env,.env.local"` (or `init --worktree-copy`) lists untracked files or folders that harma copies into each new worktree before the agent starts, never over a file already there

## 0.4.0 (2026-11-19)

More ways to run agents in herdr:

- **Beside the orchestrator by default**: inside herdr, `--layout auto` now opens a new agent in a pane beside the orchestrator, as herdr advises for subagents: to the right when the pane is wide, down when it is narrow, and only while both panes keep at least 60 columns or 15 rows. Then it opens tabs, as before. `split` picks the direction by size; `split:right` and `split:down` force it. The selection screen still opens as a tab
- **Headless jobs**: `dispatch --headless` runs one task in the CLI's print mode (`claude -p`, `codex exec`, `agy -p`, `kimi -p`, `qwen -p`, `grok -p`, `muse exec`, `mmx text chat`, `vibe --prompt-file`) and keeps prompt, answer and result in `.harma/runs/`. On herdr harma's runner reports the job's state on its pane, so it shows up as an agent named after the job, `working` then `done`. `read` prints the answer, `--wait` waits for it, `--max-time` limits the job (default one hour), `send` is refused, and `cleanup` closes a finished job without its session ID
- **CLIs herdr doesn't drive**: MiniMax (`mmx`) and Mistral Vibe (`vibe`) now run on herdr as headless jobs instead of failing with "usa --backend hc". Claude Code on Z.ai, Moonshot or QwenCloud now starts on herdr as the Claude Code it is
- **Another machine**: `dispatch --machine <name> --cwd <folder>` runs the agent on the herdr server of a machine saved with `herdr machine add`. `status`, `read`, `send`, `cleanup`, `resume` and `cleanup --workspace` follow it there
- **Mistral Vibe model**: harma passed `env:VIBE_ACTIVE_MODEL` as an argument; it now sets that variable

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
