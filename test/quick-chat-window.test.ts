import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuickChat } from '../src/main/quick-chat-window.js';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const native = vi.hoisted(() => ({
  config: { ui: { quickChatAutoCapture: true, minimizeToTray: true, theme: 'dark' } },
  handlers: new Map<string, Handler>(),
  window: null as any,
  context: { clear: vi.fn(), seal: vi.fn(), remember: vi.fn(async () => {}), sourceWindow: vi.fn(() => ({ id: 42 })), capture: vi.fn() },
  effect: { show: vi.fn(async () => {}), clear: vi.fn() },
  workspace: { mainFrame: {}, isDestroyed: () => false }, getSession: vi.fn()
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Window extends EventEmitter {
    visible = false;
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), { mainFrame: {}, send: vi.fn(), setWindowOpenHandler: vi.fn(), isDestroyed: () => false });
    constructor() { super(); native.window = this; }
    isVisible() { return this.visible; }
    isFocused() { return this.visible; }
    isDestroyed() { return this.destroyed; }
    show() { this.visible = true; this.emit('show'); }
    focus() {}
    hide() { this.visible = false; this.emit('hide'); }
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
    getBounds() { return { x: 0, y: 0, width: 440, height: 580 }; }
    async loadFile() { this.emit('ready-to-show'); }
    async loadURL() { this.emit('ready-to-show'); }
  }
  return { BrowserWindow: Window, ipcMain: { handle: (name: string, handler: Handler) => native.handlers.set(name, handler), removeHandler: (name: string) => native.handlers.delete(name) }, globalShortcut: {}, screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1024, height: 768 } }) } };
});
vi.mock('../src/main/config.js', () => ({ getConfig: () => native.config, effectiveCapabilities: () => ({ screen: true, control: true }) }));
vi.mock('../src/main/quick-chat-context.js', () => ({ createQuickChatContext: () => native.context }));
vi.mock('../src/main/quick-chat-effect.js', () => ({ createQuickChatEffect: () => native.effect }));
vi.mock('../src/main/quick-chat-shortcut.js', () => ({ initializeQuickChatShortcut: vi.fn(), disposeQuickChatShortcut: vi.fn() }));
vi.mock('../src/main/theme.js', () => ({ shownTheme: () => 'dark' }));
vi.mock('../src/main/logger.js', () => ({ logWarn: vi.fn() }));
vi.mock('../src/main/session/store.js', () => ({ getSession: native.getSession }));
vi.mock('../src/main/session/markdown-export.js', () => ({ buildSessionMarkdown: vi.fn() }));

describe('Quick Chat window context preference', () => {
  const snapshot = { kind: 'screenshot', title: 'Source', application: 'fixture', text: 'Visible text' };
  let controller: ReturnType<typeof createQuickChat>;
  beforeEach(() => {
    vi.clearAllMocks(); native.window = null; native.handlers.clear(); native.config.ui.quickChatAutoCapture = true;
    native.context.capture.mockResolvedValue(snapshot);
    native.getSession.mockImplementation(async id => ({ id, conversationId: id, title: 'Test chat' }));
    controller = createQuickChat({ hasWorkspace: () => true, workspaceContents: () => native.workspace as never, openWorkspace: vi.fn() }); controller.register();
  });
  afterEach(() => controller.dispose());
  async function open() {
    controller.toggle();
    await vi.waitFor(() => expect(native.window).not.toBeNull());
    expect(native.window.isVisible()).toBe(false);
    const initial = native.window.webContents;
    await native.handlers.get('quick-chat:ready')!({ sender: initial, senderFrame: initial.mainFrame });
    await vi.waitFor(() => expect(native.window?.isVisible()).toBe(true));
    const sender = native.window.webContents;
    return { event: { sender, senderFrame: sender.mainFrame }, shown: sender.send.mock.calls.find((call: unknown[]) => call[0] === 'quick-chat:shown') };
  }
  it('remembers identity without capturing content or scanning until manual refresh when disabled', async () => {
    native.config.ui.quickChatAutoCapture = false;
    const { event, shown } = await open();
    expect(native.context.remember).toHaveBeenCalledOnce();
    expect(native.context.capture).not.toHaveBeenCalled();
    expect(native.effect.show).not.toHaveBeenCalled();
    expect(shown).toEqual(['quick-chat:shown', expect.any(Number), false, false]);
    expect(await native.handlers.get('quick-chat:automatic')!(event, shown[1])).toBeNull();
    expect(await native.handlers.get('quick-chat:capture')!(event, 'screenshot')).toEqual(snapshot);
    expect(native.context.capture).toHaveBeenCalledOnce();
    expect(native.effect.show).toHaveBeenCalledOnce();
  });
  it('discards a pending automatic capture when the preference is turned off', async () => {
    let finish!: (value: unknown) => void;
    native.context.capture.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { event, shown } = await open();
    expect(shown).toEqual(['quick-chat:shown', expect.any(Number), true, false]);
    const pending = native.handlers.get('quick-chat:automatic')!(event, shown[1]);
    native.config.ui.quickChatAutoCapture = false; controller.notify('state:changed');
    finish(snapshot);
    expect(await pending).toBeNull();
    expect(native.effect.clear).toHaveBeenCalled();
  });
  it('opens the exact workspace chat on cold start and reuses the panel without capturing the desktop', async () => {
    const openSession = native.handlers.get('quick-chat:open-session')!;
    const workspace = { sender: native.workspace, senderFrame: native.workspace.mainFrame };
    expect(await openSession({ ...workspace, senderFrame: {} }, 'session-one')).toMatchObject({ ok: false });
    expect(await openSession(workspace, 'session-one')).toEqual({ ok: true, data: true });
    const owner = native.window;
    expect(owner.isVisible()).toBe(false);
    const sender = owner.webContents;
    await native.handlers.get('quick-chat:ready')!({ sender, senderFrame: sender.mainFrame });
    expect(sender.send.mock.calls[0]).toEqual(['session:write', 'session-one']);
    expect(sender.send).toHaveBeenCalledWith('quick-chat:shown', expect.any(Number), false, true);
    expect(owner.isVisible()).toBe(true);
    expect(await openSession(workspace, 'session-two')).toEqual({ ok: true, data: true });
    expect(native.window).toBe(owner);
    expect(sender.send).toHaveBeenCalledWith('session:write', 'session-two');
    expect(native.context.remember).not.toHaveBeenCalled();
    expect(native.context.capture).not.toHaveBeenCalled();
    expect(native.effect.show).not.toHaveBeenCalled();
  });
});
