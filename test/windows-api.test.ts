import { describe, expect, it, vi } from 'vitest';
import { createWindowsComputerApi, WINDOWS_API_METHODS, type WindowsComputerBackend } from '../src/main/computer/windows-api.js';
import type { WindowInfo, Screenshot } from '../src/main/computer/index.js';

const window = { id: 42, app: 'C:\\Apps\\fixture.exe', title: 'Fixture' };
const nativeWindow: WindowInfo = { ...window, process: 'fixture', dpi: 144, x: 100, y: 200, width: 600, height: 450, state: 'open' };
const shot: Screenshot = { frameId: 1, data: 'AA==', width: 300, height: 225, region: { x: 100, y: 200, width: 600, height: 450 }, scale: 0.5, focused: false, captureMode: 'window', windowId: 42 };
function fixture() {
  const result: Awaited<ReturnType<WindowsComputerBackend['getWindowState']>> = {
    window: nativeWindow, screenshot: shot, snapshotId: 1, uiUnavailable: null,
    accessibility: { documentText: 'Document', selectedText: 'Doc', focusedElement: 'ref-1' },
    elements: [{ ref: 'ref-1', name: 'Toggle', role: 'CheckBox', automationId: '', enabled: true, offscreen: false, bounds: shot.region, imageBounds: null, imageCenter: null, actions: ['toggle', 'focus'], focused: true, selected: true }],
    related: [{ window: { ...nativeWindow, id: 43 }, screenshot: { ...shot, frameId: 2, windowId: 43, region: { x: 250, y: 350, width: 150, height: 150 }, width: 75, height: 75 } }]
  };
  const backend: WindowsComputerBackend = {
    getWindowState: vi.fn(async () => result),
    listWindows: vi.fn(async () => ({ windows: [nativeWindow], screen: shot.region })),
    listDesktopApps: vi.fn(async () => ({ apps: [{ id: window.app, displayName: 'Fixture', windows: [nativeWindow] }], truncated: false })),
    act: vi.fn(async () => ({ cursor: null, clipboard: [], completedCount: 1, routes: ['sendinput' as const] }))
  };
  return { backend, result, api: createWindowsComputerApi(backend) };
}

describe('Windows Window2 interface', () => {
  it('exposes exactly the thirteen methods and defaults to image-only state', async () => {
    const { api, backend } = fixture();
    expect(WINDOWS_API_METHODS).toHaveLength(13);
    expect(await api.list_windows()).toEqual([window]);
    const state = await api.get_window_state({ window });
    expect(backend.getWindowState).toHaveBeenLastCalledWith(expect.objectContaining({ includeScreenshot: true, includeUi: false }));
    expect(state.accessibility).toBeNull();
    expect(state.screenshots[0]).toEqual({ id: 'frame-1', url: 'data:image/png;base64,AA==', width: 300, height: 225, originX: 100, originY: 200, zIndex: 0 });
    await expect(api.get_window_state({ window, include_screenshot: false, include_text: false })).rejects.toThrow('At least one');
  });
  it('routes popup image coordinates to the exact frame and consumes state', async () => {
    const { api, backend } = fixture();
    await api.get_window_state({ window });
    await api.click({ window, screenshotId: 'frame-2', x: 15, y: 15, mouse_button: 'r', click_count: 2 });
    expect(backend.act).toHaveBeenLastCalledWith([{ type: 'click', x: 15, y: 15, button: 'right', count: 2 }], { frameId: 2, window: 43, app: window.app, ownerWindow: 42, ownerApp: window.app });
    await expect(api.click({ window, x: 5, y: 5 })).rejects.toThrow('STALE_WINDOW_STATE');
  });
  it('reports focus, incomplete accessibility and unavailable text while retaining usable pixels', async () => {
    const { api, result, backend } = fixture();
    Object.assign(result, { uiTruncated: true });
    result.elements[0] = { ...result.elements[0]!, offscreen: true, enabled: false };
    const state = await api.get_window_state({ window, include_text: true });
    expect(state).toMatchObject({ focused: false, accessibility: { truncated: true } });
    expect(state.accessibility?.tree).toContain('[offscreen]');
    expect(state.accessibility?.tree).toContain('[disabled]');
    // Keep frame ids/dimensions before the possibly long accessibility body.
    expect(JSON.stringify(state).indexOf('"screenshots"')).toBeLessThan(JSON.stringify(state).indexOf('"accessibility"'));
    result.uiUnavailable = { code: 'UIA_FAILED', message: 'Fixture provider unavailable' };
    result.elements = [];
    const degraded = await api.get_window_state({ window, include_text: true });
    expect(degraded).toMatchObject({ accessibility: null, accessibility_error: result.uiUnavailable });
    expect(degraded.screenshots).toHaveLength(2);
    await expect(api.set_value({ window, element_index: 0, value: 'unsafe' })).rejects.toThrow('ELEMENT_NOT_FOUND');
    expect(backend.act).not.toHaveBeenCalled();
    result.uiUnavailable = null;
    result.screenshot = null;
    result.related = [];
    result.window = { ...nativeWindow, state: 'foreground' };
    Object.assign(result, { uiTruncated: false });
    expect(await api.get_window_state({ window, include_screenshot: false, include_text: true })).toMatchObject({ focused: true, accessibility: { truncated: false } });
  });
  it('uses latest numeric UI indexes and advertised case-insensitive action labels', async () => {
    const { api, backend } = fixture();
    const state = await api.get_window_state({ window, include_text: true, include_screenshot: false });
    expect(state.accessibility?.tree).toBe('0: CheckBox "Toggle" [Toggle, Raise]');
    expect(state.accessibility?.focused_element).toBe(state.accessibility?.tree);
    await expect(api.perform_secondary_action({ window, element_index: 0, action: 'Invoke' })).rejects.toThrow('ACTION_UNAVAILABLE');
    await api.perform_secondary_action({ window, element_index: 0, action: 'tOgGlE' });
    expect(backend.act).toHaveBeenLastCalledWith([{ type: 'ui_action', ref: 'ref-1', action: 'toggle' }], { window: 42, app: window.app });
  });
  it('preserves element click button/count, raw wheel units and literal multiline text', async () => {
    const { api, backend } = fixture();
    await api.get_window_state({ window, include_text: true });
    await api.click({ window, element_index: 0, mouse_button: 'm', click_count: 3 });
    expect(backend.act).toHaveBeenLastCalledWith([{ type: 'click_ref', ref: 'ref-1', button: 'middle', count: 3 }], { window: 42, app: window.app });
    await api.get_window_state({ window });
    await api.scroll({ window, x: 20, y: 40, scrollX: 120, scrollY: -240 });
    expect(backend.act).toHaveBeenLastCalledWith([{ type: 'scroll', x: 20, y: 40, scroll_x: 120, scroll_y: -240, scrollUnit: 'wheel' }], { frameId: 1, window: 42, app: window.app });
    await api.type_text({ window, text: 'first\nsecond' });
    expect(backend.act).toHaveBeenLastCalledWith([{ type: 'paste', text: 'first\nsecond' }], { window: 42, app: window.app });
  });
  it('rejects wrong app identities and screenshot ids from a replaced observation', async () => {
    const { api, result, backend } = fixture();
    await expect(api.get_window({ id: 42, app: 'wrong' })).rejects.toThrow('WINDOW_NOT_FOUND');
    await api.get_window_state({ window });
    result.screenshot = { ...shot, frameId: 7 };
    await api.get_window_state({ window });
    await expect(api.click({ window, screenshotId: 'frame-1', x: 5, y: 5 })).rejects.toThrow('STALE_SCREENSHOT');
    result.window = { ...nativeWindow, app: 'other.exe' };
    await expect(api.type_text({ window, text: 'unsafe' })).rejects.toThrow('STALE_WINDOW');
    expect(backend.act).not.toHaveBeenCalled();
  });
  it('does not publish an asynchronous observation superseded by another capture', async () => {
    const { api, backend, result } = fixture();
    let complete!: (value: typeof result) => void;
    vi.mocked(backend.getWindowState).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const first = api.get_window_state({ window });
    await api.get_window_state({ window });
    complete(result);
    await expect(first).rejects.toThrow('superseded');
    await api.click({ window, x: 1, y: 1 });
    expect(backend.act).toHaveBeenCalledOnce();
  });
  it('isolates observation authority between caller factories', async () => {
    const { api, backend } = fixture();
    const other = createWindowsComputerApi(backend);
    await api.get_window_state({ window });
    await expect(other.click({ window, x: 1, y: 1 })).rejects.toThrow('STALE_WINDOW_STATE');
    await expect(other.set_value({ window, element_index: 0, value: 'x' })).rejects.toThrow('STALE_WINDOW_STATE');
  });
  it('rejects an old action when a newer observation wins its app-identity await', async () => {
    const { api, backend, result } = fixture();
    await api.get_window_state({ window });
    let complete!: (value: typeof result) => void;
    vi.mocked(backend.getWindowState).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const click = api.click({ window, x: 1, y: 1 });
    await api.get_window_state({ window });
    complete(result);
    await expect(click).rejects.toThrow('observation changed');
    expect(backend.act).not.toHaveBeenCalled();
  });
  it('evicts old observation authority at the bounded thirty-two-window limit', async () => {
    const { api, backend, result } = fixture();
    vi.mocked(backend.getWindowState).mockImplementation(async opts => ({ ...result, window: { ...nativeWindow, id: opts.window! } }));
    for (let id = 1; id <= 33; id++) await api.get_window_state({ window: { ...window, id } });
    await expect(api.set_value({ window: { ...window, id: 1 }, element_index: 0, value: 'stale' })).rejects.toThrow('STALE_WINDOW_STATE');
    expect(backend.act).not.toHaveBeenCalled();
  });
  it('keeps identifiable windows when an inaccessible neighbor has no exact app identity', async () => {
    const { api, backend, result } = fixture();
    const inaccessible: WindowInfo = { ...nativeWindow, id: 99, app: undefined, process: 'protected' };
    vi.mocked(backend.listWindows).mockResolvedValue({ windows: [inaccessible, nativeWindow], screen: shot.region });
    expect(await api.list_windows()).toEqual([window]);
    result.window = inaccessible;
    await expect(api.get_window({ id: 99 })).rejects.toThrow('WINDOW_IDENTITY_UNAVAILABLE');
  });
  it('uses returned PNG pixels at negative monitor origins and non-default DPI', async () => {
    const { api, result, backend } = fixture();
    result.screenshot = { ...shot, region: { ...shot.region, x: -900, y: -300 }, width: 150, height: 112, scale: 0.25 };
    const state = await api.get_window_state({ window });
    expect(state.screenshots[0]).toMatchObject({ width: 150, height: 112, originX: -900, originY: -300 });
    await api.click({ window, x: 75, y: 38 });
    expect(backend.act).toHaveBeenLastCalledWith([{ type: 'click', x: 75, y: 38, button: 'left', count: 1 }], { frameId: 1, window: 42, app: window.app });
  });
  it('keeps popup z-order and rejects overflow/outside coordinates before native input', async () => {
    const { api, result, backend } = fixture();
    result.related!.push({ window: { ...nativeWindow, id: 44 }, screenshot: { ...shot, windowId: 44, frameId: 3 } });
    const state = await api.get_window_state({ window });
    expect(state.screenshots.map(s => [s.id, s.zIndex])).toEqual([['frame-1', 0], ['frame-3', 1], ['frame-2', 2]]);
    await expect(api.click({ window, x: Number.MAX_VALUE, y: 10 })).rejects.toThrow('COORDINATE_OUT_OF_BOUNDS');
    await expect(api.click({ window, x: 400, y: 10 })).rejects.toThrow('COORDINATE_OUT_OF_BOUNDS');
    await expect(api.click({ window, screenshotId: 'frame-2', x: 75, y: 10 })).rejects.toThrow('COORDINATE_OUT_OF_BOUNDS');
    await expect(api.scroll({ window, x: 1, y: 1, scrollX: 1_200_001, scrollY: 0 })).rejects.toThrow();
    expect(backend.act).not.toHaveBeenCalled();
    await api.scroll({ window, x: 1.6, y: 2.4, scrollX: 119.8, scrollY: -240.2 });
    expect(backend.act).toHaveBeenLastCalledWith([{ type: 'scroll', x: 2, y: 2, scroll_x: 120, scroll_y: -240, scrollUnit: 'wheel' }], { frameId: 1, window: 42, app: window.app });
  });
});
