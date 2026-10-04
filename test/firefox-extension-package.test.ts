import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error Packaging scripts are plain ESM JavaScript.
import { firefoxManifest, stageFirefoxExtension } from '../scripts/stage-firefox-extension.mjs';
import { APP_VERSION } from '../src/main/version.js';

const root = process.cwd();
const extensionRoot = path.join(root, 'extension');
const releaseRoot = path.join(root, 'release');
const staged: string[] = [];

afterEach(async () => {
  await Promise.all(staged.splice(0).map(target => fs.rm(target, { recursive: true, force: true })));
});

describe('Firefox companion packaging groundwork', () => {
  it('derives only the Gecko manifest delta from the canonical companion manifest', async () => {
    const source = JSON.parse(await fs.readFile(path.join(extensionRoot, 'manifest.json'), 'utf8'));
    const manifest = firefoxManifest(source);

    expect(manifest.version).toBe(APP_VERSION);
    expect(manifest.minimum_chrome_version).toBeUndefined();
    expect(manifest.background).toEqual({ scripts: ['background.js'], type: 'module' });
    expect(manifest.content_security_policy).toEqual({ extension_pages: "script-src 'self'; object-src 'self'" });
    expect(manifest.browser_specific_settings).toEqual({
      gecko: {
        id: 'chat-on-steroids-companion@local',
        strict_min_version: '128.0',
        data_collection_permissions: { required: ['personalCommunications', 'websiteContent'] }
      }
    });

    // Runtime code and permissions stay shared; this is package compatibility only.
    expect(manifest.permissions).toEqual(source.permissions);
    expect(manifest.host_permissions).toEqual(source.host_permissions);
    expect(manifest.content_scripts).toEqual(source.content_scripts);
    expect(source.background).toEqual({ service_worker: 'background.js', type: 'module' });
  });

  it('stages the shared extension bytes plus the generated manifest without mutating the source tree', async () => {
    const sourceManifestText = await fs.readFile(path.join(extensionRoot, 'manifest.json'), 'utf8');
    const target = path.join(releaseRoot, `firefox-extension-test-${randomUUID()}`);
    staged.push(target);

    await stageFirefoxExtension(target);

    const manifest = JSON.parse(await fs.readFile(path.join(target, 'manifest.json'), 'utf8'));
    expect(manifest.background).toEqual({ scripts: ['background.js'], type: 'module' });
    for (const relative of [
      'background.js', 'chatgpt-dom.js', 'content.js', 'fiber.js', 'usage.js', 'overlay.css',
      'popup.html', 'popup.css', 'popup.js', 'icons/icon16.png', 'icons/icon128.png', 'LICENSE'
    ]) await expect(fs.stat(path.join(target, ...relative.split('/')))).resolves.toBeTruthy();
    expect(await fs.readFile(path.join(extensionRoot, 'manifest.json'), 'utf8')).toBe(sourceManifestText);
  });

  it('refuses a staging destination outside the release directory', async () => {
    await expect(stageFirefoxExtension(path.join(root, 'firefox-outside-release'))).rejects.toThrow(/release/i);
  });

  it.each(['ancestor', 'destination'])('refuses a linked staging %s before replacing files', async kind => {
    const id = randomUUID();
    const parent = path.join(releaseRoot, `firefox-link-test-${id}`);
    // Both directories belong exclusively to this fixture, inside the current checkout.
    const outside = path.join(root, 'outputs', `firefox-protected-test-${id}`);
    const link = path.join(parent, 'redirect');
    const protectedDirectory = path.join(outside, 'existing');
    const sentinel = path.join(protectedDirectory, 'preserve.txt');
    staged.push(parent, outside);
    await fs.mkdir(parent, { recursive: true });
    await fs.mkdir(protectedDirectory, { recursive: true });
    await fs.writeFile(sentinel, 'owned fixture must remain unchanged');
    await fs.symlink(kind === 'ancestor' ? outside : protectedDirectory, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      let failure: unknown;
      try { await stageFirefoxExtension(kind === 'ancestor' ? path.join(link, 'existing') : link); }
      catch (error) { failure = error; }
      expect(await fs.readFile(sentinel, 'utf8').catch(() => null)).toBe('owned fixture must remain unchanged');
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toMatch(/link|release/i);
    } finally {
      // Remove the fixture's link before recursively cleaning its own parent directories.
      await fs.unlink(link);
    }
  });

  it('still replaces a normal existing nested staging directory', async () => {
    const parent = path.join(releaseRoot, `firefox-nested-test-${randomUUID()}`);
    const target = path.join(parent, 'nested', 'extension');
    staged.push(parent);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'stale.txt'), 'old fixture output');
    await stageFirefoxExtension(target);
    expect(await fs.stat(path.join(target, 'stale.txt')).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(target, 'background.js'), 'utf8'))
      .toBe(await fs.readFile(path.join(extensionRoot, 'background.js'), 'utf8'));
  });
});
