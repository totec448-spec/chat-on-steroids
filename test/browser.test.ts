import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findPreferredBrowser, openInPreferredBrowser, preferredBrowserCandidates } from '../src/main/browser.js';

describe('browser-backed ChatGPT commands', () => {
  it('prefers the normal per-user Chrome install on Windows', () => {
    const env = {
      LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)'
    };
    const wanted = path.win32.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe');
    expect(findPreferredBrowser('win32', env, 'C:\\Users\\example', (candidate) => candidate === wanted)).toBe(wanted);
  });

  it('finds the standard Google Chrome app on macOS before Chromium fallbacks', () => {
    const candidates = preferredBrowserCandidates('darwin', { HOME: '/Users/example' }, '/Users/example');
    expect(candidates[0]).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(
      findPreferredBrowser('darwin', { HOME: '/Users/example' }, '/Users/example', (candidate) => candidate === candidates[0])
    ).toBe(candidates[0]);
  });

  it('falls back to a per-user macOS Applications install when system Chrome is absent', () => {
    const candidates = preferredBrowserCandidates('darwin', { HOME: '/Users/example' }, '/Users/example');
    const userChrome = '/Users/example/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    expect(candidates[1]).toBe(userChrome);
    expect(findPreferredBrowser('darwin', { HOME: '/Users/example' }, '/Users/example', (candidate) => candidate === userChrome)).toBe(
      userChrome
    );
  });

  it('discovers every standard macOS Chrome channel before Chromium fallback', () => {
    const candidates = preferredBrowserCandidates('darwin', { HOME: '/Users/example' }, '/Users/example');
    const systemCandidates = candidates.filter((candidate) => candidate.startsWith('/Applications/'));
    expect(systemCandidates).toEqual([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ]);

    const canary = '/Users/example/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary';
    expect(findPreferredBrowser('darwin', { HOME: '/Users/example' }, '/Users/example', (candidate) => candidate === canary)).toBe(
      canary
    );
  });

  it('searches PATH for Chrome/Chromium on Linux instead of relying on the default browser', () => {
    const env = { HOME: '/home/example', PATH: '/custom/bin:/usr/local/bin:/usr/bin' };
    const wanted = '/custom/bin/google-chrome';
    expect(findPreferredBrowser('linux', env, '/home/example', (candidate) => candidate === wanted)).toBe(wanted);
  });

  it('keeps Linux Chrome Stable/Beta/Dev ahead of Chromium fallbacks', () => {
    const candidates = preferredBrowserCandidates('linux', { PATH: '/usr/bin' }, '/home/example');
    const fromUsrBin = candidates.filter((candidate) => candidate.startsWith('/usr/bin/'));
    expect(fromUsrBin.slice(0, 6)).toEqual([
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome-beta',
      '/usr/bin/google-chrome-unstable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser'
    ]);
  });

  it('discovers system and per-user Flatpak Chrome/Chromium launchers on Linux', () => {
    const candidates = preferredBrowserCandidates('linux', { HOME: '/home/example', PATH: '/usr/bin' }, '/home/example');
    expect(candidates).toContain('/home/example/.local/share/flatpak/exports/bin/com.google.Chrome');
    expect(candidates).toContain('/home/example/.local/share/flatpak/exports/bin/com.google.ChromeDev');
    expect(candidates).toContain('/home/example/.local/share/flatpak/exports/bin/org.chromium.Chromium');
    expect(candidates).toContain('/var/lib/flatpak/exports/bin/com.google.Chrome');
    expect(candidates).toContain('/var/lib/flatpak/exports/bin/com.google.ChromeDev');
    expect(candidates).toContain('/var/lib/flatpak/exports/bin/org.chromium.Chromium');
  });

  it('returns null when no compatible browser can be found so the caller can warn before fallback', () => {
    expect(findPreferredBrowser('linux', { PATH: '/nowhere' }, '/home/example', () => false)).toBeNull();
  });

  it('tries the next Chromium candidate when an earlier executable fails to launch', async () => {
    const env = { PATH: '/first:/second' };
    const candidates = preferredBrowserCandidates('linux', env, '/home/example');
    const first = candidates[0]!;
    const second = candidates.find((candidate) => candidate.startsWith('/second/'))!;
    const attempts: string[] = [];

    const opened = await openInPreferredBrowser('https://chatgpt.com/?clf=resume', {
      platform: 'linux',
      env,
      home: '/home/example',
      usable: (candidate) => candidate === first || candidate === second,
      launch: async (candidate) => {
        attempts.push(candidate);
        if (candidate === first) throw new Error('stale browser wrapper');
        return { pid: 123 };
      }
    });

    expect(opened).toBe(second);
    expect(attempts).toEqual([first, second]);
  });

  it('passes only the orchestration URL to a Linux browser, never the AppImage sandbox fallback', async () => {
    const flatpakChrome = '/var/lib/flatpak/exports/bin/com.google.Chrome';
    const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    const url = 'https://chatgpt.com/?clf=worker-marker';

    const opened = await openInPreferredBrowser(url, {
      platform: 'linux',
      env: { PATH: '/nowhere' },
      home: '/home/example',
      usable: (candidate) => candidate === flatpakChrome,
      launch: async (command, args, cwd) => {
        calls.push({ command, args, cwd });
        return { pid: 456 };
      }
    });

    expect(opened).toBe(flatpakChrome);
    expect(calls).toEqual([{ command: flatpakChrome, args: [url], cwd: '/var/lib/flatpak/exports/bin' }]);
    expect(calls[0]?.args).not.toContain('--no-sandbox');
  });
});
