import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const { APP_VERSION } = await import('../src/main/version.js');
const { firefoxManifest } = await import('../scripts/stage-firefox-extension.mjs');

describe('Firefox companion packaging', () => {
  it('derives the signed-AMO manifest from the canonical shared extension without runtime drift', async () => {
    const source = JSON.parse(await fs.readFile(path.join(process.cwd(), 'extension', 'manifest.json'), 'utf8'));
    const manifest = firefoxManifest(source);

    expect(manifest.version).toBe(APP_VERSION);
    expect(manifest.minimum_chrome_version).toBeUndefined();
    expect(manifest.background).toEqual({ scripts: ['background.js'], type: 'module' });
    expect(manifest.browser_specific_settings).toEqual({
      gecko: {
        id: 'chat-on-steroids-companion@local',
        strict_min_version: '128.0',
        data_collection_permissions: {
          required: ['personalCommunications', 'websiteContent']
        }
      }
    });
    expect(manifest.content_security_policy).toEqual({
      extension_pages: "script-src 'self'; object-src 'self'"
    });

    // Runtime and permission surfaces come from the shared source rather than a Firefox fork.
    expect(manifest.permissions).toEqual(source.permissions);
    expect(manifest.host_permissions).toEqual(source.host_permissions);
    expect(manifest.content_scripts).toEqual(source.content_scripts);
  });
});
