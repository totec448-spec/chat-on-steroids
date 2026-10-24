import type { InputAttachment, InputImage } from '../shared/input.js';
import { el, icon } from './dom.js';
import { currentLanguage, t, ui } from './i18n.js';

/** "1.5 MB" in the reader's own number format and unit names ("1,5 MB" in German). */
function sizeLabel(bytes: number): string {
  const format = (value: number, unit: 'byte' | 'kilobyte' | 'megabyte', digits: number) =>
    new Intl.NumberFormat(currentLanguage(), { style: 'unit', unit, unitDisplay: 'short', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  if (bytes < 1024) return format(bytes, 'byte', 0);
  if (bytes < 1024 * 1024) return format(bytes / 1024, 'kilobyte', bytes < 10 * 1024 ? 1 : 0);
  return format(bytes / (1024 * 1024), 'megabyte', bytes < 10 * 1024 * 1024 ? 1 : 0);
}

/** The files of a batch the draft does not hold yet, by staged id: adding the same file twice (a slow attach racing Recent files) changes nothing. */
export function notInDraft(draft: ReadonlyArray<InputImage | InputAttachment>, chosen: InputAttachment[]): InputAttachment[] {
  const held = new Set(draft.flatMap(file => 'id' in file ? [file.id] : []));
  const fresh: InputAttachment[] = [];
  for (const file of chosen) {
    if (held.has(file.id)) continue;
    held.add(file.id);
    fresh.push(file);
  }
  return fresh;
}

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

export interface AttachmentLibraryOptions {
  menu: HTMLDetailsElement;
  /** The "Recent files" row; it keeps the menu open and expands the list under it. */
  toggle: HTMLButtonElement;
  host: HTMLElement;
  list: () => Promise<Reply<InputAttachment[]>>;
  /** Ids already in the visible draft; the same staged file is not offered twice. */
  attached: () => ReadonlySet<string>;
  /** Called when a row is picked; the caller restages it into the draft it captured. The file stays out of the list until this settles. */
  choose: (attachment: InputAttachment) => void | Promise<unknown>;
}

/**
 * Files attached earlier, from any chat, offered again from the composer's + menu.
 *
 * Only staged originals are listed (main/session/input-attachments.ts owns them and their 24-hour
 * expiry), so a row always names bytes that still exist. Nothing here reads a path.
 */
export function initAttachmentLibrary(options: AttachmentLibraryOptions): void {
  const { menu, toggle, host } = options;
  let generation = 0;
  // Picked, but not yet in the draft: a slow reply must not let the same file be picked again.
  const picking = new Set<string>();
  const collapse = () => { generation++; host.hidden = true; host.replaceChildren(); toggle.setAttribute('aria-expanded', 'false'); };
  const row = (file: InputAttachment): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'attachment-library-item'; button.dataset.attachmentId = file.id; button.title = file.name;
    ui(button, 'aria-label', () => t('Attach {0} again', [file.name]));
    const thumb = el('span', 'attachment-library-thumb');
    if (file.preview) { const image = document.createElement('img'); image.src = file.preview; image.alt = ''; thumb.append(image); }
    else thumb.append(icon('i-file-text'));
    const details = el('span', 'attachment-library-details');
    details.append(el('span', 'attachment-library-name', file.name),
      el('span', 'attachment-library-meta', () => `${file.mimeType.startsWith('image/') ? t('Image') : t('File')} · ${sizeLabel(file.size)}`));
    button.append(thumb, details);
    // The row is about to be removed; focus goes to the menu button, and the caller moves it on once the file is in.
    button.addEventListener('click', () => { collapse(); menu.querySelector('summary')?.focus(); void pick(file); });
    return button;
  };
  const pick = async (file: InputAttachment) => {
    if (picking.has(file.id)) return;
    picking.add(file.id);
    try { await options.choose(file); } finally { picking.delete(file.id); }
  };
  const expand = async () => {
    const mine = ++generation;
    toggle.setAttribute('aria-expanded', 'true');
    host.hidden = false; host.replaceChildren(el('p', 'attachment-library-note', () => t('Loading…')));
    // Beside the menu when the window has room, else above it; either way no menu row moves.
    host.classList.remove('is-above');
    const above = host.getBoundingClientRect().right > window.innerWidth - 8;
    if (above) host.classList.add('is-above');
    // The flyout may not reach past the window edge it grows toward (up, whichever side it opens on); with less room than that the list scrolls.
    const popover = host.parentElement?.getBoundingClientRect();
    const room = popover ? (above ? popover.top - 6 : popover.bottom) - 8 : Infinity;
    host.style.maxHeight = Number.isFinite(room) ? `${Math.max(0, Math.min(320, window.innerHeight * 0.6, room))}px` : '';
    // The main process answers failures as { ok: false }, but the invoke itself can still reject (no handler, a closing window).
    const reply = await options.list().catch((): Reply<InputAttachment[]> => ({ ok: false, error: 'Recent files could not be loaded' }));
    if (mine !== generation) return;
    if (!reply.ok) { host.replaceChildren(el('p', 'attachment-library-note', () => t('Recent files could not be loaded'))); return; }
    const attached = options.attached();
    const files = reply.data.filter(file => !attached.has(file.id) && !picking.has(file.id));
    host.replaceChildren(...(files.length ? files.map(row) : [el('p', 'attachment-library-note', () => t('No files attached in the last 24 hours'))]));
  };
  toggle.setAttribute('aria-expanded', 'false');
  // Escape closes the menu with focus inside the list; it lands on the menu button, not the page.
  host.addEventListener('keydown', event => { if (event.key === 'Escape') menu.querySelector('summary')?.focus(); });
  toggle.addEventListener('click', () => { if (host.hidden) void expand(); else collapse(); });
  menu.addEventListener('toggle', () => { if (!menu.open) collapse(); });
}
