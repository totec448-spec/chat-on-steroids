/** Minimal app-event shape kept separate so macOS activation behavior is unit-testable. */
export interface ActivateEventSource {
  on(event: 'activate', listener: () => void): unknown;
}

/** Only the process that owns Electron's single-instance lock owns app runtime state/teardown. */
export function ownsAppRuntime(hasSingleInstanceLock: boolean): boolean {
  return hasSingleInstanceLock;
}

/**
 * Whether this process is allowed to touch the shared userData bootstrap at all.
 *
 * A losing single-instance process still evaluates this module and its `whenReady()` callback
 * can race `app.quit()`. Likewise the primary can receive an OS/application quit before ready.
 * Both are terminal: config/secrets/session/durable initialization belongs only to the live lock
 * owner, never to a process already leaving.
 */
export function shouldBeginAppBootstrap(hasSingleInstanceLock: boolean, quitting: boolean): boolean {
  return ownsAppRuntime(hasSingleInstanceLock) && !quitting;
}

/**
 * `second-instance` is only guaranteed to happen after Electron's `ready` event. Our own startup
 * continues well past that while config/durable state is restored and, critically, before the
 * renderer CSP/permission handlers and IPC surface are installed. Keep an early re-launch from
 * constructing a BrowserWindow across that gap. The normal startup path opens the initial window
 * once the gate is enabled, so dropping an earlier focus request loses nothing; later requests
 * focus/recreate the window immediately.
 */
export function createWindowActivationGate(showWindow: () => void): {
  request: () => void;
  enable: () => void;
  disable: () => void;
  isDisabled: () => boolean;
} {
  let enabled = false;
  // Shutdown is a terminal lifetime boundary, not a temporary pause. A startup continuation
  // can resume after `before-quit` because the main bootstrap contains several awaits; letting
  // that stale continuation call enable() again would reopen native activation during teardown.
  let disabled = false;
  return {
    request: () => {
      if (enabled && !disabled) showWindow();
    },
    enable: () => {
      if (!disabled) enabled = true;
    },
    disable: () => {
      disabled = true;
      enabled = false;
    },
    isDisabled: () => disabled
  };
}

/**
 * Closing the last ordinary window is not an application quit on macOS. The app stays in the
 * Dock/menu bar until the user explicitly quits (Cmd+Q / application menu / tray menu), and a
 * later `activate` recreates the window. Windows/Linux retain the existing preference semantics:
 * when close-to-tray is off, closing the last window exits the app.
 */
export function shouldQuitOnWindowAllClosed(
  platform: NodeJS.Platform,
  minimizeToTray: boolean
): boolean {
  return platform !== 'darwin' && !minimizeToTray;
}

/**
 * macOS users return to a hidden app through the Dock, which Electron reports as `activate`.
 * Windows/Linux use the tray/second-instance paths and should not gain a synthetic handler.
 */
export function registerNativeWindowActivation(
  source: ActivateEventSource,
  showWindow: () => void,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform === 'darwin') source.on('activate', showWindow);
}
