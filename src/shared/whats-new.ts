import { isNewer, RELEASES_PAGE } from './types.js';

/**
 * Whether this start shows the What's New dialog (#1172).
 *
 * `lastSeen` is the version this install last started as. A fresh install records its own version
 * before anything can show, so a missing value means a configuration from before this feature:
 * an update. The dialog shows once per real update, and only for a version that ships highlights;
 * any other change of version, a downgrade included, is recorded without showing anything.
 */
export function whatsNewAction(current: string, lastSeen: string | undefined, hasHighlights: (version: string) => boolean): 'show' | 'record' | 'none' {
  if (lastSeen === current) return 'none';
  if (lastSeen !== undefined && !isNewer(current, lastSeen)) return 'record';
  return hasHighlights(current) ? 'show' : 'record';
}

/** The full notes of a version, on the project's release page. */
export function releaseNotesUrl(version: string): string {
  return RELEASES_PAGE.replace(/\/latest$/, `/tag/v${encodeURIComponent(version)}`);
}
