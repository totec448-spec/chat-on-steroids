import { run } from './dom.js';
import { currentLanguage, t, ui } from './i18n.js';

/**
 * ChatGPT asked the app to slow down in two chats ("Chats working at once", #1694): one notice for
 * the whole app, not one per chat, saying until when automatic messages wait. Resume now ends the
 * wait early; its tooltip says the limit may come back.
 */
let shownUntil: number | null = null;
let timer: number | undefined;

export function paintAutomaticPause(until: number | null): void {
  const notice = document.getElementById('automaticPause');
  if (!notice) return;
  const active = until !== null && until > Date.now() ? until : null;
  window.clearTimeout(timer);
  if (active === null) {
    // Ended by itself, or by Resume now: a keyboard user on its button continues in the message box (CodeRabbit on #2051).
    if (!notice.hidden && notice.contains(document.activeElement)) document.getElementById('chatInput')?.focus();
    notice.hidden = true; shownUntil = null; return;
  }
  if (shownUntil !== active) {
    shownUntil = active;
    ui(document.getElementById('automaticPauseText')!, 'textContent', () =>
      t('ChatGPT asked to slow down. Automatic messages resume at {0}.', [new Date(active).toLocaleTimeString(currentLanguage(), { hour: '2-digit', minute: '2-digit' })]));
  }
  notice.hidden = false;
  // It ends by itself at ChatGPT's time, also when nothing else repaints the window. The timer checks
  // the clock again when it fires: a clock set back must not hide a pause that still holds (CodeRabbit on #2051).
  timer = window.setTimeout(() => paintAutomaticPause(active), Math.min(active - Date.now() + 500, 2 ** 31 - 1));
  const resume = document.getElementById('resumeAutomaticSends') as HTMLButtonElement;
  resume.onclick = () => void (async () => {
    resume.disabled = true;
    try {
      if (await run(window.api.resumeAutomaticSends())) {
        paintAutomaticPause(null);
      }
    }
    finally { resume.disabled = false; }
  })();
}
