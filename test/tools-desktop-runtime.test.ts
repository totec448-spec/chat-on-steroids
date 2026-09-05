import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  /**
   * The fence is right and the way out was unsaid.
   *
   * Desktop input cannot reach a web page with no focused control, because the click that would
   * create the focus is the click being refused — the macOS helper carries a long note saying so
   * and asking the next reader not to file it as a bug. But a QA run met these refusals five
   * times in a row against a browser, re-observing and retrying between each, and its closing
   * judgement was that the app's failures are loud, correct, and read as a pattern of not
   * working. `browser` drives the page over CDP and needs none of this; the refusal now says so.
   */
  it('points a caller fenced out of a browser window at the browser tool', async () => {
    desktop.actAndCapture.mockClear();
    desktop.activeWindow.mockReset();
    desktop.activeWindow.mockResolvedValue({ window: chrome, screen });
    desktop.actAndCapture.mockRejectedValueOnce(
      new desktop.ComputerError('PARTIAL_BATCH: completed_count=0 failed_index=0. INPUT_TARGET_LOST: window 41 is no longer the exact active input target')
    );
    const computer = desktopSurface({ control: true }).get('computer')!;

    const result = await computer.handler({ actions: [{ type: 'click', x: 10, y: 10, frameId: 1 }] });
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    // The real refusal survives intact; the hint is added to it, never instead of it.
    expect(text).toContain('INPUT_TARGET_LOST');
    expect(text).toContain('completed_count=0');
    expect(text).toContain('Build GTA Web Game - Google Chrome');
    expect(text).toContain('browser tool');
  });

  /**
   * The refusal that fires *before* the action, for the same reason.
   *
   * INPUT_TARGET_REQUIRED names its own remedy well — supply targetWindow, a frame, a ref, or
   * focus in the batch — but every one of those is a way to aim desktop input at a page, and a QA
   * round hit it twice in four minutes while driving a browser. Against a browser the better
   * answer is not to aim desktop input at all.
   */
  it('points at the browser tool for the target-required refusal too', async () => {
    desktop.actAndCapture.mockClear();
    desktop.activeWindow.mockReset();
    desktop.activeWindow.mockResolvedValue({ window: chrome, screen });
    desktop.actAndCapture.mockRejectedValueOnce(
      new desktop.ComputerError('PARTIAL_BATCH: completed_count=0 failed_index=0. INPUT_TARGET_REQUIRED: application keyboard input requires targetWindow')
    );
    const computer = desktopSurface({ control: true }).get('computer')!;

    const result = await computer.handler({ actions: [{ type: 'type', text: 'hello' }] });
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toContain('INPUT_TARGET_REQUIRED');
    expect(text).toContain('browser tool');
  });

  /** A capture whose geometry moved is an answer about the screenshot, not about aiming input. */
  it('leaves a stale-frame refusal alone', async () => {
    desktop.actAndCapture.mockClear();
    desktop.activeWindow.mockReset();
    desktop.activeWindow.mockResolvedValue({ window: chrome, screen });
    desktop.actAndCapture.mockRejectedValueOnce(
      new desktop.ComputerError('STALE_FRAME: window 11678 changed geometry before capture')
    );
    const computer = desktopSurface({ control: true }).get('computer')!;

    const result = await computer.handler({ actions: [{ type: 'click', x: 10, y: 10, frameId: 1 }] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('STALE_FRAME');
    expect(result.content[0].text).not.toContain('browser tool');
  });

  it('adds no browser advice when the window is not a browser', async () => {
    desktop.actAndCapture.mockClear();
    desktop.activeWindow.mockReset();
    desktop.activeWindow.mockResolvedValue({ window: notepad, screen });
    desktop.actAndCapture.mockRejectedValueOnce(
      new desktop.ComputerError('INPUT_TARGET_LOST: window 42 is no longer the exact active input target')
    );
    const computer = desktopSurface({ control: true }).get('computer')!;

    const result = await computer.handler({ actions: [{ type: 'click', x: 10, y: 10, frameId: 1 }] });
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toContain('INPUT_TARGET_LOST');
    expect(text).not.toContain('browser tool');
  });

  /** An unrelated failure is not an invitation to talk about browsers. */
  it('leaves a refusal that is not an input fence untouched', async () => {
    desktop.actAndCapture.mockClear();
    desktop.activeWindow.mockReset();
    desktop.activeWindow.mockResolvedValue({ window: chrome, screen });
    desktop.actAndCapture.mockRejectedValueOnce(new desktop.ComputerError('CLIPBOARD_FAILED: nothing to read'));
    const computer = desktopSurface({ control: true }).get('computer')!;

    const result = await computer.handler({ actions: [{ type: 'click', x: 10, y: 10, frameId: 1 }] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('CLIPBOARD_FAILED');
    expect(result.content[0].text).not.toContain('browser tool');
  });
});

describe('Desktop observe runtime contract', () => {
  beforeEach(() => vi.clearAllMocks());

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

  it('rejects a screenshot whose real control text pushes the combined MCP result over budget', async () => {
    const largeField = 'x'.repeat(4096);
    desktop.getWindowState.mockResolvedValueOnce({
      window: { id: 9, process: 'Target', state: 'foreground', title: 'Budget', x: 0, y: 0, width: 640, height: 480 },
      snapshotId: 3,
      screenshot: {
        data: 'A'.repeat(7_600_000),
        frameId: 11,
        width: 640,
        height: 480,
        region: { x: 0, y: 0, width: 640, height: 480 },
        scale: 1,
        focused: true,
        captureMode: 'window',
        windowId: 9
      },
      elements: Array.from({ length: 100 }, (_, index) => ({
        ref: `g1_s3_e${index + 1}`,
        name: largeField,
        role: 'Button',
        automationId: largeField,
        enabled: true,
        offscreen: false,
        bounds: { x: 0, y: 0, width: 20, height: 20 },
        imageBounds: { x: 0, y: 0, width: 20, height: 20 },
        imageCenter: { x: 10, y: 10 }
      })),
      uiUnavailable: null
    });
    const observe = desktopSurface().get('observe')!;

    await expect(
      observe.handler({ what: 'window', window: 9, max_elements: 100 })
    ).rejects.toThrow(/DESKTOP_RESULT_TOO_LARGE.*smaller max_width or max_elements/);
  });
});
