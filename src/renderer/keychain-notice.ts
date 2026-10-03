import type { AppApi } from '../preload/index.js';

/**
 * Explains the macOS Keychain password prompt a new build triggers. Main announces a Keychain
 * read that may wait on it before the read starts (src/main/keychain-notice.ts), because once it
 * waits, main may not reach this window again until the prompt is answered. The notice appears
 * only if the read is still running after a moment: a build the Keychain lets through shows
 * nothing, and the renderer's own timer works even while main waits.
 */
export const KEYCHAIN_NOTICE_DELAY_MS = 600;

export function initKeychainNotice(api: Pick<AppApi, 'onKeychainWaiting' | 'keychainNoticeReady'>): void {
  const notice = document.getElementById('keychainNotice')!;
  let timer: ReturnType<typeof setTimeout> | undefined;
  api.onKeychainWaiting?.(waiting => {
    clearTimeout(timer);
    if (!waiting) {
      notice.hidden = true;
      return;
    }
    timer = setTimeout(() => { notice.hidden = false; }, KEYCHAIN_NOTICE_DELAY_MS);
    void Promise.resolve(api.keychainNoticeReady()).catch(() => undefined);
  });
}
