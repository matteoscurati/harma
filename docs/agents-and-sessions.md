# Agents, sessions and backends

This page explains where harma runs agents, how it keeps each agent's session ID so you can resume it, and which files it writes in your project. harma only closes what it started, as recorded in `.harma/agents.jsonl`.

## Backends

harma runs each agent in a terminal managed by one of two backends. With `--backend auto` (the default) it uses herdr when herdr is running, otherwise herdr-core. harma never starts, stops or restarts the backend's server.

- **[herdr](https://herdr.dev)**: each agent gets a tab or a pane, placed as described in [where agents open](#where-agents-open). herdr's agent detection reports each agent's state and session ID. While a full-screen agent such as Claude Code is working, `harma read` shows its visible screen, because herdr scrolls back through that agent's history only when it is idle. herdr drives only the CLIs it recognizes as agents; harma runs any other CLI it knows (MiniMax `mmx`, Mistral `vibe`) as a [headless job](#headless-jobs). Claude Code pointed at another provider (`claude-zai`, `claude-moonshot`, `claude-qwencloud`) is still Claude Code to herdr.
- **[herdr-core](https://github.com/herdrdev/herdr-core) (`hc`)**: harma starts headless terminals labelled `harma.project` and `harma.agent`, with `--outlive-parent` so they survive the orchestrator's session. State comes from the terminal's status reports. Open one with `hc attach agent_name`.

## Where agents open

On herdr, the layout decides where a new agent goes. Set the project default with `harma init --layout`, or pass `--layout` to `dispatch` and `resume`.

| Layout | Where the agent opens |
|---|---|
| `auto` (default) | Inside herdr: a pane beside the orchestrator while both stay usable, then a tab. Outside herdr: like `workspace` |
| `tab` | A new tab in the orchestrator's own workspace, without moving focus |
| `split` | A pane beside the orchestrator's pane, in the direction that fits its size |
| `split:right`, `split:down` | A pane beside the orchestrator's pane, always in that direction |
| `workspace` | The project workspace, labelled `harma:<project>` |

`auto` follows herdr's own advice for subagents: split the orchestrator's pane to the right when it is wide (at least twice as many columns as rows) and down when it is narrow or tall, and keep both panes usable, at least 60 columns or 15 rows each. When neither direction leaves that much room, typically after two agents, the next agent opens as a tab. An explicit `split` always splits. The selection screen (`select --open`) keeps opening as a tab.

harma knows it runs inside herdr from the variables herdr sets in each pane (`HERDR_ENV`, `HERDR_WORKSPACE_ID`, `HERDR_PANE_ID`); `tab` and `split` need them. In the project workspace, the first agent uses the tab herdr creates with the workspace, so no empty shell tab is left; herdr closes that workspace with its last tab, and the next agent opens a new one. Closing an agent closes its tab, or its pane for `split`.

### Worktrees

`dispatch --worktree` gives the agent its own git checkout, so agents that write code in parallel don't overwrite each other. herdr creates the worktree on branch `harma/agent_name` (or `--branch`), under its worktrees folder, and opens it as a workspace grouped with the project's in the sidebar. The agent works there; the orchestrator reviews the branch and merges it.

harma never deletes a worktree, because it holds the agent's work. `cleanup` closes the agent and prints where the checkout is; remove it with `git worktree remove` once the work is merged. The one exception is a worktree whose agent did not start: nothing has worked there yet, so harma asks herdr to remove the checkout (never forced) and keeps the branch, and the same dispatch can run again.

### Another machine

`dispatch --machine <name> --cwd <folder>` runs the agent on the herdr server of another machine, one you saved with `herdr machine add` (list them with `herdr machine list`). herdr forwards every command over SSH, so `status`, `read`, `send`, `cleanup` and `resume` reach the agent there. On that machine the agent opens in a project workspace `harma:<project>`, whose ID harma keeps per machine in `config.json`; `--worktree` works too.

- `--cwd` is required: the project's folder on that machine, absolute or starting with `~`
- harma checks CLIs and models only on this machine: make sure the other one has the CLI and is signed in
- the trust policy does not apply there: the user answers the folder-trust dialog
- `costs` can't read that agent's usage, which stays in the other machine's logs
- headless jobs run only on this machine

### When the shell is still starting

herdr starts an agent only in a pane whose shell is at its prompt. A new pane, above all in a new worktree, can spend a few seconds in its startup files (`.zshrc`, git or node hooks), and herdr answers `agent_pane_busy` meanwhile, before starting anything. harma repeats the start for up to 20 seconds; if the shell is still busy, it reports the error and nothing is started.

## Headless jobs

`dispatch --headless` runs one task in the CLI's print mode (`claude -p`, `codex exec`, `agy -p`, …): the agent answers once and ends, with no conversation to continue. Use it for extraction, research or a review whose answer you just read; keep interactive agents for work you'll follow up on.

harma writes the task, the job and later the answer to `.harma/runs/<agent>-<time>/`, and types its own runner (`harma _run`) in a terminal placed like any agent's. On herdr the runner waits for the shell to reach its prompt, then reports to herdr: the pane shows up as an agent with its name, `working` while the CLI runs and `done` after. It stays open until `cleanup` closes it. On herdr-core it runs in a background terminal and ends with the CLI.

- `harma read <agent>` prints the answer from `output.md`, partial while the job runs; `--lines` keeps the last lines
- `dispatch --headless --wait` waits for the answer and prints it; `--timeout` (default 600 s) limits the wait, not the job
- the job is stopped after an hour, or after `--max-time` seconds
- `send` is refused: the job has its task. To continue the conversation, `cleanup` it and `resume` it, which reopens the session interactively (Claude Code and Codex)
- `cleanup` closes a finished job without needing its session ID, since the answer stays on disk

Nobody answers permission requests in print mode: each CLI applies its own non-interactive defaults, usually refusing actions that need approval. Antigravity can stay alive after printing its answer; the answer is already in `output.md`, and the job ends at its time limit or with `cleanup --force`.

## Folder trust

The first time Claude Code, Codex or Antigravity opens a folder, it asks whether you trust it, and waits. By default harma leaves that question to you: `dispatch` exits with code 4 and the task isn't sent.

If you'd rather not answer it for every new agent, turn on the project's trust policy:

```sh
harma trust on      # or: harma init … --trust-project
harma trust off
```

With the policy on, when an agent stops at startup harma reads its screen and answers only if all of these hold:

- the screen is that CLI's folder-trust dialog, matched on its exact text
- the dialog names the project folder, a folder under it, or the worktree harma created for the agent
- the selected option is the trust option; harma moves to it and checks again before pressing Enter

Otherwise it leaves the agent waiting, as without the policy. Each answer is recorded in `.harma/agents.jsonl` as a `trusted` event, and each refusal as `trust_skipped`. harma never answers tool-permission dialogs, such as a request to run a command: those stay with you.

## Session IDs

A session ID lets the agent CLI reopen a conversation with its full context. harma records it as soon as it's known:

- **Claude Code**: harma generates the ID and passes it with `--session-id` when it starts the agent
- **Codex**: Codex creates the ID on its first turn; harma reads it from herdr's agent detection, or from `~/.codex/sessions` by matching the folder and start time. For a headless `codex exec`, harma reads it from the job's output

Other CLIs run normally, but harma can resume only Claude Code and Codex sessions.

## Clean up finished agents

At the end of each step, the orchestrator runs:

```sh
harma cleanup --dry-run
harma cleanup
```

The first command lists what would close, with session IDs. The second saves each session ID to `.harma/agents.jsonl`, then closes the agent's tab or terminal.

`cleanup` keeps an agent open in two cases: it's still `working` or `blocked`, or harma can't find its session ID, since closing it would lose the context. A finished headless job closes anyway, since its answer stays on disk. `--force` closes it anyway, and `--agent agent_name` limits cleanup to one agent. `harma cleanup --workspace` also closes the herdr workspaces harma created, here and on each machine, once no harma agent is open in them.

## Resume an agent

`resume` reopens a closed agent's session in a new tab or terminal, with the same model and effort:

```sh
harma resume planner --print-only
harma resume planner --yes
```

`--print-only` shows the native command, for example `claude --resume <session_id> --model claude-opus-5-5 --effort high` or `codex resume <session_id> -m gpt-6.2-sol -c model_reasoning_effort="high"`. Under the `confirm` policy, resuming needs `--yes`.

## Project files

harma keeps its state in `.harma/` at the project root:

| Path | Contents |
|---|---|
| `.harma/config.json` | Orchestrator, backend, herdr layout and workspaces (also per machine), trust policy, dispatch policy, budgets, thresholds, routing overrides and your model choices (`roster`) |
| `.harma/agents.jsonl` | Append-only events: `orchestrator`, `started`, `session`, `prompted`, `blocked`, `trusted`, `trust_skipped`, `trust_policy`, `closed`, `resumed`, `roster` |
| `.harma/runs/` | One folder per headless job: `prompt.md`, `job.json`, `output.md`, `stderr.log`, `result.json`; git ignores this folder |
| `.harma/cache/` | Last inventory, credits, ranking and selection status, each with its fetch time; git ignores this folder |

`config.json` and `agents.jsonl` are plain files you can read and commit. Edit `config.json` by hand only for `budgets`, `thresholds` and `routing`; use `harma init` and `harma select` for the rest.
