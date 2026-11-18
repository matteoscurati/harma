#!/usr/bin/env node
// Maintainer-only: rebuild data/catalog.json from a controller-models checkout.
// Usage: node scripts/import-catalog.mjs [path/to/controller-models]
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = process.argv[2] || process.env.HARMA_CONTROLLER_MODELS
  || join(homedir(), 'work/reasance.ai/controller-models');
const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'catalog.json');
const result = spawnSync(join(root, 'bin', 'cm'), ['export-harma-catalog', dest], { stdio: 'inherit' });
if (result.error) console.error(`Cannot run controller-models at ${root}: ${result.error.message}`);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`catalog: ${dest}`);
