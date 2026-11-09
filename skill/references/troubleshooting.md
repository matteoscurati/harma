# harma troubleshooting

## Exit code 4: the agent waits on a dialog

The agent started but waits on a question, often "trust this folder?" in a new directory, and the task wasn't delivered.

1. `harma read <name>` to see the question
2. Tell the user what it asks and ask them to answer it in the agent's tab or terminal. Don't answer it yourself, even when the answer looks obvious: trust and approval decisions belong to the user
3. After they confirm, `harma send <name> "<task>" --yes` (this needs their yes for the send)

## No usable model for a job

`dispatch --task-type` fails when every model on the user's list for that job has a missing CLI or exhausted credits; the hint lists the reason for each. Tell the user and offer options: add a model with `harma select`, wait for the provider's reset, or use `--model` for this dispatch if they pick one. If the user chose "no model" for the job, dispatch refuses it on purpose; ask before working around it.

## Selection screen without a terminal

`harma select` with no options needs an interactive terminal, which you don't have. Use `harma select --open --wait --json`, or ask in chat and record with `--set`.

## Credits are `sconosciuto`

harma has no reliable figure. Say so; don't estimate. Suggest one of: install or start CodexBar, enable the provider in CodexBar, or declare a budget in `.harma/config.json`:

```json
{ "budgets": { "codex": { "limit": 100, "currency": "USD" } } }
```

## A model has no score

The bundled Artificial Analysis snapshot doesn't cover it. If `AA_API_KEY` is set, `harma rank --refresh` may fill it in. An unscored model never appears in proposals, but the user can still choose it.

## Cleanup keeps an agent

`working` or `blocked` agents, and agents without a known session id, stay open. Check with `harma status --json` and `harma read <name>`. Use `--force` only when the user asks, since it loses that agent's context.

## Anything else

`harma doctor` lists what's missing (backends, agent CLIs, CodexBar, AA key, installed skill) and how to install it. Don't start, stop or restart a herdr or hc server yourself.
