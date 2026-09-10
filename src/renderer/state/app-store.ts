import { useSyncExternalStore } from 'react';
import type { AppApi } from '../../preload/index.js';
import type { AppState, LogEntry } from '../../shared/types.js';
import type { SwarmState } from '../../shared/session.js';

declare global {
  interface Window {
    api: AppApi;
  }
}

export const api = window.api;

type Listener = () => void;
type Snapshot = {
  state: AppState | null;
  logs: LogEntry[];
  swarm: SwarmState | null;
};

let snapshot: Snapshot = { state: null, logs: [], swarm: null };
const listeners = new Set<Listener>();
let started = false;

function publish(next: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Snapshot {
  return snapshot;
}

export async function unwrap<T>(promise: Promise<{ ok: true; data: T } | { ok: false; error: string }>): Promise<T> {
  const reply = await promise;
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

export async function refreshAppState(): Promise<AppState> {
  const state = await unwrap(api.getState());
  publish({ state });
  return state;
}

export function applyAppState(state: AppState): void {
  publish({ state });
}

export function startAppStore(): void {
  if (started) return;
  started = true;
  api.onStateChanged((state) => publish({ state }));
  api.onLogEntry((entry) => publish({ logs: [...snapshot.logs, entry].slice(-500) }));
  api.onSwarmChanged((swarm) => publish({ swarm }));
  void Promise.allSettled([
    refreshAppState(),
    unwrap(api.getLog()).then((logs) => publish({ logs: logs.slice(-500) })),
    unwrap(api.getSwarm()).then((swarm) => publish({ swarm })),
  ]);
}

export function useAppStore(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

