/**
 * What's New: the highlights of the version the app just updated to, once (#1172).
 *
 * The highlights are the release notes' own Highlights, shortened, and written in each release PR
 * next to the notes. Literal `t()` calls keep the catalog audit able to see each key, so every
 * language ships them like the rest of the interface. A version without an entry shows nothing.
 */
import { releaseNotesUrl, whatsNewAction } from '../shared/whats-new.js';
import { $, el, icon, run } from './dom.js';
import { t, ui } from './i18n.js';
import { primaryShortcut } from './shortcuts.js';

interface Highlight { icon: string; title: () => string; text: () => string }
interface Release { lead: () => string; highlights: Highlight[] }

const RELEASES: Readonly<Record<string, Release>> = {
  '2.1.31': {
    lead: () => t('GPT-6 support, a timeline that reads like ChatGPT, and a clearer view of your sub-agents.'),
    highlights: [
      { icon: 'i-sparkle', title: () => t('Ready for GPT-6'), text: () => t('Pick GPT-6, GPT-5.6 or GPT-5.5 with Instant, Medium or High. Goal, Loop and Compact & Resume work on GPT-6.') },
      { icon: 'i-steps', title: () => t('A timeline in rounds'), text: () => t("Each turn reads in rounds like ChatGPT's own, with the model's notes between steps, a live status line and formulas.") },
      { icon: 'i-agents', title: () => t('A clearer sub-agent list'), text: () => t('Each worker is named for its job and shows its task, its state and its model.') },
      { icon: 'i-lock', title: () => t('Setup asks what ChatGPT may do'), text: () => t('The same permission switches as in Workspace, and Setup tells you when access is limited.') },
      { icon: 'i-panel-right', title: () => t('Panels in the title bar'), text: () => t('The panel buttons moved to the title bar, and the right panel now runs the full height of the window.') }
    ]
  },
  '2.1.30': {
    lead: () => t('See what changed after each update, and long runs that stop and recover more calmly.'),
    highlights: [
      { icon: 'i-sparkle', title: () => t("What's new, after every update"), text: () => t('A short summary like this one shows once after each update, with a link to the full notes.') },
      { icon: 'i-retry', title: () => t('Clear stops for stuck messages'), text: () => t('If ChatGPT never picks up a queued message, the app tries three times, then tells you and keeps it queued.') },
      { icon: 'i-agents', title: () => t('Steadier sub-agents'), text: () => t('New worker tabs get more time on slow connections, and a worker no longer gets stuck behind its own unsent message.') },
      { icon: 'i-gear', title: () => t('Your settings stay put'), text: () => t("A settings file the app can't read no longer resets everything: the app reads it anyway or keeps a copy.") },
      { icon: 'i-loop', title: () => t('Recovery stays on'), text: () => t("When the app reuses a quiet chat's tab for a new chat, that chat keeps its automatic recovery.") }
    ]
  },
  '2.1.29': {
    lead: () => t('Pin your chats, search from anywhere, and know when ChatGPT is waiting for you.'),
    highlights: [
      { icon: 'i-pin', title: () => t('Pin chats'), text: () => t('Keep the chats you use most at the top of the sidebar.') },
      { icon: 'i-more', title: () => t('One menu for every chat'), text: () => t("Pin, rename, open or copy a chat's link from its ⋯ menu.") },
      { icon: 'i-search', title: () => t('Search from anywhere'), text: () => t('{0} finds any chat and opens it at the message that matched.', [primaryShortcut('K')]) },
      { icon: 'i-gear', title: () => t('Search your settings'), text: () => t('Type in Settings to find any setting on any page.') },
      { icon: 'i-lock', title: () => t('Know when ChatGPT is waiting'), text: () => t('When ChatGPT asks you to allow a tool, the chat tells you instead of standing still.') },
      { icon: 'i-plug', title: () => t('One connection control'), text: () => t('A small capsule in the sidebar shows the connection and tells you if it drops.') }
    ]
  }
};

export function hasHighlights(version: string): boolean {
  return Object.hasOwn(RELEASES, version);
}

/** Paints the dialog for one version; separate from showing it so a check can paint any entry. */
export function paintWhatsNew(version: string): boolean {
  const release = RELEASES[version];
  if (!release) return false;
  ui($('whatsNewVersion'), 'textContent', () => t('Version {0}', [version]));
  ui($('whatsNewLead'), 'textContent', release.lead);
  $('whatsNewList').replaceChildren(...release.highlights.map((item, index) => {
    const row = el('li', 'whats-new-item');
    // The rows arrive one after another, after the card and its tile.
    row.style.setProperty('--i', String(index));
    const badge = el('span', 'whats-new-icon');
    badge.append(icon(item.icon));
    const words = el('div', 'whats-new-words');
    words.append(el('b', '', item.title), el('span', '', item.text));
    row.append(badge, words);
    return row;
  }));
  $<HTMLButtonElement>('whatsNewNotes').dataset.version = version;
  return true;
}

/**
 * Centred in a window of odd width or height, the dialog starts half a pixel off the pixel grid
 * and every icon in it blurs and drifts by that half pixel. Its own size is whole pixels, so
 * whole-pixel margins keep it centred within half a pixel and crisp. Margins, not a transform:
 * a fractional transform rasterises the glyphs off the grid all the same.
 */
function snapToPixels(dialog: HTMLDialogElement): void {
  if (!dialog.open) return;
  const x = (window.innerWidth - dialog.offsetWidth) / 2;
  const y = (window.innerHeight - dialog.offsetHeight) / 2;
  dialog.style.margin = x < 0 || y < 0 ? '' : `${Math.floor(y)}px ${Math.ceil(x)}px ${Math.ceil(y)}px ${Math.floor(x)}px`;
}

let wired = false;
function wire(dialog: HTMLDialogElement): void {
  if (wired) return;
  wired = true;
  window.addEventListener('resize', () => snapToPixels(dialog));
  const close = (): void => {
    if (!dialog.open || dialog.classList.contains('is-closing')) return;
    dialog.classList.add('is-closing');
    const done = (): void => { dialog.classList.remove('is-closing'); if (dialog.open) dialog.close(); };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) done();
    else { dialog.addEventListener('animationend', done, { once: true }); window.setTimeout(done, 280); }
  };
  $('whatsNewDone').addEventListener('click', close);
  $('whatsNewNotes').addEventListener('click', () => {
    const version = $<HTMLButtonElement>('whatsNewNotes').dataset.version;
    if (version) void run(window.api.openLink(releaseNotesUrl(version), { external: true }));
  });
  // Escape and a click on the backdrop dismiss it like the button does, with the same motion.
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
}

/**
 * Decides once per start: shows the dialog after a real update to a version with highlights and
 * records the version once it has been shown, so it never shows twice; any other version change is
 * recorded at once. A fresh install has already recorded
 * its version in the main process, before anything here runs.
 */
export function initWhatsNew(current: string | null, lastSeen: string | undefined): void {
  if (!current) return;
  const action = whatsNewAction(current, lastSeen, hasHighlights);
  if (action === 'none') return;
  if (action !== 'show' || !paintWhatsNew(current)) { void run(window.api.markWhatsNewSeen()); return; }
  const dialog = $<HTMLDialogElement>('whatsNewDialog');
  wire(dialog);
  // After the window has painted its first state, so the dialog opens over a settled app. Another
  // open dialog wins; the version is recorded only once this one has really been shown.
  window.setTimeout(() => {
    if (dialog.open || document.querySelector('dialog[open]')) return;
    dialog.showModal();
    snapToPixels(dialog);
    // Enter answers it at once; the focus ring appears only once the keyboard is used.
    $('whatsNewDone').focus({ focusVisible: false } as FocusOptions);
    void run(window.api.markWhatsNewSeen());
  }, 600);
}
