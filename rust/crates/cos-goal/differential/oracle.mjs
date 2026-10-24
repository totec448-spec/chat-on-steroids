#!/usr/bin/env node
// Regenerates differential/oracle.json from the TypeScript Goal module (vitest, no Electron).
//   node rust/crates/cos-goal/differential/oracle.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const result = spawnSync('npx', ['vitest', 'run', '--config', 'rust/crates/cos-goal/differential/vitest.config.ts'], {
  cwd: repo, stdio: 'inherit', shell: process.platform === 'win32',
  env: { ...process.env, COS_GOAL_ORACLE: path.join(here, 'oracle.json') }
});
process.exit(result.status ?? 2);
