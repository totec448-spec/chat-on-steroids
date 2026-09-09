/**
 * Publication facade for the external worker broker.
 *
 * The core stages durable intent. Browser work is published separately only after the
 * caller has crossed the durable barrier, preventing a lost HTTP response from causing
 * an irreversible ChatGPT action to be repeated.
 */

export * from './external-controller-core.js';

import * as core from './external-controller-core.js';
import type { ExternalWorkerRevival, ExternalWorkerSpawn } from './external-controller-core.js';

const spawnListeners = new Set<(worker: ExternalWorkerSpawn) => void>();
const reviveListeners = new Set<(revival: ExternalWorkerRevival) => void>();

export function onExternalSpawnRequest(listener: (worker: ExternalWorkerSpawn) => void): () => void {
  spawnListeners.add(listener);
  for (const worker of core.pendingExternalWorkerSpawns()) listener(worker);
  return () => spawnListeners.delete(listener);
}

export function onExternalReviveRequest(listener: (revival: ExternalWorkerRevival) => void): () => void {
  reviveListeners.add(listener);
  for (const revival of core.pendingExternalWorkerRevivals()) listener(revival);
  return () => reviveListeners.delete(listener);
}

/** Publish every still-pending browser action. The bridge de-duplicates exact command specs. */
export function publishExternalController(): void {
  for (const worker of core.pendingExternalWorkerSpawns()) {
    for (const listener of spawnListeners) listener(worker);
  }
  for (const revival of core.pendingExternalWorkerRevivals()) {
    for (const listener of reviveListeners) listener(revival);
  }
}

export function resetExternalControllerForTests(): void {
  spawnListeners.clear();
  reviveListeners.clear();
  core.resetExternalControllerForTests();
}
