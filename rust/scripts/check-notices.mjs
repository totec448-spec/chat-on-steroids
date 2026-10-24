#!/usr/bin/env node
/**
 * Fails when rust/THIRD-PARTY-NOTICES.txt differs from what cargo-about generates for the
 * workspace's current dependencies. Needs cargo and cargo-about (`cargo install cargo-about`).
 *
 *   node rust/scripts/check-notices.mjs           check
 *   node rust/scripts/check-notices.mjs --write   regenerate the file
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rust = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const notices = path.join(rust, 'THIRD-PARTY-NOTICES.txt');
const rustupCargo = path.join(os.homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const cargo = process.env.CARGO ?? (existsSync(rustupCargo) ? rustupCargo : 'cargo');

// --frozen: the lock file decides the crates, and license texts come only from the packaged
// crates, so the output does not depend on the network. cargo-about refuses to write to a pipe
// on Windows, so it writes to a scratch file.
const scratch = mkdtempSync(path.join(os.tmpdir(), 'cos-notices-'));
const output = path.join(scratch, 'notices.txt');
const run = spawnSync(cargo, ['about', 'generate', '--workspace', '--frozen', '-o', output, 'about.hbs'], {
  cwd: rust,
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true
});
const generated = run.status === 0 ? readFileSync(output) : null;
rmSync(scratch, { recursive: true, force: true });
if (!generated) {
  const hint = run.error?.code === 'ENOENT' ? ' cargo was not found: install Rust, then `cargo install cargo-about`.' : '';
  console.error(`cargo about generate failed.${hint}`);
  process.exit(1);
}

if (process.argv.includes('--write')) {
  writeFileSync(notices, generated);
  console.log('Wrote rust/THIRD-PARTY-NOTICES.txt.');
  process.exit(0);
}

const committed = readFileSync(notices);
if (committed.equals(generated)) {
  console.log('Rust third-party notices are current.');
  process.exit(0);
}
const crates = bytes => new Set(bytes.toString('utf8').match(/^ {2}\S+@\S+$/gm) ?? []);
const now = crates(generated);
const before = crates(committed);
const added = [...now].filter(entry => !before.has(entry)).map(entry => entry.trim());
const removed = [...before].filter(entry => !now.has(entry)).map(entry => entry.trim());
console.error('rust/THIRD-PARTY-NOTICES.txt is stale.');
if (added.length) console.error(`  missing: ${added.join(', ')}`);
if (removed.length) console.error(`  no longer used: ${removed.join(', ')}`);
if (!added.length && !removed.length) console.error('  the crates match, but license texts or their order differ');
console.error('Regenerate it with `node rust/scripts/check-notices.mjs --write`.');
process.exit(1);
