/**
 * The Agents pages share one view of the chat card; each Settings tab names the page it shows.
 * The tab that used to be one long page of eleven sections is gone: its old id opens the first
 * page, so a remembered or documented link keeps working.
 */
export const AGENT_PAGES: Readonly<Record<string, string>> = {
  'agents-goal': 'goal', 'agents-models': 'models', 'agents-workers': 'workers', 'agents-tools': 'tools', 'agents-browser': 'browser'
};
const LEGACY_TABS: Readonly<Record<string, string>> = { settings: 'agents-goal' };

/** The tab a request names today, and the Agents page it shows (none for any other tab). */
export function resolveSettingsTab(requested: string): { tab: string; agentPage: string | undefined } {
  const tab = Object.hasOwn(LEGACY_TABS, requested) ? LEGACY_TABS[requested]! : requested;
  return { tab, agentPage: Object.hasOwn(AGENT_PAGES, tab) ? AGENT_PAGES[tab] : undefined };
}
