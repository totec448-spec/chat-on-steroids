import { describe, expect, it, vi } from 'vitest';
import type { Capabilities } from '../src/shared/types.js';

const desktop = vi.hoisted(() => {
  class TestComputerError extends Error {}
  return {
    ComputerError: TestComputerError,
    activeWindow: vi.fn(),
    findUi: vi.fn(),
    getWindowState: vi.fn(),
    listWindows: vi.fn(),
    screenshot: vi.fn(),
    waitForWindow: vi.fn(),
    actAndCapture: vi.fn()
  };
});

vi.mock('../src/main/computer/index.js', () => ({
  ComputerError: desktop.ComputerError,
  DEFAULT_SCREENSHOT_WIDTH: 1280,
  MAX_SCREENSHOT_WIDTH: 2560,
  actAndCapture: desktop.actAndCapture,
  activeWindow: desktop.activeWindow,
  findUi: desktop.findUi,
  getWindowState: desktop.getWindowState,
  listWindows: desktop.listWindows,
  screenshot: desktop.screenshot,
  waitForWindow: desktop.waitForWindow
}));

import { registerDesktopTools } from '../src/main/mcp/tools-desktop.js';

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

function desktopSurface(over: Partial<Capabilities> = {}) {
  const registered = new Map<string, { config: any; handler: (input: any) => Promise<any> }>();
  const liveCaps = caps({ screen: true, ...over });
  registerDesktopTools({
    ctx: { privacyScreenshots: false },
    caps: liveCaps,
    exposedCaps: liveCaps,
    sessionToolsLive: false,
    sessionToolsExposed: false,
    agentToolsLive: false,
    agentToolsExposed: false,
    findExposed: false,
    register(name: string, config: any, handler: (input: any) => Promise<any>) {
      registered.set(name, { config, handler });
    },
    guarded: async (_cap: string, _name: string, fn: () => Promise<any>) => fn(),
    featureDisabled: vi.fn(),
    registered: () => [...registered.keys()]
  } as never);
  return registered;
}

describe('Desktop computer browser chords', () => {
  // 2026-09-02: the prime tested its game in a tab beside its own ChatGPT chats, closed its
  // chat with ctrl+w mid-turn, and later walked the worker chats with ctrl+tab.
  const screen = { x: 0, y: 0, width: 1920, height: 1080 };
  const chrome = { id: 41, title: 'Build GTA Web Game - Google Chrome', process: 'chrome', ...screen, state: 'foreground' };
  const notepad = { ...chrome, id: 42, title: 'notes.txt - Notepad', process: 'notepad' };
  const acted = { completedCount: 1, routes: ['helper'], cursor: null, clipboard: [], screenshot: null, verification: null };

  it('refuses a tab or window chord aimed at the browser in front', async () => {
    desktop.actAndCapture.mockClear();
    desktop.activeWindow.mockResolvedValueOnce({ window: chrome, screen });
    const computer = desktopSurface({ control: true }).get('computer')!;

    const result = await computer.handler({ actions: [{ type: 'keypress', keys: ['ctrl', 'w'] }] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('BROWSER_TAB_CHORD: ctrl+w');
    expect(result.content[0].text).toContain('Build GTA Web Game - Google Chrome');
    expect(desktop.actAndCapture).not.toHaveBeenCalled();
  });

  it('judges the chord by the window the batch focuses first', async () => {
    desktop.actAndCapture.mockClear();
    desktop.listWindows.mockResolvedValueOnce({ windows: [notepad, chrome], screen });
    const computer = desktopSurface({ control: true }).get('computer')!;

    const result = await computer.handler({
      actions: [{ type: 'focus', window: 41 }, { type: 'keypress', keys: ['ctrl', 'shift', 'tab'] }]
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('BROWSER_TAB_CHORD: ctrl+shift+tab');
    expect(desktop.actAndCapture).not.toHaveBeenCalled();
  });

  it('lets the same chord through to a window that is not a browser', async () => {
    desktop.actAndCapture.mockClear();
    desktop.activeWindow.mockResolvedValueOnce({ window: notepad, screen });
    desktop.actAndCapture.mockResolvedValueOnce(acted);
    const computer = desktopSurface({ control: true }).get('computer')!;

    const result = await computer.handler({ actions: [{ type: 'keypress', keys: ['ctrl', 'w'] }] });
    expect(result.isError).toBeFalsy();
    expect(desktop.actAndCapture).toHaveBeenCalledTimes(1);
  });

  it('never asks about the window for an ordinary key', async () => {
    desktop.actAndCapture.mockClear();
    desktop.activeWindow.mockClear();
    desktop.actAndCapture.mockResolvedValueOnce(acted);
    const computer = desktopSurface({ control: true }).get('computer')!;

    const result = await computer.handler({ actions: [{ type: 'keypress', keys: ['ctrl', 'r'] }] });
    expect(result.isError).toBeFalsy();
    expect(desktop.activeWindow).not.toHaveBeenCalled();
  });
});

describe('Desktop observe runtime contract', () => {
  it('rejects explicit window ids where the documented mode cannot use them', () => {
    const observe = desktopSurface().get('observe')!;
    expect(observe.config.inputSchema.safeParse({ what: 'active', window: 123 }).success).toBe(false);
    expect(observe.config.inputSchema.safeParse({ wait_for: 'installer', window: 123 }).success).toBe(false);
  });

  it('does not disguise a helper failure as an empty foreground', async () => {
    desktop.getWindowState.mockRejectedValueOnce(new desktop.ComputerError('HELPER_ERROR: helper exploded'));
    const observe = desktopSurface().get('observe')!;

    await expect(observe.handler({})).rejects.toThrow(/HELPER_ERROR: helper exploded/);
    expect(desktop.screenshot).not.toHaveBeenCalled();
  });

  it('still falls back to the monitor for the actual no-foreground state', async () => {
    desktop.getWindowState.mockRejectedValueOnce(
      new desktop.ComputerError('WINDOW_NOT_FOUND: no matching visible window is available')
    );
    desktop.screenshot.mockResolvedValueOnce({
      data: 'png',
      frameId: 7,
      width: 320,
      height: 200,
      region: { x: 0, y: 0, width: 320, height: 200 },
      scale: 1,
      focused: null
    });
    const observe = desktopSurface().get('observe')!;

    const result = await observe.handler({});
    expect(result.content[0].text).toContain('No foreground window');
    expect(result.content[0].text).toContain('frameId 7');
  });
});
