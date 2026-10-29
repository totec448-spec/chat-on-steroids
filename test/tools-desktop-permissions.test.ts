import { describe, expect, it, vi } from 'vitest';
import type { Capabilities } from '../src/shared/types.js';

const computer = vi.hoisted(() => ({
  actAndCapture: vi.fn(async () => ({
    cursor: {
      screen: { x: 10, y: 20 },
      image: null,
      imageSize: null,
      frameId: null
    },
    clipboard: [],
    screenshot: null,
    completedCount: 2,
    routes: ['local', 'local'],
    verification: null
  })),
  listWindows: vi.fn(async () => ({ windows: [], screen: { x: 0, y: 0, width: 1920, height: 1080 } }))
}));

vi.mock('../src/main/computer/index.js', () => ({
  ComputerError: class ComputerError extends Error {},
  DEFAULT_SCREENSHOT_WIDTH: 1280,
  MAX_SCREENSHOT_WIDTH: 4096,
  actAndCapture: computer.actAndCapture,
  activeWindow: vi.fn(),
  findUi: vi.fn(),
  getWindowState: vi.fn(),
  listWindows: computer.listWindows,
  screenshot: vi.fn(),
  waitForWindow: vi.fn()
}));

const ask = vi.hoisted(() => ({ refusal: null as string | null, asked: [] as unknown[], ended: 0 }));
vi.mock('../src/main/desktop-ask-window.js', () => ({
  askBeforeDesktopStep: async (...step: unknown[]) => { ask.asked.push(step); return ask.refusal; },
  desktopStepEnded: () => { ask.ended++; }
}));

import { registerMacOSDesktopTools as registerDesktopTools } from '../src/main/mcp/tools-desktop-macos.js';

function caps(over: Partial<Capabilities>): Capabilities {
  return {
    browse: false,
    search: false,
    read: false,
    metadata: false,
    create: false,
    edit: false,
    move: false,
    deleteFile: false,
    command: false,
    screen: false,
    control: false,
    clipboardRead: false,
    clipboardWrite: false,
    ...over
  };
}

describe('macOS Desktop computer permission normalization', () => {
  it('asks before steps that take the mouse or keyboard (#1804), runs nothing when refused, and not for waits or the clipboard', async () => {
    const liveCaps = caps({ control: true, clipboardRead: true });
    let computerHandler: ((input: any) => Promise<any>) | null = null;
    registerDesktopTools({ ctx: { privacyScreenshots: false }, caps: liveCaps, exposedCaps: liveCaps, sessionToolsLive: false, sessionToolsExposed: false,
      agentToolsLive: false, agentToolsExposed: false, findExposed: false,
      register(name: string, _config: unknown, handler: (input: any) => Promise<any>) { if (name === 'computer') computerHandler = handler; },
      guarded: vi.fn() } as never);
    ask.asked.length = 0; ask.ended = 0; computer.actAndCapture.mockClear();
    await computerHandler!({ actions: [{ type: 'wait', ms: 0 }, { type: 'read_clipboard' }] });
    expect(ask.asked).toEqual([]);
    await computerHandler!({ actions: [{ type: 'click', x: 1, y: 2 }, { type: 'wait', ms: 0 }] });
    expect(ask.asked).toEqual([['click', null]]);
    expect(ask.ended).toBe(1);
    ask.refusal = 'DECLINED_BY_USER: The person did not answer within 60 seconds. No input ran.';
    computer.actAndCapture.mockClear();
    const refused = await computerHandler!({ actions: [{ type: 'type', text: 'hello' }] });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('DECLINED_BY_USER');
    expect(computer.actAndCapture).not.toHaveBeenCalled();
    ask.refusal = null;
  });

  it('ends the step once its actions ran, before the verify poll, and only once when verification fails (#1804, CodeRabbit)', async () => {
    // Input during the poll (up to 10 s) is the person's, not the step's: the step must be over by then.
    const liveCaps = caps({ control: true, screen: true });
    let computerHandler: ((input: any) => Promise<any>) | null = null;
    registerDesktopTools({ ctx: { privacyScreenshots: false }, caps: liveCaps, exposedCaps: liveCaps, sessionToolsLive: false, sessionToolsExposed: false,
      agentToolsLive: false, agentToolsExposed: false, findExposed: false,
      register(name: string, _config: unknown, handler: (input: any) => Promise<any>) { if (name === 'computer') computerHandler = handler; },
      guarded: vi.fn() } as never);
    ask.asked.length = 0; ask.ended = 0;
    let endedWhenVerifying = -1;
    computer.actAndCapture.mockImplementationOnce((async (_actions: unknown, opts: { actionsDone?: () => void }) => {
      opts.actionsDone?.();
      endedWhenVerifying = ask.ended;
      throw new Error('POSTCONDITION_FAILED: completed_count=1. VERIFY_TIMEOUT');
    }) as never);
    await computerHandler!({ actions: [{ type: 'click', x: 1, y: 2 }], verify: { until: 'window_exists', match: 'Saved', timeout_ms: 10_000 } }).catch(() => null);
    expect(endedWhenVerifying).toBe(1);
    expect(ask.ended).toBe(1);
  });

  it('allows wait in a clipboard-only batch without demanding mouse/keyboard control', async () => {
    const liveCaps = caps({ clipboardRead: true });
    let computerHandler: ((input: any) => Promise<any>) | null = null;
    const registrar = {
      ctx: { privacyScreenshots: false },
      caps: liveCaps,
      exposedCaps: liveCaps,
      sessionToolsLive: false,
      sessionToolsExposed: false,
      agentToolsLive: false,
      agentToolsExposed: false,
      findExposed: false,
      register(name: string, _config: unknown, handler: (input: any) => Promise<any>) {
        if (name === 'computer') computerHandler = handler;
      },
      guarded: vi.fn()
    };
    registerDesktopTools(registrar as never);
    expect(computerHandler).not.toBeNull();

    const result = await computerHandler!({
      actions: [{ type: 'wait', ms: 0 }, { type: 'read_clipboard' }]
    });

    expect(result.isError).not.toBe(true);
    expect(computer.actAndCapture).toHaveBeenCalledWith(
      [{ type: 'wait', ms: 0 }, { type: 'read_clipboard' }],
      expect.objectContaining({ frameId: undefined, capture: undefined })
    );
  });

  it('bounds clipboard text before it becomes an MCP result', async () => {
    const liveCaps = caps({ clipboardRead: true });
    let computerHandler: ((input: any) => Promise<any>) | null = null;
    computer.actAndCapture.mockResolvedValueOnce({
      cursor: null,
      clipboard: ['x'.repeat(250_000)],
      screenshot: null,
      completedCount: 1,
      routes: ['local'],
      verification: null
    } as any);
    const registrar = {
      ctx: { privacyScreenshots: false },
      caps: liveCaps,
      exposedCaps: liveCaps,
      sessionToolsLive: false,
      sessionToolsExposed: false,
      agentToolsLive: false,
      agentToolsExposed: false,
      findExposed: false,
      register(name: string, _config: unknown, handler: (input: any) => Promise<any>) {
        if (name === 'computer') computerHandler = handler;
      },
      guarded: vi.fn()
    };
    registerDesktopTools(registrar as never);

    const result = await computerHandler!({ actions: [{ type: 'read_clipboard' }] });
    const text = result.content[0].text as string;
    expect(text).toContain('truncated');
    expect(text.length).toBeLessThan(70_000);
  });

  it('caps the visible-window list and says when more matches exist', async () => {
    const liveCaps = caps({ screen: true });
    computer.listWindows.mockResolvedValueOnce({
      screen: { x: 0, y: 0, width: 1920, height: 1080 },
      windows: Array.from({ length: 130 }, (_, index) => ({
        id: index + 1,
        process: 'app.exe',
        title: `Window ${index + 1}`,
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        state: 'open'
      }))
    } as any);
    let observeHandler: ((input: any) => Promise<any>) | null = null;
    const registrar = {
      ctx: { privacyScreenshots: false },
      caps: liveCaps,
      exposedCaps: liveCaps,
      sessionToolsLive: false,
      sessionToolsExposed: false,
      agentToolsLive: false,
      agentToolsExposed: false,
      findExposed: false,
      register(name: string, _config: unknown, handler: (input: any) => Promise<any>) {
        if (name === 'observe') observeHandler = handler;
      },
      guarded: async (_cap: unknown, _name: unknown, fn: () => Promise<any>) => fn()
    };
    registerDesktopTools(registrar as never);

    const result = await observeHandler!({ what: 'windows', max_elements: 3 });
    const text = result.content[0].text as string;
    expect(text).toContain('showing 3 of 130 matching windows');
    expect(text).toContain('Window 3');
    expect(text).not.toContain('Window 4\n');
  });
});
