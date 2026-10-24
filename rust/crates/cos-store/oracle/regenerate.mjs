#!/usr/bin/env node
/**
 * Regenerates rust/crates/cos-store/tests/oracle/*.json and src/shipped.json from the TypeScript
 * app. Run from the repository root (it needs node_modules):
 *
 *   node rust/crates/cos-store/oracle/regenerate.mjs
 */
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');

os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
const vitest = path.join(repo, 'node_modules', 'vitest', 'vitest.mjs');
const run = spawnSync(process.execPath, [vitest, 'run', '--config', path.join(here, 'vitest.config.ts'), '--maxWorkers=1'], {
  cwd: repo,
  stdio: 'inherit',
  windowsHide: true
});
process.exit(run.status ?? 1);
