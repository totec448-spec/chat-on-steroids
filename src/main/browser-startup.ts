/** One browser startup owner for explicit work and durable recovery. */
import { bridgeStatus, browserWakeConnected } from './bridge.js';
import { isPreferredBrowserRunning, openInPreferredBrowser } from './browser.js';
import { getConfig } from './config.js';

let waking: { lastSeenAt: number | null; selected: string; work: Promise<void>; failed: boolean; finished: boolean } | null = null;
/** One browser startup per absence episode, shared by authored sends, discovery and owed recovery. */
export async function wakeBrowserUrl(url: string, retry = false, backgroundStartup = false,
  authority?: { current(): boolean; requireProcessAbsence: boolean }): Promise<void> {
  if (authority && !authority.current()) return;
  const browser = await bridgeStatus();
  if (browserWakeConnected()) { waking = null; return; }
  const selected = getConfig().ui.chatBrowser ?? 'chrome';
  // Explicit work may disprove cached HTTP presence or an old successful launch.
  // Socket suspension alone grants nothing, and an in-flight launch stays shared.
  const prior = waking;
  const absent = (authority?.requireProcessAbsence || browser.present || (retry && prior?.finished && !prior.failed)) &&
    await isPreferredBrowserRunning() === false;
  // A settings change while the probe yielded revokes that browser's absence evidence.
  if (selected !== (getConfig().ui.chatBrowser ?? 'chrome')) return;
  // The process query yields. Off, a collected reply or a new navigation can revoke
  // the exact recovery meanwhile; a missing socket alone never proves Chrome exited.
  if (authority && (!authority.current() || (authority.requireProcessAbsence && !absent))) return;
  if (browserWakeConnected()) { waking = null; return; }
  if (browser.present && !absent) { waking = null; return; }
  if (retry && waking === prior && (waking?.failed || (absent && waking?.finished))) waking = null;
  // Until the extension registers, another explicit send belongs to the same startup.
  // A changed browser choice starts a distinct attempt without adopting the old family.
  if (waking?.lastSeenAt === browser.lastSeenAt && waking.selected === selected) return waking.work;
  const work = (async () => {
    await (backgroundStartup ? openInPreferredBrowser(url, { backgroundStartup: true }) : openInPreferredBrowser(url));
  })();
  const attempt = { lastSeenAt: browser.lastSeenAt, selected, work, failed: false, finished: false };
  waking = attempt;
  try { await work; } catch (error) { attempt.failed = true; throw error; } finally { attempt.finished = true; }
}
export function resetBrowserStartupForTests(): void { waking = null; }
