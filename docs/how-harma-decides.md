# How harma decides

This page explains where harma's numbers come from and how it turns them into proposals: the intelligence scores, the routing formula, the credit states, the cost estimates and the consent policy. Every value harma shows carries its source and date, and anything it can't measure is shown as unknown (`sconosciuto`) rather than guessed.

## Intelligence scores

Model intelligence comes from the [Artificial Analysis](https://artificialanalysis.ai/models) Intelligence Index, version 5.0, measured separately for each effort level, together with Artificial Analysis's cost per task. harma bundles a snapshot dated 2026-10-28 in `data/catalog.json`.

`harma rank --refresh` downloads current scores from the Artificial Analysis API and writes them to `~/.config/harma/catalog.json`, which harma uses instead of the bundled snapshot when it's newer. The API key is read from `AA_API_KEY`, or from the delegation-kit key file `~/.local/share/delegation-kit/config/artificial-analysis.env` when it exists. A model or effort level without a score stays unknown, and routing leaves it out.

## Routing

For each job, harma scores every installed model and effort pair:

```text
score = index − cost_weight × cost_per_task + credit_adjustment
```

Each job has its own minimum index and cost weight, so planning favours intelligence while research and development weigh cost more:

| Job | Minimum index | Cost weight | Rule |
|---|---|---|---|
| `pianificazione` | 45 | 0.5 | |
| `sviluppo` | 40 | 1.5 | |
| `review` | 42 | 1 | Excludes the author's vendor when you pass `--author` |
| `debugging` | 45 | 0.75 | |
| `ricerca` | 35 | 1.5 | |
| `estrazione` | 30 | | Cheapest model above the minimum; credits only break ties |

The credit adjustment is +2 for `ampio`, 0 for `ok`, −1 for `sconosciuto` and −8 for `scarso`. Models whose credits are `esaurito` are left out. When a cost per task is unknown, harma assumes the highest known cost, so an unmeasured model never looks cheap.

To change a profile for one project, set `routing.<job>` in `.harma/config.json`, for example `{"routing": {"sviluppo": {"min_index": 45, "cost_weight": 1}}}`.

The proposal for each job is the top candidate plus the best candidate on a different CLI, as a backup. When you've saved your own models for a job, `dispatch --task-type` uses them instead; [Choose the models for each job](choosing-models.md#use-several-models-for-one-job) explains how it picks among them.

## Credits

harma reads remaining credit per provider from [CodexBar](https://github.com/steipete/CodexBar) (`codexbar usage --format json --provider all`), removes the account identity from the result, and caches it for 15 minutes.

When CodexBar doesn't report a provider, harma falls back to a budget you declare in `.harma/config.json`:

```json
{ "budgets": { "codex": { "limit": 100, "currency": "USD" } } }
```

It compares that budget with the cost estimated from the last 7 days of local session logs. With neither CodexBar nor a budget, the credit state is `sconosciuto`.

The remaining share maps to a state through `thresholds` in `.harma/config.json`:

| State | Remaining share (defaults) |
|---|---|
| `esaurito` | Below 5% |
| `scarso` | Below 20% |
| `ok` | From 20% to below 60% |
| `ampio` | 60% or more |
| `sconosciuto` | Not measured |

## Cost estimates

`harma costs` estimates what each agent has used from its local session log: `~/.claude/projects` for Claude Code and `~/.codex/sessions` for Codex. It multiplies the input, output and cached tokens by the API list prices in the catalog.

For a subscription, that figure is what the same usage would cost at API prices, not what you pay. OpenAI's cached input is counted at 10% of the input price, which is an assumption harma states in its output. `costs` also suggests delegating more to providers with `ampio` credits and less to those that are `scarso`.

## Consent

The dispatch policy decides when harma may start or instruct an agent:

- **`confirm`** (default): `dispatch`, `send` and `resume` refuse to run without `--yes` and exit with code 3, showing the plan. The orchestrator asks you, then reruns with `--yes`.
- **`auto-within-budget`**: harma starts an agent without asking only when that provider's credits are `ok` or `ampio`; otherwise it asks as under `confirm`.

Only you set `auto-within-budget`, with `harma init --policy auto-within-budget`. The skill tells the orchestrator never to change the policy, and a saved model choice is never consent to start an agent.
