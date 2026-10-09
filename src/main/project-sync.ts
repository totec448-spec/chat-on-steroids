import type { ChatGptMembershipCheck, LocalProject } from '../shared/projects.js';
import { requestChatGptProjectObservation, type ChatGptProjectObservationResult } from './bridge.js';
import { getProject, linkChatGptProject, verifyChatGptProjectLink } from './projects.js';
import { beginChatGptProjectObservation, findSessionByConversation, recordChatGptProjectObservation, withSessionMutationFence } from './session/store.js';

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
  if (!(await getProject(projectId))) throw new Error('Project not found');
  const source = await beginChatGptProjectObservation(sessionId, projectId);
  const observed = await observe(source.conversationId);
  if (!observed.ok) throw observationError(observed);
  // Publication must linearize with Compact & Resume. Rechecking and then awaiting the
  // Project catalog would leave a gap in which A could rebind to B while A's observation
  // was still being committed. Hold the session's mutation fence through the durable Project
  // write and compare the process-lifetime attachment generation too: A -> B -> A must not
  // make a stale observation current again. Either the rebind wins first and this refuses,
  // or this write lands while A is still the same exact frontend generation and rebind follows.
  const linked = await withSessionMutationFence(sessionId, async (summary, attachmentGeneration) => {
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
  // The catalog commits the association's fresh incarnation first; only then can the
  // source's matching verdict refer to its exact link. Never write provisional/failed
  // remote observations to session history. The second session queue operation cannot
  // nest inside the mutation fence: a rebind between commits simply invalidates the
  // optional presentation mark without moving or misattributing the local session.
  if (linked.remote?.linkId) {
    await recordChatGptProjectObservation(sessionId, projectId, source.conversationId,
      source.attachmentGeneration, source.observationAttempt, linked.remote.linkId,
      'linked', observed.observedAt);
  }
  return linked;
}

/**
 * Checks only one CoS-known, explicitly requested current chat against its already-linked
 * ChatGPT Project. No enumeration, background poll, project re-assignment or ChatGPT write.
 * The raw remote identity remains in main/storage; the IPC response is a user-facing verdict.
 */
export async function checkChatGptProjectMembership(
  projectId: string,
  sessionId: string,
  observe: ProjectObservation = requestChatGptProjectObservation
): Promise<ChatGptMembershipCheck> {
  const initial = await getProject(projectId);
  if (!initial || initial.ungrouped || !initial.remote) {
    throw new Error('The local project is not linked to a ChatGPT Project');
  }
  const linked = initial.remote;
  if (!linked.linkId) throw new Error('Refresh this ChatGPT Project link before checking chat membership');
  const source = await beginChatGptProjectObservation(sessionId, projectId);
  const result = await observe(source.conversationId);
  if (!result.ok && result.reason !== 'project-not-detected') throw observationError(result);
  const remoteId = result.ok ? result.projectId : null;
  const observedAt = result.ok ? result.observedAt : Date.now();
  const status: ChatGptMembershipCheck['status'] = remoteId === null ? 'not-project' :
    remoteId === linked.projectId ? 'linked' : 'other-project';
  const sameLink = async (): Promise<boolean> => {
    const current = await getProject(projectId);
    return !!current && !current.ungrouped &&
      current.remote?.projectId === linked.projectId && current.remote.linkId === linked.linkId;
  };
  if (!(await sameLink())) throw new Error('The ChatGPT Project link changed during the observation');
  const recorded = await recordChatGptProjectObservation(sessionId, projectId, source.conversationId,
    source.attachmentGeneration, source.observationAttempt, linked.linkId, status, observedAt);
  if (!recorded) throw new Error('The selected session changed while ChatGPT Project was being observed');
  if (!(await sameLink())) throw new Error('The ChatGPT Project link changed during the observation');
  return { status: recorded.status, observedAt: recorded.observedAt };
}
