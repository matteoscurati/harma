# Agents, sessions and backends

This page explains where harma runs agents, how it keeps each agent's session ID so you can resume it, and which files it writes in your project. harma only closes what it started, as recorded in `.harma/agents.jsonl`.

## Backends

harma runs each agent in a terminal managed by one of two backends. With `--backend auto` (the default) it uses herdr when herdr is running, otherwise herdr-core. harma never starts, stops or restarts the backend's server.

- **[herdr](https://herdr.dev)**: each agent gets a tab or a pane, placed as described in [where agents open](#where-agents-open). herdr's agent detection reports each agent's state and session ID. While a full-screen agent such as Claude Code is working, `harma read` shows its visible screen, because herdr scrolls back through that agent's history only when it is idle.
- **[herdr-core](https://github.com/herdrdev/herdr-core) (`hc`)**: harma starts headless terminals labelled `harma.project` and `harma.agent`, with `--outlive-parent` so they survive the orchestrator's session. State comes from the terminal's status reports. Open one with `hc attach agent_name`.

## Where agents open

On herdr, the layout decides where a new agent goes. Set the project default with `harma init --layout`, or pass `--layout` to `dispatch` and `resume`.

| Layout | Where the agent opens |
|---|---|
| `auto` (default) | Inside herdr: like `tab`. Outside herdr: like `workspace` |
| `tab` | A new tab in the orchestrator's own workspace, without moving focus |
| `split`, `split:down` | A pane beside the orchestrator's pane, to the right or below |
| `workspace` | The project workspace, labelled `harma:<project>` |

harma knows it runs inside herdr from the variables herdr sets in each pane (`HERDR_ENV`, `HERDR_WORKSPACE_ID`, `HERDR_PANE_ID`); `tab` and `split` need them. In the project workspace, the first agent uses the tab herdr creates with the workspace, so no empty shell tab is left; herdr closes that workspace with its last tab, and the next agent opens a new one. Closing an agent closes its tab, or its pane for `split`.

### Worktrees

`dispatch --worktree` gives the agent its own git checkout, so agents that write code in parallel don't overwrite each other. herdr creates the worktree on branch `harma/agent_name` (or `--branch`), under its worktrees folder, and opens it as a workspace grouped with the project's in the sidebar. The agent works there; the orchestrator reviews the branch and merges it.

harma never deletes a worktree, because it holds the agent's work. `cleanup` closes the agent and prints where the checkout is; remove it with `git worktree remove` once the work is merged. The one exception is a worktree whose agent did not start: nothing has worked there yet, so harma asks herdr to remove the checkout (never forced) and keeps the branch, and the same dispatch can run again.

### When the shell is still starting

herdr starts an agent only in a pane whose shell is at its prompt. A new pane, above all in a new worktree, can spend a few seconds in its startup files (`.zshrc`, git or node hooks), and herdr answers `agent_pane_busy` meanwhile, before starting anything. harma repeats the start for up to 20 seconds; if the shell is still busy, it reports the error and nothing is started.

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
- **Codex**: Codex creates the ID on its first turn; harma reads it from herdr's agent detection, or from `~/.codex/sessions` by matching the folder and start time

Other CLIs run normally, but harma can resume only Claude Code and Codex sessions.

## Clean up finished agents

At the end of each step, the orchestrator runs:

```sh
harma cleanup --dry-run
harma cleanup
```

The first command lists what would close, with session IDs. The second saves each session ID to `.harma/agents.jsonl`, then closes the agent's tab or terminal.

`cleanup` keeps an agent open in two cases: it's still `working` or `blocked`, or harma can't find its session ID, since closing it would lose the context. `--force` closes it anyway, and `--agent agent_name` limits cleanup to one agent. Once no harma agent is open, `harma cleanup --workspace` also closes the herdr workspace harma created.

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
| `.harma/config.json` | Orchestrator, backend, herdr layout, trust policy, dispatch policy, budgets, thresholds, routing overrides and your model choices (`roster`) |
| `.harma/agents.jsonl` | Append-only events: `orchestrator`, `started`, `session`, `prompted`, `blocked`, `trusted`, `trust_skipped`, `trust_policy`, `closed`, `resumed`, `roster` |
| `.harma/cache/` | Last inventory, credits, ranking and selection status, each with its fetch time; git ignores this folder |

`config.json` and `agents.jsonl` are plain files you can read and commit. Edit `config.json` by hand only for `budgets`, `thresholds` and `routing`; use `harma init` and `harma select` for the rest.
