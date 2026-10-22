/**
 * Terminal tabs kept across a restart: a bounded localStorage list per dock of the shells that were
 * open, shown again as inert "previous session" tabs. No shell or output survives; a tab keeps only
 * its project (null for the home folder), its title and the folder it showed. A restarted shell
 * sends the project id alone, so main still chooses the cwd.
 */
const STORAGE_KEY = 'chat-on-steroids.terminal-tabs.';
const MAX_TABS = 8;

export type RememberedTerminal = { projectId: string | null; title: string; cwd: string };

const valid = (value: unknown): value is RememberedTerminal => {
  if (!value || typeof value !== 'object') return false;
  const { projectId, title, cwd } = value as Record<string, unknown>;
  return (projectId === null || (typeof projectId === 'string' && projectId.length > 0 && projectId.length <= 64))
    && typeof title === 'string' && title.length > 0 && title.length <= 200
    && typeof cwd === 'string' && cwd.length <= 4096;
};

export function rememberedTerminals(dock: string): RememberedTerminal[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY + dock);
    const saved: unknown = raw && raw.length <= 100_000 ? JSON.parse(raw) : [];
    if (!Array.isArray(saved)) return [];
    return saved.filter(valid).slice(0, MAX_TABS)
      .map(({ projectId, title, cwd }) => ({ projectId, title, cwd }));
  } catch { return []; /* Unavailable or corrupt storage starts with no tabs, as before. */ }
}

export function rememberTerminals(dock: string, tabs: readonly RememberedTerminal[]): void {
  try {
    const kept = tabs.filter(valid).slice(0, MAX_TABS);
    if (kept.length) window.localStorage.setItem(STORAGE_KEY + dock, JSON.stringify(kept));
    else window.localStorage.removeItem(STORAGE_KEY + dock);
  } catch { /* The tabs still work in this window; only the next launch forgets them. */ }
}
