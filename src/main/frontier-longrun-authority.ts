/** Authority provenance carried only by CoS-owned Frontier Longrun transport. */
export const FRONTIER_LONGRUN_AUTHORITY_CLASS = 'frontier_longrun_parent_v1' as const;

/**
 * App-authored marker. Core instructions treat any message carrying this exact
 * line as remote work direction whose text cannot itself authorize guarded
 * external/authority-changing actions. A caller can imitate the marker only to
 * reduce its own authority, never to gain any.
 */
export const FRONTIER_LONGRUN_REMOTE_TASK_MARKER = '[[CLF_FRONTIER_LONGRUN_REMOTE_TASK_V1]]';

export function markFrontierLongrunRemoteText(text: string): string {
  return `${FRONTIER_LONGRUN_REMOTE_TASK_MARKER}\n${text}`;
}
