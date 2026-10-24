import type { SessionSummary } from '../shared/session.js';
import { providerEntitiesAsMarkdown } from '../shared/content-reference.js';
import { markdownVisibleText } from '../shared/markdown-text.js';
import { mainText } from './main-texts.js';

/**
 * A notification when a chat finishes a turn while the window is in the background, like Codex's
 * turn-completion notifications. Before, only Session finish and stuck chats notified, so a
 * finished answer went unnoticed until someone looked.
 *
 * Workers report to their prime chat, and Goal/Loop chats continue by themselves (their end has its
 * own Session-finish notice), so neither notifies here. A turn the user stopped or that failed
 * does not either: the chat itself says so.
 */

const MAX_BODY = 140;

/**
 * The start of the answer as plain text, short enough for a notification: drawn as the chat draws
 * it, so underscores, "#1590" and "a > b" in the words stay (stripping those characters everywhere
 * turned "goal_r40.txt" into "goalr40.txt"). Code blocks are skipped; the first paragraph is shown.
 */
export function noticeText(answer: string | null): string {
  const plain = markdownVisibleText(providerEntitiesAsMarkdown(answer ?? ''), { codeBlocks: false })
    .split(/\n\s*\n/).map(part => part.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  if (!plain) return mainText('ChatGPT finished.');
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
  /** When the turn that just ended started, if the history knows. */
  turnStartedAt?(sessionId: string): Promise<number | null>;
  /** The same finished chat for the phone, which keeps its own rules (away, quiet hours, length). */
  phone?(event: { sessionId: string; chatTitle: string; conversationId: string | null; workedMs?: number; detail: string }): void;
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
        if (session.lastTurnOutcome !== 'completed' || session.activeTurnId) continue;
        if (session.origin?.kind === 'worker' || session.origin?.kind === 'helper') continue;
        if (session.conversationId && deps.automated(session.conversationId)) continue;
        const desktop = deps.enabled() && !deps.focused() && !deps.recentlyNotified(id);
        if (!desktop && !deps.phone) continue;
        const body = noticeText(await deps.lastAnswer(id).catch(() => null));
        if (deps.phone) {
          const started = await deps.turnStartedAt?.(id).catch(() => null) ?? null;
          deps.phone({ sessionId: id, chatTitle: session.title || 'Chat On Steroids', conversationId: session.conversationId ?? null,
            ...(started !== null && started <= end ? { workedMs: end - started } : {}), detail: body });
        }
        if (desktop) deps.show(session.title || 'Chat On Steroids', body, id);
      }
    }
  };
}
