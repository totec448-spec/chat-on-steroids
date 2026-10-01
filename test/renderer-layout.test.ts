/**
 * Markup, settings wiring and session activity contracts.
 * Pixel layout is exercised by scripts/verify-*.cjs in real Electron;
 * jsdom does not apply the CSS cascade or measure layout.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { filterSettingsSections } from '../src/renderer/dom.js';
import { sessionWorkingAt } from '../src/shared/session-activity.js';
import { CHAT_ACTIVE_MS, type SessionSummary } from '../src/shared/session.js';

let document: Document;
let dom: JSDOM;
let chatSource = '';
let browserPreferencesSource = '';

beforeAll(async () => {
  browserPreferencesSource = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'browser-preferences.ts'), 'utf8');
  const [html, chat] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'chat.ts'), 'utf8')
  ]);
  dom = new JSDOM(html);
  document = dom.window.document;
  chatSource = chat;
});
afterAll(() => dom.window.close());

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

it('limits the existing tool-detail preference to handoff briefs', () => {
  const toggle = document.getElementById('goalIncludeToolCalls') as HTMLInputElement;
  expect(toggle.type).toBe('checkbox');
  expect(toggle.checked).toBe(false);
  expect(toggle.closest('label')?.textContent).toContain('Include tool details in handoffs');
  expect(toggle.closest('label')?.textContent).toContain('Goal and Loop use user messages and assistant updates and answers');
  expect(chatSource).toContain("includeToolCalls: $<HTMLInputElement>('goalIncludeToolCalls').checked");
  expect(chatSource).toContain("applyChatChecked($<HTMLInputElement>('goalIncludeToolCalls')");
});

it('places context before the model picker and keeps native compaction actions in its dialog', () => {
  const group = document.getElementById('composerSettings')!.parentElement!;
  expect(group.classList.contains('composer-primary-controls')).toBe(true);
  expect(document.getElementById('contextMeter')!.nextElementSibling?.id).toBe('modelMenu');
  expect(document.getElementById('compactSession')!.closest('[role=dialog]')?.id).toBe('contextMeterInfo');
  expect(document.getElementById('cancelCompaction')!.closest('[role=dialog]')?.id).toBe('contextMeterInfo');
  expect(document.getElementById('contextMeterInfo')!.parentElement?.id).toBe('contextMeter');
});

it('centers the accessible Chats refresh icon without an extra grid text row', () => {
  const refresh = document.getElementById('chatRefresh')!;
  expect(refresh.getAttribute('aria-label')).toBe('Refresh chats');
  expect(refresh.children).toHaveLength(1);
  expect(refresh.firstElementChild?.matches('i.ico.ph.ph-arrow-clockwise[aria-hidden="true"]')).toBe(true);
  expect(refresh.textContent?.trim()).toBe('');
});

it('uses the fork back-to-chat control and separates the Usage cost sections', () => {
  const back = document.getElementById('backToChat')!;
  expect(back.querySelector('.ph-arrow-left')).not.toBeNull();
  expect(back.querySelector('span')?.textContent).toBe('Back to chat');
  const costCaption = document.getElementById('usageCost')!;
  expect(costCaption.closest('.settings-section-head')?.querySelector('h2')?.textContent).toBe('Cost estimate per day');
  expect(document.querySelectorAll('#usageCost')).toHaveLength(1);
});

describe('the session card header', () => {
  /**
   * A gear, and nothing that starts work. Compact & resume is pressed in the ChatGPT tab,
   * because the chat is what writes the brief — a button here would be a second way to
   * start the one thing that must happen exactly once.
   */
  it('keeps global connection status out of the chat header and in the sidebar footer', () => {
    const header = document.querySelector('#chatTitle')!.closest('header')!;
    const connection = document.getElementById('sidebarConnection')!;
    const footer = connection.closest('.sidebar-bottom')!;
    expect(header.contains(connection)).toBe(false);
    expect(footer).not.toBeNull();
    expect([...footer.children].map((node) => (node as HTMLElement).id || (node as HTMLElement).className)).toEqual([
      'workspaceSettings',
      'connection-anchor'
    ]);
    expect(document.getElementById('connectionPopover')!.closest('.connection-anchor')).not.toBeNull();
    expect(document.getElementById('connectionAdvanced')).not.toBeNull();
    expect(document.getElementById('connectionAdvancedGrid')).not.toBeNull();
    expect(document.getElementById('sessionControls')!.closest('#composerSettings')).not.toBeNull();
    expect(header.querySelector('.session-controls')).toBeNull();
  });

  it('has a place to say what is happening without opening the Activity log', () => {
    const note = document.getElementById('chatState')!;
    expect(note.closest('.subhead')).not.toBeNull();
  });
});

describe('a session row', () => {
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

  it('opens and blocks only recorded conversations, and never selects or deletes the adjacent row', () => {
    expect(chatSource).toMatch(/if \(summary\.conversationId\)[\s\S]{0,2000}openSessionChat\(summary\.id\)/);
    expect(chatSource).toMatch(/if \(summary\.conversationId\)[\s\S]{0,2000}toggleSessionBlock\(summary\.id/);
    expect(chatSource).toMatch(/open\.addEventListener\('click',[\s\S]{0,120}event\.stopPropagation\(\)/);
    expect(chatSource).toMatch(/block\.addEventListener\('click',[\s\S]{0,120}event\.stopPropagation\(\)/);
  });

  it('gives the session status an accessible translated label', () => {
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
  });
});

describe('the chat panel cards', () => {
  it('keeps conversations in the persistent sidebar outside the chat canvas', () => {
    const list = document.getElementById('sessionList')!;
    expect(list.closest('.sidebar')).not.toBeNull();
    expect(list.closest('[data-panel]')).toBeNull();
  });

  it('keeps the plan and queue in their conversation host', () => {
    const card = document.getElementById('chatBody')!.closest('.card')!;
    const dockBody = document.getElementById('composerDock')!.firstElementChild!;
    expect(dockBody.classList.contains('composer-dock-body')).toBe(true);
    expect(dockBody.firstElementChild?.id).toBe('agentPlan');
    expect(document.getElementById('inputQueue')!.closest('#chatBody')).not.toBeNull();
    expect(card.classList.contains('is-session')).toBe(true);
  });

});

describe('the settings sheet', () => {

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
    expect(document.getElementById('handoffPromptPanel')!.hasAttribute('hidden')).toBe(true);
    expect(document.getElementById('handoffPrompt')?.tagName).toBe('TEXTAREA');
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

  it('keeps settings inside the conversation scrolling body', () => {
    const settings = document.querySelector('.view[data-view="settings"]')!;
    const settingsScroller = settings.closest('#chatBody.scroll');
    expect(settingsScroller, 'settings is not inside the bounded scrolling body').not.toBeNull();
  });
});
