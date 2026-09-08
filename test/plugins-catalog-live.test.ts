import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { installSource, runInstaller } from '../src/main/plugins/installer.js';
import path from 'node:path';
import { createServer } from 'node:http';
import { pluginCatalog } from '../src/main/plugins/catalog.js';
import { makeTempDir, removeTempDir } from './helpers.js';

// Opt-in: actual pinned packages on each CI OS; editor discovery needs no user project.
// Playwright executes against an ephemeral loopback page, never the user's browser/profile.
for (const id of ['blender', 'unity', 'playwright']) {
  it.runIf(process.env.COS_PLUGIN_LIVE_TEST === '1')(`installs ${id} and verifies its advertised tool preview over stdio`, async () => {
    const directory = await makeTempDir(`cos-catalog-${id}-`);
    const client = new Client({ name: 'CoS catalog discovery acceptance', version: '1.0.0' });
    const page = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<h1>CoS plugin browser fixture</h1>'); });
    try {
      const recipe = pluginCatalog.find(entry => entry.id === id)!;
      const launch = await installSource(recipe.source, directory);
      if (id === 'playwright') {
        await runInstaller(launch.command, [path.join(directory, 'node_modules/playwright/cli.js'), 'install', 'chromium'], directory);
        launch.args.push('--headless', '--browser', 'chromium', '--isolated');
      }
      await client.connect(new StdioClientTransport({ command: launch.command, args: launch.args, cwd: directory, stderr: 'ignore' }), { timeout: 20000 });
      const names = (await client.listTools({}, { timeout: 15000 })).tools.map(tool => tool.name);
      expect(names.length).toBeGreaterThan(0);
      expect(names).toEqual(expect.arrayContaining(recipe.tools!));
      if (id === 'playwright') {
        await new Promise<void>(resolve => page.listen(0, '127.0.0.1', resolve));
        const address = page.address();
        if (!address || typeof address === 'string') throw new Error('Missing fixture address');
        const result = await client.callTool({ name: 'browser_navigate', arguments: { url: `http://127.0.0.1:${address.port}` } }, { timeout: 30000 });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        // Snapshot delivery can be inline or a generated file. Read the actual page via
        // the browser tool instead of assuming one upstream presentation format.
        const content = await client.callTool({ name: 'browser_evaluate', arguments: { function: "() => document.querySelector('h1')?.textContent" } });
        expect(content.isError, JSON.stringify(content)).not.toBe(true);
        expect(JSON.stringify(content)).toContain('CoS plugin browser fixture');
      }
    } finally {
      await client.close();
      if (page.listening) await new Promise<void>((resolve, reject) => page.close(error => error ? reject(error) : resolve()));
      await removeTempDir(directory);
    }
  }, 180000);
}
