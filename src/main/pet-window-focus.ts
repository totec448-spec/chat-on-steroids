/** Windows-only focus borrowed by a pet interaction; no Desktop tool authority. */
import type { BrowserWindow } from 'electron';

type WindowIdentity = { process: number; thread: number };
export interface PetNativeFocus {
  foreground(): number;
  identify(handle: number): WindowIdentity | null;
  activate(handle: number): void;
  observe(listener: (handle: number) => void): () => void;
}
export interface PetWindowFocus {
  release(): void;
  dispose(): void;
}

/** Observe ordered native foreground transfers, including applications outside Electron. */
export function trackPetFocus(win: BrowserWindow, native: PetNativeFocus): PetWindowFocus {
  const contents = win.webContents;
  const bytes = win.getNativeWindowHandle();
  const ownHandle = bytes.length === 8 ? Number(bytes.readBigUInt64LE()) : bytes.readUInt32LE();
  let previous: (WindowIdentity & { handle: number }) | null = null;
  let last = native.foreground();
  let disposed = false;
  const forget = (): void => { previous = null; };
  const stop = native.observe(handle => {
    if (disposed || handle === last) return;
    const identity = handle === ownHandle && last && !win.isDestroyed() && win.isVisible()
      && native.foreground() === ownHandle ? native.identify(last) : null;
    previous = identity ? { handle: last, ...identity } : null;
    last = handle;
  });
  // A different foreground choice, hide or destruction revokes this one-use return.
  win.on('blur', forget);
  win.on('hide', forget);
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    forget(); stop();
    win.removeListener('blur', forget);
    win.removeListener('hide', forget);
    win.removeListener('closed', dispose);
    contents.removeListener('render-process-gone', dispose);
  };
  win.once('closed', dispose);
  contents.once('render-process-gone', dispose);
  const release = (): void => {
    const target = previous;
    previous = null;
    if (disposed || !target || win.isDestroyed() || !win.isVisible() || native.foreground() !== ownHandle) return;
    const current = native.identify(target.handle);
    if (!current || current.process !== target.process || current.thread !== target.thread) return;
    // One OS-governed attempt. Never force focus with input, thread attachment or retries.
    native.activate(target.handle);
  };
  return { release, dispose };
}

export async function windowsPetFocus(win: BrowserWindow): Promise<PetWindowFocus> {
  // Lazy: no FFI module or Windows DLL is loaded on macOS/Linux or with pets disabled.
  const { load, proto, pointer, register, unregister } = await import('koffi');
  const user32 = load('user32.dll');
  const foreground = user32.func('uintptr_t __stdcall GetForegroundWindow()');
  const owner = user32.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)');
  const visible = user32.func('int32_t __stdcall IsWindowVisible(uintptr_t hwnd)');
  const enabled = user32.func('int32_t __stdcall IsWindowEnabled(uintptr_t hwnd)');
  const minimized = user32.func('int32_t __stdcall IsIconic(uintptr_t hwnd)');
  const activate = user32.func('int32_t __stdcall SetForegroundWindow(uintptr_t hwnd)');
  // Anonymous prototype permits destroying/recreating the overlay in the same process.
  const callbackType = proto('__stdcall', null, 'void', ['uintptr_t', 'uint32_t', 'uintptr_t', 'int32_t', 'int32_t', 'uint32_t', 'uint32_t']);
  const watch = user32.func('__stdcall', 'SetWinEventHook', 'uintptr_t', ['uint32_t', 'uint32_t', 'uintptr_t', pointer(callbackType), 'uint32_t', 'uint32_t', 'uint32_t']);
  const unwatch = user32.func('int32_t __stdcall UnhookWinEvent(uintptr_t hook)');
  if (win.isDestroyed()) return { release() {}, dispose() {} };
  return trackPetFocus(win, {
    foreground: () => foreground() as number,
    identify: handle => {
      if (!visible(handle) || !enabled(handle) || minimized(handle)) return null;
      const pid = new Uint32Array(1);
      const thread = owner(handle, pid) as number;
      return thread && pid[0] ? { process: pid[0], thread } : null;
    },
    activate: handle => { activate(handle); },
    observe: listener => {
      const callback = register((_hook: number, _event: number, handle: number) => listener(handle), pointer(callbackType));
      // EVENT_SYSTEM_FOREGROUND only, OUTOFCONTEXT on Electron's message-loop thread.
      const hook = watch(3, 3, 0, callback, 0, 0, 0) as number;
      if (!hook) { unregister(callback); throw new Error('Could not observe Pets foreground ownership'); }
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true; unwatch(hook); unregister(callback);
      };
    }
  });
}
