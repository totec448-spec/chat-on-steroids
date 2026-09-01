import path from 'node:path';

export interface CompanionBrowserArgsInput {
  profileDir: string;
  initialUrl?: string | null;
}

/** A persistent profile dedicated to agent automation; never Chrome's ordinary user profile. */
export function companionBrowserProfile(userDataDir: string, platform: NodeJS.Platform = process.platform): string {
  const hostPath = platform === 'win32' ? path.win32 : path.posix;
  return hostPath.join(userDataDir, 'agent-browser');
}

/**
 * Chromium argv for the app-owned companion browser.
 *
 * The first isolation boundary is profile custody, not a second automation protocol. Existing
 * extension/bridge command ownership remains authoritative, so this slice deliberately does not
 * enable remote debugging or duplicate conversation/tab state through CDP.
 */
export function companionBrowserArgs(input: CompanionBrowserArgsInput): string[] {
  const args = [
    `--user-data-dir=${input.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps'
  ];
  if (input.initialUrl) args.push(input.initialUrl);
  return args;
}
