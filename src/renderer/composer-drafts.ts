import type { InputAttachment, InputImage } from '../shared/input.js';

/** The composer and main-process admission use the same per-message attachment ceiling. */
export const MAX_COMPOSER_FILES = 20;
export const MAX_COMPOSER_FILE_BYTES = 512 * 1024 * 1024;

function attachmentBytes(file: InputImage | InputAttachment): number {
  if ('size' in file) return file.size;
  const payload = /^data:[^,]+;base64,([A-Za-z0-9+/]*={0,2})$/.exec(file.dataUrl)?.[1];
  if (payload === undefined) return MAX_COMPOSER_FILE_BYTES + 1;
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
}

/** Keep existing files first, then fit as many incoming files as possible without losing overflow. */
export function mergeComposerAttachments(
  existing: readonly (InputImage | InputAttachment)[], incoming: readonly (InputImage | InputAttachment)[]
): { merged: Array<InputImage | InputAttachment>; overflow: Array<InputImage | InputAttachment> } {
  const merged = [...existing];
  const overflow: Array<InputImage | InputAttachment> = [];
  let bytes = merged.reduce((sum, file) => sum + attachmentBytes(file), 0);
  for (const file of incoming) {
    const size = attachmentBytes(file);
    if (merged.length < MAX_COMPOSER_FILES && bytes + size <= MAX_COMPOSER_FILE_BYTES) {
      merged.push(file); bytes += size;
    } else overflow.push(file);
  }
  return { merged, overflow };
}

/** A deleted chat's draft, kept separately when it cannot be folded into New Chat. */
export type RecoveredComposerDraft = {
  sourceTitle: string;
  projectId: string | null;
  sourceDraftKey: string;
  /** Staged files can be reconstructed from their ids while main retains them (24 hours). */
  attachments: InputAttachment[];
  /** InputImage data URLs are window-local and cannot be put safely in local storage. */
  unavailableFileCount: number;
};

const RECOVERED_STORAGE_KEY = 'chat-on-steroids.recovered-composer-drafts';
const MAX_RECOVERED_DRAFTS = 100;
const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function recoveredAttachment(value: unknown): value is InputAttachment {
  if (!value || typeof value !== 'object') return false;
  const file = value as Partial<InputAttachment>;
  return typeof file.id === 'string' && ATTACHMENT_ID.test(file.id) && typeof file.name === 'string' &&
    file.name.length > 0 && file.name.length <= 255 && Number.isSafeInteger(file.size) && file.size! >= 0 &&
    file.size! <= MAX_COMPOSER_FILE_BYTES && typeof file.mimeType === 'string' && file.mimeType.length <= 120 &&
    /^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType);
}

/** Small, bounded metadata store for recovered drafts; staged bytes remain in main's attachment store. */
export function createRecoveredComposerDrafts(host: Window = window) {
  const drafts = new Map<string, RecoveredComposerDraft>();
  try {
    const raw = host.localStorage.getItem(RECOVERED_STORAGE_KEY);
    const saved: unknown = raw && raw.length <= 1_000_000 ? JSON.parse(raw) : [];
    if (Array.isArray(saved)) for (const entry of saved.slice(-MAX_RECOVERED_DRAFTS)) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.key !== 'string' || !row.key.startsWith('recovery:') || row.key.length > 200 ||
          typeof row.sourceTitle !== 'string' || row.sourceTitle.length > 300 ||
          typeof row.sourceDraftKey !== 'string' || row.sourceDraftKey.length > 200 ||
          !(row.projectId === null || (typeof row.projectId === 'string' && row.projectId.length <= 200))) continue;
      const attachments = Array.isArray(row.attachments) ? row.attachments.filter(recoveredAttachment) : [];
      const bytes = attachments.reduce((sum, file) => sum + file.size, 0);
      if (attachments.length > MAX_COMPOSER_FILES || bytes > MAX_COMPOSER_FILE_BYTES) continue;
      const unavailableFileCount = Number.isSafeInteger(row.unavailableFileCount) && (row.unavailableFileCount as number) >= 0
        ? Math.min(MAX_COMPOSER_FILES, row.unavailableFileCount as number) : 0;
      drafts.set(row.key, { sourceTitle: row.sourceTitle, projectId: row.projectId, sourceDraftKey: row.sourceDraftKey, attachments, unavailableFileCount });
    }
  } catch { /* A malformed or unavailable recovery index must not prevent the composer from opening. */ }

  function save(): boolean {
    const saved = [...drafts].slice(-MAX_RECOVERED_DRAFTS).map(([key, draft]) => ({
      key, sourceTitle: draft.sourceTitle, projectId: draft.projectId, sourceDraftKey: draft.sourceDraftKey,
      attachments: draft.attachments.map(({ id, name, size, mimeType }) => ({ id, name, size, mimeType })),
      unavailableFileCount: draft.unavailableFileCount
    }));
    try { host.localStorage.setItem(RECOVERED_STORAGE_KEY, JSON.stringify(saved)); return true; }
    catch { /* The current window still holds the recovered draft if storage is unavailable. */ return false; }
  }

  return {
    get: (key: string): RecoveredComposerDraft | undefined => drafts.get(key),
    has: (key: string): boolean => drafts.has(key),
    entries: (): Array<[string, RecoveredComposerDraft]> => [...drafts.entries()],
    set(key: string, draft: RecoveredComposerDraft): boolean {
      drafts.delete(key); drafts.set(key, draft); return save();
    },
    delete(key: string): void { if (drafts.delete(key)) save(); }
  };
}

/**
 * Unsent composer text, one draft per draft key (a chat's session id, `project:<id>` or `new`).
 * The text is also written to this window's local storage, like the sidebar pins, so a draft
 * survives a restart. Ordinary staged files and a new chat's Goal/Loop choices stay window-local;
 * recovered drafts separately retain staged-file metadata. The saved text copy is bounded.
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
  function persist(requiredKey?: string): boolean {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const kept: Array<[string, string]> = [];
    let chars = 0;
    let requiredKeySaved = requiredKey === undefined || !drafted(drafts.get(requiredKey));
    for (const [key, current] of [...drafts].reverse()) {
      if (kept.length >= MAX_SAVED) break;
      const text = savedText(key, current);
      if (!drafted(text) || key.length > MAX_KEY) { if (key === requiredKey) requiredKeySaved = false; continue; }
      // `["key","text"],` as stored. One draft too long to fit leaves room for the shorter, older ones.
      const stored = JSON.stringify(key).length + JSON.stringify(text).length + 4;
      if (chars + stored > MAX_STORED_CHARS) {
        if (key === requiredKey) requiredKeySaved = false;
        note(`a draft too long for the ${MAX_STORED_CHARS} stored characters stays in this window only.`); continue;
      }
      kept.push([key, text]); chars += stored;
      if (key === requiredKey) requiredKeySaved = true;
    }
    try { host.localStorage.setItem(STORAGE_KEY, JSON.stringify(kept.reverse())); return requiredKeySaved; }
    catch { note('storage is full or unavailable, so drafts stay in this window only.'); return false; }
  }
  function save(): void { void persist(); }
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
    entries: (): Array<[string, string]> => [...drafts.entries()],
    /** Whether the key holds text that is not only whitespace. */
    has: (key: string): boolean => drafted(drafts.get(key)),
    /** Synchronously persist a recovery key before retiring its previous owner. */
    flush(key?: string): boolean { return persist(key); },
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
