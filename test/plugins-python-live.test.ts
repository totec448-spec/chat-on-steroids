import { expect, it } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { installSource } from '../src/main/plugins/installer.js';
import { pluginCatalog } from '../src/main/plugins/catalog.js';
import { makeTempDir, removeTempDir } from './helpers.js';

/** Live regression: upstream Fetch's loose mcp>=1.1.3 otherwise resolves incompatible SDK v2. */
it.runIf(process.env.COS_PLUGIN_LIVE_TEST === '1')('installs the reviewed Python dependency pins and discovers the real Fetch server', async () => {
  const directory = await makeTempDir('cos-python-plugin-live-');
  const client = new Client({ name: 'CoS Python recipe acceptance', version: '1.0.0' });
  const page = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/plain');
    response.end(request.url === '/robots.txt' ? 'User-agent: *\nAllow: /\n' : 'CoS Python fetch fixture');
  });
  try {
    const source = pluginCatalog.find(recipe => recipe.id === 'fetch')!.source;
    expect(source.dependencies).toEqual([{ package: 'mcp', version: '1.30.0' }]);
    const launch = await installSource(source, directory);
    const data = path.join(directory, 'data');
    await fs.mkdir(data);
    await client.connect(new StdioClientTransport({ command: launch.command, args: launch.args, cwd: data, stderr: 'ignore' }), { timeout: 20000 });
    expect((await client.listTools({}, { timeout: 15000 })).tools.map(tool => tool.name)).toContain('fetch');
    await new Promise<void>(resolve => page.listen(0, '127.0.0.1', resolve));
    const address = page.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const result = await client.callTool({ name: 'fetch', arguments: { url: `http://127.0.0.1:${address.port}` } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(JSON.stringify(result)).toContain('CoS Python fetch fixture');
  } finally {
    await client.close();
    if (page.listening) await new Promise<void>((resolve, reject) => page.close(error => error ? reject(error) : resolve()));
    await removeTempDir(directory);
  }
}, 180000);
