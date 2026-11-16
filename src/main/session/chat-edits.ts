import { committedResumeAncestorsFromSummary, workSequence, type ChatEdit, type ChatEdits, type SessionEvent, type SessionSummary } from '../../shared/session.js';
import { logInfo } from '../logger.js';
import { projectRestoreTarget } from '../project-files.js';
import { getProject, projectWorkspace } from '../projects.js';
import { getSession, readRecentEvents } from './store.js';

const MAX_ROWS = 30;
const MAX_CALLS = 128;
type EditCall = Extract<SessionEvent, { kind: 'tool_call' }>;

async function scope(sessionId: string, projectId: string) {
  const [session, project] = await Promise.all([getSession(sessionId), getProject(projectId)]);
  if (session?.projectId !== projectId || !session.conversationId || !project || project.remote) return null;
  return { session, prefix: (await projectWorkspace(projectId)).virtual + '/' };
}

function chatConversations(session: SessionSummary): Set<string> {
  const id = session.conversationId ?? '';
  return new Set([id, ...committedResumeAncestorsFromSummary(session, id)]);
}

function isRecordedEdit(event: SessionEvent, session: SessionSummary, conversations: Set<string>): event is EditCall {
  if (event.kind !== 'tool_call' || event.source !== 'mcp' || !event.call) return false;
  const { call } = event;
  return call.tool === 'apply_patch' && call.outcome === 'ok' && call.attribution === 'request_id' &&
    typeof call.callId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(call.callId) &&
    (session.origin?.kind === 'worker' || !/^worker-\d+$/.test(event.agent ?? '')) &&
    typeof call.conversationId === 'string' && conversations.has(call.conversationId) &&
    Array.isArray(call.changes) && call.changes.length > 0;
}

function relativePath(path: unknown, prefix: string): string | null {
  if (typeof path !== 'string' || path.length > 4096 || !path.startsWith(prefix)) return null;
  const relative = path.slice(prefix.length);
  return !/[\\\0]/.test(relative) && relative.split('/').every(part => part && part !== '.' && part !== '..') ? relative : null;
}

/** Metadata only. Missing paths keep their history; no live file bytes enter this view. */
async function fileState(projectId: string, path: string): Promise<'changed' | 'missing' | 'unavailable'> {
  try {
    const target = await projectRestoreTarget(projectId, path);
    return target.kind === 'file' ? 'changed' : target.kind === null ? 'missing' : 'unavailable';
  } catch { return 'unavailable'; }
}

export async function readChatEdits(sessionId: string, projectId: string): Promise<ChatEdits | null> {
  const current = await scope(sessionId, projectId).catch(() => null);
  if (!current) { logInfo('chat edits: unavailable project or session scope'); return null; }
  const conversations = chatConversations(current.session);
  const calls = await readRecentEvents(sessionId, MAX_CALLS, {
    kinds: ['tool_call'], orderByOrigin: true,
    acceptEvent: event => isRecordedEdit(event, current.session, conversations) &&
      event.call.changes!.some(change => relativePath(change?.path, current.prefix) !== null)
  });
  const files = new Map<string, Omit<ChatEdit, 'state'> & { deleted: boolean }>();
  for (const event of calls.sort((a, b) => workSequence(b) - workSequence(a))) {
    if (!isRecordedEdit(event, current.session, conversations)) continue;
    for (const [index, change] of event.call.changes!.slice(0, 64).entries()) {
      const path = relativePath(change?.path, current.prefix);
      if (!path || files.has(path)) continue;
      files.set(path, { path, callId: event.call.callId, index, position: workSequence(event),
        reviewable: !!change.reviewAssetId, deleted: event.call.summary?.kind === 'delete' });
      if (files.size > MAX_ROWS) break;
    }
    if (files.size > MAX_ROWS) break;
  }
  const rows = await Promise.all([...files.values()].slice(0, MAX_ROWS).map(async ({ deleted, ...row }): Promise<ChatEdit> => {
    const state = await fileState(projectId, row.path);
    return { ...row, state: state === 'missing' && deleted ? 'deleted' : state,
      reviewable: row.reviewable && state !== 'unavailable' };
  }));
  const latest = await scope(sessionId, projectId).catch(() => null);
  if (latest?.prefix !== current.prefix || latest.session.conversationId !== current.session.conversationId) {
    logInfo('chat edits: project or session scope changed during read');
    return null;
  }
  return { rows, limited: files.size > MAX_ROWS || calls.length === MAX_CALLS };
}

/** Only the Outputs entry point requires a current project check. Existing timeline reviews
 * remain historical, including for chats without a project. */
export async function reviewChatEditPath(sessionId: string, projectId: string, event: EditCall, index: number): Promise<string | null> {
  const current = await scope(sessionId, projectId).catch(() => null);
  if (!current || !isRecordedEdit(event, current.session, chatConversations(current.session))) return null;
  const path = relativePath(event.call.changes?.[index]?.path, current.prefix);
  if (path === null || await fileState(projectId, path) === 'unavailable') return null;
  return (await getSession(sessionId))?.projectId === projectId ? path : null;
}
