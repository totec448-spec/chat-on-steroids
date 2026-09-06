import { accessSync, constants, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchCommand, runPowerShell } from './exec.js';

type Exists = (candidate: string) => boolean;
type Launch = typeof launchCommand;

export interface PreferredBrowserOpenOptions {
  /** Start the owned helper without activating its Windows startup window. */
  backgroundStartup?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Test seam and alternate host probe; defaults to executable-file validation. */
  usable?: Exists;
  /** Test seam for launch failure/retry ordering. */
  launch?: Launch;
  /** Test seam for the Windows minimized startup wrapper. */
  powershell?: typeof runPowerShell;
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
  // These switches only affect a newly started Chrome process; handing a URL to an
  // existing instance cannot change its policy. Memory Saver exclusions alone do not
  // prevent background timer/renderer throttling of long-running orchestration tabs.
  const args = [
    ...(platform === 'win32' ? ['--disable-renderer-backgrounding', '--disable-background-timer-throttling'] : []),
    ...(options.backgroundStartup ? ['--start-maximized'] : []),
    url
  ];
  let lastError: unknown = null;

  for (const browser of preferredBrowserCandidates(platform, env, options.home)) {
    if (!usable(browser)) continue;
    try {
      // A windowless Chrome exits once extensions load unless the profile has a
      // persistent background app. Launch the marked helper itself so its tab
      // owns browser lifetime; the extension adopts that same tab, never a second.
      const cwd = (platform === 'win32' ? path.win32 : path.posix).dirname(browser);
      if (options.backgroundStartup && platform === 'win32') {
        // Start-Process joins ArgumentList; supply one correctly quoted Windows
        // command line. PowerShell literals are a separate escaping boundary.
        const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`;
        const argument = (value: string): string => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
        if ([browser, ...args].some(value => value.includes('\0'))) throw new Error('Browser launch contains a null byte');
        const script = `$ErrorActionPreference='Stop'; Start-Process -FilePath ${literal(browser)} -ArgumentList ${literal(args.map(argument).join(' '))} -WorkingDirectory ${literal(cwd)} -WindowStyle Minimized`;
        // runPowerShell hides its own console. The child gets a real minimized
        // startup request, not Node's console-only windowsHide flag. No -Wait:
        // the owned helper tab, not this wrapper, keeps the browser alive.
        const result = await (options.powershell ?? runPowerShell)(script, cwd, 10_000);
        if (result.timedOut || result.exitCode !== 0) throw new Error(`Background browser launch failed: ${result.stderr.slice(0, 300) || 'PowerShell did not complete'}`);
      }
      else await launch(browser, args, cwd);
      return browser;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  return null;
}
