import { expect, it } from 'vitest';
import { workerActivity } from '../src/renderer/agent-activity.js';
import type { SessionEvent, ToolCallRecord } from '../src/shared/session.js';

let seq = 0;
const call = (callId: string, over: Partial<ToolCallRecord> = {}, origin?: number): SessionEvent => ({
  seq: ++seq, time: 1_000 * seq, source: 'app', kind: 'tool_call', ...(origin ? { origin } : {}),
  call: {
    callId, tool: 'apply_patch', attribution: 'model', requestId: null, conversationId: 'c', attributionMethod: 'request_id',
    args: { text: '{}' }, result: { text: 'ok' }, outcome: 'ok', durationMs: 5,
    summary: { title: `Call ${callId}`, tone: 'neutral', kind: 'edit' }, ...over
  } as ToolCallRecord
}) as SessionEvent;
const start = (): SessionEvent => ({ seq: ++seq, time: 0, source: 'app', kind: 'session_start', conversationId: null, title: 'w' }) as SessionEvent;

it('lists each call once, at its first place, with its latest record', () => {
  seq = 0;
  const first = call('a', { tool: 'exec_command', summary: { title: 'Ran npm test', tone: 'neutral', kind: 'run', metric: 'running' } });
  const events = [start(), first, call('b', { summary: { title: 'Read a.ts', tone: 'neutral', kind: 'read' } }),
    call('a', { tool: 'exec_command', outcome: 'process_exit_nonzero', summary: { title: 'Ran npm test', tone: 'bad', kind: 'run', metric: '✕ exit 1' } }, first.seq)];
  const { actions, partial } = workerActivity(events);
  expect(actions.map(action => [action.callId, action.summary.metric, action.failed, action.time])).toEqual([
    ['a', '✕ exit 1', true, first.time], ['b', undefined, false, 3_000]
  ]);
  expect(partial).toBe(false);
});

it('leaves internal code-mode calls out and says when the history is only a window', () => {
  seq = 0;
  const { actions, partial } = workerActivity([call('a'), call('nested', { nested: true })]);
  expect(actions.map(action => action.callId)).toEqual(['a']);
  expect(partial).toBe(true);
  expect(workerActivity([]).partial).toBe(false);
});

it('sums the changes per file from successful calls, and a created file stays created', () => {
  seq = 0;
  const events = [start(),
    call('c', { summary: { title: 'Created x.ts', tone: 'good', kind: 'create' }, changes: [{ path: 'src/x.ts', added: 10, removed: 0, approximate: false }] }),
    call('e', { changes: [{ path: 'src/x.ts', added: 2, removed: 1, approximate: true }, { path: 'README.md', added: 1, removed: 1, approximate: false }] }),
    call('f', { outcome: 'tool_execution_error', changes: [{ path: 'src/y.ts', added: 5, removed: 0, approximate: false }] }),
    call('d', { summary: { title: 'Deleted old.ts', tone: 'neutral', kind: 'delete' }, changes: [{ path: 'old.ts', added: 0, removed: 7, approximate: false }] })];
  expect(workerActivity(events).files).toEqual([
    { path: 'src/x.ts', added: 12, removed: 1, approximate: true, kind: 'create' },
    { path: 'README.md', added: 1, removed: 1, approximate: false, kind: 'edit' },
    { path: 'old.ts', added: 0, removed: 7, approximate: false, kind: 'delete' }
  ]);
});
