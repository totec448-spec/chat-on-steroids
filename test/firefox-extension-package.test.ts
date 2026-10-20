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
  it('keeps the manual npm staging entrypoint while release publication remains separate', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['extension:firefox:stage']).toBe('node scripts/stage-firefox-extension.mjs');
  });

  // Mozilla's add-on review flags markup assigned through innerHTML; the gear icon was the one case.
  it('assigns no markup through innerHTML in the scripts the add-on ships', async () => {
    for (const file of (await fs.readdir(extensionRoot)).filter(name => name.endsWith('.js'))) {
      const source = await fs.readFile(path.join(extensionRoot, file), 'utf8');
      expect(source, file).not.toMatch(/\.innerHTML\s*=(?!=)/);
      expect(source, file).not.toMatch(/\.outerHTML\s*=(?!=)/);
    }
  });

  it('adds a Firefox-only build number when one is given, and only digits', async () => {
    // Mozilla never signs a version twice (2.1.43, 2026-10-20): the publish run can ask for 2.1.43.1.
    const source = JSON.parse(await fs.readFile(path.join(extensionRoot, 'manifest.json'), 'utf8'));
    expect(firefoxManifest(source, '1').version).toBe(`${APP_VERSION}.1`);
    expect(firefoxManifest(source, '').version).toBe(APP_VERSION);
    expect(firefoxManifest(source).version).toBe(APP_VERSION);
    for (const bad of ['0', '01', 'a', '1.2', '1000']) expect(() => firefoxManifest(source, bad), bad).toThrow();
  });

  it('derives only the Gecko manifest delta from the canonical companion manifest', async () => {
    const source = JSON.parse(await fs.readFile(path.join(extensionRoot, 'manifest.json'), 'utf8'));
    const manifest = firefoxManifest(source);

    expect(manifest.version).toBe(APP_VERSION);
    expect(manifest.minimum_chrome_version).toBeUndefined();
    expect(manifest.background).toEqual({ scripts: ['background.js'], type: 'module' });
    expect(manifest.content_security_policy).toEqual({ extension_pages: "script-src 'self'; object-src 'self'" });
    expect(manifest.browser_specific_settings).toEqual({
      // The id is permanent once Mozilla signs it; updates come from the latest release.
      gecko: {
        id: 'companion@chatonsteroids.app',
        strict_min_version: '140.0',
        update_url: 'https://github.com/totec448-spec/chat-on-steroids/releases/latest/download/firefox-updates.json',
        data_collection_permissions: { required: ['personalCommunications', 'websiteContent'] }
      },
      // Mozilla's validator (2026-10-15): data_collection_permissions arrived in Firefox for
      // Android only with 142, so a 140 minimum warned there.
      gecko_android: { strict_min_version: '142.0' }
    });

    // Runtime code and permissions stay shared; this is package compatibility only. Firefox has no
    // `debugger` permission (no DevTools API for extensions), so the Gecko manifest leaves it out.
    expect(source.permissions).toContain('debugger');
    expect(manifest.permissions).toEqual(source.permissions.filter((permission: string) => permission !== 'debugger'));
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
