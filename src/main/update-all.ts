/** One explicit command over the existing updater, connection and refresh owners. */
import { checkForUpdates, manualDownloadUrl, markInstallOnQuit, updateStatus } from './update.js';
import { hasRequestedPluginRefresh, requestPluginRefreshes } from './plugin-refresh.js';
import { startBridge } from './bridge.js';
import { connect } from './connection.js';
import { wakeBrowserWork } from './browser-wake.js';
import type { UpdateAllResult } from '../shared/types.js';

let pass: Promise<UpdateAllResult> | null = null;
export function updateAll(quit: () => void, openDownload: (url: string) => Promise<void>): Promise<UpdateAllResult> {
  if (pass) return pass;
  const run = (async (): Promise<UpdateAllResult> => {
    await checkForUpdates();
    const update = updateStatus();
    if (update.stage === 'failed') throw new Error(update.error ?? 'Update check failed');
    // Reuses saved credentials and capabilities. connect() joins an existing live connection.
    await startBridge();
    await connect();
    // Durable before quitting: the next build can finish the requested connector work even
    // when automatic refresh/auto-connect are off. Neither preference is changed.
    await requestPluginRefreshes(update.latest ?? update.current);
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

/** Startup resumes accepted connector work only; it never starts another install. */
export async function resumeUpdateRefresh(): Promise<void> {
  if (!await hasRequestedPluginRefresh()) return;
  await startBridge();
  await connect();
  wakeBrowserWork();
}
