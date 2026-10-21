/**
 * The Firefox add-on's identity and update manifest, shared by the stager and the release.
 *
 * Releases attach the Mozilla-signed add-on (self-hosted, "unlisted" on AMO) and this manifest.
 * The add-on's own update_url points at the latest release's copy, and Firefox installs the
 * package it names after checking its hash. The id is permanent once Mozilla signs it.
 *
 *   node scripts/firefox-update-manifest.mjs <signed.xpi> <version> <out.json>
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const FIREFOX_ADDON_ID = 'companion@chatonsteroids.app';
export const FIREFOX_XPI = 'Chat-On-Steroids-Firefox.xpi';
export const FIREFOX_UPDATES = 'firefox-updates.json';
const RELEASES = 'https://github.com/totec448-spec/chat-on-steroids/releases';
export const FIREFOX_UPDATE_URL = `${RELEASES}/latest/download/${FIREFOX_UPDATES}`;

export function firefoxUpdateManifest({ version, sha256 }) {
  // A fourth part is a Firefox-only build of the release named by the first three (2.1.43.1 → v2.1.43).
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error(`Not a release version: ${version}`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Not a sha256 digest');
  const release = version.split('.').slice(0, 3).join('.');
  return {
    addons: {
      [FIREFOX_ADDON_ID]: {
        updates: [{ version, update_link: `${RELEASES}/download/v${release}/${FIREFOX_XPI}`, update_hash: `sha256:${sha256}` }]
      }
    }
  };
}

export async function writeFirefoxUpdateManifest({ xpi, version, out }) {
  const sha256 = createHash('sha256').update(await readFile(xpi)).digest('hex');
  await writeFile(out, `${JSON.stringify(firefoxUpdateManifest({ version, sha256 }), null, 2)}\n`, 'utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [xpi, version, out] = process.argv.slice(2);
  if (!xpi || !version || !out) {
    console.error('Usage: node scripts/firefox-update-manifest.mjs <signed.xpi> <version> <out.json>');
    process.exit(2);
  }
  await writeFirefoxUpdateManifest({ xpi, version, out });
}
