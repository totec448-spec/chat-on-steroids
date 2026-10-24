// Records what the TypeScript benign-exit classifier (`nonZeroExitIsBenign`, `benignExitNote`
// in src/main/exec-hints.ts) answers for every call its own vitest suites make, and writes the
// distinct cases to tests/benign-oracle.json for cos-exec's unit test to replay.
//
//   node rust/crates/cos-exec/differential/benign-oracle.mjs
//
// Needs the repository's npm dependencies (`npm ci`) and ripgrep (`npm run rg`).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'cos-benign-'));
const recorded = path.join(scratch, 'calls.jsonl');
writeFileSync(recorded, '');

const vitest = spawnSync(
  'npx vitest run --config rust/crates/cos-exec/differential/vitest.config.mts',
  { cwd: repo, stdio: 'inherit', shell: true, env: { ...process.env, COS_BENIGN_RECORD: recorded } }
);
if (vitest.status !== 0) {
  console.error(`vitest exited ${vitest.status ?? vitest.error}`);
  process.exit(2);
}

const seen = new Set();
const cases = { benign: [], note: [] };
for (const line of readFileSync(recorded, 'utf8').split('\n')) {
  if (!line) continue;
  if (seen.has(line)) continue;
  seen.add(line);
  const { fn, ...row } = JSON.parse(line);
  cases[fn].push(row);
}
rmSync(scratch, { recursive: true, force: true });
const out = path.join(here, '..', 'tests', 'benign-oracle.json');
writeFileSync(out, JSON.stringify(cases, null, 2) + '\n');
console.log(`${cases.benign.length} classifier and ${cases.note.length} note cases -> ${path.relative(repo, out)}`);
