import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The script is plain Node without type declarations.
import * as script from '../scripts/firefox-update-manifest.mjs';

const { FIREFOX_ADDON_ID, FIREFOX_XPI, firefoxUpdateManifest, writeFirefoxUpdateManifest } = script as {
  FIREFOX_ADDON_ID: string; FIREFOX_XPI: string;
  firefoxUpdateManifest(options: { version: string; sha256: string }): unknown;
  writeFirefoxUpdateManifest(options: { xpi: string; version: string; out: string }): Promise<void>;
};

// Firefox checks the add-on's update_url (the latest release's firefox-updates.json) and installs
// the signed package it names, after checking that package's hash.
describe('Firefox update manifest', () => {
  it('names exactly this release\'s signed package and its hash', () => {
    expect(firefoxUpdateManifest({ version: '2.1.38', sha256: 'a'.repeat(64) })).toEqual({
      addons: {
        [FIREFOX_ADDON_ID]: {
          updates: [{
            version: '2.1.38',
            update_link: `https://github.com/totec448-spec/chat-on-steroids/releases/download/v2.1.38/${FIREFOX_XPI}`,
            update_hash: `sha256:${'a'.repeat(64)}`
          }]
        }
      }
    });
  });

  it('refuses anything that is not a release version or a sha256', () => {
    expect(() => firefoxUpdateManifest({ version: '2.1', sha256: 'a'.repeat(64) })).toThrow();
    expect(() => firefoxUpdateManifest({ version: '2.1.38', sha256: 'xyz' })).toThrow();
  });

  it('hashes the signed package on disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-ff-update-'));
    try {
      const xpi = path.join(dir, FIREFOX_XPI);
      await fs.writeFile(xpi, 'signed bytes');
      const out = path.join(dir, 'firefox-updates.json');
      await writeFirefoxUpdateManifest({ xpi, version: '2.1.38', out });
      const written = JSON.parse(await fs.readFile(out, 'utf8'));
      expect(written.addons[FIREFOX_ADDON_ID].updates[0].update_hash)
        .toBe(`sha256:${createHash('sha256').update('signed bytes').digest('hex')}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
