/** One cold-start owner for the app's embedded Chromium. */
import { browserWakeConnected } from './bridge.js';
import { ensureInternalBrowserReady, openInternalBrowserUrl } from './internal-browser.js';

let waking: Promise<void> | null = null;

/**
 * Make the companion available for an already-authorized browser operation.
 *
 * A live extension wake channel owns normal tab election. Only the cold case creates the marked
 * WebContents directly; that document wakes the same MV3 worker and the durable command/status
 * protocol takes over from there. There is no process probe or OS browser launch anymore.
 */
export async function wakeBrowserUrl(
  url: string,
  _retry = false,
  backgroundStartup = false,
  authority?: { current(): boolean }
): Promise<void> {
  if (authority && !authority.current()) return;
  await ensureInternalBrowserReady();
  if (authority && !authority.current()) return;
  if (browserWakeConnected()) return;
  if (waking) return waking;

  const work = (async () => {
    if (authority && !authority.current()) return;
    if (browserWakeConnected()) return;
    await openInternalBrowserUrl(url, { active: !backgroundStartup, reveal: !backgroundStartup });
  })();
  waking = work;
  try { await work; }
  finally { if (waking === work) waking = null; }
}

export function resetBrowserStartupForTests(): void { waking = null; }
