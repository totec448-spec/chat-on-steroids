import { accessSync, constants, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchCommand, runPowerShell } from './exec.js';
import { getConfig } from './config.js';
import type { ChatBrowser } from '../shared/types.js';

type Exists = (candidate: string) => boolean;
type Launch = typeof launchCommand;

/** A successful OS handoff is not a live browser. Unknown probes never grant opening authority. */
export async function isPreferredBrowserRunning(
  platform: NodeJS.Platform = process.platform,
  powershell: typeof runPowerShell = runPowerShell,
  browser: ChatBrowser = getConfig().ui.chatBrowser ?? 'chrome'
): Promise<boolean | null> {
  if (platform !== 'win32') return null;
  try {
    // Probe only the selected family; another browser cannot prove its presence or absence.
    // Enumerate names only, never user command lines or profile data. Both names are constants.
    const processName = browser === 'edge' ? 'msedge' : 'chrome';
    const result = await powershell(`$ErrorActionPreference='Stop'; if (@(Get-Process | Where-Object ProcessName -eq '${processName}').Count) { 'running' } else { 'absent' }`, os.tmpdir(), 5000);
    if (result.timedOut || result.exitCode !== 0) return null;
    return result.stdout.trim() === 'absent' ? false : result.stdout.trim() === 'running' ? true : null;
  } catch { return null; }
}

export interface PreferredBrowserOpenOptions {
  /** Defaults to the saved ChatGPT browser choice. */
  browser?: ChatBrowser;
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
 * Installations of the selected companion browser, in preference order.
 *
 * Nothing here can choose *which running instance* of that browser the URL reaches: the
 * platform resolves it to the one that last had focus. A chat that must be opened beside
 * another chat is therefore not opened from this module at all — the browser holding the
 * source chat opens it. See `bridge.ts::offerPlacement`.
 *
 * Worker/resume URLs require the companion and the user's ChatGPT account. Browser family
 * is a saved user choice, not inferred from executable availability or the OS URL handler.
 * Never cross that choice just because another installed browser is easier to launch.
 */
export function preferredBrowserCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME ?? env.USERPROFILE ?? os.homedir(),
  browser: ChatBrowser = 'chrome'
): string[] {
  if (platform === 'win32') {
    const p = path.win32;
    const parts = browser === 'edge'
      ? ['Microsoft', 'Edge', 'Application', 'msedge.exe']
      : ['Google', 'Chrome', 'Application', 'chrome.exe'];
    return [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']]
      .filter((root): root is string => Boolean(root))
      .map(root => p.join(root, ...parts));
  }

  if (platform === 'darwin') {
    // Release channels have separate bundles. Keep Beta/Dev/Canary-only installs usable
    // without crossing the user's chosen browser family.
    const channels = browser === 'edge' ? [
      ['Microsoft Edge.app', 'Microsoft Edge'],
      ['Microsoft Edge Beta.app', 'Microsoft Edge Beta'],
      ['Microsoft Edge Dev.app', 'Microsoft Edge Dev'],
      ['Microsoft Edge Canary.app', 'Microsoft Edge Canary']
    ] : [
      ['Google Chrome.app', 'Google Chrome'],
      ['Google Chrome Beta.app', 'Google Chrome Beta'],
      ['Google Chrome Dev.app', 'Google Chrome Dev'],
      ['Google Chrome Canary.app', 'Google Chrome Canary'],
      ['Chromium.app', 'Chromium']
    ] as const;
    return channels.flatMap(([bundle, executable]) => [
      path.posix.join('/Applications', bundle, 'Contents', 'MacOS', executable),
      ...(home ? [path.posix.join(home, 'Applications', bundle, 'Contents', 'MacOS', executable)] : [])
    ]);
  }

  if (platform === 'linux') {
    const pathValue = env.PATH ?? '';
    // Search release-channel launchers too: the companion need not be installed in Stable.
    const names = browser === 'edge' ? ['microsoft-edge', 'microsoft-edge-stable', 'microsoft-edge-beta', 'microsoft-edge-dev'] : [
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
    if (browser === 'edge') return [...new Set([
      ...fromPath,
      ...names.map(name => path.posix.join('/usr/bin', name)),
      '/opt/microsoft/msedge/msedge', '/opt/microsoft/msedge-beta/msedge', '/opt/microsoft/msedge-dev/msedge'
    ])];
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
 * Opens an orchestration URL in the saved browser family.
 *
 * Existence/executable checks are intentionally not the arbitration cut. A stale wrapper or a
 * damaged first Chrome install can pass those checks and still fail at spawn time; worker/resume
 * URLs may try another installation of that family, never the system default or another family.
 */
export async function openInPreferredBrowser(
  url: string,
  options: PreferredBrowserOpenOptions = {}
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const usable = options.usable ?? ((candidate: string) => isExecutableBrowser(candidate, platform));
  const launch = options.launch ?? launchCommand;
  const selected = options.browser ?? getConfig().ui.chatBrowser ?? 'chrome';
  const label = selected === 'edge' ? 'Microsoft Edge' : 'Google Chrome / Chromium';
  // These switches only affect a newly started Chrome process; handing a URL to an
  // existing instance cannot change its policy. Memory Saver exclusions alone do not
  // prevent background timer/renderer throttling of long-running orchestration tabs.
  const args = [
    ...(platform === 'win32' ? ['--disable-renderer-backgrounding', '--disable-background-timer-throttling'] : []),
    ...(options.backgroundStartup ? ['--window-size=1100,800'] : []),
    url
  ];
  let lastError: unknown = null;

  for (const browser of new Set(preferredBrowserCandidates(platform, env, options.home, selected))) {
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

  if (lastError) throw new Error(`${label} could not start: ${(lastError as Error).message}. Check Settings > Browser & history > ChatGPT browser.`);
  throw new Error(`${label} was not found. Install it or change Settings > Browser & history > ChatGPT browser.`);
}
