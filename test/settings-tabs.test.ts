import { expect, it } from 'vitest';
import { AGENT_PAGES, resolveSettingsTab } from '../src/renderer/settings-tabs.js';

it('opens the first Agents page for the old one-page tab id, and each page for its own tab', () => {
  expect(resolveSettingsTab('settings')).toEqual({ tab: 'agents-goal', agentPage: 'goal' });
  for (const [tab, page] of Object.entries(AGENT_PAGES)) expect(resolveSettingsTab(tab)).toEqual({ tab, agentPage: page });
  expect(Object.values(AGENT_PAGES)).toEqual(['goal', 'models', 'workers', 'tools', 'browser']);
});

it('leaves every other tab alone, whatever its name', () => {
  for (const tab of ['chat', 'home', 'setup', 'general', 'appearance', 'usage', 'activity', 'plugins', 'toString', '__proto__', 'constructor', '']) {
    expect(resolveSettingsTab(tab)).toEqual({ tab, agentPage: undefined });
  }
});
