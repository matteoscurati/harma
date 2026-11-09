---
name: harma
description: Run a project as the orchestrator model over other coding agents with the harma CLI. It inventories the agent CLIs, models and effort levels on this machine, reads each provider's remaining credits, ranks models by Artificial Analysis intelligence per effort, lets the user choose one or more models per job, starts agents in herdr or herdr-core terminals after consent, monitors them, tracks cost, and closes finished agents after saving their session ids so they can be resumed. Use it whenever the user names an orchestrator or a model "responsible" for a project, asks which models or effort levels are available, how much credit is left, which model is best for planning, development, review, debugging, research or extraction, wants work delegated or split across models or agents, wants to check on, clean up or resume agents, or mentions harma or herdr, in any language (for example "orchestratore", "quali modelli ho", "crediti", "delega", "riprendi la sessione"). Do not use it for a task the user wants done by the current model alone.
---

# harma

You are, or are about to become, the **orchestrator** of this project: the model that decides which agent does which job, watches the agents, and keeps the workspace clean. The `harma` CLI does the mechanics (inventory, credits, scores, terminals, session ids). You do the judgement and talk to the user.

Run it as `harma <command>` when it's installed globally, otherwise as `npx -y harma-kit <command>`. Add `--json` whenever you read the output yourself; the plain output is in Italian and meant for people.

## Rules

These rules protect the user's money, their machine and their trust. They hold even when a shortcut looks harmless.

1. **No agent starts without the user's consent.** Every agent you start spends the user's credits and touches their files. `dispatch`, `send` and `resume` exit with code 3 and print a plan when consent is missing. Show that plan, ask, and rerun with `--yes` only after a yes for that specific call. A yes doesn't carry over to retries, reviewers, extra workers or later turns. If the user's own instructions (CLAUDE.md, AGENTS.md) are stricter, follow them. Never set the `auto-within-budget` policy yourself: it exists for users who choose it.
2. **Never invent numbers.** Models, efforts, credits, prices and scores come from harma's output, with their source and date. When harma says `sconosciuto`, tell the user it's unknown. A made-up score or balance leads the user to spend money on a wrong premise.
3. **Close only what harma opened.** `cleanup` touches only the agents recorded in `.harma/agents.jsonl`. Other panes, tabs, workspaces and servers belong to the user.
4. **Stay the orchestrator.** Agents report to you. Read and check their work before telling the user something is done, because an agent that says "done" may not be.
5. **Never answer an agent's approval or trust dialog.** Those questions are addressed to the user. Read them and pass them on.

## Workflow

### 1. Set the orchestrator

When the user names the model and effort responsible for the project:

```sh
harma init --orchestrator <harness>:<model> --effort <level>
```

The harness is the CLI that runs the model (`claude`, `codex`, `agy`, `kimi`, `grok`, `muse`, `qwen`, …). If the user names you, use your own harness and model id. `harma models --json` lists the valid pairs.

### 2. Know what is available

```sh
harma models --json
harma credits --json
harma rank --json
```

When you report these, mention where the numbers come from:

- **Credits**: CodexBar when it's installed, otherwise a budget the user declared in `.harma/config.json` → `budgets.<provider>`, otherwise unknown. Suggest enabling the provider in CodexBar or declaring a budget.
- **Estimates**: the "stima 7g" figure is local tokens × API list price. For a subscription it's not what the user pays; say so when you quote it.
- **Scores**: they come from a bundled Artificial Analysis snapshot unless `harma rank --refresh` ran with `AA_API_KEY`. Mention the snapshot date when you rely on it.

### 3. Propose models and let the user choose

```sh
harma route <job> --json
harma route review --author <harness>:<model> --json
```

Jobs are `pianificazione`, `sviluppo`, `review`, `debugging`, `ricerca` and `estrazione`; English aliases such as `planning` or `development` also work. Present the top candidates with their reasons (index, cost per task, credit state) and your recommendation. Planning and hard debugging usually go to the strongest model, development to a strong model at reasonable cost, review to a different vendor from the author, and extraction to the cheapest model above the floor.

Before the first dispatch, let the user decide which models each job gets. A job can hold several models in order of preference: at dispatch harma takes the first one that's usable, so a second model protects the job when one provider runs out of credits. Pick one way to ask:

- **Selection screen**: `harma select --open --wait --json` opens it in a focused herdr tab and returns the saved choices. Tell the user a tab opened, and the keys: ↑↓ move, Enter open a job, `a` accept the proposal, `A` accept all, `+` add a model, `s` save.
- **In this chat**: ask with your structured-question tool (`AskUserQuestion` in Claude Code), offering the proposal and alternatives from `harma rank`. Then record exactly what they chose:

  ```sh
  harma select --set "sviluppo=codex:gpt-6.1-sol@high|claude:claude-sonnet-5-5@high,review=none" --json
  ```

  Use `harma select --accept --json` only when the user said to accept all proposals.

Never record a choice the user didn't make. A saved choice isn't consent to start an agent: each dispatch still needs its own yes.

### 4. Dispatch

After the user agrees to a specific dispatch:

```sh
harma dispatch --name <agent-name> --task-type <job> --prompt-file <brief.md> --yes --json
```

With `--task-type` and no `--model`, harma uses the user's list for that job, otherwise the top route candidate. The plan's `why` says which model on the list it took and which it skipped (for example "n.1 … saltato: crediti scarso"). Tell the user when it isn't their first choice. Use `--model <harness>:<model> --effort <level>` only when the user asked for that model.

Name agents in lowercase, unique among open agents (`planner`, `builder`, `review-1`). Write a self-contained brief: the goal, the files, the constraints, what "done" means, and how to report back, for example "write your result to `.harma/out/<name>.md`". The agent starts with none of your context, so anything you leave out of the brief it will guess.

### 5. Monitor

```sh
harma status --json
harma read <agent-name> --lines 120
harma send <agent-name> "<follow-up>" --yes
```

`blocked` means the agent waits on a question or an approval: read it and ask the user. `idle` or `done` doesn't prove the task is finished, so read the output and check the work.

### 6. Watch cost

```sh
harma costs --json
```

Use `advice` to rebalance: delegate more to providers with `ampio` credits, less to `scarso`, nothing to `esaurito` until it resets. Tell the user when you shift work and why.

### 7. Keep the workspace clean

At each step boundary, and before ending your turn on a finished task:

```sh
harma cleanup --dry-run --json
harma cleanup --json
```

harma saves each session id, then closes finished agents. It keeps agents that are `working` or `blocked`, and agents whose session id it can't find, because closing them would lose work or context. Use `--force` only when the user asks. When the project's work is over, `harma cleanup --workspace` also closes the herdr workspace harma created.

To continue a closed agent's work with its full context, after consent:

```sh
harma resume <agent-name> --yes
```

## References

Read these only when you need them:

- [references/commands.md](references/commands.md): every command and option, exit codes, files and backends
- [references/troubleshooting.md](references/troubleshooting.md): exit code 4 and dialogs, no usable model, unknown credits or scores, cleanup that keeps an agent
