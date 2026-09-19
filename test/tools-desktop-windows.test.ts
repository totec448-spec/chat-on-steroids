import { beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilityTools, DESKTOP_CAPABILITIES, type Capabilities } from '../src/shared/types.js';
import { BROWSER_READ_TOOLS, BROWSER_WRITE_TOOLS } from '../src/shared/browser-control.js';

const native = vi.hoisted(() => ({
  act: vi.fn(), getWindowState: vi.fn(), call: null as any, apis: [] as any[],
  allowUnattributed: false, correlations: new Map<string, { sessionId: string }>()
}));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ multiAgent: { allowUnattributedCalls: native.allowUnattributed } }) }));
vi.mock('../src/main/session/correlation.js', () => ({ requestCorrelation: (requestId: string) => native.correlations.get(requestId) ?? null }));
vi.mock('../src/main/computer/index.js', () => ({
  ComputerError: class extends Error {}, act: native.act, getWindowState: native.getWindowState
}));
vi.mock('../src/main/mcp/call-context.js', () => ({ currentCall: () => native.call, noteCount: vi.fn() }));
vi.mock('../src/main/computer/windows-api.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/main/computer/windows-api.js')>();
  return { ...original, createWindowsComputerApi: () => {
    const api = Object.fromEntries(original.WINDOWS_API_METHODS.map(name => [name, vi.fn().mockResolvedValue(undefined)]));
    native.apis.push(api);
    return api;
  } };
});
import { registerWindowsDesktopTools } from '../src/main/mcp/tools-desktop-windows.js';
import { ComputerError } from '../src/main/computer/index.js';

function surface(over: Partial<Capabilities> = {}) {
  const caps = { screen: true, control: true, clipboardRead: true, clipboardWrite: true, ...over } as Capabilities;
  const tools = new Map<string, { config: any; handler: (input: any) => Promise<any> }>();
  registerWindowsDesktopTools({ caps, exposedCaps: { ...caps },
    register: (name: string, config: any, handler: any) => tools.set(name, { config, handler }),
    guarded: async (cap: keyof Capabilities, _name: string, run: () => Promise<any>) => caps[cap] ? run() : { isError: true, content: [{ type: 'text', text: 'TOOL_DISABLED' }] }
  } as never);
  return { caps, tools, call: (name: string, args: any = {}) => tools.get(name)!.handler(tools.get(name)!.config.inputSchema.parse(args)) };
}
const window = { app: 'fixture.exe', id: 71 };
let principalSequence = 0;
beforeEach(() => {
  vi.clearAllMocks(); native.apis.length = 0; native.correlations.clear(); native.allowUnattributed = false;
  native.call = { caller: { sessionId: `test-${++principalSequence}` } };
});

describe('Windows Desktop public registrar', () => {
  it('matches the settings tool names to registration for each Desktop permission', () => {
    for (const capability of DESKTOP_CAPABILITIES) {
      const caps = { screen: false, control: false, clipboardRead: false, clipboardWrite: false, [capability]: true };
      const browser = capability === 'screen' ? BROWSER_READ_TOOLS : capability === 'control' ? BROWSER_WRITE_TOOLS : [];
      expect(capabilityTools(capability, 'windows')).toEqual([...browser, ...surface(caps).tools.keys()]);
      expect(capabilityTools(capability, 'linux')).toEqual(browser);
      expect(capabilityTools(capability)).toEqual(browser);
    }
  });

  it('publishes the 13 Window2 operations and separately permissioned clipboard access', () => {
    expect([...surface().tools.keys()].sort()).toEqual(['activate_window', 'click', 'drag', 'get_window', 'get_window_state', 'launch_app', 'list_apps', 'list_windows', 'perform_secondary_action', 'press_key', 'read_clipboard', 'scroll', 'set_value', 'type_text', 'write_clipboard']);
    expect([...surface({ control: false, clipboardRead: false, clipboardWrite: false }).tools.keys()].sort()).toEqual(['get_window', 'get_window_state', 'list_apps', 'list_windows']);
  });

  it('uses live permissions and checks multiline clipboard permission before any native work', async () => {
    const api = surface({ clipboardWrite: false });
    expect((await api.call('type_text', { window, text: 'one\r\ntwo' })).isError).toBe(true);
    expect(native.apis).toHaveLength(0);
    api.caps.control = false;
    expect((await api.call('launch_app', { app: 'fixture.exe' })).isError).toBe(true);
    expect(native.apis).toHaveLength(0);
  });

  it('keeps exact caller state across request registrars and never lends indexes to another caller', async () => {
    await surface().call('get_window_state', { window });
    const first = native.apis[0];
    await surface().call('click', { window, element_index: 2 });
    expect(first.click).toHaveBeenCalledExactlyOnceWith({ window, element_index: 2 });
    native.call = { caller: { sessionId: 'other-principal' } };
    await surface().call('click', { window, element_index: 2 });
    expect(native.apis).toHaveLength(2);
    expect(native.apis[1].click).toHaveBeenCalledOnce();
    native.call = null;
    await expect(surface().call('click', { window, x: 2, y: 3 })).rejects.toThrow(/CALLER_IDENTITY_REQUIRED/);
    expect(native.apis).toHaveLength(2);
    await surface().call('list_windows');
    await surface().call('list_windows');
    expect(native.apis).toHaveLength(4);
  });

  it('preserves native values and literal multiline text without returning user input as success prose', async () => {
    const api = surface();
    await api.call('list_windows');
    native.apis[0].list_apps.mockResolvedValue([{ id: 'fixture.exe', displayName: 'Fixture', isRunning: true, windows: [window] }]);
    const apps = await api.call('list_apps');
    expect(apps.structuredContent.value[0]).toMatchObject({ isRunning: true, windows: [window] });
    const result = await api.call('type_text', { window, text: 'one\ntwo\r\nthree' });
    expect(native.apis[0].type_text).toHaveBeenCalledExactlyOnceWith({ window, text: 'one\ntwo\r\nthree' });
    expect(result.structuredContent.value).toBeNull();
    expect(result.content[0].text).toContain('observe to verify');
    expect(JSON.stringify(result)).not.toContain('three');
  });

  it('keeps unattributed observations request-scoped, upgrades them to the session and rechecks opt-out', async () => {
    await surface().call('get_window_state', { window });
    const identified = native.apis[0];
    native.call = { caller: { requestId: 'unresolved-workflow' } };
    native.allowUnattributed = true;
    await surface().call('get_window_state', { window });
    const anonymous = native.apis[1];
    native.call = { caller: { requestId: 'unresolved-workflow' } };
    await surface().call('click', { window, element_index: 2 });
    expect(anonymous.click).toHaveBeenCalledExactlyOnceWith({ window, element_index: 2 });
    expect(identified.click).not.toHaveBeenCalled();
    native.call = { caller: { requestId: 'different-workflow' } };
    await surface().call('click', { window, element_index: 2 });
    expect(native.apis).toHaveLength(3);
    expect(native.apis[2].click).toHaveBeenCalledOnce();
    native.call = { caller: { requestId: 'unresolved-workflow', sessionId: 'resolved-session' } };
    await surface().call('drag', { window, from_x: 1, from_y: 1, to_x: 2, to_y: 2 });
    expect(anonymous.drag).toHaveBeenCalledOnce();
    native.call = { caller: { requestId: 'next-turn', sessionId: 'resolved-session' } };
    await surface().call('click', { window, element_index: 3 });
    expect(anonymous.click).toHaveBeenCalledTimes(2);
    native.allowUnattributed = false;
    native.call = null;
    await expect(surface().call('click', { window, x: 2, y: 3 })).rejects.toThrow(/CALLER_IDENTITY_REQUIRED/);
    expect(anonymous.click).toHaveBeenCalledTimes(2);
    native.allowUnattributed = true;
    await surface().call('get_window_state', { window });
    expect(native.apis).toHaveLength(4);
    native.allowUnattributed = false;
    await surface().call('list_windows');
  });

  it('adopts a request observation when exact correlation arrives after that call returned', async () => {
    native.allowUnattributed = true;
    native.call = { caller: { requestId: 'late-observation' } };
    await surface().call('get_window_state', { window });
    const observation = native.apis[0];

    native.correlations.set('late-observation', { sessionId: 'late-session' });
    native.allowUnattributed = false;
    native.call = { caller: { requestId: 'next-turn', conversationId: 'late-chat', sessionId: 'late-session' } };
    await surface().call('click', { window, element_index: 4 });

    expect(native.apis).toHaveLength(1);
    expect(observation.click).toHaveBeenCalledExactlyOnceWith({ window, element_index: 4 });
  });

  it('returns image blocks and structured screenshot values under one combined response bound', async () => {
    const api = surface();
    await api.call('list_windows');
    native.apis[0].get_window_state.mockResolvedValue({ window, accessibility: null, screenshots: [{ id: 'frame-1', url: 'data:image/png;base64,YQ==', width: 1, height: 1, originX: 0, originY: 0, zIndex: 0 }] });
    const result = await api.call('get_window_state', { window });
    expect(result.content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'YQ==' });
    expect(result.content[0].text).not.toContain('base64');
    expect(result.structuredContent.value).toEqual(JSON.parse(result.content[0].text));
    expect(result.structuredContent.value.screenshots[0]).not.toHaveProperty('url');
    native.apis[0].get_window_state.mockResolvedValue({ window, screenshots: [{ url: `data:image/png;base64,${'A'.repeat(4_200_000)}` }] });
    expect((await api.call('get_window_state', { window })).content.filter((part: any) => part.type === 'image')).toHaveLength(1);
    native.apis[0].get_window_state.mockResolvedValue({ window, screenshots: [{ url: `data:image/png;base64,${'A'.repeat(8_400_000)}` }] });
    await expect(api.call('get_window_state', { window })).rejects.toThrow(/DESKTOP_RESULT_TOO_LARGE/);
  });

  it.each(['Control_L+w', 'Control_L+t'])('checks %s against the exact browser target and directs testing to background tab tools', async key => {
    const api = surface();
    native.getWindowState.mockResolvedValue({ window: { id: 71, title: 'Owned browser popup', process: 'chrome' } });
    const result = await api.call('press_key', { window, key });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('browser_tabs new');
    expect(result.content[0].text).toContain('browser_snapshot');
    expect(result.content[0].text).toContain('No keys were sent');
    expect(native.getWindowState).toHaveBeenCalledExactlyOnceWith({ window: 71, includeScreenshot: false, includeUi: false });
    expect(native.apis).toHaveLength(0);
    native.getWindowState.mockResolvedValue({ window: { id: 71, title: 'Editor', process: 'notepad' } });
    await api.call('press_key', { window, key });
    expect(native.apis[0].press_key).toHaveBeenCalledExactlyOnceWith({ window, key });
  });
  it('returns actionable native failure details without repeating input or inventing completion', async () => {
    const api = surface();
    await api.call('list_windows');
    const error = Object.assign(new ComputerError('PARTIAL_BATCH: completed_count=1 failed_index=1 routes=uia. STALE_FRAME: window resized'), {
      completedCount: 1, failedIndex: 1, completedRoutes: ['uia']
    });
    native.apis[0].click.mockRejectedValueOnce(error);
    const failure = await api.call('click', { window, x: 10, y: 10 });
    expect(failure.isError).toBe(true);
    expect(failure.structuredContent.error).toMatchObject({ code: 'STALE_FRAME', completed_count: 1, failed_index: 1, completed_routes: ['uia'] });
    expect(failure.content[0].text).toContain('get_window_state');
    expect(failure.content[0].text).toContain('Do not repeat');
    expect(native.apis[0].click).toHaveBeenCalledOnce();
    expect(native.apis[0].get_window_state).not.toHaveBeenCalled();
  });
  it.each([
    ['CAPTURE_FAILED', 'include_screenshot:false'],
    ['WINDOW_NOT_FOUND', 'list_windows'],
    ['FOCUS_FAILED', 'list_windows'],
    ['UIA_FAILED', 'include_text:false']
  ])('makes %s recoverable without treating it as disabled tools', async (code, recovery) => {
    const api = surface();
    await api.call('list_windows');
    native.apis[0].get_window_state.mockRejectedValueOnce(new ComputerError(`${code}: fixture failure`));
    const failure = await api.call('get_window_state', { window });
    expect(failure.isError).toBe(true);
    expect(failure.structuredContent.error).toMatchObject({ code, completed_count: null });
    expect(failure.content[0].text).toContain(recovery);
    expect(native.apis[0].get_window_state).toHaveBeenCalledOnce();
    expect(native.apis[0].activate_window).not.toHaveBeenCalled();
  });
});
