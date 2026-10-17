import { t } from './i18n.js';
import { UNATTRIBUTED_SESSION_TITLE, type SessionSummary } from '../shared/session.js';

/** A chat's name as the window shows it: the unattributed activity chat in the interface language. */
export function shownSessionTitle(summary: Pick<SessionSummary, 'title' | 'conversationId'>): string {
  if (summary.conversationId === null && summary.title === UNATTRIBUTED_SESSION_TITLE) return t('Unattributed activity');
  return summary.title || t('Untitled session');
}
