import type { AppApi } from '../preload/index.js';
import type { DesktopAskPending } from '../shared/desktop-ask.js';

/**
 * The ask-before-mouse-and-keyboard question in the app's own window (#1864, Haz's keyboard
 * condition). The corner panel never takes the focus, so Tab cannot reach it; this notice can be,
 * once the person switches to the app. It never takes the focus by itself either. An answer here or
 * in the panel ends the question, and main then clears both.
 */
export function initDesktopAskNotice(api: Pick<AppApi, 'desktopAskPending' | 'answerDesktopAsk' | 'onDesktopAskPending'>): void {
  const notice = document.getElementById('desktopAskNotice')!;
  let shown: DesktopAskPending | null = null;
  const paint = (pending: DesktopAskPending | null): void => {
    shown = pending;
    notice.hidden = !pending;
    if (!pending) return;
    document.getElementById('desktopAskNoticeTitle')!.textContent = pending.title;
    document.getElementById('desktopAskNoticeStep')!.textContent = pending.chat ? `${pending.step} · ${pending.chat}` : pending.step;
  };
  const answer = (choice: 'go' | 'not-now'): void => {
    if (!shown) return;
    const id = shown.id;
    void Promise.resolve(api.answerDesktopAsk(id, choice)).catch(() => undefined);
  };
  document.getElementById('desktopAskGo')!.addEventListener('click', () => answer('go'));
  document.getElementById('desktopAskNotNow')!.addEventListener('click', () => answer('not-now'));
  api.onDesktopAskPending?.(paint);
  // A window that opens or reloads while a question waits shows it too.
  void Promise.resolve(api.desktopAskPending?.()).then(reply => { if (reply?.ok && shown === null) paint(reply.data); }).catch(() => undefined);
}
