import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { zipSync, strToU8 } from 'fflate';
import sharp from 'sharp';
import { makeTempDir, removeTempDir } from './helpers.js';
const secrets = vi.hoisted(() => new Map<string, string>());
vi.mock('../src/main/secrets.js', () => ({
  getSecret: vi.fn(async (k: string) => secrets.get(k) ?? null),
  setSecret: vi.fn(async (k: string, v: string) => {
    secrets.set(k, v);
  }),
  clearSecret: vi.fn(async (k: string) => {
    secrets.delete(k);
  }),
}));
import { initDurableStore } from '../src/main/durable.js';
import { getSecret } from '../src/main/secrets.js';
import { PluginManager } from '../src/main/plugins/manager.js';
import { PluginOAuth, PluginNeedsAuth } from '../src/main/plugins/oauth.js';
import * as pluginInstaller from '../src/main/plugins/installer.js';

const fixture = `const readline=require('node:readline');
const tools=[{name:'Echo.Mixed',description:'Echo fixture',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},outputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}}];
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result;if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'CoS test fixture',version:'1'}};else if(m.method==='tools/list')result={tools};else if(m.method==='tools/call')result={content:[{type:'text',text:process.env.TEST_SECRET||m.params.arguments.value}],structuredContent:{value:m.params.arguments.value},isError:m.params.arguments.value==='error'};else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`;
let dir: string, manager: PluginManager, entry: string;
beforeEach(async () => {
  dir = await makeTempDir('plugins-test-');
  initDurableStore(dir);
  manager = new PluginManager();
  await manager.initialize(dir);
  entry = path.join(dir, 'server.cjs');
  await fs.writeFile(entry, fixture);
  secrets.clear();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await manager.close();
  await removeTempDir(dir);
});
describe('external plugin authority', () => {
  it('finds standard desktop-installed runtimes without replacing inherited PATH precedence', () => {
    const inherited = { PATH: '/custom/bin:/usr/bin:/bin', HOME: '/Users/example' };
    expect(pluginInstaller.pluginEnvironment(inherited, 'darwin').PATH).toBe('/custom/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/Users/example/.local/bin');
    const linux = pluginInstaller.pluginEnvironment({ PATH: '/usr/local/bin:/usr/bin', HOME: '/home/example' }, 'linux');
    expect(linux.PATH).toBe('/usr/local/bin:/usr/bin:/home/example/.local/bin');
    expect(pluginInstaller.pluginEnvironment(linux, 'linux')).toEqual(linux);
    expect(pluginInstaller.pluginEnvironment({ Path: 'C:\\tools;C:\\Windows' }, 'win32')).toEqual({ Path: 'C:\\tools;C:\\Windows' });
    expect(inherited.PATH).toBe('/custom/bin:/usr/bin:/bin');
  });

  it('projects reviewed license terms for existing installations without reinstalling them', async () => {
    vi.spyOn(pluginInstaller, 'installSource').mockResolvedValueOnce({
      command: process.execPath, args: [entry], version: '2026.8.31', license: 'MIT',
    });
    await manager.install({ catalogId: 'memory' });
    expect(manager.snapshot().plugins[0]!.license).toContain('Apache-2.0');
    await manager.close();
    manager = new PluginManager();
    await manager.initialize(dir);
    expect(manager.snapshot().plugins[0]!.license).toContain('Apache-2.0');
  });
  it('restores OAuth as needs-auth without a request or browser opening and never publishes its cached catalog', async () => {
    const row = (await manager.install({ source: { kind: 'command', command: process.execPath, args: [entry] } })).plugins[0]!;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    await manager.configure(row.id, { source: { kind: 'remote', url: 'https://oauth.example/mcp', auth: 'oauth' } });
    expect(manager.snapshot().plugins[0]!).toMatchObject({ status: 'needs-auth', tools: [expect.objectContaining({ published: false })] });
    expect(manager.tools()).toEqual([]);
    await manager.restart(row.id); await manager.close();
    const open = vi.fn(); manager = new PluginManager(open);
    await manager.initialize(dir);
    expect(manager.tools()).toEqual([]);
    await vi.waitFor(() => expect(manager.snapshot().plugins[0]!.status).toBe('needs-auth'));
    expect(fetcher).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });
  it('keeps needs-auth and unpublishes cached tools after an authenticated call retires its expired connection', async () => {
    const endpoint = 'https://oauth.example/mcp';
    const row = (await manager.install({ source: { kind: 'remote', url: endpoint, auth: 'oauth' } })).plugins[0]!;
    secrets.set(`plugin:${row.id}:oauth:state`, JSON.stringify({ endpoint, tokens: { access_token: 'oauth-access-token', token_type: 'Bearer', issuer: 'https://oauth.example' } }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method !== 'POST') return new Response(null, { status: 405 });
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer oauth-access-token');
      const message = JSON.parse(String(init.body));
      if (message.id === undefined) return new Response(null, { status: 202 });
      const result = message.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'OAuth fixture', version: '1' } } : { tools: [{ name: 'oauth_action', inputSchema: { type: 'object' } }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), { headers: { 'Content-Type': 'application/json' } });
    });
    await manager.restart(row.id); expect(manager.snapshot().plugins[0]!.status).toBe('ready');
    const close = vi.spyOn(Client.prototype, 'close');
    vi.spyOn(Client.prototype, 'callTool').mockRejectedValueOnce(new PluginNeedsAuth());
    expect((await manager.call('oauth_action', {})).isError).toBe(true);
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    expect(manager.snapshot().plugins[0]!.status).toBe('needs-auth');
    expect(manager.snapshot().plugins[0]!.tools[0]!.published).toBe(false);
    expect(manager.tools()).toEqual([]);
  });
  it.each(['cancel', 'disable', 'uninstall', 'update', 'endpoint', 'shutdown'] as const)('returns immediately from Sign in and revokes late token writes on %s', async action => {
    let begin!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(PluginOAuth.prototype, 'signIn').mockImplementation(async function (this: PluginOAuth) {
      begin(); await pending;
      await this.saveTokens({ access_token: 'late-private-token', token_type: 'Bearer', issuer: 'https://oauth.example' });
    });
    const row = (await manager.install({ source: { kind: 'remote', url: 'https://oauth.example/mcp', auth: 'oauth' } })).plugins[0]!;
    expect((await manager.authenticate(row.id)).plugins[0]!.status).toBe('authenticating');
    await started;
    const retire = action === 'cancel' ? manager.cancelAuthentication(row.id) : action === 'disable' ? manager.setEnabled(row.id, false) : action === 'uninstall' ? manager.uninstall(row.id) : action === 'update' ? manager.update(row.id) : action === 'endpoint' ? manager.configure(row.id, { source: { kind: 'remote', url: 'https://oauth.example/other', auth: 'oauth' } }) : manager.close();
    release(); await retire;
    await vi.waitFor(() => expect(manager.snapshot().plugins.some(plugin => plugin.status === 'authenticating')).toBe(false));
    expect([...secrets.values()].some(value => value.includes('late-private-token'))).toBe(false);
    expect(JSON.stringify(manager.snapshot())).not.toContain('late-private-token');
    expect(manager.tools()).toEqual([]);
  });
  it('retains an installed and enabled server immediately after discovery', async () => {
    const h = await trackedFixture();
    expect(alive((await h.pids())[0]!.pid)).toBe(true);
    expect(h.row.status).toBe('ready');
  });
  it('satisfies the pinned Blender scene-probe schema and accepts an object name containing Error', async () => {
    // Pinned blender-mcp 1.9.1 requires user_prompt. The fixture enforces it instead
    // of silently accepting the old {} probe that falsely reported a disconnected addon.
    await fs.writeFile(entry, `const readline=require('node:readline');
const tools=[{name:'get_scene_info',inputSchema:{type:'object',properties:{user_prompt:{title:'User Prompt',type:'string'}},required:['user_prompt'],title:'get_scene_infoArguments'},outputSchema:{type:'object',properties:{result:{title:'Result',type:'string'}},required:['result'],title:'get_scene_infoOutput'}}];
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);if(m.id===undefined)return;let result;
  if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'Pinned Blender schema fixture',version:'1.9.1'}};
  else if(m.method==='tools/list')result={tools};
  else if(m.method==='tools/call'){
    const args=m.params.arguments||{};
    if(typeof args.user_prompt!=='string'||!args.user_prompt.startsWith('Read-only connection check:')||args.user_prompt.length>150||Object.keys(args).length!==1)
      result={isError:true,content:[{type:'text',text:'Error: required bounded diagnostic user_prompt is missing or invalid'}]};
    else {const text=JSON.stringify({name:'Error Cube'});result={content:[{type:'text',text}],structuredContent:{result:text}};}
  }else result={};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`);
    const row = (await manager.install({ catalogId: 'blender', source: { kind: 'command', command: process.execPath, args: [entry] } })).plugins[0]!;
    expect(row.status, row.error).toBe('ready');
  });
  it('redacts text secrets without corrupting image bytes, MIME types or protocol tags', async () => {
    const data = (await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ffffff' } }).png().toBuffer()).toString('base64');
    await fs.writeFile(entry, fixture.replace("content:[{type:'text',text:process.env.TEST_SECRET||m.params.arguments.value}]", `content:[{type:'text',text:process.env.TEST_SECRET},{type:'image',mimeType:'image/png',data:'${data}',_meta:{echo:'i'}}]`));
    await manager.install({ source: { kind: 'command', command: process.execPath, args: [entry] }, credentials: { TEST_SECRET: 'i' } });
    const result = await manager.call(manager.tools()[0]!.name, { value: 'safe' });
    expect(result.content[0]).toEqual({ type: 'text', text: '[redacted]' });
    expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png', data });
    expect(JSON.stringify(result.content[1])).not.toContain('"echo":"i"');
    expect(manager.redactResult(result).content[1]).toMatchObject({ type: 'image', mimeType: 'image/png', data });
  });
  it('rejects plaintext configuration declared sensitive by a replacement bundle', async () => {
    const row = (await manager.install({ source: { kind: 'command', command: process.execPath, args: [entry] } })).plugins[0]!;
    const bundle = path.join(dir, 'sensitive.mcpb');
    const manifest = {
      manifest_version: '0.3', name: 'sensitive-fixture', version: '1.0.0', description: 'Test', author: { name: 'CoS' },
      user_config: { credential: { type: 'string', title: 'Credential', description: 'Server credential', sensitive: true } },
      server: { type: 'node', entry_point: 'server.cjs', mcp_config: { command: process.execPath, args: ['server.cjs'] } },
    };
    await fs.writeFile(bundle, zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'server.cjs': strToU8(fixture) }));
    await expect(manager.configure(row.id, { source: { kind: 'mcpb', path: bundle }, config: { credential: 'must-stay-private' } })).rejects.toThrow('sensitive bundle fields');
    expect(manager.snapshot().plugins[0]!.source.kind).toBe('command');
    expect(JSON.stringify(manager.snapshot())).not.toContain('must-stay-private');
    expect(await fs.readFile(path.join(dir, 'state', 'plugins.json'), 'utf8')).not.toContain('must-stay-private');
    await manager.configure(row.id, { source: { kind: 'mcpb', path: bundle }, credentials: { credential: 'private-value' } });
    expect(manager.snapshot().plugins[0]!.fields).toEqual([expect.objectContaining({ key: 'credential', secret: true })]);
    await manager.configure(row.id, { source: { kind: 'command', command: process.execPath, args: [entry] } });
    expect(manager.snapshot().plugins[0]!.fields).toBeUndefined();
  });
  it('bounds endless empty discovery pages and releases lifecycle work', async () => {
    await fs.writeFile(entry, fixture.replace('result={tools}', 'result={tools:[],nextCursor:String(m.id)}'));
    const row = (await manager.install({ source: { kind: 'command', command: process.execPath, args: [entry] } })).plugins[0]!;
    expect(row.status).toBe('error');
    expect(row.error).toContain('page/time limit');
    await manager.uninstall(row.id);
    expect(manager.snapshot().plugins).toEqual([]);
  });
  it('refuses queued replacement work once shutdown begins', async () => {
    const row = (await manager.install({ source: { kind: 'command', command: process.execPath, args: [entry] } })).plugins[0]!;
    const update = manager.update(row.id);
    const rejected = expect(update).rejects.toThrow('shutting down');
    await manager.close();
    await rejected;
  });
  it('launches an imported MCPB relative Node entry point with stable data cwd', async () => {
    const bundle = path.join(dir, 'working.mcpb');
    const manifest = {
      manifest_version: '0.3',
      name: 'fixture-bundle',
      version: '1.0.0',
      description: 'Test bundle',
      author: { name: 'CoS' },
      server: {
        type: 'node',
        entry_point: 'server/entry.cjs',
        mcp_config: { command: process.execPath, args: ['server/entry.cjs'] },
      },
    };
    await fs.writeFile(
      bundle,
      zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'server/entry.cjs': strToU8(fixture) }),
    );
    const row = (await manager.install({ source: { kind: 'mcpb', path: bundle } })).plugins[0]!;
    expect(row.status, row.error).toBe('ready');
    expect((await manager.call(manager.tools()[0]!.name, { value: 'bundle works' })).structuredContent).toEqual({
      value: 'bundle works',
    });
  });
  it('routes Streamable HTTP with encrypted bearer configuration and never retries a failed mutation', async () => {
    let calls = 0,
      authorization = '';
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const msg = JSON.parse(body);
      authorization = req.headers.authorization ?? '';
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (msg.method === 'initialize')
        result = {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'HTTP fixture', version: '1' },
        };
      else if (msg.method === 'tools/list') result = { tools: [{ name: 'mutation', inputSchema: { type: 'object' } }] };
      else {
        calls++;
        res.writeHead(500).end('Ambiguous server failure');
        return;
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      const row = (
        await manager.install({
          source: { kind: 'remote', url: `http://127.0.0.1:${address.port}/mcp` },
          credentials: { token: 'http-test-secret' },
        })
      ).plugins[0]!;
      expect(row.status, row.error).toBe('ready');
      expect(authorization).toBe('Bearer http-test-secret');
      expect((await manager.call(manager.tools()[0]!.name, {})).isError).toBe(true);
      expect(calls).toBe(1);
      await manager.uninstall(row.id);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it.runIf(process.env.COS_PLUGIN_LIVE_TEST === '1')(
    'live pinned Memory npm server: install, discover, create/read and update without data loss',
    async () => {
      const row = (await manager.install({ catalogId: 'memory' })).plugins[0]!;
      expect(row.status, row.error).toBe('ready');
      const create = row.tools.find((t) => t.name === 'create_entities')!;
      const read = row.tools.find((t) => t.name === 'read_graph')!;
      expect(create).toBeDefined();
      const written = await manager.call(create.exposedName, {
        entities: [
          { name: 'CoS plugin validation fixture', entityType: 'test', observations: ['End-to-end plugin routing'] },
        ],
      });
      expect(written.isError).not.toBe(true);
      expect(JSON.stringify(await manager.call(read.exposedName, {}))).toContain('CoS plugin validation fixture');
      await manager.update(row.id);
      expect(manager.snapshot().plugins[0]!.status).toBe('ready');
      expect(JSON.stringify(await manager.call(read.exposedName, {}))).toContain('CoS plugin validation fixture');
      await manager.uninstall(row.id);
    },
    180000,
  );
  it('discovers a real stdio subprocess, preserves schemas/results, rejects stale disabled calls', async () => {
    const snapshot = await manager.install({
      name: 'Fixture',
      source: { kind: 'command', command: process.execPath, args: [entry] },
    });
    const row = snapshot.plugins[0]!;
    expect(row.status).toBe('ready');
    expect(row.tools[0]!.published).toBe(true);
    const tool = manager.tools()[0]!;
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.inputSchema.required).toEqual(['value']);
    expect(tool.outputSchema).toBeDefined();
    expect(tool.name).toBe('Echo.Mixed');
    expect((await manager.call(tool.name, { value: 'hello' })).structuredContent).toEqual({ value: 'hello' });
    const upstreamOutcome = vi.fn();
    expect((await manager.call(tool.name, { value: 'error' }, upstreamOutcome)).isError).toBe(true);
    expect(upstreamOutcome).toHaveBeenCalledExactlyOnceWith('tool_execution_error');
    await manager.setToolEnabled(row.id, 'Echo.Mixed', false);
    expect(manager.tools()).toEqual([]);
    expect((await manager.call(tool.name, { value: 'blocked' })).isError).toBe(true);
    await manager.setToolEnabled(row.id, 'Echo.Mixed', true);
    await manager.setEnabled(row.id, false);
    expect(manager.tools()).toEqual([]);
    const blockedOutcome = vi.fn();
    expect((await manager.call(tool.name, {}, blockedOutcome)).isError).toBe(true);
    expect(blockedOutcome).toHaveBeenCalledExactlyOnceWith('tool_rejected');
  });
  it('seals credentials separately and redacts echoed credentials and recordable values', async () => {
    const result = await manager.install({
      source: { kind: 'command', command: process.execPath, args: [entry] },
      credentials: { TEST_SECRET: 'secret-fixture-value' },
    });
    const row = result.plugins[0]!;
    expect(row.credentialKeys).toEqual(['TEST_SECRET']);
    expect(JSON.stringify(result)).not.toContain('secret-fixture-value');
    expect(await fs.readFile(path.join(dir, 'state', 'plugins.json'), 'utf8')).not.toContain('secret-fixture-value');
    expect((await manager.call(manager.tools()[0]!.name, { value: 'safe' })).content).toEqual([
      { type: 'text', text: '[redacted]' },
    ]);
    expect(manager.redact({ nested: ['secret-fixture-value'] })).toEqual({ nested: ['[redacted]'] });
    await manager.uninstall(row.id);
    expect(secrets.size).toBe(0);
    expect(manager.tools()).toEqual([]);
  });
  it('rolls back an invalid replacement and retains the previously working server', async () => {
    const row = (await manager.install({ source: { kind: 'command', command: process.execPath, args: [entry] } }))
      .plugins[0]!;
    const name = manager.tools()[0]!.name;
    await expect(
      manager.configure(row.id, { source: { kind: 'command', command: 'cos-nonexistent-runtime' } }),
    ).rejects.toThrow('rolled back');
    expect(manager.snapshot().plugins[0]!.status).toBe('ready');
    expect(manager.tools()[0]!.name).toBe(name);
    expect((await manager.call(name, { value: 'still works' })).structuredContent).toEqual({ value: 'still works' });
    const persisted = JSON.parse(await fs.readFile(path.join(dir, 'state', 'plugins.json'), 'utf8'));
    expect(persisted[0].source.command).toBe(process.execPath);
  });
  it('restores encrypted credentials when replacement fails', async () => {
    const row = (
      await manager.install({
        source: { kind: 'command', command: process.execPath, args: [entry] },
        credentials: { TEST_SECRET: 'previous-secret' },
      })
    ).plugins[0]!;
    await expect(
      manager.configure(row.id, {
        source: { kind: 'command', command: 'cos-nonexistent-runtime' },
        credentials: { TEST_SECRET: 'replacement-secret', ADDED_SECRET: 'new-secret' },
      }),
    ).rejects.toThrow('rolled back');
    expect(secrets.get(`plugin:${row.id}:TEST_SECRET`)).toBe('previous-secret');
    expect(secrets.get(`plugin:${row.id}:ADDED_SECRET`)).toBe('');
    expect(manager.snapshot().plugins[0]!.credentialKeys).toEqual(['TEST_SECRET']);
  });
  it('revokes queued disable synchronously before another queued operation finishes', async () => {
    const row = (await manager.install({ source: { kind: 'command', command: process.execPath, args: [entry] } }))
      .plugins[0]!;
    const tool = manager.tools()[0]!.name;
    const pendingRestart = manager.restart(row.id);
    const disable = manager.setEnabled(row.id, false);
    expect((await manager.call(tool, { value: 'must not reach server' })).isError).toBe(true);
    await pendingRestart;
    await disable;
    expect(manager.tools()).toEqual([]);
  });
  it('ignores malformed persistent records without crashing startup', async () => {
    await manager.close();
    await fs.mkdir(path.join(dir, 'state'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'state', 'plugins.json'),
      JSON.stringify([
        { id: 'bad', directory: null },
        null,
        {
          id: '11111111-1111-1111-1111-111111111111',
          source: { kind: 'command' },
          launch: { command: 'node', args: [] },
          directory: 42,
        },
      ]),
    );
    manager = new PluginManager();
    await expect(manager.initialize(dir)).resolves.toBeUndefined();
    expect(manager.snapshot().plugins).toEqual([]);
  });
  it('keeps the latest Off authoritative through queued Off-On-Off changes', async () => {
    const row = (await manager.install({ source: { kind: 'command', command: process.execPath, args: [entry] } })).plugins[0]!;
    const first = manager.setEnabled(row.id, false);
    const middle = manager.setEnabled(row.id, true);
    const last = manager.setEnabled(row.id, false);
    let republished = false;
    const unsubscribe = manager.onChanged(() => { if (manager.tools().length) republished = true; });
    await Promise.all([first, middle, last]);
    unsubscribe();
    expect(republished).toBe(false);
    expect(manager.snapshot().plugins[0]!.enabled).toBe(false);
  });
  it('keeps tool Off authoritative through queued changes and persists that final policy', async () => {
    const row = (await manager.install({ source: { kind: 'command', command: process.execPath, args: [entry] } })).plugins[0]!;
    const first = manager.setToolEnabled(row.id, 'Echo.Mixed', false);
    const middle = manager.setToolEnabled(row.id, 'Echo.Mixed', true);
    const last = manager.setToolEnabled(row.id, 'Echo.Mixed', false);
    let republished = false;
    const unsubscribe = manager.onChanged(() => { if (manager.tools().length) republished = true; });
    await Promise.all([first, middle, last]);
    unsubscribe();
    expect(republished).toBe(false);
    await manager.restart(row.id);
    expect(manager.tools()).toEqual([]);
    expect(manager.snapshot().plugins[0]!.tools[0]!.enabled).toBe(false);
  });
  it('rejects credential-bearing URLs before persistence and secrets in plain configuration', async () => {
    await expect(
      manager.install({ source: { kind: 'remote', url: 'https://example.com/mcp?token=hidden' } }),
    ).rejects.toThrow('without URL credentials');
    await expect(
      manager.install({ source: { kind: 'command', command: process.execPath }, config: { API_KEY: 'hidden' } }),
    ).rejects.toThrow('secure credential fields');
    expect(manager.snapshot().plugins).toEqual([]);
  });
  it('keeps IDs stable across restart and disabled state durable', async () => {
    const row = (await manager.install({ source: { kind: 'command', command: process.execPath, args: [entry] } }))
      .plugins[0]!;
    await manager.setEnabled(row.id, false);
    await manager.close();
    manager = new PluginManager();
    await manager.initialize(dir);
    expect(manager.snapshot().plugins[0]!.id).toBe(row.id);
    expect(manager.snapshot().plugins[0]!.status).toBe('disabled');
    expect(manager.tools()).toEqual([]);
  });
  it('retains exact upstream names while restoring enabled servers in the background', async () => {
    const row = (await manager.install({ source: { kind: 'command', command: process.execPath, args: [entry] } })).plugins[0]!;
    await manager.close();
    manager = new PluginManager();
    await manager.initialize(dir);
    await vi.waitFor(() => expect(manager.snapshot().plugins[0]!.status).toBe('ready'));
    expect(manager.snapshot().plugins[0]!.tools[0]!.exposedName).toBe('Echo.Mixed');
    expect(manager.tools()[0]!.name).toBe('Echo.Mixed');
    expect(manager.snapshot().plugins[0]!.id).toBe(row.id);
  });
});


const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function trackedFixture(withChild = false) {
  const pidLog = path.join(dir, 'owned-pids.jsonl');
  const releaseFile = path.join(dir, 'release-call');
  const prefix = `const fs=require('node:fs');
const child=${withChild ? `require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true})` : 'null'};
fs.appendFileSync(process.env.PID_LOG,JSON.stringify({pid:process.pid,child:child?.pid})+'\\n');
`;
  const delayed = fixture.replace("process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');", `
const send=()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
if(m.method==='tools/call'&&m.params.arguments.value==='hold'){
  const timer=setInterval(()=>{if(fs.existsSync(process.env.RELEASE_FILE)){clearInterval(timer);send();}},10);
}else send();`);
  await fs.writeFile(entry, prefix + delayed);
  const row = (await manager.install({ source: { kind: 'command', command: process.execPath, args: [entry] }, config: { PID_LOG: pidLog, RELEASE_FILE: releaseFile } })).plugins[0]!;
  const pids = async () => (await fs.readFile(pidLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { pid: number; child?: number });
  return { row, pids, releaseFile };
}

describe('enabled plugin process ownership', () => {
  it.each(['disable', 'uninstall'] as const)('%s retires its live process while a replacement download is pending', async action => {
    const h = await trackedFixture();
    const active = (await h.pids())[0]!;
    const original = pluginInstaller.installSource;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const installing = vi.spyOn(pluginInstaller, 'installSource').mockImplementationOnce(async (...args) => {
      await gate; return original(...args);
    });
    const replacing = manager.update(h.row.id);
    await vi.waitFor(() => expect(installing).toHaveBeenCalledTimes(1));
    const revoke = action === 'disable' ? manager.setEnabled(h.row.id, false) : manager.uninstall(h.row.id);
    try { await vi.waitFor(() => expect(alive(active.pid)).toBe(false), { timeout: 1000 }); }
    finally { release(); await replacing; await revoke; }
    expect(await h.pids()).toHaveLength(1);
    expect(manager.tools()).toEqual([]);
  });
  it.each(['disable', 'uninstall'] as const)('%s cancels its own pending restart before credentials resolve', async action => {
    const h = await trackedFixture();
    await manager.configure(h.row.id, { credentials: { TEST_SECRET: 'slow' } });
    let release!: (value: string) => void;
    vi.mocked(getSecret).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const restarting = manager.restart(h.row.id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const before = await h.pids();
    try {
      const revoke = action === 'disable' ? manager.setEnabled(h.row.id, false) : manager.uninstall(h.row.id);
      expect(await Promise.race([revoke, new Promise(resolve => setTimeout(() => resolve('blocked'), 500))])).not.toBe('blocked');
      await restarting;
      expect(manager.tools()).toEqual([]);
    } finally { release('slow'); }
    await new Promise(resolve => setImmediate(resolve));
    expect(await h.pids()).toEqual(before);
  });
  it('does not let a slow startup block a ready peer call or shutdown its process', async () => {
    const h = await trackedFixture();
    const slowEntry = path.join(dir, 'slow-server.cjs');
    await fs.writeFile(slowEntry, fixture.replaceAll('Echo.Mixed', 'Slow.Echo'));
    await manager.install({ source: { kind: 'command', command: process.execPath, args: [slowEntry] }, credentials: { TEST_SECRET: 'slow' } });
    await manager.close();
    let release!: (value: string) => void;
    vi.mocked(getSecret).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    manager = new PluginManager(); await manager.initialize(dir);
    try {
      await vi.waitFor(() => expect(manager.snapshot().plugins.find(row => row.id === h.row.id)!.status).toBe('ready'));
      const result = await Promise.race([manager.call('Echo.Mixed', { value: 'ready peer' }), new Promise(resolve => setTimeout(() => resolve('blocked'), 200))]);
      expect(result).not.toBe('blocked');
      const active = (await h.pids()).at(-1)!;
      const closing = manager.close();
      await vi.waitFor(() => expect(alive(active.pid)).toBe(false), { timeout: 1000 });
      await closing;
    } finally { release?.('slow'); }
  });
  it('starts with zero installations and does not wait for enabled-server credential discovery on reopen', async () => {
    expect(manager.snapshot().plugins).toEqual([]);
    expect(manager.tools()).toEqual([]);
    const h = await trackedFixture();
    await manager.configure(h.row.id, { credentials: { TEST_SECRET: 'fixture-value' } });
    await manager.close();
    let releaseSecret!: (value: string) => void;
    vi.mocked(getSecret).mockImplementationOnce(() => new Promise(resolve => { releaseSecret = resolve; }));
    manager = new PluginManager();
    await manager.initialize(dir);
    expect(manager.snapshot().plugins[0]!.status).toBe('connecting');
    expect(manager.tools().map(tool => tool.name)).toEqual(['Echo.Mixed']);
    await vi.waitFor(() => expect(releaseSecret).toBeTypeOf('function'));
    releaseSecret('fixture-value');
    await vi.waitFor(() => expect(manager.snapshot().plugins[0]!.status).toBe('ready'));
    await manager.setEnabled(h.row.id, false);
    const before = await h.pids();
    await manager.close(); manager = new PluginManager(); await manager.initialize(dir);
    expect(manager.snapshot().plugins[0]!.status).toBe('disabled');
    expect(manager.tools()).toEqual([]);
    expect(await h.pids()).toEqual(before);
  });
  it('restores installed enabled servers and preserves a process across long gaps between calls', async () => {
    const h = await trackedFixture();
    expect(alive((await h.pids())[0]!.pid)).toBe(true);
    await manager.close(); manager = new PluginManager(); await manager.initialize(dir);
    expect(manager.tools().map(tool => tool.name)).toEqual(['Echo.Mixed']);
    await vi.waitFor(() => expect(manager.snapshot().plugins[0]!.status).toBe('ready'));
    const active = (await h.pids())[1]!;
    vi.useFakeTimers();
    expect((await manager.call('Echo.Mixed', { value: 'first' })).isError).not.toBe(true);
    await vi.advanceTimersByTimeAsync(600_000);
    manager.tools(); manager.snapshot();
    expect(alive(active.pid)).toBe(true);
    expect((await manager.call('Echo.Mixed', { value: 'stateful next step' })).isError).not.toBe(true);
    expect(await h.pids()).toHaveLength(2);
  });

  it('keeps the same runtime across concurrent calls and after they settle', async () => {
    const h = await trackedFixture();
    const active = (await h.pids())[0]!;
    const held = manager.call('Echo.Mixed', { value: 'hold' });
    expect((await manager.call('Echo.Mixed', { value: 'concurrent' })).isError).not.toBe(true);
    await fs.writeFile(h.releaseFile, 'finish');
    expect((await held).isError).not.toBe(true);
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(alive(active.pid)).toBe(true);
    expect(await h.pids()).toHaveLength(1);
  });

  it.each(['disable', 'uninstall', 'close'] as const)('%s ends the owned process and refuses later calls', async action => {
    const h = await trackedFixture(process.platform === 'win32');
    await manager.call('Echo.Mixed', { value: 'first' });
    const active = (await h.pids())[0]!;
    expect(alive(active.pid)).toBe(true);
    if (action === 'disable') await manager.setEnabled(h.row.id, false);
    else if (action === 'uninstall') await manager.uninstall(h.row.id);
    else await manager.close();
    await vi.waitFor(() => expect(alive(active.pid)).toBe(false));
    if (active.child) await vi.waitFor(() => expect(alive(active.child!)).toBe(false));
    expect((await manager.call('Echo.Mixed', { value: 'must not restart' })).isError).toBe(true);
    expect(await h.pids()).toHaveLength(1);
  });

  it('stops a failed call runtime and never retries the ambiguous operation', async () => {
    const h = await trackedFixture();
    await fs.appendFile(entry, "\nprocess.on('uncaughtException',()=>process.exit(2));\n");
    // The response violates its declared output schema after startup/discovery succeeded.
    const contents = await fs.readFile(entry, 'utf8');
    await fs.writeFile(entry, contents.replace('structuredContent:{value:m.params.arguments.value}', 'structuredContent:{value:42}'));
    await manager.restart(h.row.id);
    expect((await manager.call('Echo.Mixed', { value: 'one attempt' })).isError).toBe(true);
    const active = (await h.pids())[1]!;
    await vi.waitFor(() => expect(alive(active.pid)).toBe(false));
    expect(await h.pids()).toHaveLength(2);
    expect(manager.snapshot().plugins[0]!.status).toBe('error');
  });

  it('shutdown during credential lookup cannot start a late unowned server', async () => {
    const h = await trackedFixture();
    await manager.configure(h.row.id, { credentials: { TEST_SECRET: 'fixture-value' } });
    const before = await h.pids();
    let releaseSecret!: (value: string) => void;
    let requested = false;
    vi.mocked(getSecret).mockImplementationOnce(() => {
      requested = true;
      return new Promise(resolve => { releaseSecret = resolve; });
    });
    const call = manager.restart(h.row.id);
    await vi.waitFor(() => expect(requested).toBe(true));
    const closing = manager.close();
    releaseSecret('fixture-value');
    await call;
    await closing;
    expect(await h.pids()).toEqual(before);
  });

  it('an old pending call cannot mark a successfully restarted installation as failed', async () => {
    const h = await trackedFixture();
    await manager.call('Echo.Mixed', { value: 'start runtime' });
    let rejectCall!: (reason: Error) => void;
    const request = vi.spyOn(Client.prototype, 'callTool').mockImplementationOnce(() =>
      new Promise((_resolve, reject) => { rejectCall = reject; }));
    const old = manager.call('Echo.Mixed', { value: 'delayed old transport result' });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await manager.restart(h.row.id);
    expect(manager.snapshot().plugins[0]!.status).toBe('ready');
    rejectCall(new Error('old connection failed after replacement'));
    expect((await old).isError).toBe(true);
    expect(manager.snapshot().plugins[0]!.status).toBe('ready');
    expect(manager.tools().map(tool => tool.name)).toEqual(['Echo.Mixed']);
  });

  it('rediscovers legacy or invalid cached schemas from the enabled installation in the background', async () => {
    const h = await trackedFixture();
    await manager.close();
    const file = path.join(dir, 'state', 'plugins.json');
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    stored[0].catalog = [{ name: 'unvalidated' }];
    stored[0].tools = [{ name: 'Echo.Mixed', exposedName: 'old_hashed_name', enabled: true }];
    await fs.writeFile(file, JSON.stringify(stored));
    manager = new PluginManager(); await manager.initialize(dir);
    expect(manager.tools()).toEqual([]);
    await vi.waitFor(() => expect(manager.snapshot().plugins[0]!.status).toBe('ready'));
    expect(manager.tools().map(tool => tool.name)).toEqual(['Echo.Mixed']);
    expect(await h.pids()).toHaveLength(2);
    expect(alive((await h.pids())[1]!.pid)).toBe(true);
  });
});
