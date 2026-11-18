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

The catalog comes from controller-models, the model registry that holds prices and the Artificial Analysis snapshots. harma is one of its consumers, so the registry rewrites `data/catalog.json` on a new branch of this repo and runs the tests:

```sh
cm sync harma          # show what would change
cm sync harma --write  # write it on branch models/sync-<date>
```

The maintainer import script also uses `cm` from a local controller-models checkout.

```sh
node scripts/import-catalog.mjs path_to_controller_models
```

The script also reads the path from `HARMA_CONTROLLER_MODELS`. Both commands use the same renderer and stop if the destination was generated from a newer registry snapshot. Edit models in the registry before regenerating `data/catalog.json`. Users can refresh scores on their machine with `harma rank --refresh`.

## Release

1. Update `version` in `package.json` and add an entry to `CHANGELOG.md`
2. Run `npm test` and `node bin/harma.mjs doctor`
3. Check the package contents with `npm pack --dry-run`
4. Commit, then tag and push: `git tag -a vX.Y.Z -m "harma X.Y.Z" && git push origin main vX.Y.Z`

Pushing the tag starts `.github/workflows/publish.yml`, which checks that the tag matches `package.json`, runs the tests and publishes to npm through npm Trusted Publishing, so no npm login or token is needed. A version already on npm is skipped. To publish an existing tag again, run the workflow by hand: `gh workflow run publish.yml -f tag=vX.Y.Z`.

Trusted Publishing is set up once on npmjs.com, in the `harma-kit` package settings: add a trusted publisher of type GitHub Actions with owner `matteoscurati`, repository `harma` and workflow `publish.yml`.

The package is published as `harma-kit`, and it installs the `harma` and `harma-kit` commands.
