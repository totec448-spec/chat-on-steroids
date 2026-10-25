import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BACKUP_FORMAT, BackupError, buildBackup, changedSettings, exportableSecret, openSecrets, overlaySettings, pickByShape, readBackup, settingsForBackup, widerAccess
} from '../src/main/settings-backup.js';

// A small stand-in for the Settings form's schema: nested objects, optional and strict parts.
const schema = z.object({
  connectorSuffix: z.string().optional(),
  readOnly: z.boolean(),
  tunnel: z.object({ kind: z.string(), tunnelId: z.string() }),
  ui: z.object({ theme: z.enum(['light', 'dark']), browserBridgePort: z.string().optional(), language: z.string().optional() }),
  mcp: z.object({ instructions: z.string(), persistentUrls: z.boolean().optional() }).strict().optional(),
  goal: z.object({ model: z.string(), prompt: z.string(), defaultModel: z.string().optional() }).superRefine(() => undefined),
  rules: z.array(z.string()).optional()
});
const config = {
  roots: [{ name: 'work', path: '/Users/someone/work' }],
  connectorSuffix: 'Mac',
  readOnly: false,
  tunnel: { kind: 'openai', tunnelId: 'tunnel_' + 'a'.repeat(32), binaryPath: '/opt/tunnel' },
  ui: { theme: 'dark', browserBridgePort: '9333', language: 'de', windowBounds: { x: 1 } },
  mcp: { instructions: 'Be brief.', persistentUrls: true },
  goal: { model: 'openai/gpt-5', prompt: 'Check the goal.', secretInternal: 'x' }
};
// Made up for this test; not real credentials.
const keys = { openaiApiKey: 'sk-test-' + 'k'.repeat(40), 'plugin:github:token': 'ghp_' + 'p'.repeat(36) };
const now = new Date('2026-10-23T08:00:00Z');

describe('what a settings backup carries', () => {
  it('picks exactly what the Settings form saves, nothing the config keeps besides', () => {
    expect(pickByShape(schema, config)).toEqual({
      connectorSuffix: 'Mac', readOnly: false, tunnel: { kind: 'openai', tunnelId: 'tunnel_' + 'a'.repeat(32) },
      ui: { theme: 'dark', browserBridgePort: '9333', language: 'de' }, mcp: { instructions: 'Be brief.', persistentUrls: true },
      goal: { model: 'openai/gpt-5', prompt: 'Check the goal.' }
    });
  });

  it('leaves out what belongs to this computer: folders, tunnel, connector name, bridge port, stable URLs', async () => {
    const backup = JSON.parse(await buildBackup({ settings: pickByShape(schema, config), appVersion: '2.1.46', now }));
    expect(backup).toMatchObject({ format: BACKUP_FORMAT, version: 1, appVersion: '2.1.46', exportedAt: '2026-10-23T08:00:00.000Z' });
    expect(backup.settings).toEqual({ readOnly: false, ui: { theme: 'dark', language: 'de' }, mcp: { instructions: 'Be brief.' },
      goal: { model: 'openai/gpt-5', prompt: 'Check the goal.' } });
    expect(backup.secrets).toBeUndefined();
    expect(JSON.stringify(backup)).not.toContain('/Users/someone');
  });

  it.each([
    ['openaiApiKey', true], ['openRouterApiKey', true], ['customProviderApiKey', true], ['plugin:github:token', true],
    // Phone notifications' access token (#1800): the topic travels in the settings, so its token must too.
    ['ntfyToken', true],
    ['bridgeToken', false], ['setup:profile-1', false], ['mcp:path:core', false]
  ])('exports the saved key %s: %s', (key, expected) => {
    expect(exportableSecret(key)).toBe(expected);
  });
});

describe('saved keys in a backup', () => {
  it('are sealed with the passphrase and open only with it', async () => {
    const text = await buildBackup({ settings: {}, appVersion: '2.1.46', now, secrets: { values: keys, passphrase: 'correct horse battery' } });
    for (const value of Object.values(keys)) expect(text).not.toContain(value);
    const parsed = readBackup(text);
    expect(parsed.secretCount).toBe(2);
    expect(await openSecrets(parsed.secrets!, 'correct horse battery')).toEqual(keys);
    await expect(openSecrets(parsed.secrets!, 'wrong horse battery')).rejects.toMatchObject({ code: 'wrong-passphrase' });
  });

  it('refuses a short passphrase, and a backup with no keys to seal carries no sealed part', async () => {
    await expect(buildBackup({ settings: {}, appVersion: '2.1.46', now, secrets: { values: keys, passphrase: 'short' } }))
      .rejects.toMatchObject({ code: 'passphrase-too-short' });
    const empty = readBackup(await buildBackup({ settings: {}, appVersion: '2.1.46', now, secrets: { values: {}, passphrase: 'correct horse battery' } }));
    expect(empty).toMatchObject({ secrets: null, secretCount: 0 });
  });

  it('notices a sealed part that was changed, and never yields a per-computer key', async () => {
    const text = await buildBackup({ settings: {}, appVersion: '2.1.46', now, secrets: { values: { ...keys, bridgeToken: 'local-only' }, passphrase: 'correct horse battery' } });
    const parsed = readBackup(text);
    expect(parsed.secretCount).toBe(2);
    const opened = await openSecrets(parsed.secrets!, 'correct horse battery');
    expect(opened).not.toHaveProperty('bridgeToken');
    const tampered = JSON.parse(text);
    const bytes = Buffer.from(tampered.secrets.data, 'base64'); bytes[0] = bytes[0]! ^ 1;
    tampered.secrets.data = bytes.toString('base64');
    await expect(openSecrets(readBackup(JSON.stringify(tampered)).secrets!, 'correct horse battery')).rejects.toMatchObject({ code: 'wrong-passphrase' });
  });
});

describe('reading a backup file', () => {
  it.each([
    ['not JSON', 'hello', 'not-a-backup'],
    ['another app\'s JSON', JSON.stringify({ name: 'package' }), 'not-a-backup'],
    ['a newer format', JSON.stringify({ format: BACKUP_FORMAT, version: 2, settings: {} }), 'newer-version'],
    ['settings that are not an object', JSON.stringify({ format: BACKUP_FORMAT, version: 1, settings: [] }), 'not-a-backup'],
    ['a damaged sealed part', JSON.stringify({ format: BACKUP_FORMAT, version: 1, settings: {}, secrets: { kdf: 'scrypt' } }), 'not-a-backup'],
    ['a file far too large', 'x'.repeat(2_000_001), 'too-large']
  ])('refuses %s', (_name, text, code) => {
    expect(() => readBackup(text)).toThrow(BackupError);
    try { readBackup(text); } catch (error) { expect((error as BackupError).code).toBe(code); }
  });

  it('drops the per-computer parts even when a hand-edited file carries them', () => {
    const parsed = readBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 1, appVersion: '9.9.9', exportedAt: 'x',
      settings: { tunnel: { tunnelId: 'tunnel_x' }, connectorSuffix: 'Other', ui: { theme: 'light', browserBridgePort: '1' }, mcp: { persistentUrls: true } } }));
    expect(parsed.settings).toEqual({ ui: { theme: 'light' }, mcp: {} });
  });
});

describe('applying a backup over the current settings', () => {
  const current = pickByShape(schema, config) as { ui: object; goal: object; tunnel: object } & Record<string, unknown>;
  it('takes every setting the backup has and keeps this computer\'s own', () => {
    const merged = overlaySettings(schema, current, { readOnly: true, ui: { theme: 'light' }, goal: { model: 'openai/gpt-6' } });
    expect(merged).toEqual({ ...current, readOnly: true, ui: { ...current.ui, theme: 'light' }, goal: { ...current.goal, model: 'openai/gpt-6' } });
    expect(merged.tunnel).toEqual(current.tunnel);
    expect(changedSettings(current, merged)).toEqual(['goal.model', 'readOnly', 'ui.theme']);
  });

  it('takes a setting that is unset here but set in the backup', () => {
    const merged = overlaySettings(schema, current, { goal: { defaultModel: 'gpt-6' } });
    expect(merged.goal).toEqual({ ...current.goal, defaultModel: 'gpt-6' });
    expect(changedSettings(current, merged)).toEqual(['goal.defaultModel']);
  });

  it('keeps today\'s value for anything an older backup does not know, and ignores what this version does not know', () => {
    const merged = overlaySettings(schema, current, { ui: { theme: 'dark', futureSwitch: true }, futureSection: { on: true } });
    expect(merged).toEqual(current);
    expect(changedSettings(current, merged)).toEqual([]);
  });

  // macOS live test 2026-10-25: Developer mode was never switched, so it was missing from the backup,
  // and importing that backup later left the switch on. An unset setting is written as null.
  it('writes a setting that was never changed as null, so importing the backup puts it back', () => {
    const exported = settingsForBackup(schema, { ...config, ui: { theme: 'dark' } });
    expect(exported.ui).toEqual({ theme: 'dark', browserBridgePort: null, language: null });
    expect(exported.rules).toBeNull();
    const changedSince = { ...current, ui: { ...current.ui, language: 'fr' }, rules: ['ls'] };
    const merged = overlaySettings(schema, changedSince, exported);
    expect((merged.ui as Record<string, unknown>).language).toBeUndefined();
    expect('language' in (merged.ui as object)).toBe(false);
    expect(merged.rules).toBeUndefined();
    expect(changedSettings(changedSince, merged)).toEqual(['rules', 'ui.language']);
  });

  it('ignores a null where a setting cannot be empty, as from a hand-edited file', () => {
    const merged = overlaySettings(schema, current, { readOnly: null, ui: { theme: null }, goal: null });
    expect(merged).toEqual(current);
  });

  it('keeps a whole section the other computer never set up, rather than wiping it here', () => {
    // `mcp` is an optional section: a backup from a computer without one has it as null.
    const withSection = { ...current, mcp: { instructions: 'Be brief.' } };
    const merged = overlaySettings(schema, withSection, { mcp: null });
    expect(merged.mcp).toEqual({ instructions: 'Be brief.' });
    expect(changedSettings(withSection, merged)).toEqual([]);
  });

  it('replaces a list as a whole rather than mixing two lists', () => {
    const withRules = { ...current, rules: ['git status', 'npm test'] };
    expect(overlaySettings(schema, withRules, { rules: ['ls'] }).rules).toEqual(['ls']);
    expect(changedSettings(withRules, overlaySettings(schema, withRules, { rules: ['ls'] }))).toEqual(['rules']);
  });
});

describe('what an import would open up', () => {
  const base = {
    capabilities: { read: true, edit: false, command: false, screen: false }, readOnly: true,
    commandAllowlist: { enabled: true, mode: 'allow', rules: ['npm test'] },
    controlApi: { enabled: false, allowActions: false }, multiAgent: { strictChatAllowlist: true, allowUnattributedCalls: false },
    ui: { secretsShield: true, theme: 'dark' }
  };
  const after = (patch: (copy: typeof base) => void) => { const copy = structuredClone(base); patch(copy); return copy; };

  it('names every change that gives ChatGPT more access, and nothing that only looks different', () => {
    expect(widerAccess(base, after(copy => { copy.ui.theme = 'light'; copy.capabilities.read = false; }))).toEqual([]);
    expect(widerAccess(base, after(copy => {
      copy.capabilities.edit = true; copy.capabilities.command = true; copy.readOnly = false;
      copy.commandAllowlist.rules = ['npm test', 'rm -rf build']; copy.controlApi.allowActions = true;
      copy.multiAgent.strictChatAllowlist = false; copy.multiAgent.allowUnattributedCalls = true; copy.ui.secretsShield = false;
    }))).toEqual(['capabilities.command', 'capabilities.edit', 'commandAllowlist', 'controlApi.allowActions',
      'multiAgent.allowUnattributedCalls', 'multiAgent.strictChatAllowlist', 'readOnly', 'ui.secretsShield']);
  });

  it('counts the command rules as wider when they are switched off, even with the same rules', () => {
    expect(widerAccess(base, after(copy => { copy.commandAllowlist.enabled = false; }))).toEqual(['commandAllowlist']);
  });

  it('treats a missing secrets shield as on, as the app does', () => {
    const { secretsShield: _, ...ui } = base.ui;
    expect(widerAccess(base, { ...base, ui })).toEqual([]);
    expect(widerAccess({ ...base, ui }, after(copy => { copy.ui.secretsShield = false; }))).toEqual(['ui.secretsShield']);
  });
});
