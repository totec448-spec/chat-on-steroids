import { appendEvent, getSession } from '../src/main/session/store.js';

/** Actual local-call shape for tests whose subject is the downstream Loop backend. */
export async function recordLoopMcpProof(sessionId: string, turnId = 'backend-turn'): Promise<void> {
  const session = await getSession(sessionId);
  await appendEvent(sessionId, { source: 'extension', kind: 'turn_start', time: Date.now(), turnId });
  await appendEvent(sessionId, { source: 'mcp', kind: 'tool_call', time: Date.now(), turnId, call: {
    callId: 'loop-proof', tool: 'read', attribution: 'request_id', requestId: 'loop-proof-request', conversationId: session!.conversationId,
    attributionMethod: 'request_id', outcome: 'ok', durationMs: 1,
    args: { text: '{}', chars: 2, truncated: false }, result: { text: 'ok', chars: 2, truncated: false },
    summary: { kind: 'read', tone: 'neutral', title: 'Read' }
  } });
}
