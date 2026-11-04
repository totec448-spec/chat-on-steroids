import { beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ enabled: true, screen: true }));
const shot = vi.hoisted(() => 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
const native = vi.hoisted(() => ({
  version: vi.fn(async () => undefined),
  run: vi.fn(async () => ({ ok: true, command: 'screenshot', data: { data: shot, format: 'png', width: 1, height: 1 } }))
}));
vi.mock('../src/main/config.js', () => ({
  getConfig: () => ({ ui: { linuxDesktopEnabled: config.enabled } }),
  effectiveCapabilities: () => ({ screen: config.screen })
}));
vi.mock('../src/main/computer/linux-screenshot-backend.js', () => ({
  checkLinuxScreenshotVersion: native.version,
  runLinuxScreenshot: native.run
}));

import { registerLinuxScreenshotTool } from '../src/main/mcp/tools-desktop-linux-readonly.js';
import type { SurfaceRegistrar, ToolResult } from '../src/main/mcp/kernel.js';

function registry() {
  const handlers = new Map<string, (input: any) => Promise<ToolResult>>();
  const declarations = new Map<string, any>();
  const reg = {
    ctx: { exposedLinuxDesktop: true },
    exposedCaps: { screen: true },
    register(name: string, decl: any, handler: (input: any) => Promise<ToolResult>) {
      handlers.set(name, handler); declarations.set(name, decl);
    },
    guarded(_cap: string, _name: string, fn: () => Promise<ToolResult>) { return fn(); }
  } as unknown as SurfaceRegistrar;
  registerLinuxScreenshotTool(reg);
  return { handlers, declarations };
}

describe.runIf(process.platform === 'linux')('read-only native screenshot MCP surface', () => {
  beforeEach(() => { config.enabled = true; config.screen = true; native.version.mockClear(); native.run.mockClear(); });

  it('registers only one read-only screenshot tool, with no native action schema', () => {
    const { handlers, declarations } = registry();
    expect([...handlers.keys()]).toEqual(['linux_observe']);
    const decl = declarations.get('linux_observe');
    expect(decl.annotations.readOnlyHint).toBe(true);
    expect(decl.inputSchema.safeParse({ what: 'screenshot', display: 0 }).success).toBe(true);
    expect(decl.inputSchema.safeParse({ what: 'screenshot', display: 1 }).success).toBe(false);
    expect(decl.inputSchema.safeParse({ what: 'screenshot', display: 32 }).success).toBe(false);
    expect(decl.inputSchema.safeParse({ what: 'click', ref: '@s1:e1' }).success).toBe(false);
    expect(decl.inputSchema.safeParse({ what: 'snapshot', window_id: '1' }).success).toBe(false);
  });

  it('publishes an image, not text containing the base64 or private pixels', async () => {
    const result = await registry().handlers.get('linux_observe')!({ what: 'screenshot', display: 0 });
    expect(result.isError).not.toBe(true);
    expect(result.content?.find(part => part.type === 'image')).toMatchObject({ mimeType: 'image/png', data: shot });
    expect(result.content?.find(part => part.type === 'text')?.text).toContain('"scope":"display"');
    expect(result.content?.find(part => part.type === 'text')?.text).not.toContain(shot);
    expect(native.run).toHaveBeenCalledExactlyOnceWith({ kind: 'screenshot', display: 0 });
  });
  it('refuses a nonzero display even if an internal caller bypasses schema validation', async () => {
    const result = await registry().handlers.get('linux_observe')!({ what: 'screenshot', display: 1 });
    expect(result.isError).toBe(true);
    expect(result.content?.find(part => part.type === 'text')?.text).toContain('DISPLAY_UNSUPPORTED');
    expect(native.version).not.toHaveBeenCalled();
    expect(native.run).not.toHaveBeenCalled();
  });

  it('refuses before the version check if opt-in or Screen permission is off', async () => {
    const handler = registry().handlers.get('linux_observe')!;
    config.enabled = false;
    expect((await handler({ what: 'screenshot', display: 0 })).isError).toBe(true);
    expect(native.version).not.toHaveBeenCalled();
    config.enabled = true; config.screen = false;
    expect((await handler({ what: 'screenshot', display: 0 })).isError).toBe(true);
    expect(native.run).not.toHaveBeenCalled();
  });

  it('does not reveal an image if Screen permission is revoked during portal consent', async () => {
    native.run.mockImplementationOnce(async () => {
      config.screen = false;
      return { ok: true, command: 'screenshot', data: { data: shot, format: 'png', width: 1, height: 1 } };
    });
    const result = await registry().handlers.get('linux_observe')!({ what: 'screenshot', display: 0 });
    expect(result.isError).toBe(true);
    expect(result.content?.some(part => part.type === 'image')).toBe(false);
  });
});
