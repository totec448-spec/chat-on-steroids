import type { SessionSummary } from '../shared/session.js';
import { providerEntitiesAsMarkdown } from '../shared/content-reference.js';

/**
 * A notification when a chat finishes a turn while the window is in the background, like Codex's
 * turn-completion notifications. Before, only Session finish and stuck chats notified, so a
 * finished answer went unnoticed until someone looked.
 *
 * Workers report to their prime chat, and Goal/Loop chats continue by themselves (their end has its
 * own Session-finish notice), so neither notifies here. A turn the user stopped or that failed
 * does not either: the chat itself says so.
 */

const FALLBACK = 'ChatGPT finished.';
const MAX_BODY = 140;

/** The start of the answer as plain text, short enough for a notification. */
export function noticeText(answer: string | null): string {
  const plain = providerEntitiesAsMarkdown(answer ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~>#]/g, '')
    .split(/\n\s*\n/).map(part => part.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  if (!plain) return FALLBACK;
  return plain.length <= MAX_BODY ? plain : `${plain.slice(0, MAX_BODY - 1).trimEnd()}…`;
}

export interface TurnNotifierDeps {
  getSession(id: string): Promise<SessionSummary | null>;
  lastAnswer(sessionId: string): Promise<string | null>;
  enabled(): boolean;
  focused(): boolean;
  automated(conversationId: string): boolean;
  /** Another notice (Session finish) already told the user about this chat just now. */
  recentlyNotified(sessionId: string): boolean;
  show(title: string, body: string, sessionId: string): void;
}

export function createTurnNotifier(deps: TurnNotifierDeps) {
  // The newest turn end seen per chat. Seeded at startup so old turns never notify.
  const seen = new Map<string, number>();
  return {
    seed(sessions: readonly SessionSummary[]): void {
      for (const session of sessions) seen.set(session.id, session.lastTurnEndAt ?? 0);
    },
    async handle(sessionIds: readonly string[]): Promise<void> {
      for (const id of sessionIds) {
        const session = await deps.getSession(id).catch(() => null);
        if (!session) continue;
        const end = session.lastTurnEndAt ?? 0;
        const previous = seen.get(id);
        seen.set(id, Math.max(end, previous ?? 0));
        // A chat first seen now was created after startup; its first end is still news.
        if (end <= (previous ?? 0) || !end) continue;
        if (!deps.enabled() || deps.focused()) continue;
        if (session.lastTurnOutcome !== 'completed' || session.activeTurnId) continue;
        if (session.origin?.kind === 'worker' || session.origin?.kind === 'helper') continue;
        if (session.conversationId && deps.automated(session.conversationId)) continue;
        if (deps.recentlyNotified(id)) continue;
        deps.show(session.title || 'Chat On Steroids', noticeText(await deps.lastAnswer(id).catch(() => null)), id);
      }
    }
  };
}
