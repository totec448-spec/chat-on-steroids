import type { AddressInfo } from 'node:net';
import { app } from 'electron';
import { createWebLocalServer, type WebLocalService } from './http.mjs';
import { listProjects } from '../projects.js';
import { getConfig } from '../config.js';
import { logInfo, logWarn } from '../logger.js';

let current: WebLocalService | null = null;
let opening: Promise<WebLocalService> | null = null;
let handingOff = false;
let shuttingDown = false;

/** CoS's existing owners provide the only data exposed in this first slice. */
async function readLocalView() {
  const projects = await listProjects();
  return {
    projects: projects.filter(project => !project.ungrouped).slice(0, 200).map(project => ({ name: project.name }))
  };
}

async function startOnce(): Promise<WebLocalService> {
  if (shuttingDown) throw new Error('local_web_shutting_down');
  const service = createWebLocalServer({
    read: readLocalView,
    language: () => getConfig().ui.language ?? app.getLocale(),
    onDecision: kind => {
      if (kind === 'activation_accepted') logInfo('web local: browser activation accepted');
      else if (kind === 'projects_view_served') logInfo('web local: Projects view served (HTTP 200)');
      else if (kind === 'owner_read_unavailable') logWarn('web local: projects read unavailable; HTTP 503');
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      service.server.once('error', reject);
      service.server.listen(0, '127.0.0.1', () => {
        service.server.off('error', reject);
        resolve();
      });
    });
    if (shuttingDown) {
      await service.stop();
      throw new Error('local_web_shutting_down');
    }
    current = service;
    logInfo('web local: loopback listener ready (read-only)');
    return service;
  } catch (error) {
    await service.stop().catch(() => undefined);
    logWarn('web local: listener start failed; no browser activation issued');
    throw error;
  }
}

/** A native, owner-checked Desktop gesture alone opens one browser activation. */
export async function openWebLocal(openExternal: (url: string) => Promise<unknown>): Promise<boolean> {
  if (shuttingDown) throw new Error('local_web_shutting_down');
  if (handingOff) throw new Error('local_web_busy');
  handingOff = true;
  try {
    if (!current) {
      if (!opening) opening = startOnce().finally(() => { opening = null; });
      await opening;
    }
    const service = current;
    if (!service || shuttingDown) throw new Error('local_web_unavailable');
    const address = service.server.address() as AddressInfo | null;
    if (!address || address.address !== '127.0.0.1') throw new Error('local_web_wrong_listener');
    const activation = service.issueActivation();
    try {
      await openExternal('http://127.0.0.1:' + address.port + activation);
    } catch (error) {
      service.revokeActivation(activation);
      // Native shell errors may contain the activation URL. Never log the error itself.
      logWarn('web local: native browser handoff failed; activation revoked');
      throw error;
    }
    if (shuttingDown || service !== current) throw new Error('local_web_shutting_down');
    return true;
  } finally {
    handingOff = false;
  }
}

/** Terminal admission fence: app shutdown revokes all tickets and cookies. */
export async function shutdownWebLocal(): Promise<void> {
  shuttingDown = true;
  if (opening) await opening.catch(() => undefined);
  const service = current;
  current = null;
  if (service) {
    await service.stop();
    logInfo('web local: listener stopped; browser session revoked');
  }
}
