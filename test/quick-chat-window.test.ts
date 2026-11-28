import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuickChat } from '../src/main/quick-chat-window.js';
import { logInfo, logWarn } from '../src/main/logger.js';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const native = vi.hoisted(() => ({
  config: { ui: { minimizeToTray: true, theme: 'dark' } },
  handlers: new Map<string, Handler>(),
  window: null as any,
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
vi.mock('../src/main/config.js', () => ({ getConfig: () => native.config }));
vi.mock('../src/main/quick-chat-shortcut.js', () => ({ initializeQuickChatShortcut: vi.fn(), disposeQuickChatShortcut: vi.fn() }));
vi.mock('../src/main/theme.js', () => ({ shownTheme: () => 'dark' }));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('../src/main/session/store.js', () => ({ getSession: native.getSession }));

describe('Quick Chat window lifecycle', () => {
  let controller: ReturnType<typeof createQuickChat>;
  beforeEach(() => {
    vi.clearAllMocks(); native.window = null; native.handlers.clear();
    native.getSession.mockImplementation(async id => ({ id, conversationId: id, title: 'Test chat' }));
    controller = createQuickChat({ hasWorkspace: () => true, workspaceContents: () => native.workspace as never, openWorkspace: vi.fn(() => false) }); controller.register();
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
  it('waits for the renderer before showing and toggles the same panel', async () => {
    const { event } = await open();
    expect(native.window.isVisible()).toBe(true);
    expect(native.handlers.has('quick-chat:capture')).toBe(false);
    expect(native.handlers.has('quick-chat:replace')).toBe(false);
    expect(logInfo).toHaveBeenCalledExactlyOnceWith('quick chat: waiting for compact renderer readiness before showing the panel');
    controller.toggle();
    expect(native.window.isVisible()).toBe(false);
    await expect(Promise.resolve().then(() => native.handlers.get('quick-chat:ready')!({ ...event, senderFrame: {} }))).rejects.toThrow();
  });
  it('keeps the compact conversation visible if Workspace cannot open', async () => {
    const { event } = await open();
    expect(await native.handlers.get('quick-chat:expand')!(event, 'session-one')).toBe(false);
    expect(native.window.isVisible()).toBe(true);
    expect(logWarn).toHaveBeenCalledExactlyOnceWith('quick chat: expand refused because Workspace could not be opened');
  });
  it('opens the exact workspace chat on cold start and reuses the panel', async () => {
    const openSession = native.handlers.get('quick-chat:open-session')!;
    const workspace = { sender: native.workspace, senderFrame: native.workspace.mainFrame };
    expect(await openSession({ ...workspace, senderFrame: {} }, 'session-one')).toMatchObject({ ok: false });
    expect(await openSession(workspace, 'session-one')).toEqual({ ok: true, data: true });
    const owner = native.window;
    expect(owner.isVisible()).toBe(false);
    const sender = owner.webContents;
    await native.handlers.get('quick-chat:ready')!({ sender, senderFrame: sender.mainFrame });
    expect(sender.send.mock.calls[0]).toEqual(['session:write', 'session-one']);
    expect(sender.send).toHaveBeenCalledWith('quick-chat:shown');
    expect(owner.isVisible()).toBe(true);
    expect(await openSession(workspace, 'session-two')).toEqual({ ok: true, data: true });
    expect(native.window).toBe(owner);
    expect(sender.send).toHaveBeenCalledWith('session:write', 'session-two');
  });
});
