import type { SessionEvent } from '../shared/session.js';

type Communication = Extract<SessionEvent, { kind: 'agent_message' }>;

export function communicationTitle(event: Communication): string {
  const worker = event.from === 'prime' ? event.to : event.from;
  if (event.from === 'prime') return `Message to ${worker}`;
  if ((event.message.text.startsWith(`[${worker} is awake again]`) || event.message.text.startsWith(`[${worker} is back]`))) return `${worker} resumed work`;
  if ((event.message.text.startsWith(`[${worker} reported]`) || event.message.text.startsWith(`[${worker} finished]`))) return `${worker} finished · report`;
  return `Message from ${worker}`;
}

/** Keep the tool's args/result as the single presentation of its outgoing message.
 * Old recordings have no causal call id: only collapse a unique exact payload match
 * inside the successful call's lifetime. Incoming reports are independent records.
 */
export function foldAgentCommunication(events: SessionEvent[]): SessionEvent[] {
  const calls = events.flatMap(event => {
    if (event.kind !== 'tool_call' || event.call.tool !== 'agents' || event.call.outcome !== 'ok' || event.call.args.truncated) return [];
    try {
      const args = JSON.parse(event.call.args.text);
      if (args.action !== 'message' || typeof args.to !== 'string' || typeof args.text !== 'string') return [];
      return [{ event, to: args.to, text: args.text }];
    } catch { return []; }
  });
  const matches = new Map<SessionEvent, SessionEvent[]>();
  for (const event of events) {
    if (event.kind !== 'agent_message' || event.delivery !== 'sent' || event.message.truncated) continue;
    const candidates = calls.filter(call => call.event.agent === event.from && call.to === event.to && call.text === event.message.text &&
      event.time >= call.event.time && event.time <= call.event.time + call.event.call.durationMs);
    if (candidates.length !== 1) continue;
    const call = candidates[0]!.event;
    matches.set(call, [...(matches.get(call) ?? []), event]);
  }
  const redundant = new Set([...matches.values()].filter(rows => rows.length === 1).flat());
  return events.filter(event => !redundant.has(event));
}
