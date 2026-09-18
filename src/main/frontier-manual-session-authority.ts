/** Local provenance for inputs created only by signed Frontier manual-session authority. */
export const FRONTIER_MANUAL_SESSION_AUTHORITY_CLASS = 'frontier_manual_session_v1' as const;

/** Keep remote manual-session text from becoming ambient authority after delivery/resume. */
export const FRONTIER_MANUAL_SESSION_REMOTE_TASK_MARKER = '[[CLF_FRONTIER_MANUAL_SESSION_REMOTE_TASK_V1]]';

export function markFrontierManualSessionRemoteText(text: string): string {
  return `${FRONTIER_MANUAL_SESSION_REMOTE_TASK_MARKER}\n${text}`;
}
