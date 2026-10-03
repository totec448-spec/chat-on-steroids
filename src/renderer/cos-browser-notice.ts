import type { ChatBrowser } from '../shared/types.js';

const DISMISSED_KEY = 'cos.cosBrowserNotice.dismissed';

let dismissed = false;
try { dismissed = window.localStorage.getItem(DISMISSED_KEY) === '1'; }
catch { /* Dismissing still works for this window when storage is unavailable. */ }

/**
 * Offers the built-in CoS browser to someone whose ChatGPT runs in a desktop browser window.
 *
 * It appears once that browser is actually connected, which is when its window first shows up
 * (normally right after the first message), and points at the ChatGPT browser setting rather than
 * switching anything itself. Choosing the CoS browser hides it; dismissing hides it for good.
 */
/**
 * Says so in the chat when the built-in browser has no ChatGPT sign-in, because nothing can be
 * sent until there is one and Setup is the only other place that shows it. Unknown (the browser
 * is still starting, or is not the selected one) shows nothing. It cannot be dismissed: it is a
 * state, not a tip, and goes away by itself once the sign-in is there.
 */
export function paintCosSignInNotice(state: { chatBrowser: ChatBrowser | undefined; signedIn: boolean | null | undefined }, signIn: () => void): void {
  const notice = document.getElementById('cosSignInNotice')!;
  notice.hidden = (state.chatBrowser ?? 'chrome') !== 'cos' || state.signedIn !== false;
  document.getElementById('cosSignInNoticeOpen')!.onclick = signIn;
}

export function paintCosBrowserNotice(state: { chatBrowser: ChatBrowser | undefined; browserConnected: boolean }, choose: () => void): void {
  const notice = document.getElementById('cosBrowserNotice')!;
  notice.hidden = dismissed || (state.chatBrowser ?? 'chrome') === 'cos' || !state.browserConnected;
  document.getElementById('cosBrowserNoticeChoose')!.onclick = choose;
  document.getElementById('dismissCosBrowserNotice')!.onclick = () => {
    dismissed = true;
    try { window.localStorage.setItem(DISMISSED_KEY, '1'); }
    catch { /* Keep it dismissed for this window. */ }
    notice.hidden = true;
  };
}
