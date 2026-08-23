import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = process.cwd();
const extensionDownload =
  'https://github.com/totec448-spec/chat-on-steroids/releases/latest/download/Chat-On-Steroids-Extension.zip';

describe('runtime multi-agent enable regression', () => {
  it('wires the immediate swarm persistence sink before the multi-agent restore gate', async () => {
    const source = await readFile(path.join(repo, 'src/main/index.ts'), 'utf8');
    const persistSink = source.indexOf('onSwarmPersistNow((snapshot) => writeDurableNow(SWARM_STATE, snapshot))');
    const restoreGate = source.indexOf('if (getConfig().multiAgent.enabled) {');

    expect(persistSink).toBeGreaterThanOrEqual(0);
    expect(restoreGate).toBeGreaterThanOrEqual(0);
    expect(persistSink).toBeLessThan(restoreGate);
  });
});

describe('companion extension setup contract', () => {
  it('keeps the standalone extension link both visible and allowed by main-process IPC', async () => {
    const [html, ipc] = await Promise.all([
      readFile(path.join(repo, 'src/renderer/index.html'), 'utf8'),
      readFile(path.join(repo, 'src/main/ipc.ts'), 'utf8')
    ]);

    expect(html).toContain(extensionDownload);
    expect(html).toMatch(/Required for sub-agents/i);
    expect(html).toMatch(/Requires the Chrome extension to be loaded and connected/i);
    expect(ipc).toContain(extensionDownload);
  });
});
