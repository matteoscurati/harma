# Development

This page covers working on harma itself: running the tests, updating the model catalog and publishing a release. harma is plain JavaScript modules for Node.js 20 or later, with no dependencies.

## Repository layout

| Path | Contents |
|---|---|
| `bin/harma.mjs` | Command entry point |
| `src/` | Commands, backends, credits, ranking, routing, roster and the selection screen |
| `skill/SKILL.md` | The skill that `harma install` copies for Claude Code and Codex |
| `data/catalog.json` | Bundled models, efforts, prices and Artificial Analysis scores |
| `scripts/import-catalog.mjs` | Rebuilds the catalog |
| `tests/` | Test suite |
| `docs/` | This documentation |

## Run the tests

```sh
npm test
```

The suite runs with fake `herdr`, `hc`, `codexbar` and agent CLIs on a private `PATH`, so it never starts a real agent or reads your real credits. The selection screen is a pure state machine (`reduce` and `render` in `src/tui.mjs`), and the tests drive it with simulated keys.

## Update the catalog

The catalog comes from a local checkout of controller-models, the model registry that holds the Artificial Analysis snapshots:

```sh
node scripts/import-catalog.mjs path_to_controller_models
```

The script also reads the path from `HARMA_CONTROLLER_MODELS`. Users can refresh scores on their own machine with `harma rank --refresh`, without a new release.

## Release

1. Update `version` in `package.json` and add an entry to `CHANGELOG.md`
2. Run `npm test` and `node bin/harma.mjs doctor`
3. Check the package contents with `npm pack --dry-run`
4. Push to GitHub, then run `npm publish`; `prepublishOnly` runs the tests again

The package is published as `harma-kit`, and it installs the `harma` and `harma-kit` commands.
