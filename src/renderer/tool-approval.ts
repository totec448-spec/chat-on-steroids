import { el } from './dom.js';
import { t, ui } from './i18n.js';

const acknowledgement = 'cos.tool-approval-notice.v1';
const screenshot = new URL('./setup-images/tool-approval.jpg', import.meta.url).href;

function notice(): HTMLElement {
  const card = el('section', 'tool-approval-notice');
  card.append(el('h3', '', () => t('One last step in ChatGPT')),
    el('p', 'tool-approval-lead', () => t('If the first tool call pauses, check its approval prompt.')));
  const image = document.createElement('img'); image.src = screenshot; image.width = 690; image.height = 226;
  ui(image, 'aria-label', () => t('Example of a ChatGPT tool approval prompt'));
  image.alt = t('Example of a ChatGPT tool approval prompt');
  card.append(image,
    el('p', '', () => t('Review the action, then open Allow → Always allow.')),
    el('p', 'muted tool-approval-footnote', () => t('Separate from Plugins → Allow all actions. This reminder does not approve a tool call.')));
  return card;
}

/** Presentation subscribes to an existing successful opening; it never opens a browser. */
export function initToolApprovalNotice(subscribe?: (listener: () => void) => () => void): void {
  document.getElementById('toolApprovalSetup')?.replaceChildren(notice());
  const dialog = document.createElement('dialog'); dialog.className = 'tool-approval-dialog';
  ui(dialog, 'aria-label', () => t('ChatGPT tool approval'));
  const close = el('button', 'btn btn-solid', () => t('Got it')) as HTMLButtonElement; close.type = 'button';
  close.addEventListener('click', () => dialog.close());
  dialog.append(notice(), close); document.body.append(dialog);
  let shown = false;
  dialog.addEventListener('close', () => {
    try { window.localStorage.setItem(acknowledgement, '1'); } catch { /* Still once in this window. */ }
  });
  subscribe?.(() => {
    if (shown) return;
    try { if (window.localStorage.getItem(acknowledgement) === '1') return; } catch { /* No storage does not block setup. */ }
    dialog.showModal(); shown = true;
  });
}
