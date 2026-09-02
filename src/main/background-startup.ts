/**
 * Keeps the Core connector available without requiring a browser or a visible app window.
 *
 * Windows login startup is tied to the existing auto-connect preference: somebody who asked
 * Chat On Steroids to connect automatically should not also have to remember to launch the tray
 * app after every sign-in. The dedicated argument prevents that OS-driven launch from flashing
 * the renderer; tray activation or a normal second launch can still create the window later.
 */

export const BACKGROUND_START_ARG = '--background';

export interface LoginStartupApp {
  isPackaged: boolean;
  setLoginItemSettings(settings: { openAtLogin: boolean; args: string[] }): void;
}

export function isBackgroundStartup(argv: readonly string[] = process.argv): boolean {
  return argv.includes(BACKGROUND_START_ARG);
}

/**
 * Mirrors `ui.autoConnect` into the Windows login item for packaged builds only.
 *
 * The same argument is supplied when disabling so Electron addresses the exact login item it
 * created when enabling. Development launches never write host startup state, and the current
 * macOS/Linux lifecycle remains unchanged until those platforms get an explicit product design.
 */
export function syncLoginStartup(
  app: LoginStartupApp,
  enabled: boolean,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'win32' || !app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: [BACKGROUND_START_ARG]
  });
}
