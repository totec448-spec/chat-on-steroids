import type { AppState } from '../shared/types.js';
import { t } from './i18n.js';

/** What the enabled Desktop permissions need from macOS and do not have. */
export interface DesktopAccessProblem {
  screen: boolean;
  accessibility: boolean;
  /** At least one of them is definitely missing, not merely not known yet. */
  missing: boolean;
  /**
   * A missing permission this app held before. Releases are not signed with a developer ID, so
   * after an update macOS treats the app as new: System Settings still shows the switch on, and
   * only resetting the entry lets macOS ask again (live 2026-10-15).
   */
  stale: boolean;
}

type AccessState = Pick<AppState, 'platform' | 'config' | 'desktopAccess'>;

export function desktopAccessProblem(next: AccessState): DesktopAccessProblem | null {
  const access = next.desktopAccess;
  if (next.platform?.family !== 'macos' || !access) return null;
  const screen = next.config.capabilities.screen && access.screen !== 'granted';
  const accessibility = next.config.capabilities.control && !next.config.readOnly && access.accessibility !== 'granted';
  if (!screen && !accessibility) return null;
  const missingScreen = screen && access.screen === 'missing';
  const missingAccessibility = accessibility && access.accessibility === 'missing';
  return {
    screen, accessibility,
    missing: missingScreen || missingAccessibility,
    stale: (missingScreen && access.grantedBefore?.screen === true) || (missingAccessibility && access.grantedBefore?.accessibility === true)
  };
}

/** The chat's own notice: Desktop tools fail without these, so the chat says so, not only Settings. */
export function paintDesktopAccessNotice(next: AccessState, actions: { repair(): void; open(): void }): void {
  const notice = document.getElementById('desktopAccessNotice')!;
  const problem = desktopAccessProblem(next);
  notice.hidden = !problem?.missing;
  if (!problem?.missing) return;
  document.getElementById('desktopAccessNoticeText')!.textContent = problem.stale
    ? t('Desktop access stopped working after the update: macOS still shows it as allowed, but has to be asked again.')
    : t('Desktop access is on, but macOS has not given Chat On Steroids the permission it needs.');
  const repair = document.getElementById('desktopAccessNoticeRepair') as HTMLButtonElement;
  // Offered whether or not an earlier grant is remembered: resetting this app's own entry and
  // asking again is harmless, and the first version that remembers grants knows of none.
  repair.hidden = false;
  repair.onclick = () => actions.repair();
  (document.getElementById('desktopAccessNoticeOpen') as HTMLButtonElement).onclick = () => actions.open();
}
