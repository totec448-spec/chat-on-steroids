import { t } from './i18n.js';
import type { SessionEvent, SessionSummary } from '../shared/session.js';
import { el } from './dom.js';

type Communication = Extract<SessionEvent, { kind: 'agent_message' }>;

export function workerAvatar(worker: string): HTMLElement {
  const avatar = el('span', 'agent-avatar', worker.replace(/^worker-/, ''));
  avatar.dataset.color = String([...worker].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6);
  avatar.setAttribute('aria-hidden', 'true');
  return avatar;
}

/** Recorded participation, never a roster/status snapshot or a guessed slot incarnation. */
export function participatingWorkers(event: SessionEvent, workers: SessionSummary[]): SessionSummary[] {
  let names: unknown[] = [];
  if (event.kind === 'agent_message') names = [event.from, event.to];
  else if (event.kind === 'tool_call' && event.call.tool === 'agents' && event.call.outcome === 'ok') {
    if (event.call.args.truncated) return [];
    try {
      const args = JSON.parse(event.call.args.text);
      if (args.action === 'message' && !args.target_run_id) {
        names = Array.isArray(args.messages) ? args.messages.map((message: { to?: unknown }) => message?.to) : [args.to];
      }
      // Only structured spawn receipts name the workers actually accepted. Prose and
      // requested assignments cannot prove which reusable worker the broker chose.
      if (args.action === 'spawn' && !event.call.result.truncated) {
        const result = JSON.parse(event.call.result.text)?.structuredContent;
        if (result?.action === 'spawn' && Array.isArray(result.workers)) names = result.workers.map((worker: { id?: unknown }) => worker?.id);
      }
    } catch { return []; }
  }
  return [...new Set(names)].flatMap(name => {
    if (typeof name !== 'string' || !name.startsWith('worker-')) return [];
    const matches = workers.filter(worker => worker.origin?.agentId === name);
    return matches.length === 1 ? matches : [];
  });
}

export function communicationTitle(event: Communication): string {
  const worker = event.from === 'prime' ? event.to : event.from;
  if (event.from === 'prime') return t("Message to {0}", [worker]);
  if ((event.message.text.startsWith(`[${worker} is awake again]`) || event.message.text.startsWith(`[${worker} is back]`))) return t("{0} resumed work", [worker]);
  if ((event.message.text.startsWith(`[${worker} reported]`) || event.message.text.startsWith(`[${worker} finished]`))) return t("{0} finished · report", [worker]);
  return t("Message from {0}", [worker]);
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
