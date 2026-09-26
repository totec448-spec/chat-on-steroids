/**
 * The desktop window's layout contract.
 *
 * The window has a preferred size and a fixed set of controls, so a control going missing
 * at that size or after a supported resize is a layout failure rather than a styling opinion. On the installed build
 * the session card's header held the title, a three-way view switcher and three buttons in
 * one flex row, and at the window's own default width "Compact & resume" — the primary
 * action of the whole app — was pushed entirely off the right edge. Not clipped: absent.
 *
 * jsdom does no layout, so this cannot measure pixels. What it can do is hold the
 * structural rules that made the overflow possible in the first place: the actions cluster
 * must not be allowed to shrink, the title must be the thing that yields, navigation must
 * not compete with actions for the same row, and nothing anywhere may scroll sideways.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';
import { filterSettingsSections } from '../src/renderer/dom.js';
import { sessionWorkingAt } from '../src/shared/session-activity.js';
import { CHAT_ACTIVE_MS, type SessionSummary } from '../src/shared/session.js';

let document: Document;
let css = '';
let chatSource = '';
let browserPreferencesSource = '';
let disclosureSource = '';

beforeAll(async () => {
  browserPreferencesSource = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'browser-preferences.ts'), 'utf8');
  const [html, styles, chat, main, filePanel, agentPlan, plugins] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'styles.css'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'chat.ts'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'main.ts'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'file-panel.ts'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'agent-plan.ts'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'plugins.ts'), 'utf8')
  ]);
  document = new JSDOM(html).window.document;
  css = styles;
  chatSource = chat;
  disclosureSource = [chat, main, filePanel, agentPlan, plugins].join('\n');
});

it('searches whole settings sections without empty headings, orphaned controls or lost conditional visibility', () => {
  const view = document.querySelector<HTMLElement>('[data-view="settings"]')!;
  const sections = [...view.querySelectorAll<HTMLElement>('.automation-section-head')];
  const conditional = document.getElementById('goalModels')!;
  expect(conditional.hidden).toBe(true);
  filterSettingsSections(view, '  SESSION FINISH  ');
  expect(sections.filter(section => !section.hidden).map(section => section.querySelector('h2')?.textContent)).toEqual(['Keep the turn open']);
  for (const section of sections) expect((section.nextElementSibling as HTMLElement).hidden).toBe(section.hidden);
  expect(document.getElementById('finishTool')!.closest('.pane')!.hasAttribute('hidden')).toBe(false);
  expect(document.getElementById('goalKey')!.closest('.pane')!.hasAttribute('hidden')).toBe(true);
  filterSettingsSections(view, 'no-such-setting-123');
  expect(sections.every(section => section.hidden)).toBe(true);
  expect(document.getElementById('settingsSearchEmpty')!.hidden).toBe(false);
  filterSettingsSections(view, '');
  expect(sections.every(section => !section.hidden && !(section.nextElementSibling as HTMLElement).hidden)).toBe(true);
  expect(conditional.hidden).toBe(true);
  expect(document.getElementById('settingsSearchEmpty')!.hidden).toBe(true);
});

it('gives Plugins, Skills and Pets the same restrained page entrance as Settings', () => {
  expect(rule(".app[data-screen='library'] .panel.is-active")).toContain('animation: surface-in 160ms ease-out');
  expect(document.querySelectorAll("[data-panel='plugins'], [data-panel='skills'], [data-panel='pets']")).toHaveLength(3);
  expect(document.getElementById('skillsRefresh')!.querySelector('.ph-arrow-clockwise')).not.toBeNull();
  expect(css).toContain('@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important;');
});

it('animates Agents & automation only at its inner view boundary', () => {
  expect(css).toContain(".app[data-screen='settings'] .panel.is-active:not([data-panel='chat']),\n.app[data-screen='library'] .panel.is-active { animation: surface-in 160ms ease-out; }");
  expect(rule(".app[data-screen='settings'] [data-view='settings']:not([hidden])")).toContain('animation: surface-in 160ms ease-out');
  expect(css).not.toContain(".app[data-screen='settings'] .panel.is-active, .app[data-screen='settings'] [data-view='settings']");
});

it('keeps Agents & automation on the shared settings canvas with its model action in the section header', () => {
  const view = document.querySelector<HTMLElement>('[data-view="settings"]')!;
  const sections = [...view.querySelectorAll<HTMLElement>('.automation-section-head')];
  expect(view.classList.contains('settings-page-content')).toBe(true);
  expect(view.querySelector('.settings-page-head #settingsSearch')).not.toBeNull();
  expect(document.getElementById('settingsSearch')!.closest('.plugin-search')?.querySelector('.ph-magnifying-glass')).not.toBeNull();
  expect(sections).toHaveLength(7);
  expect(sections.every(section => Boolean(section.querySelector('p')?.textContent?.trim()))).toBe(true);
  expect(sections.every(section => section.nextElementSibling?.classList.contains('settings-surface'))).toBe(true);
  expect(document.getElementById('refreshChatModels')!.closest('.automation-section-head')?.querySelector('h2')?.textContent).toBe('ChatGPT models');
  expect(document.getElementById('swarmReset')!.closest('.pane')?.previousElementSibling?.querySelector('h2')?.textContent).toBe('Workers & recovery');
});

it('uses the same navigation typography in the chat and settings sidebars', () => {
  expect(rule('.sidebar-primary .new-chat, .sidebar .sidebar-primary-link')).toContain('min-height: 38px');
  expect(rule('.sidebar-primary .new-chat, .sidebar .sidebar-primary-link')).toContain('font-size: calc(13px * var(--text-scale, 1))');
  expect(rule('nav button')).toContain('min-height: 38px');
  expect(rule('nav button')).toContain('font-size: calc(13px * var(--text-scale, 1))');
  expect(rule('nav button')).toContain('font-weight: 550');
});

it('reveals settings navigation inside the sidebar without animating its shell geometry', () => {
  expect(rule(".app[data-screen='settings'] #backToChat")).toContain('animation: sidebar-content-in 170ms cubic-bezier(.16, 1, .3, 1)');
  expect(rule(".app[data-screen='settings'] #tabs,\n.app[data-screen='chat'] .sidebar-sessions")).toContain('animation: sidebar-content-in 200ms cubic-bezier(.16, 1, .3, 1)');
  expect(rule(".app[data-screen='chat'] #sidebarPrimary")).toContain('animation: sidebar-content-in 170ms cubic-bezier(.16, 1, .3, 1)');
  expect(css).toContain('@keyframes sidebar-content-in { from { opacity: .35; transform: translateX(-6px); clip-path: inset(0 0 0 8px); }');
  expect(rule('.sidebar')).not.toContain('sidebar-content-in');
});

it('groups Appearance into the shared settings sections without moving its controls or reset scope', () => {
  const panel = document.getElementById('appearancePanel')!;
  const content = panel.querySelector('.appearance-content')!;
  const sections = [...content.querySelectorAll('.appearance-section')];
  expect(content.classList.contains('settings-page-content')).toBe(true);
  expect(sections.map(section => section.querySelector('h2')?.textContent)).toEqual(['Preview', 'Colors', 'Typography', 'Preferences']);
  expect(sections.every(section => Boolean(section.querySelector('.settings-section-head p')?.textContent?.trim()))).toBe(true);
  expect(sections.every(section => Boolean(section.querySelector('.appearance-preview, .appearance-settings-card')))).toBe(true);
  expect(document.getElementById('appearanceReset')!.closest('.appearance-page-head')).not.toBeNull();
  expect(document.getElementById('uiLanguage')!.closest('.appearance-section')?.querySelector('h2')?.textContent).toBe('Preferences');
  expect(document.getElementById('setupProfile')!.closest('.appearance-section')?.querySelector('h2')?.textContent).toBe('Preferences');
});

it('uses one centered vector geometry for animated disclosure and dropdown indicators', () => {
  const staticIndicators = [...document.querySelectorAll<SVGElement>('svg.disclosure-chevron')];
  expect(staticIndicators).toHaveLength(8);
  expect(staticIndicators.every(node => node.getAttribute('viewBox') === '0 0 16 16')).toBe(true);
  expect(staticIndicators.every(node => node.querySelector('path')?.getAttribute('d') === 'M6 3.5 10.5 8 6 12.5')).toBe(true);
  expect(document.querySelectorAll('.sidebar-section-chev.ph, .sum-chev.ph, .picker-chevron.ph')).toHaveLength(0);
  expect(disclosureSource).not.toContain("icon('i-chev'");
  expect(disclosureSource.match(/disclosureChevron\(/g)).toHaveLength(10);
  expect(rule('.disclosure-chevron')).toContain('transform-box: view-box');
  expect(rule('.disclosure-chevron')).toContain('transform-origin: 50% 50%');
  expect(rule('.dropdown-chevron')).toContain('rotate(90deg)');
  expect(rule('select::picker-icon')).toContain("content: ''");
  expect(rule('select::picker-icon')).toContain('mask: url(');
  expect(rule('select:open::picker-icon')).toContain('rotate(270deg)');
  expect(css).toContain(':where(.plugin-about, .plugin-legal, .setup-optional, .session-diagnostics, .connection-runtime)[open] > summary .details-chevron { transform: rotate(90deg); }');
});

it('optically centers the Chats refresh glyph inside its hover target', () => {
  const refresh = document.getElementById('chatRefresh')!;
  expect(refresh.getAttribute('aria-label')).toBe('Refresh chats');
  expect(refresh.querySelector('.ph-arrow-clockwise')).not.toBeNull();
  expect(rule('.sidebar-session-heading .acts .btn')).toContain('width: 26px; height: 26px');
  expect(rule('#chatRefresh .ico')).toContain('width: 16px; height: 16px; font-size: 16px');
  expect(rule('#chatRefresh .ico::before')).toContain('translate: -1px 2px');
});

it('limits the existing tool-detail preference to handoff briefs', () => {
  const toggle = document.getElementById('goalIncludeToolCalls') as HTMLInputElement;
  expect(toggle.type).toBe('checkbox');
  expect(toggle.checked).toBe(false);
  expect(toggle.closest('label')?.textContent).toContain('Include tool details in handoffs');
  expect(toggle.closest('label')?.textContent).toContain('Goal and Loop use user messages and assistant updates and answers');
  expect(chatSource).toContain("includeToolCalls: $<HTMLInputElement>('goalIncludeToolCalls').checked");
  expect(chatSource).toContain("applyChatChecked($<HTMLInputElement>('goalIncludeToolCalls')");
});

it('keeps the context circle in the gear group rather than an auto-placed composer grid cell', () => {
  const group = document.getElementById('composerModeControl')!.parentElement!;
  expect(group.classList.contains('composer-options')).toBe(true);
  expect(document.getElementById('contextMeter')!.parentElement).toBe(group);
  expect(document.getElementById('contextMeterInfo')!.parentElement?.id).toBe('contextMeter');
  expect(document.getElementById('clearComposerMode')!.parentElement?.id).toBe('composerModeControl');
  expect(document.getElementById('composerSettingsSummary')!.contains(document.getElementById('clearComposerMode'))).toBe(false);
});

it('anchors the composer mode menu to the fixed icon slot instead of the variable-width mode pill', () => {
  const popover = document.querySelector('#composerSettings .composer-popover');
  expect(popover).not.toBeNull();
  expect(rule('#composerSettings .composer-popover')).toContain('left: 18px');
  expect(rule('#composerSettings .composer-popover')).toContain('translate: -50% 0');
  expect(rule('#composerSettings .composer-popover')).not.toContain('left: 50%');
});

it('does not expose a periodic Astra continuation outside session_finish', () => {
  expect(document.getElementById('goalImpulseMinutes')).toBeNull();
  expect(chatSource).not.toContain("number('goalImpulseMinutes'");
});

/** The declarations of one selector, whitespace-normalised. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match ? match[1]!.replace(/\s+/g, ' ').trim() : '';
}

describe('the session card header', () => {
  it('indents rendered project tasks once and gives worker children their additional depth', () => {
    expect(rule('.project-group > .sess, .project-group > .worker-group')).toContain('margin-inline-start: 24px');
    expect(rule('.worker-group')).toContain('padding-left: 16px');
    expect(css).not.toContain('.project-group .session-row');
  });
  /**
   * A gear, and nothing that starts work. Compact & resume is pressed in the ChatGPT tab,
   * because the chat is what writes the brief — a button here would be a second way to
   * start the one thing that must happen exactly once.
   */
  it('keeps global connection status out of the chat header and in the sidebar footer', () => {
    const header = document.querySelector('#chatTitle')!.closest('header')!;
    const connection = document.getElementById('sidebarConnection')!;
    const connect = document.getElementById('sidebarConnect')!;
    const footer = connection.closest('.sidebar-bottom')!;
    expect(header.contains(connection)).toBe(false);
    expect(header.querySelector('#headerConnect')).toBeNull();
    expect(document.getElementById('headerActions')).toBe(header.querySelector('.state'));
    expect(connect.parentElement).toBe(connection.parentElement);
    expect(footer).not.toBeNull();
    expect([...footer.children].map((node) => (node as HTMLElement).id || (node as HTMLElement).className)).toEqual([
      'workspaceSettings',
      'connection-anchor'
    ]);
    expect(document.getElementById('connectionPopover')!.closest('.connection-anchor')).not.toBeNull();
    expect(rule('.connection-popover')).toContain('position: fixed');
    expect(rule('.connection-popover')).toContain('max-height: min(580px, calc(100vh - 70px))');
    expect(rule('.connection-popover:not([hidden])')).toContain('animation: surface-in 140ms ease-out');
    expect(rule('.connection-popover::-webkit-scrollbar-track')).toContain('margin-block: 10px');
    expect(rule('#workspaceSettings')).toContain('flex: 0 0 36px');
    expect(rule('#workspaceSettings')).toContain('place-items: center');
    expect(rule('#workspaceSettings')).toContain('justify-content: center');
    expect(rule('#workspaceSettings')).toContain('border: 0');
    expect(rule('#workspaceSettings:hover')).toContain('background: var(--hover)');
    expect(rule('#workspaceSettings')).toContain('background: transparent');
    expect(rule('#workspaceSettings.is-sel')).toContain('background: var(--hover)');
    expect(rule('#workspaceSettings .ico')).toContain('font-size: 22px');
    expect(document.getElementById('workspaceSettings')!.textContent?.trim()).toBe('');
    expect(document.getElementById('workspaceSettings')!.getAttribute('aria-label')).toBe('Settings');
    expect(rule('.sidebar-connection')).toContain('width: 36px; height: 36px');
    expect(rule('.connection-anchor')).toContain('margin-left: auto');
    expect(rule('.sidebar-connect-action')).toContain('height: 36px');
    expect(rule('.sidebar-connect-action:not(:disabled)')).toContain('background: var(--green-wash)');
    expect(rule(".connection-anchor:has(.sidebar-connect-action[data-collapsed='false'])")).toContain('112px');
    expect(css).not.toContain('.connection-anchor:has(.sidebar-connection.is-busy)');
    expect(document.getElementById('connectionAdvanced')).not.toBeNull();
    expect(rule('.connection-advanced > summary')).toContain('margin-top: 8px');
    expect(rule('.connection-advanced[open] > .connection-advanced-body')).toContain('animation: surface-in 140ms ease-out');
    expect(document.getElementById('connectionAdvancedGrid')).not.toBeNull();
    expect(document.getElementById('connectionPopoverDisconnect')).not.toBeNull();
    expect(rule('#connectionPopoverDisconnect')).toContain('background: var(--red-wash)');
    expect(rule('#connectionPopoverDisconnect:disabled')).toContain('background: transparent');
    expect(document.getElementById('connectionPopoverToggle')).toBeNull();
    expect(document.getElementById('sessionControls')!.closest('#composerSettings')).not.toBeNull();
    expect(header.querySelector('.session-controls')).toBeNull();
  });

  /**
   * Settings is not a view of the session the way the timeline and the compaction are;
   * it is app configuration reached from the session. It belongs on the gear.
   */
  it('reaches settings from the gear rather than from the view switcher', () => {
    const views = [...document.getElementById('chatView')!.querySelectorAll('[data-view]')].map(
      (button) => (button as HTMLElement).dataset.view
    );
    expect(views).toEqual(['timeline', 'compact']);
    // The view itself still exists — only its entry point moved.
    expect(document.querySelector('#chatBody > .view[data-view="settings"]')).not.toBeNull();
  });

  /**
   * The switcher is navigation, not an action. Sharing the row with three buttons is what
   * made the row wider than the window; giving it its own is what makes the fit provable
   * rather than a matter of how long the session title happens to be.
   */
  it('keeps legacy view navigation hidden outside the header', () => {
    const header = document.querySelector('#chatTitle')!.closest('header')!;
    const view = document.getElementById('chatView')!;
    expect(header.contains(view)).toBe(false);
    expect(view.hidden).toBe(true);
  });

  it('lets the title shrink and never the actions', () => {
    expect(rule('.acts')).toContain('flex: none');
    const title = rule('#chatTitle');
    expect(title).toContain('min-width: 0');
    expect(title).toContain('text-overflow: ellipsis');
    // The title is the first child of the header, which is what that selector relies on.
    expect(document.querySelector('#chatTitle')!.closest('header')!.firstElementChild!.id).toBe('chatTitle');
  });

  it('has a place to say what is happening without opening the Activity log', () => {
    const note = document.getElementById('chatState')!;
    const rail = note.closest('.turn-status-rail')!;
    expect(rail.nextElementSibling?.id).toBe('composerDock');
    expect(rule('.turn-status-rail')).toContain('max-width: 860px');
    expect(rule('.turn-status-copy')).toContain('text-overflow: ellipsis');
    expect(rule('.turn-status-rail:not([hidden]) ~ .composer')).toContain('margin-top: 4px');
  });
});

/**
 * The session list is the one surface where rows are near-identical by construction: a
 * resume and its workers are all opened within a minute of each other. Which run a row
 * belongs to, and whether its tab ever opened, are carried by chips — so the chips are
 * the part that must survive a narrow row, and the counts are the part that yields.
 */
describe('a session row', () => {
  it('keeps status visible and lets the title truncate', () => {
    expect(rule('.sess-top')).toContain('display: flex');
    expect(rule('.session-status')).toContain('flex: none');
    const bits = rule('.sess-top b');
    expect(bits).toContain('min-width: 0');
    expect(bits).toContain('text-overflow: ellipsis');
  });

  it('never borrows live worker status from a different run that reused worker-1/worker-2', () => {
    // Worker ids are slot names and repeat every run. The conversation is the durable chat
    // identity, so both have to match before an old recorded session can show the current
    // swarm's `active` / `finished` badge. This pins the screenshot regression where several
    // old worker-2 rows all suddenly said `active` when one new worker-2 was active.
    expect(chatSource).toMatch(/entry\.id === origin\.agentId[\s\S]{0,220}entry\.conversationId === summary\.conversationId/);
  });

  it('does not call an idle prime active merely because it still owns the run', () => {
    expect(chatSource).toMatch(/else if \(agent && agent\.role !== 'prime'\)/);
    // Idle means idle: generic recording traffic cannot renew the exact tool clock.
    const summary = { startedAt: 100, lastToolCallAt: 200, lastAssistantFinalAt: 300,
      lastTurnEndAt: 300, updatedAt: 400, activeTurnId: 'old-open-turn', agents: ['prime'],
      endedAt: null, origin: null } as SessionSummary;
    expect(sessionWorkingAt(summary, 400)).toBe(false);
    expect(sessionWorkingAt({ ...summary, lastToolCallAt: 350 }, 400)).toBe(true);
  });

  /**
   * A page that lost its answer stream has no open turn while the model behind it goes on
   * calling tools for minutes. Keying the badge on the open turn alone showed that chat - the
   * one a user most wants to see is still going - as idle.
   */
  it('uses session start and exact calls rather than reload-generated turn boundaries for visible activity', () => {
    const summary = { startedAt: 100, lastToolCallAt: null, endedAt: null, origin: null,
      activeTurnId: 'reload-turn', updatedAt: 100 + CHAT_ACTIVE_MS } as SessionSummary;
    expect(sessionWorkingAt(summary, 101)).toBe(true);
    expect(sessionWorkingAt(summary, 101 + CHAT_ACTIVE_MS)).toBe(false);
    expect(sessionWorkingAt({ ...summary, activityExpiresAt: 100 + 10 * 60_000 }, 101 + CHAT_ACTIVE_MS)).toBe(true);
    expect(sessionWorkingAt({ ...summary, activityExpiresAt: null }, 101)).toBe(false);
    expect(chatSource).toMatch(/else if \(!agent && workerReportedFinish\(summary\)\) badges\.push\(AGENT_BADGE\.sleeping\)/);
    expect(chatSource).toMatch(/if \(sessionWorking\(summary\)\) badges\.push\(AGENT_BADGE\.active\)/);
    expect(chatSource).toMatch(/scheduleToolActivityExpiry/);
  });

  it('lets a worker finish report override its still-recent finish tool call', () => {
    expect(chatSource).toMatch(/\['sleeping', 'finished', 'failed'\]\.includes\(agent\.state\)/);
    expect(chatSource).toMatch(/if \(workerStopped\) badges\.push\(AGENT_BADGE\[agent\.state\]\)/);
  });
});

describe('the session-row chat actions', () => {
  it('keeps current-chat pressure in the conversation detail', () => {
    expect(chatSource).toContain('compactNumber(summary.contextTokens)');
    expect(chatSource).toContain('rough current-chat context tokens');
  });

  it('reserves all three top-right hit targets instead of laying the timestamp underneath them', () => {
    expect(rule('.sess-action')).not.toContain('position: absolute');
    expect(rule('.sess-actions')).toContain('flex: none');
  });

  it('opens and blocks only recorded conversations, and never selects or deletes the adjacent row', () => {
    expect(chatSource).toMatch(/if \(summary\.conversationId\)[\s\S]{0,2000}openSessionChat\(summary\.id\)/);
    expect(chatSource).toMatch(/if \(summary\.conversationId\)[\s\S]{0,2000}toggleSessionBlock\(summary\.id/);
    expect(chatSource).toMatch(/open\.addEventListener\('click',[\s\S]{0,120}event\.stopPropagation\(\)/);
    expect(chatSource).toMatch(/block\.addEventListener\('click',[\s\S]{0,120}event\.stopPropagation\(\)/);
  });

  it('keeps a block visible without hovering, because it is state and not just an action', () => {
    expect(rule('.session-status.is-failed')).toContain('background: var(--red)');
    expect(chatSource).toContain("ui(indicator, 'aria-label', () => t(status.text))");
  });

  /**
   * The Unattributed row is the one row with no chat to block, and it was the one row with no
   * way to stop what it was showing. The switch that governs it is app-wide by necessity — the
   * whole point of the row is that the app cannot say which chat these calls came from — so the
   * button presses the settings checkbox rather than writing a second copy of that state.
   */
  it('blocks the Unattributed row through the one switch that can answer for it', () => {
    expect(chatSource).toMatch(
      /if \(summary\.conversationId === null\)[\s\S]{0,1200}toggleUnattributedBlock\(!blocked\)/
    );
    expect(chatSource).toMatch(
      /toggleUnattributedBlock[\s\S]{0,400}\$<HTMLInputElement>\('allowUnattributedCalls'\)\.checked = !blocked/
    );
    expect(chatSource).toMatch(/unattributedBlocked\(\)[\s\S]{0,200}allowUnattributedCalls === false/);
    // Same word and same tone as a blocked chat: one state, read the same way down the list.
    expect(chatSource).toMatch(/unattributedBlocked\(\)[\s\S]{0,120}text: 'blocked', tone: 'is-failed'/);
    // And the row says what it is, on its own line, because no other row needs explaining.
    expect(rule('.session-diagnostics > summary')).toContain('cursor: pointer');
  });
});

describe('the live worker list', () => {
  it('shows the exact broker id instead of a generic worker role chip', () => {
    expect(chatSource).toMatch(/if \(label !== agent\.id\)[^\n]*agent\.id/);
    expect(chatSource).not.toContain("el('span', 'chip', agent.role)");
  });
});

/**
 * Every card in this app is a grid with an explicit row for each of its children. The
 * Sessions card has three children; the session card has four, because it also carries a
 * navigation row. They shared one three-track template, so on the session card the tracks
 * landed on the wrong children: `.subhead` took the flexible `1fr` track and floated the
 * view switcher into the vertical middle of an empty card, while `.scroll` fell into an
 * implicit `auto` row sized to its whole content and painted the timeline over the header.
 *
 * jsdom does no layout, so this counts tracks against children instead of pixels. That is
 * the invariant that was actually violated, and it is checkable.
 */
describe('the chat panel cards', () => {
  /** The track list a card's own rule declares, as an array. */
  function tracks(selector: string): string[] {
    const declarations = rule(selector);
    const match = /grid-template-rows:([^;]*)/.exec(declarations);
    expect(match, `${selector} declares no grid-template-rows`).not.toBeNull();
    // minmax(0, 1fr) is one track despite its comma.
    return match![1]!.trim().replace(/minmax\([^)]*\)/g, 'minmax').split(/\s+/);
  }

  it('keeps conversations in the persistent sidebar outside the chat canvas', () => {
    const list = document.getElementById('sessionList')!;
    expect(list.closest('.sidebar')).not.toBeNull();
    expect(list.closest('[data-panel]')).toBeNull();
  });

  it('gives the session card one row per child, including its navigation row', () => {
    const card = document.getElementById('chatBody')!.closest('.card')!;
    // Subhead, scrolling conversation, turn status, shared plan/queue dock, composer and footer.
    const layoutChildren = [...card.children].filter(child => child.id !== 'chatSettingsBtn');
    expect(layoutChildren.length).toBe(6);
    expect(document.getElementById('composerDock')!.firstElementChild?.id).toBe('agentPlan');
    expect(document.getElementById('inputQueue')!.closest('#chatBody')).not.toBeNull();
    expect(card.classList.contains('is-session')).toBe(true);
    expect(tracks("[data-panel='chat'] .card.is-session")).toHaveLength(layoutChildren.length);
  });

  it('joins Plan, Goal and Compact rows to the composer without covering their content', () => {
    const dock = rule('.composer-dock');
    const joined = rule(".composer-dock:not([hidden]):has(> :not([hidden])) + .composer");
    expect(dock).toContain('margin: 10px auto -1px');
    expect(dock).not.toContain('margin: 10px auto -15px');
    expect(joined).toContain('margin-top: 0');
  });

  /**
   * The flexible track must be the scrolling body and nothing else. When it landed on
   * `.subhead`, an empty Compaction view pushed the switcher into the middle of the card.
   */
  it('gives the flexible track to the body, not to the navigation row', () => {
    const card = document.getElementById('chatBody')!.closest('.card')!;
    const bodyIndex = [...card.children].filter(child => child.id !== 'chatSettingsBtn').indexOf(document.getElementById('chatBody')!);
    expect(bodyIndex).toBeGreaterThan(-1);
    const list = tracks("[data-panel='chat'] .card.is-session");
    expect(list[bodyIndex]).toBe('minmax');
    expect(list.filter((track) => track === 'minmax')).toHaveLength(1);
  });
});

/**
 * A recorded tool call is a `<details>`. A `<details>` whose `display` is changed stops
 * stacking its summary above its body and lays the two out as siblings — which is how the
 * arguments/result panel came to sit beside the row, pinned to the right edge of the card
 * and clipped. A bare `.tool` rule for the permission checkboxes was matching it.
 */
describe('an expanded tool call', () => {
  it('opens underneath its row rather than beside it', () => {
    expect(rule('.tool')).toContain('display: block');
  });

  it('does not share a selector with the permission checkboxes', () => {
    // The permission row is a `<label class="tool">` laid out in two columns, a checkbox
    // and its text. Scoping that to its container is what keeps the row's own `display`
    // off the timeline's `<details class="tool">`, whichever layout the row uses.
    expect(css).toMatch(/\n\.tools \.tool \{[^}]*display: grid/);
    expect(rule('.tool')).toContain('display: block');
  });
});

/**
 * Every recorded event kind has a row.
 *
 * `eventBody` ends in a `default` arm that renders the words "Unknown event", so a kind
 * added to the recorder and not to the renderer does not fail a build or a type check —
 * it ships, and shows the user grey placeholder rows in their own timeline. That is how
 * `agent_message` came to be unrendered: it was added to the union, written by the
 * recorder, and read by nothing in the renderer.
 *
 * Checked against the union in the shared types rather than a hand-kept list here, so the
 * next kind is covered the moment it is declared.
 */
describe('the settings sheet', () => {
  /**
   * Three rows, and each one is a label, a number, a unit and — where it has one — a
   * switch, side by side. The sheet shipped broken once: `.num` sets the field's width,
   * but the shared `input[type='number']` rule sets `width: 100%`, and a bare class loses
   * that specificity tie. The field stretched across the whole row, squeezed the label to
   * a couple of characters, and pushed the unit and the switch out of the window.
   */
  it('gives the number field a width the shared input rule cannot beat', () => {
    expect(rule('input.num')).toContain('width: 92px');
    expect(rule('.num')).toBe('');
    expect(css.indexOf('input.num {')).toBeGreaterThan(css.indexOf("input[type='number'],"));
  });

  /**
   * The pane's column is capped, not content-sized. A grid with no explicit column gets an
   * implicit `auto` track, and an `auto` track is floored by the widest child's min-content
   * width — which for these rows is the whole of a `white-space: nowrap` hint. Measured in
   * Electron at the window's own 1080px: the track came out 724px inside a 674px content
   * box, so every row overhung by 50px and the card, which clips rather than scrolls
   * sideways, simply ate the switches, the units and the end of "Select model".
   */
  it('caps the settings column instead of letting the widest row size it', () => {
    const pane = rule('.pane');
    expect(pane).toContain('display: grid');
    expect(pane).toContain('grid-template-columns: minmax(0, 1fr)');
  });

  /**
   * A dropdown in a settings row is as wide as its longest option, not as wide as the row.
   * `select` shares the `width: 100%` rule written for the stacked fields in `.field`, and
   * inherited into a flex row that made a five-word menu a 708px control with "Reasoning"
   * squeezed to nothing beside it.
   */
  it('keeps a settings row dropdown at its own width', () => {
    const select = rule('.setting select');
    expect(select).toContain('width: auto');
    expect(select).toContain('flex: 0 0 auto');
    // Same specificity trap as input.num: the shared rule has to come first to lose.
    expect(css.indexOf('\n.setting select {')).toBeGreaterThan(css.indexOf("input[type='number'],"));
  });

  /** The row's action never shrinks; its explanation is the thing that ellipsizes. */
  it('never shrinks the button in a settings row', () => {
    expect(rule('.setting .btn')).toContain('flex: 0 0 auto');
    expect(rule('.setting-text em')).toContain('white-space: normal');
  });

  it('is settings rows and nothing else to read', () => {
    const pane = document.querySelector('.view[data-view="settings"]')!;
    expect(pane.querySelectorAll('h3')).toHaveLength(0);
    // One explanation per row, one clause long.
    for (const row of pane.querySelectorAll('.setting')) {
      expect(row.querySelectorAll('.setting-text em')).toHaveLength(1);
    }
    // Prose is allowed only where a credential or a list needs to report its own state,
    // and only inside that field. A hint loose among the switches is the wall of text this
    // sheet was rebuilt to get rid of.
    for (const hint of pane.querySelectorAll('p.hint')) {
      expect(hint.closest('.field'), 'a hint is loose among the settings rows').not.toBeNull();
    }
  });

  /**
   * The goal loop controls belong together: the switch, key, model, reasoning and editable
   * continuation instruction. The key comes
   * before the picker, because a picker that cannot reach OpenRouter without one is not the
   * first thing to meet.
   */
  it('puts the goal key above the model picker', () => {
    const pane = document.querySelector('.view[data-view="settings"]')!;
    const order = [...pane.querySelectorAll('[id^="goal"]')].map((node) => node.id);
    expect(document.getElementById('goalEnabled')).toBeNull();
    expect(document.getElementById('chatAutomation')!.closest('#composerSettings')).not.toBeNull();
    expect(order.indexOf('goalKey')).toBeLessThan(order.indexOf('goalPick'));
    expect(order.indexOf('goalPick')).toBeLessThan(order.indexOf('goalReasoning'));
    expect(order.indexOf('goalReasoning')).toBeLessThan(order.indexOf('goalPromptEdit'));
    // Closed until asked for: the catalogue is several hundred long and costs a round trip.
    expect(document.getElementById('goalModels')!.hasAttribute('hidden')).toBe(true);
    expect(document.getElementById('goalPromptPanel')!.hasAttribute('hidden')).toBe(true);
    expect(document.getElementById('goalPrompt')?.tagName).toBe('TEXTAREA');
  });

  /** One threshold. Three inputs for the same number is three ways to disagree. */
  it('asks for a single compaction threshold', () => {
    const pane = document.querySelector('.view[data-view="settings"]')!;
    const numbers = [...pane.querySelectorAll('input[type="number"]')].map((input) => input.id);
    expect(numbers).toEqual(['maWorkers', 'autoCompactTokens']);
    for (const id of ['sessRecord', 'sessRetain', 'sessAdvisory', 'sessLimit']) {
      expect(document.getElementById(id), `#${id} is back`).toBeNull();
    }
    expect(document.querySelector('[data-group="recording"]')).toBeNull();
    expect(pane.textContent).not.toContain('Keep recordings');
  });

  /**
   * Every input on the sheet has to be in the change-listener list or it silently does not
   * save. `autoCompactTokens` was missing from it, so the one number the automatic trigger
   * fires on kept whatever was typed until the pane was repainted, and then dropped it.
   */
  it('saves every field it shows', () => {
    const pane = document.querySelector('.view[data-view="settings"]')!;
    const listened = /const CHAT_INPUTS[^=]*=\s*\[([^\]]*)\]/.exec(chatSource);
    expect(listened, 'CHAT_INPUTS is gone or renamed').not.toBeNull();
    for (const input of pane.querySelectorAll<HTMLInputElement>('.pane input')) {
      if (input.id === 'browserOverwrite' || input.id === 'browserDurations') {
        const variable = input.id === 'browserOverwrite' ? 'overwrite' : 'durations';
        expect(browserPreferencesSource).toContain(`('${input.id}')`);
        expect(browserPreferencesSource).toContain(`${variable}.addEventListener('change'`);
        continue;
      }
      // A credential is the one exception, and it is an exception on purpose: it is written
      // on blur through its own channel rather than saved with the settings snapshot, so
      // that a half-typed key never travels. It still has to be wired to something.
      if (input.type === 'password') {
        expect(chatSource, `#${input.id} is never read`).toContain(`$('${input.id}').addEventListener('blur'`);
        continue;
      }
      expect(listened![1], `#${input.id} never saves`).toContain(`'${input.id}'`);
    }
    // Selects and textareas save through the same change listener.
    for (const field of pane.querySelectorAll('select, textarea')) {
      // Interface language persists in the renderer; the event/storage behavior is
      // covered by renderer-i18n, independently of the app configuration channel.
      if (field.id === 'uiLanguage') continue;
      expect(listened![1], `#${field.id} never saves`).toContain(`'${field.id}'`);
    }
  });
});

describe('the session timeline', () => {
  it('renders every event kind the recorder can write', async () => {
    const [shared, chat] = await Promise.all([
      fs.readFile(path.join(process.cwd(), 'src', 'shared', 'session.ts'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'chat.ts'), 'utf8')
    ]);
    const union = shared.slice(shared.indexOf('export type SessionEvent ='), shared.indexOf('export type SessionEventKind'));
    const declared = [...new Set([...union.matchAll(/\bkind: '([a-z_]+)'/g)].map((match) => match[1]!))];
    expect(declared.length).toBeGreaterThan(5);

    const body = chat.slice(chat.indexOf('function eventBody'));
    const handled = new Set([...body.slice(0, body.indexOf('\n}')).matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]!));
    expect(declared.filter((kind) => !handled.has(kind))).toEqual([]);
  });
});

describe('the window as a whole', () => {
  it('keeps the Files toolbar on one stable row and integrates Refresh with its actions', () => {
    expect(rule('.file-panel-toolbar')).toContain('flex-wrap: nowrap');
    expect(rule('.file-panel-toolbar')).toContain('overflow-x: auto');
    expect(rule('.file-panel-toolbar .file-panel-action')).toContain('flex: 0 0 auto');
    expect(rule('.file-panel-refresh')).toContain('flex: 0 0 30px');
    expect(rule('.file-panel-refresh')).not.toContain('margin-left');
    expect(css).not.toContain('.file-panel-toolbar .file-panel-action span { display: none; }');
  });

  it('keeps right work-panel grid tracks interpolation-compatible with their closed state', () => {
    const closed = rule("[data-panel='chat']");
    const open = rule("[data-panel='chat'].has-agent-panel,\n[data-panel='chat'].has-file-panel,\n[data-panel='chat'].has-browser-panel");
    expect(closed).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 0px)');
    expect(closed).toContain('transition: grid-template-columns 220ms cubic-bezier(.16, 1, .3, 1)');
    expect(open).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, var(--work-panel-width, 42%))');
  });

  it('anchors composer rows to the bottom while its measured height animates', () => {
    expect(rule('.composer')).toContain('align-content: end');
    expect(rule('.composer.is-resizing')).toContain('overflow: clip');
    expect(rule('.composer.is-resizing')).toContain('will-change: height');
  });

  it('keeps workspace settings in a scrollable column', () => {
    expect(rule("[data-panel='home']")).toContain('overflow-y: auto');
    expect(rule('#rootsEmpty')).toContain('margin: 0');
    expect(rule('#rootsEmpty')).toContain('padding: 10px 14px');
    expect(rule('#rootsEmpty')).toContain('line-height: 1.5');
  });

  /**
   * Two panels each had a `#agentFilter`. `getElementById` only ever returns the first, so
   * the Activity panel's filter was unreachable and two modules bound handlers to the same
   * node. Ids are the app's only wiring between markup and script; duplicates are a bug.
   */
  it('has no duplicate element ids', () => {
    const seen = new Map<string, number>();
    for (const node of document.querySelectorAll('[id]')) {
      seen.set(node.id, (seen.get(node.id) ?? 0) + 1);
    }
    const duplicates = [...seen].filter(([, count]) => count > 1).map(([id]) => id);
    expect(duplicates).toEqual([]);
  });

  it('never scrolls sideways', () => {
    // Authored tables/code and dense Usage data may scroll locally; the
    // surrounding app must not.
    const horizontal = [...css.matchAll(/([^{}]+)\{[^{}]*overflow-x:\s*(?:auto|scroll)[^{}]*\}/g)];
    expect(horizontal.map(match => match[1]!.trim())).toEqual([
      '.msg.rich .markdown-table',
      '.usage-heatmap-surface',
      '.usage-table-stack',
      '.browser-use-tabs-viewport',
      '.file-panel-toolbar',
      '.file-preview-markdown pre',
      '.file-preview-markdown-table',
      '.file-pdf-viewport',
      '.terminal-tabs'
    ]);
    expect(css).not.toMatch(/overflow:\s*(auto|scroll)\s+/);
    // The one scrolling surface in the app is vertical only.
    expect(rule('.scroll')).toContain('overflow: hidden auto');
  });

  it('keeps setup and settings vertically reachable when the window is short', () => {
    // The page itself stays fixed so header/nav remain put; long forms own the vertical scroll.
    expect(rule("[data-panel='setup'].is-active")).toContain('overflow: hidden auto');

    const settings = document.querySelector('.view[data-view="settings"]')!;
    const settingsScroller = settings.closest('#chatBody.scroll');
    expect(settingsScroller, 'settings is not inside the bounded scrolling body').not.toBeNull();
    expect(rule('.scroll')).toContain('overflow: hidden auto');
  });
});
