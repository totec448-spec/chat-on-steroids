import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerPowerTool, htmlToCleanMarkdown } from '../src/main/mcp/tools-power.js';
import { fail, type SurfaceRegistrar, type ToolResult } from '../src/main/mcp/kernel.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

interface CapturedTool {
  name: string;
  handler: (args: any) => Promise<ToolResult>;
}

function powerRegistrar(options: { live?: boolean; exposed?: boolean } = {}): { reg: SurfaceRegistrar; tool: () => CapturedTool | null } {
  const live = options.live ?? true;
  const exposed = options.exposed ?? true;
  const caps = { ...DEFAULT_CAPABILITIES, command: live };
  const exposedCaps = { ...DEFAULT_CAPABILITIES, command: exposed };
  let captured: CapturedTool | null = null;
  const reg = {
    ctx: { roots: [], caps, exposedCaps, readOnly: false },
    caps,
    exposedCaps,
    sessionToolsLive: false,
    sessionToolsExposed: false,
    agentToolsLive: false,
    agentToolsExposed: false,
    findExposed: false,
    register(name: string, _config: unknown, handler: (args: any) => Promise<ToolResult>) {
      captured = { name, handler };
    },
    guarded(cap: keyof typeof caps, name: string, fn: () => Promise<ToolResult>) {
      return caps[cap]
        ? fn()
        : Promise.resolve(fail(`TOOL_DISABLED: ${name} is disabled by the current Chat On Steroids permissions.`));
    },
    featureDisabled(feature: string) {
      return fail(`FEATURE_DISABLED: ${feature}`);
    },
    registered() {
      return captured ? [captured.name] : [];
    }
  } as unknown as SurfaceRegistrar;
  return { reg, tool: () => captured };
}

async function invoke(action: Record<string, unknown>, options?: { live?: boolean; exposed?: boolean }): Promise<ToolResult> {
  const fixture = powerRegistrar(options);
  registerPowerTool(fixture.reg);
  const tool = fixture.tool();
  if (!tool) throw new Error('power tool was not registered');
  return tool.handler({ action });
}

const textOf = (result: ToolResult): string =>
  result.content.filter((part) => part.type === 'text').map((part) => (part as { text: string }).text).join('\n');

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length) await removeTempDir(tempDirs.pop()!);
});

describe('Power Agent composite tool', () => {
  it('adds no schema when Run commands was never exposed', () => {
    const fixture = powerRegistrar({ live: false, exposed: false });
    registerPowerTool(fixture.reg);
    expect(fixture.tool()).toBeNull();
  });

  it('stays registered but fails closed after live command permission is revoked', async () => {
    const result = await invoke({ type: 'system_info' }, { live: false, exposed: true });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('TOOL_DISABLED');
  });

  it('returns bounded non-secret system facts', async () => {
    const result = await invoke({ type: 'system_info' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      action: 'system_info',
      platform: process.platform,
      architecture: process.arch
    });
    expect(result.structuredContent).not.toHaveProperty('hostname');
    expect(result.structuredContent).not.toHaveProperty('environment');
  });

  it('turns ordinary HTML into readable markdown without scripts', () => {
    const markdown = htmlToCleanMarkdown(
      '<html><body><h1>Hello</h1><script>secret()</script><p>Read <a href="https://example.com/x">this</a>.</p></body></html>'
    );
    expect(markdown).toContain('# Hello');
    expect(markdown).toContain('[this](https://example.com/x)');
    expect(markdown).not.toContain('secret()');
  });

  it('fetches HTTP(S) text without cookies or browser state', async () => {
    const server = http.createServer((req, res) => {
      expect(req.headers.cookie).toBeUndefined();
      expect(req.headers.authorization).toBeUndefined();
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<html><head><title>Power test</title></head><body><h1>Fetched</h1><p>clean body</p></body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing test server port');
      const result = await invoke({
        type: 'web_fetch',
        url: `http://127.0.0.1:${address.port}/page`,
        max_chars: 10_000,
        timeout_seconds: 5
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ action: 'web_fetch', status: 200, title: 'Power test' });
      expect(String(result.structuredContent?.markdown)).toContain('# Fetched');
      expect(String(result.structuredContent?.markdown)).toContain('clean body');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('supports explicit system-wide write, read and list under command permission', async () => {
    const base = await makeTempDir('clf-power-');
    tempDirs.push(base);
    const target = path.join(base, 'outside-roots.txt');

    const write = await invoke({
      type: 'fs_system_write',
      path: target,
      content: 'power-file\n',
      mode: 'create',
      create_parents: false
    });
    expect(write.isError).not.toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('power-file\n');

    const read = await invoke({ type: 'fs_system_read', path: target, max_chars: 1_000 });
    expect(read.isError).not.toBe(true);
    expect(read.structuredContent).toMatchObject({ action: 'fs_system_read', path: target, text: 'power-file\n' });

    const list = await invoke({ type: 'fs_system_list', path: base, limit: 20 });
    expect(list.isError).not.toBe(true);
    expect(JSON.stringify(list.structuredContent)).toContain('outside-roots.txt');
  });

  it('runs a bounded one-shot system shell command', async () => {
    const base = await makeTempDir('clf-power-exec-');
    tempDirs.push(base);
    const result = await invoke({
      type: 'system_exec',
      script: process.platform === 'win32' ? "Write-Output 'power-exec-ok'" : "printf '%s\\n' power-exec-ok",
      shell: process.platform === 'win32' ? 'powershell' : 'sh',
      cwd: base,
      timeout_seconds: 10
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ action: 'system_exec', exit_code: 0, timed_out: false });
    expect(String(result.structuredContent?.stdout)).toContain('power-exec-ok');
  });
});
