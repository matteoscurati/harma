# Troubleshooting

This page covers the situations where harma stops and asks for something, and how to get past each one. Start with `harma doctor`, which checks Node.js, the catalog, the backends, the agent CLIs, CodexBar, the Artificial Analysis key and the installed skill, and says what to install for each missing piece.

## A command exits with code 3

Code 3 isn't an error: harma needs your confirmation before it starts or instructs an agent. It prints the plan (model, effort, command and why) and starts nothing. When you agree, the orchestrator reruns the same command with `--yes`. Your yes covers that one dispatch, not retries or extra agents.

## An agent waits on a dialog

`dispatch` exits with code 4 when the agent started but waits on a question, often "Do you trust this folder?" the first time a CLI opens a new directory. The task wasn't sent. To continue:

1. Run `harma read agent_name` to see the question
2. Answer it yourself in the agent's tab or terminal; the orchestrator must not answer approval dialogs for you
3. Send the task again with `harma send agent_name "task" --yes`

## The selection screen needs a terminal

`harma select` without options needs an interactive terminal. An agent has none, so it runs `harma select --open --wait`, which opens the screen in a herdr tab or an `hc` terminal. Without either, record choices with `harma select --set`, `--accept` or `--show`; see [Choose the models for each job](choosing-models.md#choose-without-the-screen).

## Dispatch finds no usable model for a job

`dispatch --task-type` stops when every model you saved for that job is unavailable: its CLI isn't installed or its credits are exhausted. The message lists the reason for each model. Add another model with `harma select`, wait for the provider's reset, or pass `--model harness:model` for this one dispatch.

When you chose "no model" for a job, `dispatch --task-type` refuses it by design; pass `--model` or change the choice.

## Credits show as unknown

`sconosciuto` means harma has no reliable figure for that provider:

- **CodexBar isn't installed or not running**: install [CodexBar](https://github.com/steipete/CodexBar), or declare a budget
- **CodexBar doesn't report this provider**: enable the provider in the CodexBar app
- **No CodexBar and no budget**: add `budgets.<provider>` to `.harma/config.json`, as shown in [How harma decides](how-harma-decides.md#credits)

## A model has no score

The bundled snapshot doesn't cover every model and effort level. Set `AA_API_KEY` and run `harma rank --refresh` to fetch current scores. A model that Artificial Analysis hasn't measured stays unknown and doesn't appear in proposals, but you can still choose it in `harma select` or pass it with `--model`.

## Cleanup keeps an agent open

`cleanup` keeps agents that are `working` or `blocked`, and agents whose session ID it can't find, because closing them would lose work or context. Check them with `harma status` and `harma read agent_name`. Use `harma cleanup --force` only when you're sure you don't need the session again.
