#!/usr/bin/env node
/**
 * Regenerates rust/crates/cos-types/tests/fixtures from the TypeScript app.
 *
 *   node rust/crates/cos-types/fixture-gen/regenerate.mjs            harvest, then select
 *   node rust/crates/cos-types/fixture-gen/regenerate.mjs --select   select from the last harvest
 *
 * The harvest runs the app's own vitest files (see HARVESTED_TESTS in vitest.config.ts) plus the
 * *.gen.ts generators here, with harvest-setup.ts recording every durable write and HTTP JSON
 * exchange. It runs at below-normal priority with two workers so it can share the machine.
 */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectFixtures } from './select-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const harvest = path.join(repo, 'rust', 'target', 'fixture-harvest');
const fixtures = path.resolve(here, '..', 'tests', 'fixtures');

os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);

if (!process.argv.includes('--select')) {
  rmSync(harvest, { recursive: true, force: true });
  const vitest = path.join(repo, 'node_modules', 'vitest', 'vitest.mjs');
  const run = spawnSync(process.execPath, [vitest, 'run', '--config', path.join(here, 'vitest.config.ts'), '--maxWorkers=2'], {
    cwd: repo,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, COS_FIXTURE_HARVEST: harvest }
  });
  // A failing app test still leaves its earlier writes behind; selection reports what it found.
  if (run.status !== 0) console.warn(`vitest exited with status ${run.status}; selecting from what was harvested`);
}

const summary = selectFixtures({ harvest, fixtures });
for (const [kind, count] of Object.entries(summary).sort()) console.log(`${kind}: ${count}`);
