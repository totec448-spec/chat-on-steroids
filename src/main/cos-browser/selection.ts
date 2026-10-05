/**
 * The built-in browser's one way in. It is opt-in: its module, and every hook that module installs,
 * load only once the built-in browser is the selected ChatGPT browser, so the default extension
 * path never loads it. A module cannot be unloaded; after switching away the browser is stopped
 * and its hooks do nothing.
 */
import { getConfig } from '../config.js';
import { logWarn } from '../logger.js';
import type { CosBrowser } from './host.js';

type CosBrowserModule = typeof import('./index.js');

let loaded: CosBrowserModule | null = null;
let loading: Promise<CosBrowserModule> | null = null;
const listeners = new Set<(browser: CosBrowser) => void>();

/** The built-in browser if it was ever selected in this process, else null without loading it. */
export function loadedCosBrowser(): CosBrowser | null {
  return loaded?.cosBrowser ?? null;
}

/** Runs once the module loads, or at once if it already has. */
export function onCosBrowserLoaded(listener: (browser: CosBrowser) => void): () => void {
  listeners.add(listener);
  if (loaded) listener(loaded.cosBrowser);
  return () => listeners.delete(listener);
}

function load(): Promise<CosBrowserModule> {
  loading ??= import('./index.js').then(module => {
    loaded = module;
    for (const listener of listeners) listener(module.cosBrowser);
    return module;
  }).catch(error => {
    loading = null;
    throw error;
  });
  return loading;
}

/** For callers acting on the selected built-in browser: loads it when it is not loaded yet. */
export async function loadCosBrowser(): Promise<CosBrowser> {
  return (await load()).cosBrowser;
}

/**
 * Starts the built-in browser when it is selected and stops it when it is not. Choosing it loads
 * and starts it right away, so it is ready to use; the other browsers never load it just to stop it.
 */
export async function syncCosBrowser(): Promise<void> {
  if (getConfig().ui.chatBrowser !== 'cos') {
    loaded?.syncCosBrowser();
    return;
  }
  try { (await load()).syncCosBrowser(); }
  catch (error) { logWarn(`cos browser: could not load: ${error instanceof Error ? error.message : String(error)}`); }
}
