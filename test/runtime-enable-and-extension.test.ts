import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = process.cwd();

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
  it('keeps standalone recovery visible without pointing an installed app at releases/latest', async () => {
    const [html, renderer, preload, ipc] = await Promise.all([
      readFile(path.join(repo, 'src/renderer/index.html'), 'utf8'),
      readFile(path.join(repo, 'src/renderer/main.ts'), 'utf8'),
      readFile(path.join(repo, 'src/preload/index.ts'), 'utf8'),
      readFile(path.join(repo, 'src/main/ipc.ts'), 'utf8')
    ]);

    expect(html).toMatch(/id="bridgeDownload"[\s\S]*?Download extension ZIP/i);
    expect(html).toMatch(/Required for sub-agents/i);
    expect(html).toMatch(/Requires the Chrome extension to be loaded and connected/i);
    expect(html).not.toContain('/releases/latest/');
    expect(ipc).not.toContain('/releases/latest/');
    expect(renderer).toContain('api.downloadExtension()');
    expect(preload).toContain("call<boolean>('bridge:downloadExtension')");
    expect(ipc).toContain("handle('bridge:downloadExtension'");
  });
});
