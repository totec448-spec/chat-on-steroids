import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { companionBrowserArgs, companionBrowserProfile } from '../src/main/detached-browser.js';

describe('detached companion browser custody', () => {
  it('uses a persistent profile owned by Chat On Steroids, never the normal Chrome profile', () => {
    expect(companionBrowserProfile('C:\\Users\\example\\AppData\\Roaming\\Chat On Steroids', 'win32')).toBe(
      path.win32.join('C:\\Users\\example\\AppData\\Roaming\\Chat On Steroids', 'agent-browser')
    );
  });

  it('launches Chromium with only the app-owned profile and orchestration URL', () => {
    const args = companionBrowserArgs({
      profileDir: 'C:\\cos\\agent-browser',
      initialUrl: 'https://chatgpt.com/'
    });
    expect(args).toContain('--user-data-dir=C:\\cos\\agent-browser');
    expect(args.at(-1)).toBe('https://chatgpt.com/');
    expect(args.some((arg) => arg.includes('Default'))).toBe(false);
    expect(args.some((arg) => arg.startsWith('--remote-debugging-'))).toBe(false);
  });

  it('wires bridge orchestration to one companion target instead of the personal default browser', () => {
    const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    expect(main).toContain('const companionTarget = companionBrowserTarget(userData);');
    expect(main).toContain('await openInCompanionBrowser(url, companionTarget);');
    expect(main).not.toContain('falling back to the default browser');
  });
});
