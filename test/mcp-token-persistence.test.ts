import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  }
}));

const { defaultConfig, initConfigPath, loadConfig, updateConfig } = await import('../src/main/config.js');
const { initSecretsPath, resetSecretsCacheForTests } = await import('../src/main/secrets.js');
const { startMcpServer } = await import('../src/main/mcp/server.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;

function tokenOf(url: string): string {
  return new URL(url).pathname.split('/').at(-1) ?? '';
}

async function start() {
  const cfg = defaultConfig();
  return startMcpServer(() => ({
    roots: [],
    caps: cfg.capabilities,
    readOnly: true,
    sessionTools: false,
    agentTools: false
  }));
}

beforeEach(async () => {
  dir = await makeTempDir('clf-mcp-token-');
  initConfigPath(dir);
  initSecretsPath(dir);
  resetSecretsCacheForTests();
  await loadConfig();
});

afterEach(async () => {
  await removeTempDir(dir);
});

describe('MCP token persistence', () => {
  it('rotates tokens between server starts by default', async () => {
    const first = await start();
    const firstToken = tokenOf(first.urls.core);
    await first.stop();

    const second = await start();
    const secondToken = tokenOf(second.urls.core);
    await second.stop();

    expect(secondToken).not.toBe(firstToken);
  });

  it('reuses per-surface tokens when the advanced option is enabled', async () => {
    await updateConfig(config => ({
      ...config,
      ui: { ...config.ui, persistMcpTokens: true }
    }));

    const first = await start();
    const firstTokens = Object.fromEntries(
      Object.entries(first.urls).map(([surface, url]) => [surface, tokenOf(url)])
    );
    await first.stop();

    resetSecretsCacheForTests();

    const second = await start();
    const secondTokens = Object.fromEntries(
      Object.entries(second.urls).map(([surface, url]) => [surface, tokenOf(url)])
    );
    await second.stop();

    expect(secondTokens).toEqual(firstTokens);
    expect(new Set(Object.values(secondTokens)).size).toBe(Object.keys(secondTokens).length);
  });
});
