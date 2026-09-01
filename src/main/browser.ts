import { accessSync, constants, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchCommand } from './exec.js';

type Exists = (candidate: string) => boolean;
type Launch = typeof launchCommand;

export interface PreferredBrowserOpenOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Test seam and alternate host probe; defaults to executable-file validation. */
  usable?: Exists;
  /** Test seam for launch failure/retry ordering. */
  launch?: Launch;
}

function isExecutableBrowser(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return false;
    if (platform !== 'win32') accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Browsers which can run the unpacked companion extension, in preference order.
 *
 * Nothing here can choose *which running instance* of that browser the URL reaches: the
 * platform resolves it to the one that last had focus. A chat that must be opened beside
 * another chat is therefore not opened from this module at all — the browser holding the
 * source chat opens it. See `bridge.ts::offerPlacement`.
 *
 * Worker/resume URLs are not ordinary links: the extension must redeem the command marker
 * embedded in them. Sending those URLs to Safari/Firefox merely opens a dead ChatGPT tab, so
 * browser-backed orchestration deliberately prefers the Chrome installation the setup guide
 * tells the user to load the extension into.
 */
export function preferredBrowserCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME ?? env.USERPROFILE ?? os.homedir()
): string[] {
  if (platform === 'win32') {
    const p = path.win32;
    return [
      env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      env.ProgramFiles && p.join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      env['ProgramFiles(x86)'] && p.join(env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
    ].filter((candidate): candidate is string => Boolean(candidate));
  }

  if (platform === 'darwin') {
    // Chrome's release channels are separate .app bundles on macOS. A Beta/Dev/Canary-only
    // install is still a perfectly valid place to load this unpacked Chrome extension, and the
    // setup UI never requires Stable specifically. If orchestration only knows the Stable bundle,
    // a worker/resume command falls through to the system default browser (commonly Safari) even
    // though the compatible Chrome instance is sitting right there with the extension loaded.
    const chromeChannels = [
      ['Google Chrome.app', 'Google Chrome'],
      ['Google Chrome Beta.app', 'Google Chrome Beta'],
      ['Google Chrome Dev.app', 'Google Chrome Dev'],
      ['Google Chrome Canary.app', 'Google Chrome Canary'],
      ['Chromium.app', 'Chromium']
    ] as const;
    return chromeChannels.flatMap(([bundle, executable]) => [
      path.posix.join('/Applications', bundle, 'Contents', 'MacOS', executable),
      ...(home ? [path.posix.join(home, 'Applications', bundle, 'Contents', 'MacOS', executable)] : [])
    ]);
  }

  if (platform === 'linux') {
    const pathValue = env.PATH ?? '';
    // Google ships Beta and Dev as separate Linux packages/binaries, just as it ships
    // separate .app bundles on macOS. A user can legitimately have the companion loaded in
    // one of those channels with Stable absent, so keep all Chrome channels ahead of the
    // Chromium fallbacks rather than handing an orchestration marker to the default browser.
    const names = [
      'google-chrome',
      'google-chrome-stable',
      'google-chrome-beta',
      'google-chrome-unstable',
      'chromium',
      'chromium-browser'
    ];
    const fromPath = pathValue
      .split(':')
      .filter(Boolean)
      .flatMap((dir) => names.map((name) => path.posix.join(dir, name)));
    // Chrome and Chromium are both widely installed through Flatpak on immutable Linux
    // desktops. Flatpak exports host launchers for installed applications under these
    // `exports/bin` directories (the exported Chrome desktop file uses the same path as
    // TryExec), so they can be launched exactly like the distro/Snap wrappers below. Keep
    // this shell-free: worker/resume markers are URLs and must remain one literal argv item.
    const userFlatpak = home ? path.posix.join(home, '.local', 'share', 'flatpak', 'exports', 'bin') : '';
    return [
      ...fromPath,
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome-beta',
      '/usr/bin/google-chrome-unstable',
      '/opt/google/chrome/google-chrome',
      '/opt/google/chrome-beta/google-chrome-beta',
      '/opt/google/chrome-unstable/google-chrome-unstable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      userFlatpak && path.posix.join(userFlatpak, 'com.google.Chrome'),
      userFlatpak && path.posix.join(userFlatpak, 'com.google.ChromeDev'),
      userFlatpak && path.posix.join(userFlatpak, 'org.chromium.Chromium'),
      '/var/lib/flatpak/exports/bin/com.google.Chrome',
      '/var/lib/flatpak/exports/bin/com.google.ChromeDev',
      '/var/lib/flatpak/exports/bin/org.chromium.Chromium'
    ].filter(Boolean);
  }

  return [];
}

export function findPreferredBrowser(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
  exists: Exists = (candidate) => isExecutableBrowser(candidate, platform)
): string | null {
  for (const candidate of preferredBrowserCandidates(platform, env, home)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Opens an orchestration URL in the first Chromium browser that can actually be launched.
 *
 * Existence/executable checks are intentionally not the arbitration cut. A stale wrapper or a
 * damaged first Chrome install can pass those checks and still fail at spawn time; worker/resume
 * URLs must then try the next compatible Chromium candidate rather than falling straight through
 * to Safari/Firefox via the system default browser.
 */
export async function openInPreferredBrowser(
  url: string,
  options: PreferredBrowserOpenOptions = {}
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const usable = options.usable ?? ((candidate: string) => isExecutableBrowser(candidate, platform));
  const launch = options.launch ?? launchCommand;
  let lastError: unknown = null;

  for (const browser of preferredBrowserCandidates(platform, env, options.home)) {
    if (!usable(browser)) continue;
    try {
      await launch(browser, [url], path.dirname(browser));
      return browser;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  return null;
}
