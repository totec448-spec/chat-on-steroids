import { expect, it } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { PluginManager } from '../src/main/plugins/manager.js';
import { initDurableStore, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import { pluginCatalog } from '../src/main/plugins/catalog.js';
import { makeTempDir, removeTempDir } from './helpers.js';

/** Live regression: reviewed Fetch release and bounded Windows installation paths. */
it.runIf(process.env.COS_PLUGIN_LIVE_TEST === '1')('installs the reviewed Fetch release and discovers its real server', async () => {
  const temporary = await makeTempDir('cos-python-plugin-live-');
  const packageData = 'venv/Lib/site-packages/jsonschema_specifications/schemas/draft201909/metaschema.json';
  const legacySuffix = path.win32.join('plugins', '0'.repeat(36), '0'.repeat(36), packageData);
  const windowsRootLength = 267 - legacySuffix.length - 1;
  const directory = process.platform === 'win32'
    ? path.join(temporary, 'r'.repeat(Math.max(1, windowsRootLength - temporary.length - 1))) : temporary;
  const manager = new PluginManager();
  const page = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/plain');
    response.end(request.url === '/robots.txt' ? 'User-agent: *\nAllow: /\n' : 'CoS Python fetch fixture');
  });
  try {
    const source = pluginCatalog.find(recipe => recipe.id === 'fetch')!.source;
    expect(source.dependencies).toBeUndefined();
    initDurableStore(directory);
    await manager.initialize(directory);
    const installed = (await manager.install({ catalogId: 'fetch' })).plugins[0]!;
    expect(installed.status, installed.error).toBe('ready');
    expect(manager.tools().map(tool => tool.name)).toContain('fetch');
    if (process.platform === 'win32') {
      const [record] = JSON.parse(await fs.readFile(path.join(directory, 'state/plugins.json'), 'utf8'));
      await expect(fs.stat(path.join(record.directory, packageData))).resolves.toBeDefined();
      expect(path.join(directory, legacySuffix).length).toBeGreaterThanOrEqual(267);
      expect(path.join(record.directory, packageData).length).toBeLessThan(260);
    }
    await new Promise<void>(resolve => page.listen(0, '127.0.0.1', resolve));
    const address = page.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const result = await manager.call('fetch', { url: `http://127.0.0.1:${address.port}` });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(JSON.stringify(result)).toContain('CoS Python fetch fixture');
  } finally {
    await manager.close();
    await flushDurable(); resetDurableForTests();
    if (page.listening) await new Promise<void>((resolve, reject) => page.close(error => error ? reject(error) : resolve()));
    await removeTempDir(temporary);
  }
}, 180000);
