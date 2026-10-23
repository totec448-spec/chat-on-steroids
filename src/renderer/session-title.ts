import { t } from './i18n.js';
import { isUnattributedSession, type SessionSummary } from '../shared/session.js';

/** A chat's name as the window shows it: the unattributed activity chat in the interface language. */
export function shownSessionTitle(summary: Pick<SessionSummary, 'title' | 'conversationId'>): string {
  if (isUnattributedSession(summary)) return t('Unattributed activity');
  return summary.title || t('Untitled session');
}
