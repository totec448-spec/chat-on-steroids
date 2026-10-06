import type { LocalProject } from '../shared/projects.js';
import { requestChatGptProjectObservation, type ChatGptProjectObservationResult } from './bridge.js';
import { getProject, linkChatGptProject, verifyChatGptProjectLink } from './projects.js';
import { findSessionByConversation, withSessionMutationFence } from './session/store.js';

type ProjectObservation = (conversationId: string) => Promise<ChatGptProjectObservationResult>;
type ProjectPublication = (
  action: 'link' | 'verify', projectId: string, remoteProjectId: string, observedAt: number
) => Promise<LocalProject>;

const publishProjectObservation: ProjectPublication = (action, projectId, remoteProjectId, observedAt) => action === 'link'
  ? linkChatGptProject(projectId, remoteProjectId, observedAt)
  : verifyChatGptProjectLink(projectId, remoteProjectId, observedAt);

function observationError(result: Exclude<ChatGptProjectObservationResult, { ok: true }>): Error {
  return new Error({
    'project-not-detected': 'The selected chat is not currently open in a ChatGPT Project.',
    'project-ambiguous': 'More than one current browser holds this chat; the ChatGPT Project link was not changed.',
    'source-tab-lost': 'The exact ChatGPT chat is not available to the companion; the ChatGPT Project link was not changed.',
    'project-route-changed': 'The ChatGPT Project route changed while it was being observed; the link was not changed.'
  }[result.reason]);
}

async function exactLinkedSession(projectId: string, sessionId: string): Promise<{ conversationId: string; attachmentGeneration: number }> {
  if (!(await getProject(projectId))) throw new Error('Project not found');
  return withSessionMutationFence(sessionId, async (session, attachmentGeneration) => {
    if (!session.projectId) throw new Error('The selected chat is not assigned to this local project');
    if (session.projectId !== projectId) throw new Error('The selected chat already belongs to another local project');
    if (!session.conversationId) throw new Error('The selected session has no current ChatGPT conversation');
    const exact = await findSessionByConversation(session.conversationId, { requireUnique: true });
    if (!exact || exact.id !== session.id) throw new Error('The selected ChatGPT conversation does not have unique current session ownership');
    return { conversationId: session.conversationId, attachmentGeneration };
  });
}

/**
 * Links or verifies one current ChatGPT Project against an existing approved LocalProject.
 * The browser observation is read-only, then session/conversation ownership is revalidated before
 * the durable Project catalog changes. This operation never moves a session between local projects.
 */
export async function syncChatGptProjectLink(
  projectId: string,
  sessionId: string,
  action: 'link' | 'verify',
  observe: ProjectObservation = requestChatGptProjectObservation,
  publish: ProjectPublication = publishProjectObservation
): Promise<LocalProject> {
  const source = await exactLinkedSession(projectId, sessionId);
  const observed = await observe(source.conversationId);
  if (!observed.ok) throw observationError(observed);
  // Publication must linearize with Compact & Resume. Rechecking and then awaiting the
  // Project catalog would leave a gap in which A could rebind to B while A's observation
  // was still being committed. Hold the session's mutation fence through the durable Project
  // write and compare the process-lifetime attachment generation too: A -> B -> A must not
  // make a stale observation current again. Either the rebind wins first and this refuses,
  // or this write lands while A is still the same exact frontend generation and rebind follows.
  return withSessionMutationFence(sessionId, async (summary, attachmentGeneration) => {
    if (summary.projectId !== projectId) throw new Error('The selected chat changed local project while ChatGPT Project was being observed');
    if (summary.conversationId !== source.conversationId || attachmentGeneration !== source.attachmentGeneration) {
      throw new Error('The selected session changed while ChatGPT Project was being observed');
    }
    const exact = await findSessionByConversation(source.conversationId, { requireUnique: true });
    if (!exact || exact.id !== sessionId) {
      throw new Error('The selected ChatGPT conversation lost unique current session ownership');
    }
    return publish(action, projectId, observed.projectId, observed.observedAt);
  });
}
