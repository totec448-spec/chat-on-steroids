/**
 * Unsent composer text, one draft per draft key (a chat's session id, `project:<id>` or `new`).
 * The text is also written to this window's local storage, like the sidebar pins, so a draft
 * survives a restart. Only text is kept there: staged files and a new chat's Goal/Loop choices
 * stay window-local. The saved copy is bounded; the newest drafts win.
 */
const STORAGE_KEY = 'chat-on-steroids.composer-drafts';
const MAX_SAVED = 100;
// Counted as stored: JSON escaping can make one typed character six.
const MAX_STORED_CHARS = 1_000_000;
const MAX_KEY = 200;
const SAVE_DELAY_MS = 400;

const drafted = (text: string | undefined): boolean => !!text?.trim();

export type ComposerDraftOptions = {
  /** Hears when a key starts or stops holding a draft, so its sidebar row can repaint. */
  onDraftedChange?: (key: string) => void;
  /** The text a restart gives back for a key, when that is not what the composer holds now. */
  savedText?: (key: string, text: string) => string;
};

export function createComposerDrafts({ onDraftedChange = () => {}, savedText = (_key, text) => text }: ComposerDraftOptions = {}) {
  // Insertion order is recency: a written draft moves to the end.
  const drafts = new Map<string, string>();
  // A late save writes to the window that made it, never to one created after it closed.
  const host = window;
  // The app log takes only renderer errors. A draft a restart will not give back counts as one:
  // logged once per window and reason, with no draft text.
  const noted = new Set<string>();
  const note = (why: string): void => {
    if (!noted.has(why)) { noted.add(why); console.error(`Composer drafts: ${why}`); }
  };
  try {
    const raw = host.localStorage.getItem(STORAGE_KEY);
    const saved: unknown = !raw ? [] : raw.length <= MAX_STORED_CHARS + 2 ? JSON.parse(raw) : null;
    if (!Array.isArray(saved)) note('the saved drafts were not a list, so none came back.');
    else {
      for (const entry of saved.slice(-MAX_SAVED)) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [key, text] = entry as unknown[];
        if (typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY && typeof text === 'string' && drafted(text)) drafts.set(key, text);
      }
    }
  } catch { note('the saved drafts could not be read, so none came back.'); /* Writing a message still works. */ }

  let timer: ReturnType<typeof setTimeout> | undefined;
  function save(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const kept: Array<[string, string]> = [];
    let chars = 0;
    for (const [key, current] of [...drafts].reverse()) {
      if (kept.length >= MAX_SAVED) break;
      const text = savedText(key, current);
      if (!drafted(text) || key.length > MAX_KEY) continue;
      // `["key","text"],` as stored. One draft too long to fit leaves room for the shorter, older ones.
      const stored = JSON.stringify(key).length + JSON.stringify(text).length + 4;
      if (chars + stored > MAX_STORED_CHARS) { note(`a draft too long for the ${MAX_STORED_CHARS} stored characters stays in this window only.`); continue; }
      kept.push([key, text]); chars += stored;
    }
    try { host.localStorage.setItem(STORAGE_KEY, JSON.stringify(kept.reverse())); }
    catch { note('storage is full or unavailable, so drafts stay in this window only.'); }
  }
  function schedule(): void { if (timer === undefined) timer = setTimeout(save, SAVE_DELAY_MS); }
  // A quit or reload writes the newest keystrokes the delay would otherwise lose.
  host.addEventListener('pagehide', save);
  host.addEventListener('beforeunload', save);

  function changed(key: string, before: string | undefined, after: string | undefined): void {
    schedule();
    if (drafted(before) !== drafted(after)) onDraftedChange(key);
  }
  return {
    get: (key: string): string | undefined => drafts.get(key),
    /** Whether the key holds text that is not only whitespace. */
    has: (key: string): boolean => drafted(drafts.get(key)),
    set(key: string, text: string): void {
      const before = drafts.get(key);
      if (before === text) return;
      drafts.delete(key); drafts.set(key, text);
      changed(key, before, text);
    },
    delete(key: string): void {
      const before = drafts.get(key);
      if (!drafts.delete(key)) return;
      changed(key, before, undefined);
    }
  };
}
