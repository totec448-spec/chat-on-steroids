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
function release(change: { manifest?: object; stamp?: string | null; omit?: string; afterSums?: () => void; firefoxVersion?: string; updatesVersion?: string; updatesHash?: string; updatesRelease?: string } = {}) {
  dir = mkdtempSync(path.join(tmpdir(), 'release-'));
  const extensionEntries: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(change.manifest ?? { version: '2.1.21' }))
  };
  if (change.stamp !== null) {
    extensionEntries['build-stamp.txt'] = strToU8(change.stamp ?? '7b3057119b13\n');
  }
  for (const name of EXTENSION_FILES) extensionEntries[name] = strToU8(name);
  const xpi = zipSync({ 'manifest.json': strToU8(JSON.stringify({ version: change.firefoxVersion ?? '2.1.21',
    browser_specific_settings: { gecko: { id: 'companion@chatonsteroids.app' } } })), 'META-INF/cose.sig': strToU8('signature') });
  const updates = Buffer.from(JSON.stringify({ addons: { 'companion@chatonsteroids.app': { updates: [{
    version: change.updatesVersion ?? '2.1.21',
    update_link: `https://github.com/totec448-spec/chat-on-steroids/releases/download/v${change.updatesRelease ?? change.updatesVersion ?? '2.1.21'}/Chat-On-Steroids-Firefox.xpi`,
    update_hash: `sha256:${change.updatesHash ?? createHash('sha256').update(xpi).digest('hex')}` }] } } }));
  const sums: string[] = [];
  for (const name of RELEASE_FILES) {
    const bytes = name === 'Chat-On-Steroids-Extension.zip' ? zipSync(extensionEntries)
      : name === 'Chat-On-Steroids-Firefox.xpi' ? xpi : name === 'firefox-updates.json' ? updates : Buffer.from(`contents of ${name}`);
    sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
    if (name !== change.omit) writeFileSync(path.join(dir, name), bytes);
  }
  writeFileSync(path.join(dir, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
  change.afterSums?.();
  return dir;
}

it('accepts a complete release whose files match their checksums and whose extension is the tagged build', async () => {
  expect(RELEASE_FILES).not.toContain('Chat-On-Steroids-Firefox.zip');
  expect(await verifyReleaseAssets({ dir: release(), tag: 'v2.1.21' })).toEqual([]);
});

it('reports a file whose bytes differ from the published checksum', async () => {
  const folder = release({ afterSums: () => writeFileSync(path.join(dir, 'Chat-On-Steroids-Setup-x64.exe'), 'truncated') });
  expect(await verifyReleaseAssets({ dir: folder, tag: 'v2.1.21' })).toEqual([
    'Chat-On-Steroids-Setup-x64.exe does not match its SHA256SUMS.txt checksum.'
  ]);
});

it('reports missing files and a Chromium extension whose version or build stamp is wrong', async () => {
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

// Firefox installs the signed add-on and follows firefox-updates.json from the latest release.
it('checks the signed Firefox add-on and the update manifest that points at it', async () => {
  expect(RELEASE_FILES).toEqual(expect.arrayContaining(['Chat-On-Steroids-Firefox.xpi', 'firefox-updates.json']));
  expect(await verifyReleaseAssets({ dir: release({ firefoxVersion: '2.1.20' }), tag: 'v2.1.21' }))
    .toEqual(['The add-on in Chat-On-Steroids-Firefox.xpi is version 2.1.20, not 2.1.21.']);
  rmSync(dir, { recursive: true, force: true });
  expect(await verifyReleaseAssets({ dir: release({ updatesVersion: '2.1.20' }), tag: 'v2.1.21' }))
    .toEqual(['firefox-updates.json does not offer Chat-On-Steroids-Firefox.xpi of v2.1.21 with its checksum.']);
  rmSync(dir, { recursive: true, force: true });
  expect(await verifyReleaseAssets({ dir: release({ updatesHash: 'b'.repeat(64) }), tag: 'v2.1.21' }))
    .toEqual(['firefox-updates.json does not offer Chat-On-Steroids-Firefox.xpi of v2.1.21 with its checksum.']);
});

it('accepts a Firefox-only fourth version part of this release, and nothing looser', async () => {
  // v2.1.43 (2026-10-20): Mozilla had already signed 2.1.43 from a tag that moved, so this release
  // signed its add-on as 2.1.43.1 (publish.yml firefox_build), and the check reported it as wrong.
  const fourth = { firefoxVersion: '2.1.21.1', updatesVersion: '2.1.21.1', updatesRelease: '2.1.21' };
  expect(await verifyReleaseAssets({ dir: release(fourth), tag: 'v2.1.21' })).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
  // The update file must offer exactly the add-on it ships.
  expect(await verifyReleaseAssets({ dir: release({ ...fourth, updatesVersion: '2.1.21', updatesRelease: undefined }), tag: 'v2.1.21' }))
    .toEqual(['firefox-updates.json does not offer Chat-On-Steroids-Firefox.xpi of v2.1.21 with its checksum.']);
  rmSync(dir, { recursive: true, force: true });
  for (const version of ['2.1.22.1', '2.1.21.0', '2.1.21.1000', '2.1.211']) {
    expect(await verifyReleaseAssets({ dir: release({ firefoxVersion: version, updatesVersion: version, updatesRelease: '2.1.21' }), tag: 'v2.1.21' }), version)
      .toContain(`The add-on in Chat-On-Steroids-Firefox.xpi is version ${version}, not 2.1.21.`);
    rmSync(dir, { recursive: true, force: true });
  }
});
