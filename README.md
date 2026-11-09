# harma

harma lets one model run a project while the other models on your machine do the work. You name the orchestrator (for example Opus 5.5 at high effort) and it uses harma to see which models you have, how much credit each provider has left and how capable each model is per effort level. It then proposes who takes planning, development, review, debugging, research or extraction, starts those agents in terminal tabs once you agree, and closes them when they finish without losing their sessions.

harma is a skill for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Codex](https://github.com/openai/codex), plus the `harma` command line tool the skill drives.

## What harma does

From one conversation with your orchestrator, harma covers eight steps:

1. **Orchestrator**: records which model and effort level runs the project
2. **Inventory**: lists the agent command line interfaces (CLIs) on your machine, their models and their effort levels
3. **Credits**: reads how much each provider has left from [CodexBar](https://github.com/steipete/CodexBar), or from a budget you declare
4. **Intelligence**: ranks every model and effort pair by the [Artificial Analysis](https://artificialanalysis.ai/models) (AA) Intelligence Index and cost per task
5. **Routing**: proposes models for each kind of job; you accept them or pick your own, with several models per job in order of preference
6. **Monitoring**: shows what each agent is doing
7. **Cost**: estimates cost per agent and says where to delegate more or less
8. **Cleanup**: saves each agent's session ID, closes its tab, and reopens the same session later with its full context

No agent starts without your yes: under the default policy, every start asks for confirmation.

## Requirements

You need:

- Node.js 20 or later
- At least one agent CLI: `claude`, `codex`, `agy`, `kimi`, `grok`, `muse`, `qwen` or another one in the catalog
- A terminal backend: [herdr](https://herdr.dev) or [herdr-core](https://github.com/herdrdev/herdr-core) (`hc`)

CodexBar and an Artificial Analysis API key are optional. Without them, harma uses a declared budget and the bundled scores.

## Install

Install the skill for Claude Code and Codex, then check the setup:

```sh
npx harma-kit install
npx harma-kit doctor
```

`install` copies the skill to `~/.claude/skills/harma` and `~/.codex/skills/harma`; add `--target claude` or `--target codex` for one of them. `doctor` checks Node.js, the backends, the agent CLIs, CodexBar, the AA key and the installed skill. For the `harma` command without `npx`, run `npm i -g harma-kit`.

## Get started

In a project, ask Claude Code or Codex for what you want, in your own words:

> Use harma. You're the orchestrator, Opus 5.5 at high effort. Check which models we have and how much credit is left, then plan the auth refactor with the best planner and have a builder implement it. Ask me before starting each agent.

The skill turns that request into harma commands. These are the main ones:

```sh
harma init --orchestrator claude:claude-opus-5-5 --effort high
harma models && harma credits && harma rank --top 15
harma select --open --wait
harma dispatch --name planner --task-type pianificazione --prompt-file brief.md
harma status
harma cleanup
```

`select --open --wait` opens a screen in a herdr tab where you accept or change the models for each job. `dispatch` exits with code 3 and shows the plan until you agree; the orchestrator then runs it again with `--yes`.

## Documentation

- [Choose the models for each job](docs/choosing-models.md): the selection screen, several models per job, and doing it without a screen
- [Command reference](docs/commands.md): every command, option and exit code
- [How harma decides](docs/how-harma-decides.md): intelligence scores, routing, credits, cost estimates and consent
- [Agents, sessions and backends](docs/agents-and-sessions.md): herdr and herdr-core, session IDs, cleanup and resume, project files
- [Troubleshooting](docs/troubleshooting.md): exit codes, dialogs an agent waits on, missing credits or scores
- [Development](docs/development.md): tests, catalog updates and releases
- [Changelog](CHANGELOG.md)

## Credits

The Intelligence Index and cost per task come from [Artificial Analysis](https://artificialanalysis.ai/). herdr and herdr-core belong to their authors, and harma isn't affiliated with them.

## License

[MIT](LICENSE)
