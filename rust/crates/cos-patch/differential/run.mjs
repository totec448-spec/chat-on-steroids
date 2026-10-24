// Differential check: the TypeScript apply_patch (the app's own MCP server under vitest, no
// Electron window) and cos-patch (a real kernel) run the same cases on identical fresh trees.
// Prints every case whose answers or resulting files differ. Exit 0 when none differ.
//
//   node rust/crates/cos-patch/differential/run.mjs [--probe <differential.exe>] [--keep <dir>]
//
// Without --probe it builds the example with `cargo build -p cos-patch --example differential`.
// Needs the repository's npm dependencies (`npm ci`), found from this checkout upward.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cases } from './cases.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const rust = path.join(repo, 'rust');
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
};

const scratch = option('--keep') ?? mkdtempSync(path.join(os.tmpdir(), 'cos-patch-diff-'));
const casesFile = path.join(scratch, 'cases.json');
const tsOut = path.join(scratch, 'ts.json');
const rustOut = path.join(scratch, 'rust.json');
const expanded = cases.map((testCase) => ({
  ...testCase,
  binaryBytes: Object.fromEntries(
    Object.entries(testCase.binary ?? {}).map(([file, base64]) => [file, [...Buffer.from(base64, 'base64')]])
  )
}));
writeFileSync(casesFile, JSON.stringify(expanded));
const baseCaps = JSON.parse(readFileSync(path.join(rust, 'golden/base/config.json'), 'utf8')).config.capabilities;

const run = (command, args, options) => {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.status !== 0) {
    console.error(`${path.basename(command)} ${args.join(' ')} exited ${result.status ?? result.error}`);
    process.exit(2);
  }
};

let probe = option('--probe');
if (!probe) {
  run('cargo', ['build', '-q', '-p', 'cos-patch', '--example', 'differential'], { cwd: rust, shell: process.platform === 'win32' });
  probe = path.join(rust, 'target/debug/examples', process.platform === 'win32' ? 'differential.exe' : 'differential');
}
run(probe, [casesFile, rustOut]);

const vitestPackage = createRequire(path.join(repo, 'package.json')).resolve('vitest/package.json');
const vitest = path.join(path.dirname(vitestPackage), JSON.parse(readFileSync(vitestPackage, 'utf8')).bin.vitest);
run(process.execPath, [vitest, 'run', '--config', 'rust/crates/cos-patch/differential/vitest.config.mts'], {
  cwd: repo,
  env: { ...process.env, COS_PATCH_DIFF_CASES: casesFile, COS_PATCH_DIFF_OUT: tsOut, COS_PATCH_DIFF_CAPS: JSON.stringify(baseCaps) }
});

const ts = JSON.parse(readFileSync(tsOut, 'utf8'));
const rs = JSON.parse(readFileSync(rustOut, 'utf8'));

/** Folder spellings and run times differ between the two runs and mean nothing. */
function normalize(value, [project, second]) {
  const spellings = [
    [project, '<PROJECT>'], [project.replaceAll('\\', '/'), '<PROJECT>'],
    [second, '<SECOND>'], [second.replaceAll('\\', '/'), '<SECOND>']
  ].sort((a, b) => b[0].length - a[0].length);
  const text = (s) => {
    let out = s.replace(/Wall time: [0-9.e+-]+ seconds/g, 'Wall time: <DURATION> seconds');
    for (const [from, to] of spellings) out = out.split(from).join(to);
    return out;
  };
  return JSON.parse(JSON.stringify(value), (_key, item) => (typeof item === 'string' ? text(item) : item));
}

const sortKeys = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
let differing = 0;
for (const { name } of cases) {
  const left = ts[name];
  const right = rs[name];
  if (!left || !right) {
    console.log(`${name}: missing from ${left ? 'Rust' : 'TypeScript'} output`);
    differing++;
    continue;
  }
  const a = normalize({ calls: left.calls, disk: sortKeys(left.disk) }, left.roots);
  const b = normalize({ calls: right.calls, disk: sortKeys(right.disk) }, right.roots);
  if (JSON.stringify(a) === JSON.stringify(b)) continue;
  differing++;
  console.log(`\n${name}: DIFFERENT`);
  a.calls.forEach((call, index) => {
    if (JSON.stringify(call) !== JSON.stringify(b.calls[index])) {
      console.log(`  call ${index + 1}\n    ts:   ${JSON.stringify(call)}\n    rust: ${JSON.stringify(b.calls[index])}`);
    }
  });
  for (const key of new Set([...Object.keys(a.disk), ...Object.keys(b.disk)])) {
    if (JSON.stringify(a.disk[key]) !== JSON.stringify(b.disk[key])) {
      console.log(`  ${key}\n    ts:   ${JSON.stringify(a.disk[key])?.slice(0, 300)}\n    rust: ${JSON.stringify(b.disk[key])?.slice(0, 300)}`);
    }
  }
}
console.log(`\n${cases.length - differing} of ${cases.length} cases equal, ${differing} different.`);
if (!option('--keep')) rmSync(scratch, { recursive: true, force: true });
process.exit(differing === 0 ? 0 : 1);
