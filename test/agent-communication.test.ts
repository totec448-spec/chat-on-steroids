import { expect, it } from 'vitest';
import type { SessionEvent } from '../src/shared/session.js';
import { communicationTitle, foldAgentCommunication } from '../src/renderer/agent-communication.js';

const text = (value: string) => ({ text: value, chars: value.length, truncated: false });
const message = (overrides = {}): SessionEvent => ({ kind: 'agent_message', source: 'app', seq: 2, time: 112,
  agent: 'prime', messageId: 'msg-1', from: 'prime', to: 'worker-1', delivery: 'sent', message: text('Refine the room'), ...overrides });
const call = { kind: 'tool_call', source: 'mcp', seq: 3, time: 100, agent: 'prime', call: {
  tool: 'agents', outcome: 'ok', durationMs: 16, args: text(JSON.stringify({ action: 'message', to: 'worker-1', text: 'Refine the room' }))
} } as SessionEvent;

it('shows the exact outgoing communication once while retaining the complete tool result', () => {
  expect(foldAgentCommunication([message(), call])).toEqual([call]);
  expect(foldAgentCommunication([message()])).toHaveLength(1);
});
it('preserves incoming, repeated, ambiguous and unrelated communication', () => {
  for (const row of [message({ delivery: 'delivered' }), message({ time: 200 }), message({ to: 'worker-2' }), message({ from: 'worker-1' })]) {
    expect(foldAgentCommunication([row, call])).toEqual([row, call]);
  }
  expect(foldAgentCommunication([message(), message({ messageId: 'msg-2' }), call])).toHaveLength(3);
  expect(foldAgentCommunication([message(), call, { ...call, seq: 4 }])).toHaveLength(3);
});
it('distinguishes worker status, messages and final reports', () => {
  const title = (value: string) => communicationTitle(message({ from: 'worker-1', to: 'prime', message: text(value) }) as Extract<SessionEvent, { kind: 'agent_message' }>);
  expect(title('[worker-1 is awake again] It resumed')).toBe('worker-1 resumed work');
  expect(title('[worker-1 reported] RESULT: Done')).toBe('worker-1 finished · report');
  expect(title('The room is ready for review')).toBe('Message from worker-1');
});
