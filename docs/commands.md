# Command reference

This page lists every `harma` command with its options and exit codes. harma prints its own messages in Italian; every command also takes `--json` for output an agent can parse.

Model targets are written `harness:model`, where the harness is the CLI that runs the model, for example `claude:claude-opus-5-5` or `codex:gpt-6.1-sol`. `harma models` lists the valid pairs on your machine.

## Set up a project

| Command | Description |
|---|---|
| `init --orchestrator harness:model --effort level` | Creates `.harma/` and records the orchestrator |

`init` options:

- `--backend auto|herdr|hc`: terminal backend; `auto` (default) uses herdr when it runs, otherwise `hc`
- `--policy confirm|auto-within-budget`: dispatch policy; `confirm` is the default, see [consent](how-harma-decides.md#consent)

## Know your resources

| Command | Description |
|---|---|
| `models` | Agent CLIs on `PATH`, their models and effort levels, with the source of each row |
| `credits` | Remaining share per provider and its state: `ampio`, `ok`, `scarso`, `esaurito` or `sconosciuto` |
| `rank [--refresh] [--top count]` | AA Intelligence Index and cost per task for each model and effort; `--refresh` updates the scores from the AA API |
| `route job [--author harness:model] [--top count]` | Best candidates for a job, your saved choice, and which of your models `dispatch` would use now |

`--author` on `route review` excludes the vendor of the model that wrote the code.

## Choose models

| Command | Description |
|---|---|
| `select` | Opens the selection screen in this terminal |
| `select --open [--wait] [--timeout seconds]` | Opens the screen in a focused herdr tab or an `hc` terminal; `--wait` returns your choices once you save (default timeout 900) |
| `select --set "job=harness:model@effort\|…,…"` | Records choices without the screen; `none` means no model for that job |
| `select --accept` | Accepts every proposal |
| `select --show` | Prints the current choices and proposals |

[Choose the models for each job](choosing-models.md) covers the screen and the `--set` syntax.

## Delegate work

These commands start or instruct an agent, so under the `confirm` policy they need `--yes`. Without it they print the plan and exit with code 3.

| Command | Description |
|---|---|
| `dispatch --name agent_name (--model harness:model [--effort level] \| --task-type job)` | Starts an agent in its own tab or terminal and sends it the task |
| `send agent_name "text" [--wait] [--timeout seconds]` | Gives an open agent more work |
| `read agent_name [--lines count]` | Prints the agent's recent screen output |

`dispatch` options:

- `--prompt "text"` or `--prompt-file path`: the task to send once the agent starts
- `--task-type job`: uses your saved models for that job, otherwise the best route candidate
- `--cwd path`: working folder for the agent (default: the project root)
- `--wait`: waits until the agent is idle again; `--timeout seconds` (default 600)
- `--author harness:model`: with `--task-type review` and no saved choice, excludes that vendor

Agent names are lowercase, start with a letter, use `a-z`, `0-9`, `_` or `-`, are at most 32 characters, and are unique among open agents.

## Watch agents

| Command | Description |
|---|---|
| `status [--all]` | Each open agent: model, effort, live state, age and session ID; `--all` includes closed agents |
| `costs` | Estimated cost per agent, credits per provider, and advice on where to delegate more or less |

Live states come from the backend: `working`, `idle`, `done`, `blocked`, `unknown` or `finished`.

## Clean up and resume

| Command | Description |
|---|---|
| `cleanup [--dry-run] [--agent agent_name] [--force] [--workspace]` | Saves session IDs, then closes finished agents |
| `resume agent_name [--print-only] [--yes]` | Reopens a closed agent's session with its model and effort |

`cleanup` keeps agents that are `working` or `blocked` and agents whose session ID it can't find; `--force` closes them anyway. `--workspace` also closes the herdr workspace harma created, once no harma agent is open. `resume --print-only` prints the native resume command without running it.

## Install the skill

| Command | Description |
|---|---|
| `install [--target claude\|codex\|both] [--force]` | Copies the skill into `~/.claude/skills/harma` and `~/.codex/skills/harma` |
| `uninstall [--target claude\|codex\|both] [--force]` | Removes the skill harma installed |
| `doctor` | Checks Node.js, catalog, backends, agent CLIs, CodexBar, the AA key and the installed skill |

harma doesn't overwrite or remove a skill folder it didn't install unless you pass `--force`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done |
| 1 | Error; the message says what failed and how to fix it |
| 3 | Needs your confirmation; nothing was started (rerun with `--yes` after you agree) |
| 4 | `dispatch` started the agent, but it waits on a dialog and the task wasn't sent; see [troubleshooting](troubleshooting.md#an-agent-waits-on-a-dialog) |

## Environment variables

| Variable | Use |
|---|---|
| `AA_API_KEY` | Artificial Analysis API key for `rank --refresh` |
| `HERDR_TAB_ID` | Set by herdr; `select --open` uses it to close its own tab |
