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

export interface NormalWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowPlacement {
  bounds: NormalWindowBounds;
  maximized: boolean;
}

interface NormalWindowBoundsOwner {
  on(event: 'move' | 'resize' | 'maximize' | 'unmaximize', listener: () => void): unknown;
  isDestroyed(): boolean;
  isMaximized(): boolean;
  isMinimized(): boolean;
  isFullScreen(): boolean;
  getNormalBounds(): NormalWindowBounds;
}

/**
 * Keep the user-controlled normal rectangle even while the native window is maximized. The
 * maximized bit is presentation state; minimized/fullscreen geometry remains transient and is
 * never allowed to replace the normal rectangle.
 */
export function trackNormalWindowBounds(
  owner: NormalWindowBoundsOwner,
  save: (placement: WindowPlacement) => void
): void {
  const normalBounds = (): NormalWindowBounds | null => {
    const bounds = owner.getNormalBounds();
    if (
      !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) ||
      !Number.isFinite(bounds.width) || bounds.width <= 0 ||
      !Number.isFinite(bounds.height) || bounds.height <= 0
    ) return null;
    return {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height)
    };
  };
  const rememberNormal = (): void => {
    if (owner.isDestroyed() || owner.isMaximized() || owner.isMinimized() || owner.isFullScreen()) return;
    const bounds = normalBounds();
    if (bounds) save({ bounds, maximized: false });
  };
  const rememberMaximized = (): void => {
    if (owner.isDestroyed() || owner.isMinimized() || owner.isFullScreen()) return;
    const bounds = normalBounds();
    if (bounds) save({ bounds, maximized: true });
  };
  owner.on('move', rememberNormal);
  owner.on('resize', rememberNormal);
  owner.on('maximize', rememberMaximized);
  owner.on('unmaximize', rememberNormal);
}

/** Login launch is distinct from tunnel auto-connect and ordinary app activation. */
export function isBackgroundLaunch(argv: readonly string[]): boolean {
  return argv.includes('--background');
}

export function supportsLoginStartup(platform: NodeJS.Platform, packaged: boolean): boolean {
  return platform === 'win32' && packaged;
}

export function applyLoginStartup(
  app: { isPackaged: boolean; setLoginItemSettings(settings: { openAtLogin: boolean; path: string; args: string[] }): void },
  enabled: boolean,
  platform: NodeJS.Platform = process.platform,
  executable = process.execPath
): void {
  if (!supportsLoginStartup(platform, app.isPackaged)) return;
  app.setLoginItemSettings({ openAtLogin: enabled, path: executable, args: ['--background'] });
}
