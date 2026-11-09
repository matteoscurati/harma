# Agents, sessions and backends

This page explains where harma runs agents, how it keeps each agent's session ID so you can resume it, and which files it writes in your project. harma only closes what it started, as recorded in `.harma/agents.jsonl`.

## Backends

harma runs each agent in a terminal managed by one of two backends. With `--backend auto` (the default) it uses herdr when herdr is running, otherwise herdr-core. harma never starts, stops or restarts the backend's server.

- **[herdr](https://herdr.dev)**: harma creates one workspace per project, labelled `harma:<project>`, and one tab per agent. Closing an agent closes its tab. herdr's agent detection reports each agent's state and session ID.
- **[herdr-core](https://github.com/herdrdev/herdr-core) (`hc`)**: harma starts headless terminals labelled `harma.project` and `harma.agent`, with `--outlive-parent` so they survive the orchestrator's session. State comes from the terminal's status reports. Open one with `hc attach agent_name`.

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

`--print-only` shows the native command, for example `claude --resume <session_id> --model claude-opus-5-5 --effort high` or `codex resume <session_id> -m gpt-6.1-sol -c model_reasoning_effort="high"`. Under the `confirm` policy, resuming needs `--yes`.

## Project files

harma keeps its state in `.harma/` at the project root:

| Path | Contents |
|---|---|
| `.harma/config.json` | Orchestrator, backend, dispatch policy, budgets, thresholds, routing overrides and your model choices (`roster`) |
| `.harma/agents.jsonl` | Append-only events: `orchestrator`, `started`, `session`, `prompted`, `blocked`, `closed`, `resumed`, `roster` |
| `.harma/cache/` | Last inventory, credits, ranking and selection status, each with its fetch time; git ignores this folder |

`config.json` and `agents.jsonl` are plain files you can read and commit. Edit `config.json` by hand only for `budgets`, `thresholds` and `routing`; use `harma init` and `harma select` for the rest.
