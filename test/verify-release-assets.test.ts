import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
// @ts-expect-error The checker is a plain Node script without type declarations.
import { RELEASE_FILES as files, verifyReleaseAssets as verify } from '../scripts/verify-release-assets.mjs';

const RELEASE_FILES = files as string[];
const verifyReleaseAssets = verify as (options: { dir: string; tag: string }) => Promise<string[]>;

const EXTENSION_FILES = ['background.js', 'chatgpt-dom.js', 'content.js', 'fiber.js', 'overlay.css', 'popup.html', 'popup.css', 'popup.js',
  'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png', 'LICENSE'];
let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

/** A complete, correct release folder; `change` edits it before the checksums are written. */
function release(change: { manifest?: object; stamp?: string | null; omit?: string; afterSums?: () => void } = {}) {
  dir = mkdtempSync(path.join(tmpdir(), 'release-'));
  const entries: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(change.manifest ?? { version: '2.1.21' }))
  };
  if (change.stamp !== null) entries['build-stamp.txt'] = strToU8(change.stamp ?? '7b3057119b13\n');
  for (const name of EXTENSION_FILES) entries[name] = strToU8(name);
  const sums: string[] = [];
  for (const name of RELEASE_FILES) {
    const bytes = name === 'Chat-On-Steroids-Extension.zip' ? zipSync(entries) : Buffer.from(`contents of ${name}`);
    sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
    if (name !== change.omit) writeFileSync(path.join(dir, name), bytes);
  }
  writeFileSync(path.join(dir, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
  change.afterSums?.();
  return dir;
}

it('accepts a complete release whose files match their checksums and whose extension is the tagged build', async () => {
  expect(await verifyReleaseAssets({ dir: release(), tag: 'v2.1.21' })).toEqual([]);
});

it('reports a file whose bytes differ from the published checksum', async () => {
  const folder = release({ afterSums: () => writeFileSync(path.join(dir, 'Chat-On-Steroids-Setup-x64.exe'), 'truncated') });
  expect(await verifyReleaseAssets({ dir: folder, tag: 'v2.1.21' })).toEqual([
    'Chat-On-Steroids-Setup-x64.exe does not match its SHA256SUMS.txt checksum.'
  ]);
});

it('reports a missing file and an extension that is not the tagged version or has no build stamp', async () => {
  expect(await verifyReleaseAssets({ dir: release({ omit: 'Chat-On-Steroids-Linux-arm64.deb' }), tag: 'v2.1.21' }))
    .toEqual(['Chat-On-Steroids-Linux-arm64.deb is missing from the release.']);
  rmSync(dir, { recursive: true, force: true });
  expect(await verifyReleaseAssets({ dir: release({ manifest: { version: '2.1.20' }, stamp: null }), tag: 'v2.1.21' })).toEqual([
    'Chat-On-Steroids-Extension.zip is missing build-stamp.txt.',
    'The extension in Chat-On-Steroids-Extension.zip is version 2.1.20, not 2.1.21.'
  ]);
});

it('reports a release without checksums instead of trusting its files', async () => {
  const folder = release({ afterSums: () => rmSync(path.join(dir, 'SHA256SUMS.txt')) });
  expect(await verifyReleaseAssets({ dir: folder, tag: 'v2.1.21' })).toEqual(['SHA256SUMS.txt is missing from the release.']);
});
