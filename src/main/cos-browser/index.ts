/** The app's one CoS browser, running while it is the selected ChatGPT browser. */
import path from 'node:path';
import { getConfig } from '../config.js';
import { logWarn } from '../logger.js';
import { CosBrowser } from './host.js';

export const cosBrowser = new CosBrowser({
  // The main process is bundled into out/main; its preloads and pages sit beside it.
  preloadDir: path.join(__dirname, '../preload'),
  rendererDir: path.join(__dirname, '../renderer'),
  rendererUrl: () => process.env.ELECTRON_RENDERER_URL ?? null
});

/** Starts the CoS browser when it is the selected browser and stops it when it no longer is. */
export function syncCosBrowser(): void {
  if (getConfig().ui.chatBrowser === 'cos') {
    void cosBrowser.start().catch(error => logWarn(`cos browser: could not start: ${error instanceof Error ? error.message : String(error)}`));
  } else if (cosBrowser.running()) cosBrowser.stop();
}
