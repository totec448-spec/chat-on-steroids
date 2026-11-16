import { isExternalMcpSession, isUnattributedSession, type SessionSummary } from '../shared/session.js';
import { isGeminiConversationId } from '../shared/provider.js';
import { sessionWorkingAt } from '../shared/session-activity.js';
import type { AppState } from '../shared/types.js';

export type SidebarClientFilter = 'all' | 'chatgpt' | 'gemini';
export type SessionClientKind = 'chatgpt' | 'gemini' | 'other-external' | 'unattributed';

export const SIDEBAR_CLIENT_STORAGE_KEY = 'cos.sidebar.clientFilter';

type SessionIdentitySlice = Pick<SessionSummary, 'conversationId' | 'origin' | 'mcpClient' | 'title'>;

/** Normalizes any stored or external filter value onto one supported sidebar client tab. */
export function normalizeSidebarClientFilter(value: unknown): SidebarClientFilter {
  return value === 'chatgpt' || value === 'gemini' ? value : 'all';
}

function tryLocalStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Loads the window's last chosen sidebar client filter, defaulting safely to 'all'. */
export function loadSidebarClientFilter(storage: Storage | null = tryLocalStorage()): SidebarClientFilter {
  if (!storage) return 'all';
  try {
    return normalizeSidebarClientFilter(storage.getItem(SIDEBAR_CLIENT_STORAGE_KEY));
  } catch {
    return 'all';
  }
}

/** Saves the sidebar client filter preference best-effort without failing restricted sandboxes. */
export function saveSidebarClientFilter(filter: SidebarClientFilter, storage: Storage | null = tryLocalStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(SIDEBAR_CLIENT_STORAGE_KEY, normalizeSidebarClientFilter(filter));
  } catch {
    /* Persistence is optional; in-memory switching still works. */
  }
}

/** Classifies a session row under its AI provider, inheriting external parent provenance for workers. */
export function sessionClientKind(
  entry: SessionIdentitySlice,
  parentsById?: ReadonlyMap<string, SessionIdentitySlice>
): SessionClientKind {
  if (isUnattributedSession(entry)) return 'unattributed';
  if (isGeminiConversationId(entry.conversationId) || entry.mcpClient?.id === 'gemini') {
    return 'gemini';
  }
  if (entry.origin?.kind === 'worker') {
    const parent = entry.origin.fromSessionId ? parentsById?.get(entry.origin.fromSessionId) : undefined;
    if (parent && (isGeminiConversationId(parent.conversationId) || parent.mcpClient?.id === 'gemini')) {
      return 'gemini';
    }
    if (parent && isExternalMcpSession(parent)) {
      return 'other-external';
    }
    return 'chatgpt';
  }
  if (isExternalMcpSession(entry)) {
    return 'other-external';
  }
  return 'chatgpt';
}

/** Returns true when a session belongs in the selected sidebar client tab. */
export function matchesSidebarClientFilter(
  entry: SessionIdentitySlice,
  filter: SidebarClientFilter,
  parentsById?: ReadonlyMap<string, SessionIdentitySlice>
): boolean {
  if (filter === 'all') return true;
  const kind = sessionClientKind(entry, parentsById);
  if (filter === 'gemini') return kind === 'gemini';
  return kind === 'chatgpt';
}

/** Summarizes whether Gemini currently has an active bridge, live MCP presence, or working session dot. */
export function geminiSidebarPresence(
  state: AppState | null | undefined,
  sessions: readonly SessionSummary[],
  now = Date.now()
): { live: boolean; working: boolean } {
  const working = sessions.some(
    (entry) => sessionClientKind(entry) === 'gemini' && sessionWorkingAt(entry, now)
  );
  const live =
    working ||
    state?.status?.geminiBridge?.state === 'live' ||
    Boolean(state?.status?.externalClients?.some((client) => client.id === 'gemini'));
  return { live, working };
}
