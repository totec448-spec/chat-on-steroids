/**
 * ChatGPT's own outline of one turn's work, in its order (extension/fiber.js `shellTurnTrace`).
 *
 * ChatGPT draws a turn as rounds: what the model says before a step, the step's calls, and a
 * one-line recap that closes the round ("Created the test files"). In a new chat's first turn
 * none of those sentences or recaps reach a message ChatGPT publishes, so this outline is the only
 * record of them. The timeline builds its rounds from it.
 *
 * It is presentation, kept beside the event log rather than in it: it is never a message, never a
 * call, never work or completion evidence. A `call` names ChatGPT's own call id, which no recorded
 * call carries. The timeline aligns this app's recorded calls with the outline's by tool and order,
 * and by `at` (when the page first showed the call, recorded only while the turn ran live) against
 * each call's start. ChatGPT can show a call that never reached this app, so not every item has a
 * recorded call. An `exec` is ChatGPT's code mode, one item for any number of this app's calls.
 */
export type TurnTraceItem =
  | { kind: 'say'; id?: string; text: string; done: boolean }
  | { kind: 'call'; id: string; tool?: string; done: boolean; at?: number }
  | { kind: 'exec'; id: string; done: boolean }
  | { kind: 'recap'; text: string }
  /** The turn's answer, by ChatGPT's message id: it stands after the rounds, never among them. */
  | { kind: 'answer'; id: string }
  /** What ChatGPT says the turn is doing right now (its open thought); present only while the turn runs. */
  | { kind: 'now'; text: string };

export type TurnTrace = TurnTraceItem[];

export const MAX_TRACE_ITEMS = 400;
export const MAX_TRACE_SAY_CHARS = 8000;
export const MAX_TRACE_RECAP_CHARS = 300;
export const MAX_TRACE_TEXT_CHARS = 128 * 1024;

const ID = /^[A-Za-z0-9_:.-]{1,200}$/;
const TOOL = /^[A-Za-z0-9_.-]{1,100}$/;

/** Revalidates an outline that crossed from the page: bounded, typed, unknown items dropped. Null when nothing is left. */
export function turnTrace(value: unknown): TurnTrace | null {
  if (!Array.isArray(value)) return null;
  const out: TurnTrace = [];
  let room = MAX_TRACE_TEXT_CHARS;
  for (const raw of value.slice(0, MAX_TRACE_ITEMS)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === 'string' && ID.test(item.id) ? item.id : undefined;
    if (item.kind === 'say' || item.kind === 'recap' || item.kind === 'now') {
      const limit = item.kind === 'say' ? MAX_TRACE_SAY_CHARS : MAX_TRACE_RECAP_CHARS;
      const text = typeof item.text === 'string' ? item.text.slice(0, limit) : '';
      if (!text.trim() || text.length > room) continue;
      room -= text.length;
      out.push(item.kind === 'say' ? { kind: 'say', ...(id ? { id } : {}), text, done: item.done === true } : { kind: item.kind, text });
    } else if (item.kind === 'answer' && id) {
      out.push({ kind: 'answer', id });
    } else if ((item.kind === 'call' || item.kind === 'exec') && id) {
      const tool = item.kind === 'call' && typeof item.tool === 'string' && TOOL.test(item.tool) ? item.tool : undefined;
      const at = item.kind === 'call' && typeof item.at === 'number' && Number.isFinite(item.at) && item.at > 0 ? Math.round(item.at) : undefined;
      out.push(item.kind === 'call' ? { kind: 'call', id, ...(tool ? { tool } : {}), done: item.done === true, ...(at ? { at } : {}) } : { kind: 'exec', id, done: item.done === true });
    }
  }
  return out.length ? out : null;
}
