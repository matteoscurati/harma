# Choose the models for each job

This guide shows how to accept the orchestrator's proposals or choose your own models and effort levels, for the orchestrator and for each kind of job. Your choices are stored per project, and `harma dispatch --task-type` uses them before any proposal.

## Kinds of job

harma sorts work into six jobs. The CLI uses the Italian names and accepts the English aliases:

| Job | Aliases | What the proposal favours |
|---|---|---|
| `pianificazione` | `planning`, `plan` | Highest intelligence; cost matters little |
| `sviluppo` | `development`, `dev`, `build` | High intelligence at a reasonable cost |
| `review` | `code-review`, `revisione` | A vendor other than the one that wrote the code |
| `debugging` | `debug`, `problem-solving` | High intelligence; cost matters little |
| `ricerca` | `research` | Good intelligence at a contained cost |
| `estrazione` | `extraction`, `clerk` | The cheapest model above a minimum score |

[How harma decides](how-harma-decides.md) explains the scoring behind each proposal.

## Open the selection screen

Run `harma select` in your own terminal from the project folder. When an agent drives harma it has no terminal of its own, so it runs this instead:

```sh
harma select --open --wait
```

That opens the screen in a focused herdr tab (or an `hc` terminal) and returns your choices to the agent once you save.

The screen lists the orchestrator first, then one row per job, each with the proposal and your current choice. Use these keys:

| Key | Action |
|---|---|
| `↑` `↓` (or `k` `j`) | Move between rows |
| `Enter` | Open the row: pick the orchestrator's model, or open a job's list of models |
| `a` | Accept the proposal for this row |
| `A` | Accept every proposal |
| `x` | Clear the row (it goes back to undecided) |
| `s` | Save to `.harma/config.json` |
| `q` or `Esc` | Quit; harma asks first if you have unsaved changes |

Each model is shown with its best AA Intelligence Index and its provider's credit state. Each effort level is shown with its index and cost per task. A job can also be set to "no model", and `dispatch` then refuses that job.

## Use several models for one job

A job can hold up to five models in order of preference. When you open a job, its list appears with these keys:

| Key | Action |
|---|---|
| `+` | Add a model, then choose its effort |
| `Enter` | Change the selected model or its effort; on the "add" line, add one |
| `d` (or `Backspace`) | Remove the selected model |
| `K` `J` (or `Shift` `↑` `↓`) | Move the selected model up or down |
| `a` | Replace the list with the proposal |
| `Esc` | Go back to the rows |

The proposal for each job is the best candidate plus a backup on a different CLI, so the job keeps a model when one provider runs low.

At dispatch, harma goes down your list in order:

1. It skips a model whose CLI isn't installed or whose credits are exhausted (`esaurito`)
2. It passes over a model whose credits are low (`scarso`) when a later one has more
3. It takes the first model left; if none is left, `dispatch` stops and lists why each one was skipped

The dispatch plan names the model it took and its position, for example `n.2 di 2 — n.1 codex:gpt-6.1-sol @ xhigh saltato: crediti scarso`. `harma route <job>` shows which model on your list `dispatch` would take right now.

## Choose without the screen

The same choices work as options, which helps when you answer the orchestrator in chat:

```sh
harma select --set "sviluppo=codex:gpt-6.1-sol@xhigh|claude:claude-sonnet-5-5@high,review=none"
harma select --accept
harma select --show
```

`--set` takes `job=harness:model@effort`, separated by commas. Separate models for the same job with `|`, in order of preference, and use `none` for no model. The orchestrator takes exactly one model. `--accept` accepts every proposal and `--show` prints the current choices.

## What gets saved

Saving writes the `roster` section of `.harma/config.json` and adds a `roster` event to `.harma/agents.jsonl`. Each job records its models in order, whether you accepted the proposal (`proposta`) or chose them (`utente`), the proposal at that time, and the date. Every project has its own roster.

Saving choices never starts an agent: each `dispatch` still asks for your confirmation.
