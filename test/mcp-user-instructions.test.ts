/**
 * The user's own standing instructions, appended to what each connector says about itself.
 *
 * Issue #85: there was no persistent way to add anything, so the only route was patching
 * `app.asar` — which an update overwrites. This is a settings field instead.
 *
 * Two properties are worth defending in tests rather than in review. It goes **last**, because
 * everything above it is what the app can actually promise about its own tools and a preference
 * must not quietly redefine one. And it is **attributed**, so the model can tell a standing
 * instruction from this user apart from the connector's description of itself — those carry
 * different authority, and running them together hides that.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

const { MAX_MCP_INSTRUCTIONS_CHARS, defaultConfig, getConfig, initConfigPath, saveConfig } = await import(
  '../src/main/config.js'
);
const { serverInstructions } = await import('../src/main/mcp/instructions.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');
const { CAPABILITIES } = await import('../src/shared/types.js');
type Capabilities = import('../src/shared/types.js').Capabilities;

let dir: string;

const allCapabilities = (): Capabilities =>
  Object.fromEntries(CAPABILITIES.map((name) => [name, true])) as Capabilities;

const ctx = {
  roots: [],
  caps: allCapabilities(),
  readOnly: false,
  sessionTools: false,
  agentTools: false
};

const HEADING = "The user's own standing instructions for this connector:";

async function withInstructions(instructions: string): Promise<void> {
  const config = getConfig();
  await saveConfig({ ...config, mcp: { ...config.mcp, instructions } });
}

beforeAll(async () => {
  dir = await makeTempDir('clf-mcp-instructions-');
  initConfigPath(dir);
  await saveConfig(defaultConfig());
});

afterAll(async () => {
  await removeTempDir(dir);
});

beforeEach(async () => {
  await withInstructions('');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the user’s own connector instructions', () => {
  it('adds nothing at all when empty, not even the heading', () => {
    expect(defaultConfig().mcp.instructions).toBe('');
    for (const surface of ['core', 'desktop'] as const) {
      const text = serverInstructions(ctx, surface, 'win32');
      expect(text, surface).not.toContain(HEADING);
    }
  });

  it.each(['core', 'desktop'] as const)('appends them last on the %s connector, attributed', async (surface) => {
    const mine = 'Always run the test suite before saying a change works.';
    await withInstructions(mine);

    const text = serverInstructions(ctx, surface, 'win32');
    expect(text).toContain(HEADING);
    expect(text).toContain(mine);
    // Last: nothing the app authored may follow, or a preference would be read as overriding
    // guidance that comes after it.
    expect(text.trimEnd().endsWith(mine)).toBe(true);
    // And the heading immediately precedes it, so the attribution cannot drift away.
    expect(text.indexOf(HEADING)).toBeLessThan(text.indexOf(mine));
  });

  it('leaves everything the app says about itself intact', async () => {
    const before = serverInstructions(ctx, 'core', 'win32');
    await withInstructions('Prefer pnpm.');
    const after = serverInstructions(ctx, 'core', 'win32');

    // Added to, never edited: the connector's own description is unchanged character for
    // character, and only the attributed block is new.
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toContain('Prefer pnpm.');
  });

  it('survives a reload, which is the whole point of it being a setting', async () => {
    await withInstructions('Never force-push.');
    initConfigPath(dir);
    expect(getConfig().mcp.instructions).toBe('Never force-push.');
    expect(serverInstructions(ctx, 'core', 'win32')).toContain('Never force-push.');
  });

  it('trims surrounding whitespace rather than emitting a blank block', async () => {
    await withInstructions('   \n  \t ');
    expect(getConfig().mcp.instructions).toBe('');
    expect(serverInstructions(ctx, 'core', 'win32')).not.toContain(HEADING);
  });

  it('caps an over-long value instead of rejecting the whole config', async () => {
    // Repaired, not rejected. This is free text a person typed, and one over-long field must
    // not send every root and every permission through conservative recovery.
    await withInstructions('x'.repeat(MAX_MCP_INSTRUCTIONS_CHARS + 500));
    const stored = getConfig().mcp.instructions;
    expect(stored.length).toBe(MAX_MCP_INSTRUCTIONS_CHARS);
    // And the rest of the config is still the real one, not the conservative fallback.
    expect(getConfig().readOnly).toBe(false);
    expect(serverInstructions(ctx, 'core', 'win32')).toContain(stored);
  });
});
