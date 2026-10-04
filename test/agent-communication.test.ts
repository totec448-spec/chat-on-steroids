import { expect, it } from 'vitest';
import type { SessionEvent, SessionSummary } from '../src/shared/session.js';
import { communicationTitle, foldAgentCommunication, participatingWorkers } from '../src/renderer/agent-communication.js';

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

it('links recorded participation only to a unique worker in the selected family', () => {
  const worker = { id: 'local-worker', origin: { agentId: 'worker-1' } } as SessionSummary;
  expect(participatingWorkers(message(), [worker])).toEqual([worker]);
  expect(participatingWorkers(call, [worker])).toEqual([worker]);
  expect(participatingWorkers(message({ to: 'worker-2' }), [worker])).toEqual([]);
  expect(participatingWorkers(message(), [worker, { ...worker, id: 'older-incarnation' }])).toEqual([]);
  const tool = call as Extract<SessionEvent, { kind: 'tool_call' }>;
  for (const args of [{ action: 'status' }, { action: 'message', to: 'worker-1', target_run_id: 'foreign-family' }]) {
    expect(participatingWorkers({ ...tool, call: { ...tool.call, args: text(JSON.stringify(args)) } }, [worker])).toEqual([]);
  }
  expect(participatingWorkers({ ...tool, call: { ...tool.call, outcome: 'tool_rejected' } }, [worker])).toEqual([]);
  expect(participatingWorkers({ ...tool, call: { ...tool.call, args: { ...tool.call.args, truncated: true } } }, [worker])).toEqual([]);
});

it('uses a complete structured spawn receipt and never infers accepted workers from prose', () => {
  const worker = { id: 'local-worker', origin: { agentId: 'worker-1' } } as SessionSummary;
  const tool = call as Extract<SessionEvent, { kind: 'tool_call' }>;
  const spawn = { ...tool, call: { ...tool.call, args: text('{"action":"spawn"}'),
    result: text(JSON.stringify({ structuredContent: { action: 'spawn', workers: [{ id: 'worker-1' }] } })) } };
  expect(participatingWorkers(spawn, [worker])).toEqual([worker]);
  expect(participatingWorkers({ ...spawn, call: { ...spawn.call, result: text('worker-1 (opening)') } }, [worker])).toEqual([]);
  expect(participatingWorkers({ ...spawn, call: { ...spawn.call, result: { ...spawn.call.result, truncated: true } } }, [worker])).toEqual([]);
});
