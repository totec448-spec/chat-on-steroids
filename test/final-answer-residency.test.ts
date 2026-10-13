import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, createSession, initSessionStore, resetSessionStoreForTests, upsertMessageEvent } from '../src/main/session/store.js';
import { readSessionEvents } from '../src/main/session/read-model.js';
import { residenceOf } from '../src/shared/chronology.js';

// A long GPT-6 turn: ChatGPT opened its answer message early (18:12 in the report), ran about 200
// more calls, and only at the end filled that same message with the final summary. The answer is
// drawn at the end of its turn, but pages were cut by where the message first appeared, so the
// newest page never held it and the chat seemed to stop at its last work heading.

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-final-residency-'));
  initSessionStore(directory);
});
afterEach(async () => {
  resetSessionStoreForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

const text = (value: string) => ({ text: value, chars: value.length, truncated: false });
const TURN = 'g-long-turn-0-1';

async function longTurn() {
  const session = await createSession({ conversationId: 'chat-long', title: 'Long turn' });
  let time = Date.UTC(2026, 9, 13, 18, 10);
  await appendEvent(session.id, { time: time++, source: 'extension', kind: 'turn_start', turnId: TURN });
  await upsertMessageEvent(session.id, { time: time++, source: 'extension', kind: 'assistant_message', messageId: 'answer', turnId: TURN, final: false, message: text('Restoring the fleet first.') });
  for (let index = 0; index < 220; index++) {
    await appendEvent(session.id, { time: time++, source: 'mcp', kind: 'tool_call', turnId: TURN, call: {
      callId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, tool: 'exec_command', requestId: `request-${index}`,
      conversationId: 'chat-long', attribution: 'request_id', attributionMethod: 'request_id',
      args: text('{"cmd":"true"}'), result: text(''), outcome: 'ok', durationMs: 1,
      summary: { kind: 'run', title: `Step ${index}`, tone: 'neutral' }
    } });
  }
  await upsertMessageEvent(session.id, { time: time++, source: 'extension', kind: 'assistant_message', messageId: 'answer', turnId: TURN, final: true,
    message: text('Restoring the fleet first.\n\nDone: 53 devices are back, and the fix is deployed.') });
  await appendEvent(session.id, { time: time++, source: 'extension', kind: 'turn_end', turnId: TURN, outcome: 'completed' });
  return session;
}

it("keeps a long turn's final answer on the newest page, next to the turn's end", async () => {
  const session = await longTurn();
  const page = (await readSessionEvents(session.id, {}))!;
  const answer = page.events.find(event => event.kind === 'assistant_message' && event.messageId === 'answer');
  expect(answer?.kind === 'assistant_message' ? answer.message.text : null).toContain('53 devices are back');
  expect(page.events.some(event => event.kind === 'turn_end')).toBe(true);
});

it('shows the final answer on exactly one page when reading back through history', async () => {
  const session = await longTurn();
  const seen: number[] = [];
  let before: number | undefined;
  for (let pages = 0; pages < 20; pages++) {
    const page = (await readSessionEvents(session.id, { ...(before !== undefined ? { before } : {}), limit: 30 }))!;
    if (!page.events.length) break;
    seen.push(...page.events.filter(event => event.kind === 'assistant_message' && event.messageId === 'answer').map(event => event.seq));
    before = Math.min(...page.events.map(residenceOf));
  }
  expect(seen).toHaveLength(1);
});
