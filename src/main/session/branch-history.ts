import { appendEvent, getSession, readEvents, readOverflowText, upsertMessageEvent, writeOverflowText } from './store.js';
import { positionOf } from '../../shared/chronology.js';
import type { SessionEvent, StoredText } from '../../shared/session.js';

type Copied = Extract<SessionEvent, { kind: 'user_message' | 'assistant_message' | 'page_tool' }>;

/**
 * Branch in new chat (#482): gives a new branch chat the history ChatGPT copied into it.
 *
 * ChatGPT's branch holds the source chat's messages up to the reply it was made from, and the
 * page reports them once the branch has its own id. The first question is recorded at Send,
 * before that, so it was drawn above the history it continues. This writes that history from
 * the source chat's own recording first, under the same native ids: the page's later report of
 * the same messages and steps then revises these rows in place. Runs once, when the reserved
 * chat binds to its new conversation; nothing is copied for any other chat.
 */
export async function seedBranchHistory(sessionId: string, conversationId: string): Promise<number> {
  const session = await getSession(sessionId);
  const branch = session?.origin?.branchOf;
  const sourceId = session?.origin?.fromSessionId;
  if (!session || !branch || !sourceId || session.conversationId !== conversationId) return 0;
  const kinds: Array<Copied['kind']> = ['user_message', 'assistant_message', 'page_tool'];
  const own = await readEvents(sessionId, { kinds });
  if (own.length) return 0;
  // A source that went through Compact & Resume also holds the chat it left; ChatGPT's branch
  // holds only the chat it was made from, which began when the session last left a chat.
  const sourceSummary = await getSession(sourceId);
  const since = Math.max(0, ...Object.values(sourceSummary?.retiredChatAt ?? {}));
  const source = (await readEvents(sourceId, { kinds }).catch(() => []) as Copied[]).filter(event => event.time >= since);
  const reply = source.filter(event => event.kind === 'assistant_message' && event.messageId === branch.messageId);
  if (!reply.length) return 0;
  // The history up to the reply is everything that first appeared before the source chat's next
  // question, each message in its latest revision: a step row or a question revision can be
  // recorded after the reply's final revision and still belong before it (measured live).
  const first = new Map<string, number>();
  const latest = new Map<string, Copied>();
  for (const event of source) {
    if (!event.messageId) continue;
    const key = `${event.kind}\u0000${event.messageId}`;
    first.set(key, Math.min(first.get(key) ?? Infinity, positionOf(event)));
    if ((latest.get(key)?.seq ?? -1) < event.seq) latest.set(key, event);
  }
  const replyAt = first.get(`assistant_message\u0000${branch.messageId}`)!;
  const nextQuestion = Math.min(...[...first].filter(([key, at]) => key.startsWith('user_message\u0000') && at > replyAt).map(([, at]) => at));
  // Written in the order the source draws each exchange: its question, then its steps and interim
  // text, then its final answer, as a turn shows them. The copies carry no turn, and ChatGPT opens
  // the answer first while a later page scan can record steps after it (measured live).
  const kept = [...latest.entries()].filter(([key]) => first.get(key)! < nextQuestion);
  const questions = kept.filter(([key]) => key.startsWith('user_message\u0000')).map(([key]) => first.get(key)!).sort((a, b) => a - b);
  const exchange = (at: number) => questions.filter(question => question <= at).length;
  const rank = (event: Copied) => event.kind === 'user_message' ? 0
    : event.kind === 'assistant_message' && (event.final || event.state === 'final') ? 2 : 1;
  const ordered = kept.map(([key, event]) => ({ event, at: first.get(key)! }))
    .sort((a, b) => exchange(a.at) - exchange(b.at) || rank(a.event) - rank(b.event) || a.at - b.at)
    .map(({ event }) => event);
  let copied = 0;
  for (const event of ordered) {
    if (event.kind === 'page_tool') {
      await appendEvent(sessionId, { time: event.time, source: 'extension', kind: 'page_tool', messageId: event.messageId, label: event.label });
    } else {
      // Not part of any turn here, as the page reports copied history; app delivery details stay with the source.
      const { seq: _seq, origin: _origin, turnId: _turn, turnOrigin: _turnOrigin, agent: _agent, inputId: _input, inputDelivery: _delivery,
        attachments: _attachments, assets: _assets, ...rest } = event as Copied & Record<string, unknown>;
      await upsertMessageEvent(sessionId, { ...rest, source: 'extension', message: await copyText(sourceId, sessionId, event.message) } as Parameters<typeof upsertMessageEvent>[1]);
    }
    copied++;
  }
  return copied;
}

/** A long message keeps its full text: the overflow lives with each chat, so it is copied too. */
async function copyText(from: string, to: string, stored: StoredText): Promise<StoredText> {
  if (!stored.truncated || !stored.assetId) return stored;
  const full = await readOverflowText(from, stored.assetId);
  const assetId = full === null ? null : await writeOverflowText(to, full);
  if (!assetId) {
    const { assetId: _gone, ...inline } = stored;
    return inline;
  }
  return { ...stored, assetId, text: stored.text.split(stored.assetId).join(assetId) };
}
