import { logInfo } from '../logger.js';

/**
 * #1752 diagnostics. A connector call can carry a request id that no page reported as its turn's
 * own, and is then filed under Unattributed activity. The extension also reports where a chat's
 * response stream named ids in fields attribution does not trust (the field's path, never its
 * content). Matching the two puts in the log where ChatGPT carried the id, which is what a fix
 * needs. Never used to attribute a call.
 */
export interface RequestTrace { requestId: string; path: string }

const MAX = 256;
const traces = new Map<string, { conversationId: string; path: string }>();
const unplaced = new Set<string>();
/** Chats whose page has reported traces in this run: one line each, so a report shows tracing works. */
const tracing = new Set<string>();

/** Stream traces from one chat's page; an id already filed without evidence is logged once. */
export function noteRequestTraces(conversationId: string, reported: readonly RequestTrace[]): void {
  if (reported.length && !tracing.has(conversationId) && tracing.size < 64) {
    tracing.add(conversationId);
    // Tracing has limits (16 new ids per message, 64 per stream), so a missing trace makes it likely, not
    // certain, that the page never saw an id.
    logInfo(`request attribution: the page of ${conversationId} reports the ids in its streams (tracing works, up to 16 new ids per message)`);
  }
  for (const { requestId, path } of reported) {
    if (traces.has(requestId)) continue;
    traces.set(requestId, { conversationId, path });
    if (traces.size > MAX) traces.delete(traces.keys().next().value!);
    if (unplaced.has(requestId)) {
      logInfo(`request attribution: ${requestId} had no page evidence in time; the stream of ${conversationId} names it at ${path}`);
    }
  }
}

/** For a request id that ended its wait without page evidence: what the page's stream showed of it. */
export function requestTraceNote(requestId: string): string {
  if (!unplaced.has(requestId)) {
    unplaced.add(requestId);
    if (unplaced.size > MAX) unplaced.delete(unplaced.values().next().value!);
  }
  const trace = traces.get(requestId);
  return trace ? `; the stream of ${trace.conversationId} named it at ${trace.path}` : '';
}

export function resetRequestTracesForTests(): void {
  traces.clear();
  unplaced.clear();
  tracing.clear();
}
