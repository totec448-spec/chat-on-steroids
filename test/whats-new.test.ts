import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, loadConfig } from '../src/main/config.js';
import { APP_VERSION } from '../src/main/version.js';
import { releaseNotesUrl, whatsNewAction } from '../src/shared/whats-new.js';
import { makeTempDir, removeTempDir } from './helpers.js';

// #1172: What's New shows once after a real update, never on a fresh install.

describe('whatsNewAction', () => {
  const has = (version: string) => version === '2.1.30';
  it('shows once after an update to a version with highlights', () => {
    expect(whatsNewAction('2.1.30', '2.1.29', has)).toBe('show');
    expect(whatsNewAction('2.1.30', '2.1.30', has)).toBe('none');
  });
  it('treats a configuration from before the feature as an update', () => {
    expect(whatsNewAction('2.1.30', undefined, has)).toBe('show');
  });
  it('records quietly for a version without highlights, a downgrade, or a malformed old value', () => {
    expect(whatsNewAction('2.1.31', '2.1.30', has)).toBe('record');
    expect(whatsNewAction('2.1.30', '2.1.31', has)).toBe('record');
    expect(whatsNewAction('2.1.30', '2.1.30.1', has)).toBe('record');
  });
  it('links the full notes of that exact version', () => {
    expect(releaseNotesUrl('2.1.30')).toBe('https://github.com/totec448-spec/chat-on-steroids/releases/tag/v2.1.30');
  });
});

describe('the version a start records', () => {
  let dir: string;
  beforeAll(async () => { dir = await makeTempDir('clf-whats-new-'); initConfigPath(dir); });
  afterAll(async () => { await removeTempDir(dir); });

  it('records its own version on a fresh install, so nothing shows', async () => {
    await fs.rm(path.join(dir, 'config.json'), { force: true });
    expect((await loadConfig()).ui.lastSeenVersion).toBe(APP_VERSION);
  });
  it('keeps an existing install without a recorded version unrecorded, so its update shows', async () => {
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(defaultConfig()), 'utf8');
    expect((await loadConfig()).ui.lastSeenVersion).toBeUndefined();
  });
  it('drops a stored value that is not a version string instead of rejecting the file', async () => {
    const config = { ...defaultConfig(), ui: { ...defaultConfig().ui, lastSeenVersion: 42 } };
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(config), 'utf8');
    const loaded = await loadConfig();
    expect(loaded.ui.lastSeenVersion).toBeUndefined();
    expect(loaded.ui.theme).toBe(defaultConfig().ui.theme);
  });
});
