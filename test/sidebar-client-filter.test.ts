import { expect, it, vi } from 'vitest';
import {
  SIDEBAR_CLIENT_STORAGE_KEY,
  geminiSidebarPresence,
  loadSidebarClientFilter,
  matchesSidebarClientFilter,
  normalizeSidebarClientFilter,
  saveSidebarClientFilter,
  sessionClientKind
} from '../src/renderer/sidebar-client.js';
import { inboxChat, inboxProjects, listed, mountChat, mountInbox, waitFor } from './renderer-state.harness.js';

vi.mock('../src/renderer/workspace-terminal.js', () => ({ createWorkspaceTerminal: () => ({
  update: vi.fn(), show: vi.fn(), hide: vi.fn(), newTab: vi.fn(() => null),
  tabs: vi.fn(() => []), selectTab: vi.fn(), closeTab: vi.fn()
}) }));
vi.mock('../src/renderer/pet.js', () => ({ initPet: () => Object.assign(() => {}, { toggle: () => {}, isVisible: () => false }) }));

it('classifies and filters ChatGPT, Gemini, other external, worker, and unattributed sessions', () => {
  const gpt = inboxChat('gpt-1');
  const gemini = inboxChat('gem-1', { conversationId: null, chatIds: [], mcpClient: { id: 'gemini', name: 'Gemini' } });
  const geminiWeb = inboxChat('gem-web-1', { conversationId: 'gemini-8f3b2c1d9e0a4567', chatIds: ['gemini-8f3b2c1d9e0a4567'] });
  const claude = inboxChat('cla-1', { conversationId: null, chatIds: [], mcpClient: { id: 'claude', name: 'Claude' } });
  const gptWorker = inboxChat('wrk-1', { origin: { kind: 'worker', fromSessionId: gpt.id, agentId: 'worker-1' } });
  const gemWorker = inboxChat('wrk-2', { origin: { kind: 'worker', fromSessionId: gemini.id, agentId: 'worker-1' } });
  const gemWebWorker = inboxChat('wrk-3', { origin: { kind: 'worker', fromSessionId: geminiWeb.id, agentId: 'worker-1' } });
  const unattributed = inboxChat('unattr-1', { conversationId: null, chatIds: [], origin: null, title: 'Unattributed activity' });

  const parents = new Map([gpt, gemini, geminiWeb, claude, unattributed].map(entry => [entry.id, entry] as const));

  expect(sessionClientKind(gpt, parents)).toBe('chatgpt');
  expect(sessionClientKind(gemini, parents)).toBe('gemini');
  expect(sessionClientKind(geminiWeb, parents)).toBe('gemini');
  expect(sessionClientKind(claude, parents)).toBe('other-external');
  expect(sessionClientKind(gptWorker, parents)).toBe('chatgpt');
  expect(sessionClientKind(gemWorker, parents)).toBe('gemini');
  expect(sessionClientKind(gemWebWorker, parents)).toBe('gemini');
  expect(sessionClientKind(unattributed, parents)).toBe('unattributed');

  expect(matchesSidebarClientFilter(gpt, 'all', parents)).toBe(true);
  expect(matchesSidebarClientFilter(gemini, 'all', parents)).toBe(true);
  expect(matchesSidebarClientFilter(claude, 'all', parents)).toBe(true);

  expect(matchesSidebarClientFilter(gpt, 'chatgpt', parents)).toBe(true);
  expect(matchesSidebarClientFilter(gptWorker, 'chatgpt', parents)).toBe(true);
  expect(matchesSidebarClientFilter(gemini, 'chatgpt', parents)).toBe(false);
  expect(matchesSidebarClientFilter(claude, 'chatgpt', parents)).toBe(false);

  expect(matchesSidebarClientFilter(gemini, 'gemini', parents)).toBe(true);
  expect(matchesSidebarClientFilter(gemWorker, 'gemini', parents)).toBe(true);
  expect(matchesSidebarClientFilter(gpt, 'gemini', parents)).toBe(false);
  expect(matchesSidebarClientFilter(claude, 'gemini', parents)).toBe(false);
  expect(matchesSidebarClientFilter(unattributed, 'gemini', parents)).toBe(false);

  expect(normalizeSidebarClientFilter('bogus')).toBe('all');
});

it('switches between All, ChatGPT, and Gemini in inbox mode, combines with project groups, and restores choice', async () => {
  const now = Date.now();
  const { alpha, beta } = inboxProjects();
  const gptAlpha = inboxChat('gpt-alpha', { projectId: alpha.id, updatedAt: now });
  const gemAlpha = inboxChat('gem-alpha', {
    projectId: alpha.id,
    conversationId: null,
    chatIds: [],
    title: 'Gemini Workspace',
    mcpClient: { id: 'gemini', name: 'Gemini', version: '1.0' },
    updatedAt: now - 1000
  });
  const gemLoose = inboxChat('gem-loose', {
    conversationId: null,
    chatIds: [],
    title: 'Gemini Notes',
    mcpClient: { id: 'gemini', name: 'Gemini' },
    updatedAt: now - 2000
  });
  const unattributed = inboxChat('unattr-row', {
    conversationId: null,
    chatIds: [],
    origin: null,
    title: 'Unattributed activity',
    updatedAt: now - 3000
  });

  const mounted = await mountInbox({
    listProjects: async () => ({ ok: true, data: [alpha, beta] }),
    listSessions: async () => listed([gptAlpha, gemAlpha, gemLoose, unattributed])
  });
  const doc = mounted.window.document;
  const tab = (id: 'all' | 'chatgpt' | 'gemini') =>
    doc.querySelector<HTMLButtonElement>(`#sidebarClientSwitch [data-sidebar-client="${id}"]`)!;

  await waitFor(() => expect(doc.querySelectorAll('.sess')).toHaveLength(4));
  expect(tab('all').getAttribute('aria-pressed')).toBe('true');

  // Switch to Gemini: shows both Gemini sessions (with Gemini label on unfiled card) and hides ChatGPT + Unattributed.
  tab('gemini').click();
  await waitFor(() => expect(doc.querySelector(`.sess[data-id="${gptAlpha.id}"]`)).toBeNull());
  expect(tab('gemini').getAttribute('aria-pressed')).toBe('true');
  expect(doc.querySelector(`.sess[data-id="${gemAlpha.id}"]`)).not.toBeNull();
  expect(doc.querySelector(`.sess[data-id="${gemLoose.id}"]`)).not.toBeNull();
  expect(doc.querySelector(`.sess[data-id="${gemLoose.id}"] .sess-project`)?.textContent).toBe('Gemini');
  expect(doc.querySelector('.session-diagnostics')).toBeNull();

  // Combine Gemini filter with Project Alpha in the Inbox project picker: shows only Alpha's Gemini chat.
  doc.querySelector<HTMLButtonElement>('#chatList [data-inbox-control="picker"]')!.click();
  [...doc.querySelectorAll<HTMLButtonElement>('.inbox-project-picker [role="option"]')]
    .find(option => option.textContent === 'Alpha')!
    .click();
  expect(doc.querySelector(`.sess[data-id="${gemAlpha.id}"]`)).not.toBeNull();
  expect(doc.querySelector(`.sess[data-id="${gemLoose.id}"]`)).toBeNull();

  // Combine ChatGPT filter with Project Alpha: shows only Alpha's ChatGPT chat.
  tab('chatgpt').click();
  expect(doc.querySelector(`.sess[data-id="${gptAlpha.id}"]`)).not.toBeNull();
  expect(doc.querySelector(`.sess[data-id="${gemAlpha.id}"]`)).toBeNull();

  // Switch to Project Beta under Gemini (0 Gemini chats): renders helpful empty state + Reset & Open Gemini setup.
  doc.querySelector<HTMLButtonElement>('#chatList [data-inbox-control="picker"]')!.click();
  [...doc.querySelectorAll<HTMLButtonElement>('.inbox-project-picker [role="option"]')]
    .find(option => option.textContent === 'Bêta')!
    .click();
  tab('gemini').click();
  await waitFor(() => expect(doc.querySelector('[data-sidebar-empty-action="gemini-setup"]')?.textContent).toBe('Open Gemini setup'));
  doc.querySelector<HTMLButtonElement>('[data-sidebar-empty-action="show-all"]')!.click();
  expect(tab('all').getAttribute('aria-pressed')).toBe('true');

  // Keyboard ArrowRight advances from All -> ChatGPT -> Gemini and saves preference.
  tab('all').focus();
  tab('all').dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(tab('chatgpt').getAttribute('aria-pressed')).toBe('true');
  expect(mounted.window.localStorage.getItem(SIDEBAR_CLIENT_STORAGE_KEY)).toBe('chatgpt');

  saveSidebarClientFilter('gemini', mounted.window.localStorage);
  expect(loadSidebarClientFilter(mounted.window.localStorage)).toBe('gemini');
});

it('filters projects and chat groups in classic projects tree layout and shows live Gemini dot', async () => {
  const now = Date.now();
  const { alpha, beta } = inboxProjects();
  const gemAlpha = inboxChat('gem-proj-1', {
    projectId: alpha.id,
    conversationId: null,
    chatIds: [],
    title: 'Gemini Alpha',
    mcpClient: { id: 'gemini', name: 'Gemini' },
    updatedAt: now
  });
  const gptBeta = inboxChat('gpt-proj-1', {
    projectId: beta.id,
    title: 'ChatGPT Beta',
    updatedAt: now
  });

  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [alpha, beta] }),
    listSessions: async () => listed([gemAlpha, gptBeta]),
    chatGroups: async () => ({
      ok: true,
      data: {
        version: 1,
        groups: [
          { id: 'grp-gem', projectId: alpha.id, name: 'Gemini group' },
          { id: 'grp-gpt', projectId: alpha.id, name: 'ChatGPT group' }
        ],
        members: { [gemAlpha.id]: 'grp-gem' }
      }
    })
  });

  const doc = mounted.window.document;
  const geminiTab = doc.querySelector<HTMLButtonElement>('#sidebarClientSwitch [data-sidebar-client="gemini"]')!;
  await waitFor(() => expect(doc.querySelector(`[data-project-id="${beta.id}"]`)).not.toBeNull());

  // Switching to Gemini hides Project Beta (ChatGPT-only) and empty ChatGPT sub-groups inside Alpha.
  geminiTab.click();
  expect(doc.querySelector(`[data-project-id="${alpha.id}"]`)).not.toBeNull();
  expect(doc.querySelector(`[data-project-id="${beta.id}"]`)).toBeNull();
  expect(doc.querySelector('[data-group-id="grp-gem"]')).not.toBeNull();
  expect(doc.querySelector('[data-group-id="grp-gpt"]')).toBeNull();

  // Live bridge or working Gemini session illuminates the Gemini pill indicator dot.
  expect(geminiSidebarPresence(mounted.state, []).live).toBe(false);
  mounted.push({
    ...mounted.state,
    status: {
      ...mounted.state.status,
      geminiBridge: {
        mode: 'tailscale',
        state: 'live',
        publicOrigin: 'https://inmersion.tail1b6353.ts.net',
        localPort: 41931,
        actionUrl: null,
        detail: 'Live'
      }
    }
  });
  await waitFor(() => expect(geminiTab.classList.contains('is-live')).toBe(true));
});
