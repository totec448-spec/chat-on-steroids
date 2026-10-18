/** One explicit command over the existing updater, connection and refresh owners. */
import { checkForUpdates, manualDownloadUrl, markInstallOnQuit, updateStatus } from './update.js';
import { consumeRequestedPluginRefreshStartup, requestPluginRefreshes } from './plugin-refresh.js';
import { startBridge } from './bridge.js';
import { connect, getStatus } from './connection.js';
import { getConfig } from './config.js';
import { wakeBrowserWork } from './browser-wake.js';
import type { UpdateAllResult } from '../shared/types.js';

let pass: Promise<UpdateAllResult> | null = null;
export function updateAll(quit: () => void, openDownload: (url: string) => Promise<void>, confirmRestart: (version: string) => Promise<boolean>): Promise<UpdateAllResult> {
  if (pass) return pass;
  const run = (async (): Promise<UpdateAllResult> => {
    await checkForUpdates();
    const update = updateStatus();
    const failed = update.stage === 'failed';
    // Ask after the download, when quitting can actually install the named build. Until the
    // person approves exactly that version in the app, neither installer shutdown nor future
    // startup work is granted.
    if (update.stage === 'ready' && !await confirmRestart(update.latest!)) return 'confirm';
    // An app update must not wait on tunnel authentication or connectivity. The next
    // build connects for its accepted refresh request; the current build only commits intent.
    if (failed || !update.latest) {
      await startBridge();
      await connect();
    }
    // Durable before quitting: the next build can finish the requested connector work even
    // when automatic refresh/auto-connect are off. Neither preference is changed.
    const tunnel = getConfig().tunnel;
    const surfaces = getStatus().surfaces.filter(surface => surface.id === 'core' || (surface.available && surface.tools.length > 0 &&
      (tunnel.kind !== 'openai' || (surface.id === 'desktop' ? tunnel.desktopTunnelId : tunnel.pluginsTunnelId)))).map(surface => surface.id);
    // Core remains requested even if connecting failed before any surface became live.
    await requestPluginRefreshes(failed ? update.current : update.latest ?? update.current, [...new Set(['core' as const, ...surfaces])]);
    if (failed) {
      // GitHub failure does not block the running build's connector check. Keep the
      // release owner's failure and the operation error visible; this is no full pass.
      wakeBrowserWork();
      throw new Error(update.error ?? 'Update check failed');
    }
    if (update.stage === 'ready') {
      if (!markInstallOnQuit(update.latest!)) throw new Error('There is no downloaded update to install yet');
      quit();
      return 'restarting';
    }
    if (update.latest) {
      await openDownload(manualDownloadUrl(update.latest));
      return 'manual';
    }
    wakeBrowserWork(); // Also lets the existing extension owner discover its shipped build.
    return 'checking-connectors';
  })().finally(() => { if (pass === run) pass = null; });
  pass = run;
  return run;
}

/** One durable startup attempt per accepted connector request; never another install. */
export async function resumeUpdateRefresh(): Promise<void> {
  // Config saves replace the tunnel settings object. Preserve that incarnation as well as
  // its values, so a profile/tunnel A -> B -> A cannot borrow the old startup reservation.
  const tunnel = getConfig().tunnel, snapshot = JSON.stringify(tunnel);
  const current = () => getConfig().tunnel === tunnel && JSON.stringify(tunnel) === snapshot;
  if (!await consumeRequestedPluginRefreshStartup(current) || !current()) return;
  await startBridge();
  if (!current()) return;
  await connect(current);
  if (current()) wakeBrowserWork();
}
