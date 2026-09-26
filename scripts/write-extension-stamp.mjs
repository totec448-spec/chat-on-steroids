/**
 * Writes the stamp the app and the browser compare, over every file the browser loads.
 *
 * The comparison used to be computed at runtime over `background.js` and the manifest, and it was
 * blind to everything else: on 2026-09-20 a build changed `popup.js` and `browser-control.js`, and
 * both sides went on reporting the same digest about a browser that was running neither. Widening
 * that runtime hash to all eighteen files was tried and taken back out — discovery waits for the
 * digest, and eighteen reads in front of the app's first request delayed it measurably.
 *
 * So the work moves to where it costs nothing: here, once per build. Both sides then read one
 * small file, which is cheaper than what they do today and covers everything.
 *
 * A stale stamp would be the new way to be blind, so the repo's own test recomputes this from the
 * folder and fails when the file disagrees with it.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The stamp file itself, which cannot be part of what it stamps. */
export const STAMP_FILE = 'build-stamp.txt';

/**
 * Every file the browser loads, in one fixed order.
 *
 * Type stubs are left out because Chrome never loads them: they cannot be the thing that is
 * running, and including them would make an editor's `.d.ts` churn look like a changed extension.
 */
export function extensionFiles(dir) {
  const found = [];
  const visit = (current, relative = '') => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path.join(current, entry.name), name);
      else if (name !== STAMP_FILE && !name.endsWith('.d.ts')) found.push(name);
    }
  };
  visit(dir);
  return found;
}

/** Twelve hex characters over the name and bytes of every loaded file, in that order. */
export function extensionStamp(dir) {
  const hash = createHash('sha256');
  for (const name of extensionFiles(dir)) {
    hash.update(`${name}\0`);
    hash.update(readFileSync(path.join(dir, ...name.split('/'))));
  }
  return hash.digest('hex').slice(0, 12);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.join(here, '..', 'extension');

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const stamp = extensionStamp(extensionDir);
  writeFileSync(path.join(extensionDir, STAMP_FILE), `${stamp}\n`, { encoding: 'utf8' });
  console.log(`extension build stamp: ${stamp} over ${extensionFiles(extensionDir).length} file(s)`);
}
