import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_GOAL_SYSTEM_PROMPT, DEFAULT_HANDOFF_PROMPT, catalogue, mountChat, projectSidebarFixture, settle, waitFor } from './renderer-state.harness.js';

vi.mock('../src/renderer/workspace-terminal.js', () => ({ createWorkspaceTerminal: () => ({
  update: vi.fn(), show: vi.fn(), hide: vi.fn(), newTab: vi.fn(() => null),
  tabs: vi.fn(() => []), selectTab: vi.fn(), closeTab: vi.fn()
}) }));
// Native animation/media APIs are covered by pet DOM and real Electron tests.
vi.mock('../src/renderer/pet.js', () => ({ initPet: () => Object.assign(() => {}, { toggle: () => {}, isVisible: () => false }) }));


/**
 * The version difference has a direction, and only one of them is the user's to act on.
 *
 * An extension newer than the app is the ordinary state while an app update is downloading, and
 * the bundled folder is then the older copy: "load the extension folder again" would talk that
 * user into downgrading a working extension. The app-update line already owns being behind.
 */
it('asks for an extension reload only when the extension is older than this app', async () => {
  const mounted = await mountChat({
    bridge: {
      running: true, port: 8765, paired: true, present: true, lastSeenAt: Date.now(), extensionVersion: '2.0.1'
    }
  });
  const doc = mounted.window.document;
  const notice = doc.getElementById('updateNotice')!;
  expect(notice.hidden).toBe(false);
  expect(doc.getElementById('updateText')!.textContent).toContain('2.0.1');
  const action = doc.getElementById('updateExtension') as HTMLButtonElement;
  expect(action.hidden).toBe(false);
  action.click();
  expect(doc.querySelector('[data-panel="setup"]')!.classList.contains('is-active')).toBe(true);
  const rejected = structuredClone(mounted.state) as any;
  rejected.bridge.present = false;
  mounted.push(rejected);
  expect(notice.hidden, 'an old companion rejected by the protocol gate still needs an update').toBe(false);

  const ahead = structuredClone(mounted.state) as any;
  ahead.bridge.extensionVersion = '2.0.3';
  mounted.push(ahead);
  expect(notice.hidden, 'a newer extension is not a downgrade prompt').toBe(true);
  expect(action.hidden).toBe(true);
});

// 2.1.39 release round: the VM's Firefox still ran the 2.1.38 add-on, and the notice told the person
// to reload the extension from the app's folder. Firefox runs the signed add-on and updates it itself.
it('tells a Firefox user how Firefox updates its add-on instead of pointing at the app folder', async () => {
  const mounted = await mountChat({
    bridge: {
      running: true, port: 8765, paired: true, present: true, lastSeenAt: Date.now(), extensionVersion: '2.0.1',
      externalExtension: { present: true, version: '2.0.1', lastSeenAt: Date.now(), engine: 'gecko' }
    }
  });
  const text = mounted.window.document.getElementById('updateText')!.textContent!;
  expect(text).toContain('2.0.1');
  expect(text).toContain('about:addons');
  expect(text).not.toContain('folder');
});

// The outdated copy may be Firefox's while Chrome, current, was the last browser to report in.
it('gives Firefox advice when the outdated extension is Firefox’s, whichever browser reported last', async () => {
  const mounted = await mountChat({
    bridge: {
      running: true, port: 8765, paired: true, present: true, lastSeenAt: Date.now(), extensionVersion: '2.0.1', extensionEngine: 'gecko',
      externalExtension: { present: true, version: '2.0.2', lastSeenAt: Date.now() }
    }
  });
  const text = mounted.window.document.getElementById('updateText')!.textContent!;
  expect(text).toContain('2.0.1');
  expect(text).toContain('about:addons');
  expect(text).not.toContain('folder');
});

it('shows a missing-extension reminder while connected and clears it after the companion reports in', async () => {
  const mounted = await mountChat();
  const connected = structuredClone(mounted.state) as any;
  connected.status.state = 'connected'; connected.bridge.running = true; connected.bridge.present = false;
  mounted.push(connected);
  const doc = mounted.window.document;
  expect(doc.getElementById('updateText')!.textContent).toContain('Browser extension not connected');
  expect(doc.getElementById('updateExtension')!.hidden).toBe(false);
  connected.bridge.present = true; connected.bridge.extensionVersion = connected.update.current;
  mounted.push(connected);
  expect(doc.getElementById('updateNotice')!.hidden).toBe(true);
});

it('keeps plugin connection controls out of general Setup and preserves its tunnel during unrelated saves', async () => {
  const mounted = await mountChat(); const doc = mounted.window.document;
  const next = structuredClone(mounted.state); next.config.tunnel.pluginsTunnelId = 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  mounted.push(next);
  expect(doc.querySelector('[data-panel="setup"] #pluginsTunnelId')).toBeNull();
  const input = doc.getElementById('tunnelId') as HTMLInputElement;
  input.value = 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  input.dispatchEvent(new mounted.window.Event('change')); await settle();
  expect(mounted.calls.at(-1).tunnel.pluginsTunnelId).toBe(next.config.tunnel.pluginsTunnelId);
  expect(doc.querySelector('[data-panel="setup"] [data-link="https://chatgpt.com/plugins"]')).not.toBeNull();
});

/**
 * The exact sentence, because it is the same sentence the composer's settings sheet shows
 * and the two are meant to be recognisably one message rather than two paraphrases.
 */
it('reports stored API credentials without exposing app-wide Goal switches', async () => {
  const mounted = await mountChat();
  expect(mounted.window.document.getElementById('goalEnabled')).toBeNull();
  expect((mounted.window.document.getElementById('goalKeyRemove') as HTMLButtonElement).disabled).toBe(true);

  mounted.push({ ...mounted.state, hasGoalKey: true });
  await settle();
  expect(mounted.window.document.getElementById('goalKeyState')!.textContent).toContain('A key is stored');
  expect((mounted.window.document.getElementById('goalKeyRemove') as HTMLButtonElement).disabled).toBe(false);
});

/**
 * The key goes to the one channel that encrypts it and never to the settings file. This is
 * the whole reason the goal request is made by the app and not by the extension, so it is
 * worth an assertion rather than a comment.
 */
it('sends the key to the secret store and never into the settings patch', async () => {
  const mounted = await mountChat();
  const field = mounted.window.document.getElementById('goalKey') as HTMLInputElement;
  field.value = 'sk-or-v1-not-a-real-key';
  field.dispatchEvent(new mounted.window.Event('blur'));
  await settle();

  expect(mounted.keys).toEqual([{ method: 'setGoalKey', value: 'sk-or-v1-not-a-real-key' }]);
  // Cleared from the input as well: a stored key has no reason to stay on screen.
  expect(field.value).toBe('');
  expect(JSON.stringify(mounted.calls)).not.toContain('sk-or-v1');
});

it('keeps secret-key input on secure-storage failure', async () => {
  const failed = await mountChat({}, [], {
    setGoalKey: () => Promise.resolve({ ok: false, error: 'safeStorage unavailable' }),
    setApiKey: () => Promise.resolve({ ok: false, error: 'safeStorage unavailable' })
  });
  const goalFailed = failed.window.document.getElementById('goalKey') as HTMLInputElement;
  goalFailed.value = 'sk-or-v1-retry-me';
  goalFailed.dispatchEvent(new failed.window.Event('blur'));
  const apiFailed = failed.window.document.getElementById('apiKey') as HTMLInputElement;
  apiFailed.value = 'sk-retry-me';
  apiFailed.dispatchEvent(new failed.window.Event('blur'));
  await settle();
  expect(goalFailed.value).toBe('sk-or-v1-retry-me');
  expect(apiFailed.value).toBe('sk-retry-me');
});

it('never lets an older secret save erase a newer value typed while IPC is in flight', async () => {
  let releaseGoal!: (value: any) => void;
  let releaseApi!: (value: any) => void;
  const deferred = await mountChat({}, [], {
    setGoalKey: () => new Promise((resolve) => (releaseGoal = resolve)),
    setApiKey: () => new Promise((resolve) => (releaseApi = resolve))
  });
  const goal = deferred.window.document.getElementById('goalKey') as HTMLInputElement;
  goal.value = 'sk-or-v1-old';
  goal.dispatchEvent(new deferred.window.Event('blur'));
  goal.value = 'sk-or-v1-new';
  const api = deferred.window.document.getElementById('apiKey') as HTMLInputElement;
  api.value = 'sk-old';
  api.dispatchEvent(new deferred.window.Event('blur'));
  api.value = 'sk-new';

  releaseGoal({ ok: true, data: { ...deferred.state, hasGoalKey: true } });
  releaseApi({ ok: true, data: { ...deferred.state, hasApiKey: true } });
  await settle();
  await settle();
  expect(goal.value).toBe('sk-or-v1-new');
  expect(api.value).toBe('sk-new');
});

it('does not turn whitespace in the OpenRouter key field into a remove-key request', async () => {
  const mounted = await mountChat({ hasGoalKey: true });
  const field = mounted.window.document.getElementById('goalKey') as HTMLInputElement;
  field.value = '   ';
  field.dispatchEvent(new mounted.window.Event('blur'));
  await settle();
  expect(mounted.keys).toEqual([]);
  expect(field.value).toBe('   ');
});

it('opens, saves and restores the editable goal prompt', async () => {
  const mounted = await mountChat({ hasGoalKey: true });
  const doc = mounted.window.document;
  const panel = doc.getElementById('goalPromptPanel')!;
  const edit = doc.getElementById('goalPromptEdit') as HTMLButtonElement;
  const prompt = doc.getElementById('goalPrompt') as HTMLTextAreaElement;

  expect(panel.hidden).toBe(true);
  edit.click();
  expect(panel.hidden).toBe(false);
  expect(prompt.value).toBe(DEFAULT_GOAL_SYSTEM_PROMPT);

  prompt.value = 'custom gate: continue only explicit missing work. otherwise NO_REPLY.';
  prompt.dispatchEvent(new mounted.window.Event('change'));
  await settle();
  await settle();
  expect(mounted.calls.at(-1)?.goal.prompt).toBe(prompt.value);

  (doc.getElementById('goalPromptReset') as HTMLButtonElement).click();
  await settle();
  await settle();
  expect(prompt.value).toBe(DEFAULT_GOAL_SYSTEM_PROMPT);
  expect(mounted.calls.at(-1)?.goal.prompt).toBe(DEFAULT_GOAL_SYSTEM_PROMPT);
});

it('asks before Clear workers ends running workers and removes their histories', async () => {
  const resetSwarm = vi.fn(async () => ({ ok: true as const, data: { running: false, agents: [], retainedHistory: false } }));
  const mounted = await mountChat({ hasGoalKey: true }, [], { resetSwarm });
  const w = mounted.window;
  const button = w.document.getElementById('swarmReset') as HTMLButtonElement;
  button.disabled = false;
  const confirm = vi.fn(() => false);
  w.confirm = confirm;
  button.click();
  await settle();
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('removed for good'));
  expect(resetSwarm).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  button.click();
  await settle();
  expect(resetSwarm).toHaveBeenCalledTimes(1);
});

it('opens, saves and restores the editable handoff prompt', async () => {
  const mounted = await mountChat({ hasGoalKey: true });
  const doc = mounted.window.document;
  const panel = doc.getElementById('handoffPromptPanel')!;
  const edit = doc.getElementById('handoffPromptEdit') as HTMLButtonElement;
  const prompt = doc.getElementById('handoffPrompt') as HTMLTextAreaElement;

  expect(panel.hidden).toBe(true);
  edit.click();
  expect(panel.hidden).toBe(false);
  expect(prompt.value).toBe(DEFAULT_HANDOFF_PROMPT);

  prompt.value = 'Keep only continuation-critical state and the exact next action.';
  prompt.dispatchEvent(new mounted.window.Event('change'));
  await settle();
  await settle();
  expect(mounted.calls.at(-1)?.compaction.handoffPrompt).toBe(prompt.value);

  (doc.getElementById('handoffPromptReset') as HTMLButtonElement).click();
  await settle();
  await settle();
  expect(prompt.value).toBe(DEFAULT_HANDOFF_PROMPT);
  expect(mounted.calls.at(-1)?.compaction.handoffPrompt).toBe(DEFAULT_HANDOFF_PROMPT);
});

it('saves the Continue prompt from its editor, and Restore default sends the built-in phrases again', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const automation = doc.querySelector('[data-view="settings"]')!;
  const panel = doc.getElementById('customContinuePanel')!;
  const prompt = doc.getElementById('customContinue') as HTMLTextAreaElement;
  expect(automation.contains(prompt)).toBe(true);
  expect(prompt.maxLength).toBe(500);
  expect(panel.hidden).toBe(true);
  (doc.getElementById('customContinueEdit') as HTMLButtonElement).click();
  expect(panel.hidden).toBe(false);
  expect(prompt.value).toBe('');

  prompt.value = '  Keep going and run the tests at the end.  ';
  prompt.dispatchEvent(new mounted.window.Event('change'));
  await waitFor(() => expect(mounted.calls.at(-1)?.ui.customContinue).toBe('Keep going and run the tests at the end.'));

  (doc.getElementById('customContinueReset') as HTMLButtonElement).click();
  await waitFor(() => expect(mounted.calls.at(-1)?.ui).toMatchObject({ customContinue: undefined }));
  expect(prompt.value).toBe('');
});

it('saves Personality and Writing style from their editors: own text, left out when empty, default again on Restore (#1856)', async () => {
  const { DEFAULT_CHAT_PERSONALITY, DEFAULT_CHAT_WRITING_STYLE, MAX_CHAT_STYLE_CHARS } = await import('../src/shared/chat-style.js');
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const automation = doc.querySelector('[data-view="settings"]')!;
  for (const [id, fallback] of [['chatPersonality', DEFAULT_CHAT_PERSONALITY], ['chatWritingStyle', DEFAULT_CHAT_WRITING_STYLE]] as const) {
    const panel = doc.getElementById(`${id}Panel`)!;
    const box = doc.getElementById(id) as HTMLTextAreaElement;
    expect(automation.contains(box)).toBe(true);
    expect(box.maxLength).toBe(MAX_CHAT_STYLE_CHARS);
    expect(panel.hidden).toBe(true);
    (doc.getElementById(`${id}Edit`) as HTMLButtonElement).click();
    expect(panel.hidden).toBe(false);
    // The built-in text is what it starts from, so a change edits it rather than starting blank.
    expect(box.value).toBe(fallback);
    // What new chats get, said under the editor once it is saved (Haz on #1859).
    const said = () => doc.getElementById(`${id}State`)!.textContent;
    expect(said()).toBe('New chats use the built-in text.');
    expect(box.classList.contains('is-content-sized')).toBe(true);
    box.value = '  Short, plain answers.  ';
    box.dispatchEvent(new mounted.window.Event('change'));
    await waitFor(() => expect(mounted.calls.at(-1)?.ui[id]).toBe('Short, plain answers.'));
    await waitFor(() => expect(said()).toBe('Saved. New chats use your text.'));
    box.value = '   ';
    box.dispatchEvent(new mounted.window.Event('change'));
    await waitFor(() => expect(mounted.calls.at(-1)?.ui[id]).toBe(''));
    await waitFor(() => expect(said()).toBe('Saved. New chats leave this part out.'));
    (doc.getElementById(`${id}Reset`) as HTMLButtonElement).click();
    await waitFor(() => expect(mounted.calls.at(-1)?.ui).toMatchObject({ [id]: undefined }));
    expect(box.value).toBe(fallback);
    await waitFor(() => expect(said()).toBe('New chats use the built-in text.'));
  }
  // Its own section, after Continuation prompts, not inside that section's card.
  const heading = [...doc.querySelectorAll('h2')].find(node => node.textContent === 'Chat instructions')!;
  expect(heading).toBeTruthy();
  expect(heading.closest('.settings-surface')).toBeNull();
  const { collectSettings, searchSettings } = await import('../src/renderer/settings-search.js');
  expect(searchSettings(collectSettings(doc), 'writing style').map(entry => entry.title)).toContain('Writing style');
});

it('says a chat style was restored only when that save went through (#1856, CodeRabbit)', async () => {
  const mounted = await mountChat({}, [], { saveSettings: async () => ({ ok: false, error: 'Settings could not be saved.' }) });
  const doc = mounted.window.document;
  (doc.getElementById('chatPersonalityReset') as HTMLButtonElement).click();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect([...doc.querySelectorAll('.toast')].map(node => node.textContent)).not.toContain('Personality restored to default');
});

it('keeps a chat style editor open with the typed text when its save is refused, and closes it once saved (#1856, CodeRabbit)', async () => {
  const mounted = await mountChat({}, [], { saveSettings: async () => ({ ok: false, error: 'Settings could not be saved.' }) });
  const doc = mounted.window.document;
  const panel = doc.getElementById('chatPersonalityPanel')!;
  const box = doc.getElementById('chatPersonality') as HTMLTextAreaElement;
  const close = doc.getElementById('chatPersonalityEdit') as HTMLButtonElement;
  close.click();
  expect(panel.hidden).toBe(false);
  box.value = 'Answer like a calm colleague.';
  box.dispatchEvent(new mounted.window.Event('change'));
  close.click();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(panel.hidden).toBe(false);
  expect(box.value).toBe('Answer like a calm colleague.');
  expect(close.textContent).toBe('Close prompt');
});

it('closes a chat style editor when its text was stored although a later step of that save failed (#1856, CodeRabbit)', async () => {
  let mounted: Awaited<ReturnType<typeof mountChat>> | undefined;
  mounted = await mountChat({}, [], { saveSettings: async (patch: any) => {
    // Stored first, then a later side effect of the save fails: the answer says no.
    mounted!.state.config = { ...mounted!.state.config, ...structuredClone(patch) };
    return { ok: false, error: 'A later step of saving failed.' };
  } });
  const doc = mounted.window.document;
  const panel = doc.getElementById('chatPersonalityPanel')!;
  const box = doc.getElementById('chatPersonality') as HTMLTextAreaElement;
  const edit = doc.getElementById('chatPersonalityEdit') as HTMLButtonElement;
  edit.click();
  box.value = 'Answer like a calm colleague.';
  box.dispatchEvent(new mounted.window.Event('change'));
  edit.click();
  await waitFor(() => expect(panel.hidden).toBe(true));
  expect(mounted.state.config.ui.chatPersonality).toBe('Answer like a calm colleague.');
});

it('offers the handoff length, starting at the thorough default, and saves a shorter choice', async () => {
  const mounted = await mountChat({ hasGoalKey: true });
  const length = mounted.window.document.getElementById('handoffLength') as HTMLSelectElement;
  expect(length.value).toBe('thorough');
  expect([...length.options].map(option => option.value)).toEqual(['thorough', 'standard', 'short']);
  length.value = 'short';
  length.dispatchEvent(new mounted.window.Event('change'));
  await settle();
  await settle();
  expect(mounted.calls.at(-1)?.compaction.handoffLength).toBe('short');
  expect(mounted.calls.at(-1)?.compaction.handoffPrompt).toBe(DEFAULT_HANDOFF_PROMPT);
});

// #1406: the recording store's size used to be fixed at 2 GB.
it('offers the recording storage sizes, starting at 2 GB, and saves a larger choice', async () => {
  const mounted = await mountChat({ hasGoalKey: true });
  const size = mounted.window.document.getElementById('recordingStorageLimit') as HTMLSelectElement;
  expect(size.value).toBe('2');
  expect([...size.options].map(option => option.value)).toEqual(['2', '5', '10', '20', '50']);
  size.value = '10';
  size.dispatchEvent(new mounted.window.Event('change'));
  await settle();
  await settle();
  expect(mounted.calls.at(-1)?.sessions.storageLimitGiB).toBe(10);
});

/**
 * The catalogue is a network request to somebody else's service, so it happens when a person
 * asks for it and not when the settings tab is opened.
 */
it('loads the model catalogue only when the picker is opened, twenty at a time', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(45));
  const doc = mounted.window.document;
  expect(mounted.modelPages).toEqual([]);

  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(mounted.modelPages).toHaveLength(1);
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);
  // Newest first, which is the whole point of the ordering.
  expect((doc.querySelector('.goal-model .goal-model-name') as HTMLElement).textContent).toBe('Model 0');
  expect(doc.getElementById('goalModelsState')!.textContent).toContain('45');

  (doc.getElementById('goalMore') as HTMLButtonElement).click();
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(40);
  (doc.getElementById('goalMore') as HTMLButtonElement).click();
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(45);
  // Nothing left to page, so the control stops offering.
  expect((doc.getElementById('goalMore') as HTMLButtonElement).hidden).toBe(true);
});

/**
 * "Load 20 more" is the deliberate way to ask for the next page. Scrolling to the bottom of
 * the list is the way people actually ask, and it did nothing at all: the list simply ended
 * at twenty with four hundred still to come and no sign that there was a button below it.
 *
 * The repaint is the other half. The list is rebuilt whole on every page, and emptying an
 * element scrolls it back to the top — so even once it paged, the reader was thrown back to
 * the newest model, which is the one they had just scrolled away from.
 */
it('pages the catalogue in as the list is scrolled, without losing the reader\'s place', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(45));
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);

  // jsdom does no layout, so the box has to be described: a 260px window onto a list whose
  // height follows the number of rows actually in it, the way the real one does.
  const list = doc.getElementById('goalModelList')!;
  Object.defineProperty(list, 'clientHeight', { value: 260, configurable: true });
  Object.defineProperty(list, 'scrollHeight', {
    get: () => list.querySelectorAll('.goal-model').length * 50,
    configurable: true
  });
  Object.defineProperty(list, 'scrollTop', { value: 0, writable: true, configurable: true });
  const scroll = (top: number): void => {
    (list as unknown as { scrollTop: number }).scrollTop = top;
    list.dispatchEvent(new mounted.window.Event('scroll'));
  };

  // Halfway down twenty rows: nothing is asked for.
  scroll(300);
  await settle();
  expect(mounted.modelPages).toHaveLength(1);
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);

  // At the end of them: the next twenty arrive without the button being touched.
  scroll(740);
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(40);
  // And the list is still where it was left, not back at the newest model.
  expect(list.scrollTop).toBe(740);

  // Forty rows is 2000px now, so arriving at the end again pages in the last five.
  scroll(1740);
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(45);
  expect((doc.getElementById('goalMore') as HTMLButtonElement).hidden).toBe(true);

  // Nothing left to page: scrolling on does not ask OpenRouter again.
  const spent = mounted.modelPages.length;
  scroll(2200);
  await settle();
  expect(mounted.modelPages).toHaveLength(spent);
});

/**
 * A closed picker measures zero in every direction, which reads as "scrolled to the end".
 * Left unguarded, every repaint of the settings sheet would page the whole catalogue in
 * behind a panel nobody has open — hundreds of models, on somebody else's service.
 */
it('never pages the catalogue while the picker is closed', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(45));
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(mounted.modelPages).toHaveLength(1);

  // Close it again, then push a fresh state through: applyGoal repaints the list.
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  expect(doc.getElementById('goalModels')!.hidden).toBe(true);
  mounted.push({ ...mounted.state, hasGoalKey: true });
  await settle();

  expect(mounted.modelPages).toHaveLength(1);
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);
});

it('searches the whole OpenRouter catalogue and clearing restores newest-first paging', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(45));
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);

  const search = doc.getElementById('goalModelSearch') as HTMLInputElement | null;
  expect(search).not.toBeNull();
  // It says what it does: it searches the whole catalogue, not a model field.
  expect([search!.placeholder, search!.getAttribute('aria-label')]).toEqual(['Search models', 'Search models']);
  search!.value = 'model-44';
  search!.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
  await settle(); await settle();

  expect(mounted.modelPages.at(-1)?.query).toBe('model-44');
  expect([...doc.querySelectorAll<HTMLElement>('.goal-model')].map(row => row.dataset.model)).toEqual(['vendor44/model-44']);

  search!.value = '';
  search!.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
  await settle(); await settle();

  expect(mounted.modelPages.at(-1)?.query).toBe('');
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);
  expect((doc.querySelector('.goal-model .goal-model-name') as HTMLElement).textContent).toBe('Model 0');
  expect((doc.getElementById('goalMore') as HTMLButtonElement).hidden).toBe(false);
});

/** Choosing one stores it verbatim: the id is what OpenRouter wants, not a display name. */
it('saves the chosen model id', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(3));
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  (doc.querySelectorAll('.goal-model')[1] as HTMLButtonElement).click();
  await settle();

  expect(doc.getElementById('goalModelName')!.textContent).toBe('vendor1/model-1');
  expect(mounted.calls.at(-1)?.goal).toMatchObject({ model: 'vendor1/model-1' });
});

it('saves GLM High and Max from catalogue-specific options and drops unsupported levels on model selection', async () => {
  const glm = { id: 'z-ai/glm-5.3', name: 'GLM 5.3', created: 100, contextLength: 200000,
    reasoning: { supportedEfforts: ['max', 'high', 'low'], defaultEffort: 'max', mandatory: true } };
  const plain = { id: 'plain/model', name: 'Plain', created: 1, contextLength: 1000 };
  const mounted = await mountChat({ hasGoalKey: true }, [glm, plain]);
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  (doc.querySelector('[data-model="z-ai/glm-5.3"]') as HTMLButtonElement).click();
  await settle();
  const select = doc.getElementById('goalReasoning') as HTMLSelectElement;
  expect([...select.options].filter(option => !option.disabled).map(option => option.value)).toEqual(['default', 'max', 'high', 'low']);
  for (const reasoning of ['high', 'max']) {
    select.value = reasoning;
    select.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
    await settle();
    expect(mounted.calls.at(-1)?.goal).toMatchObject({ model: glm.id, reasoning });
  }
  (doc.querySelector('[data-model="plain/model"]') as HTMLButtonElement).click();
  await settle();
  expect([...select.options].map(option => option.value)).toEqual(['default']);
  expect(mounted.calls.at(-1)?.goal).toMatchObject({ model: plain.id, reasoning: 'default' });
});

it('loads supported levels for the saved model without paging to its catalogue row', async () => {
  const selectedModel = { id: 'saved/model', name: 'Saved', created: 1, contextLength: 200000,
    reasoning: { supportedEfforts: ['max', 'high', 'low'], defaultEffort: 'max', mandatory: true } };
  const mounted = await mountChat({}, [], {
    listGoalModels: async () => ({ ok: true, data: { models: [], total: 500, selectedModel } })
  }, { model: selectedModel.id, reasoning: 'high' });
  const select = mounted.window.document.getElementById('goalReasoning') as HTMLSelectElement;
  select.focus();
  await settle();
  expect(select.value).toBe('high');
  expect(select.selectedOptions[0]?.disabled).toBe(false);
  expect([...select.options].map(option => option.value)).toEqual(['default', 'max', 'high', 'low']);
  expect(mounted.calls).toHaveLength(0);
});

/** A provider that cannot be reached says so and changes nothing about what is in use. */
it('keeps the model in use when OpenRouter cannot be reached', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(2));
  const doc = mounted.window.document;
  (mounted.window as any).api.listGoalModels = () => Promise.resolve({ ok: false, error: 'offline' });

  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(doc.getElementById('goalModelsState')!.textContent).toContain('unchanged');
  expect(doc.getElementById('goalModelName')!.textContent).toBe('deepseek/deepseek-v4-flash');
});

it('retains a fresh Goal and first message when rejected sends return to New Chat', async () => {
  const sendInput = vi.fn(async () => ({ ok: false, error: 'test delivery stopped' }));
  const mounted = await mountChat({}, [], { sendInput,
    getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: Date.now(), models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['none', 'high'] }] } }),
    draftGoalOpening: async () => ({ ok: true, data: { reply: 'Generated opening', model: 'fixture' } })
  });
  const w = mounted.window, doc = w.document;
  (doc.getElementById('newChat') as HTMLButtonElement).click();
  await settle();
  expect(doc.getElementById('sessionControls')!.hidden).toBe(false);
  (doc.querySelector('[data-mode="goal"]') as HTMLButtonElement).click();
  const objective = doc.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Build and verify the requested feature';
  objective.dispatchEvent(new w.Event('input', { bubbles: true }));
  (doc.getElementById('saveSessionObjective') as HTMLButtonElement).click();
  await settle();
  expect(sendInput).toHaveBeenCalledWith(expect.objectContaining({ text: 'Generated opening', sessionId: null, automation: 'goal', objective: 'Build and verify the requested feature' }));
  const input = doc.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Start with the existing code';
  doc.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(sendInput).toHaveBeenCalledWith(expect.objectContaining({ sessionId: null, automation: 'goal', objective: 'Build and verify the requested feature' }));
  (doc.getElementById('newChat') as HTMLButtonElement).click();
  await settle();
  expect(objective.value).toBe('Build and verify the requested feature');
  expect(input.value).toBe('Start with the existing code');
  expect((doc.getElementById('chatAutomation') as HTMLSelectElement).value).toBe('goal');
});


it('gives twenty rapid New Chat sends independent visible local chats before any provider receipt', async () => {
  const rows: any[] = [], summaries: any[] = [];
  const ok = (data: any) => ({ ok: true, data });
  const sendInput = vi.fn(async (request: any) => {
    const row = { ...request, sessionId: request.id, opening: true, state: 'queued', owner: null, createdAt: Date.now(), conversationId: null };
    rows.push(row);
    summaries.push({ id: row.sessionId, title: row.text, conversationId: null, origin: { kind: 'desktop' }, createdAt: row.createdAt, updatedAt: row.createdAt, eventCount: 0, projectId: null, selectedModel: null, usage: {} });
    return ok(row);
  });
  const setInputAutomation = vi.fn(async (id: string, automation: string, loopAfterTurn?: boolean) => {
    const row = rows.find(row => row.id === id); row.automation = automation; if (loopAfterTurn !== undefined) row.loopAfterTurn = loopAfterTurn; return ok(true);
  });
  const setSessionAutomation = vi.fn();
  const mounted = await mountChat({}, [], { sendInput, setInputAutomation, setSessionAutomation,
    getChatModels: async () => ok({ state: 'ready', requestedAt: 1, observedAt: Date.now(), models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['high'] }] }),
    listInputs: async () => ok([...rows]), runningTools: async () => ok([]), turnTraces: async () => ok({}), listPausedHelpers: async () => ok([]),
    listSessions: async () => ok({ sessions: [...summaries], activeId: null, pressure: [] }),
    getSession: async (id: string) => ok({ summary: summaries.find(row => row.id === id), events: [], nextCursor: null })
  });
  const w = mounted.window, doc = w.document, field = doc.getElementById('chatInput') as HTMLTextAreaElement;
  for (let index = 0; index < 20; index++) {
    (doc.getElementById('newChat') as HTMLButtonElement).click(); await settle();
    field.value = `Independent opening ${index}`;
    doc.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => expect(sendInput).toHaveBeenCalledTimes(index + 1));
    await waitFor(() => expect(doc.querySelector(`.sess.is-sel[data-id="${rows[index]!.sessionId}"]`)).not.toBeNull());
    expect(doc.querySelector(`[data-input-id="${rows[index]!.id}"]`)?.textContent).toContain(rows[index]!.text);
    expect((doc.getElementById('composerModel') as HTMLSelectElement).value).toBe('gpt-5.6-sol');
  }
  (doc.querySelector('[data-mode=loop]') as HTMLButtonElement).click(); await settle();
  const loop = doc.getElementById('loopDelivery') as HTMLSelectElement; loop.value = 'after-turn'; loop.dispatchEvent(new w.Event('change')); await settle();
  expect(setInputAutomation).toHaveBeenLastCalledWith(rows[19]!.id, 'loop', true);
  expect(setSessionAutomation).not.toHaveBeenCalled();
  expect(rows[19]).toMatchObject({ automation: 'loop', loopAfterTurn: true });
  expect(rows.slice(0, 19).every(row => row.automation !== 'loop')).toBe(true);
  expect(new Set(rows.map(row => row.sessionId)).size).toBe(20);
  expect(rows.every(row => row.state === 'queued' && row.deliveredAt === undefined)).toBe(true);
  expect(sendInput.mock.calls.every(([request]) => request.sessionId === null)).toBe(true);
});

it('shows the frozen Auto-selected Skill receipt for an accepted ordinary send', async () => {
  const rows: any[] = [], summaries: any[] = [];
  const ok = (data: any) => ({ ok: true, data });
  const sendInput = vi.fn(async (request: any) => {
    const row = {
      ...request,
      sessionId: request.id,
      opening: true,
      autoSkills: [{ id: 'code-review', revision: 'a'.repeat(64) }],
      state: 'queued',
      owner: null,
      createdAt: Date.now(),
      conversationId: null
    };
    rows.push(row);
    summaries.push({
      id: row.sessionId,
      title: row.text,
      conversationId: null,
      origin: { kind: 'desktop' },
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
      eventCount: 0,
      projectId: null,
      selectedModel: null,
      usage: {}
    });
    return ok(row);
  });
  const mounted = await mountChat({}, [], {
    sendInput,
    getChatModels: async () => ok({ state: 'ready', requestedAt: 1, observedAt: Date.now(), models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['high'] }] }),
    listInputs: async () => ok([...rows]),
    runningTools: async () => ok([]),
    turnTraces: async () => ok({}),
    listPausedHelpers: async () => ok([]),
    listSessions: async () => ok({ sessions: [...summaries], activeId: null, pressure: [] }),
    getSession: async (id: string) => ok({ summary: summaries.find(row => row.id === id), events: [], nextCursor: null })
  });
  const w = mounted.window, doc = w.document, field = doc.getElementById('chatInput') as HTMLTextAreaElement;
  (doc.getElementById('newChat') as HTMLButtonElement).click();
  await settle();
  field.value = 'Review this source code change for correctness.';
  doc.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(doc.querySelector('.toast')?.textContent).toContain('Auto-selected Skill: /code-review'));
});

it('does not steal a newer New Chat draft when an older admission response arrives', async () => {
  let release!: (value: any) => void;
  const rows: any[] = [], summaries: any[] = [];
  const ok = (data: any) => ({ ok: true, data });
  const sendInput = vi.fn((request: any) => new Promise(resolve => { release = () => {
    const row = { ...request, sessionId: request.id, opening: true, state: 'queued', owner: null, createdAt: Date.now(), conversationId: null };
    rows.push(row); summaries.push({ id: row.sessionId, title: row.text, conversationId: null, origin: { kind: 'desktop' }, createdAt: row.createdAt, updatedAt: row.createdAt, eventCount: 0, projectId: null, usage: {} });
    resolve(ok(row));
  }; }));
  const mounted = await mountChat({}, [], { sendInput,
    getChatModels: async () => ok({ state: 'ready', requestedAt: 1, observedAt: Date.now(), models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['high'] }] }),
    listInputs: async () => ok([...rows]), runningTools: async () => ok([]), turnTraces: async () => ok({}), listPausedHelpers: async () => ok([]),
    listSessions: async () => ok({ sessions: [...summaries], activeId: null, pressure: [] }),
    getSession: async (id: string) => ok({ summary: summaries.find(row => row.id === id), events: [], nextCursor: null })
  });
  const w = mounted.window, doc = w.document, field = doc.getElementById('chatInput') as HTMLTextAreaElement;
  (doc.getElementById('newChat') as HTMLButtonElement).click(); await settle();
  field.value = 'Old admission'; doc.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
  (doc.getElementById('newChat') as HTMLButtonElement).click(); field.value = 'Keep this newer draft';
  field.dispatchEvent(new w.Event('input', { bubbles: true })); release(undefined); await settle(); await settle();
  expect(field.value).toBe('Keep this newer draft');
  expect(doc.querySelector('.sess.is-sel')).toBeNull();
  expect(doc.getElementById('chatTitle')!.textContent).toBe('New chat');
});

it('shows each startup log line once and in order when lines arrive while the log is loading', async () => {
  // Seen on Windows: the Activity page listed "session catalog ready" and "renderer state ready"
  // both before "app started" and again after it. Those lines arrived live while the page was
  // still loading the log, and the loaded log contained them too.
  let live: (entry: any) => void = () => undefined;
  let release!: (reply: any) => void;
  const line = (time: number, message: string) => ({ time, level: 'info', message });
  const mounted = await mountChat({}, [], {
    getLog: () => new Promise(resolve => { release = resolve; }),
    onLogEntry: (fn: any) => { live = fn; return () => undefined; }
  });
  await waitFor(() => expect(release).toBeTypeOf('function'));
  live(line(2, 'session catalog ready'));
  live(line(3, 'renderer state ready'));
  release({ ok: true, data: [line(1, 'app started'), line(2, 'session catalog ready'), line(3, 'renderer state ready')] });
  await settle(); await settle();
  live(line(4, 'window loaded'));
  // A row shows the line's source and text in separate cells; compare without the spacing.
  const rows = () => [...mounted.window.document.querySelectorAll('#fullFeed > *')].map(row => (row.textContent ?? '').replace(/\s/g, ''));
  await waitFor(() => expect(rows()).toHaveLength(4));
  expect(rows().map(text => ['app started', 'session catalog ready', 'renderer state ready', 'window loaded'].find(m => text.includes(m.replace(/\s/g, '')))))
    .toEqual(['app started', 'session catalog ready', 'renderer state ready', 'window loaded']);
});

it.each(['.project-menu'])('keeps keyboard focus on a project row button (%s) across an activity repaint', async selector => {
  // Seen live on Windows: after picking a project color, focus went back to the color button and
  // the next sidebar repaint dropped it to the page. Only the project heading kept its focus.
  const { project, session } = projectSidebarFixture();
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [project] }),
    listSessions: async () => ({ ok: true, data: { sessions: [session], activeId: null, pressure: [], blocked: [] } })
  });
  const doc = mounted.window.document;
  const control = () => doc.querySelector<HTMLElement>(`[data-project-id="${project.id}"] ${selector}`)!;
  await waitFor(() => expect(control()).not.toBeNull());
  await settle();
  const before = control();
  before.focus();
  expect(doc.activeElement).toBe(before);
  mounted.push(structuredClone(mounted.state));
  await settle();
  expect(control()).not.toBe(before); // the repaint really replaced the row
  expect(doc.activeElement).toBe(control());
});

it('saves this computer\'s connector name, and keeps the saved one while the typed one is invalid', async () => {
  const mounted = await mountChat();
  const w = mounted.window, doc = w.document;
  const field = doc.getElementById('connectorSuffix') as HTMLInputElement;
  const error = doc.getElementById('connectorSuffixError')!;
  const details = doc.getElementById('connectorSuffixField') as HTMLDetailsElement;
  expect(field.value).toBe('');
  expect(details.open).toBe(false);
  expect(error.hidden).toBe(true);

  field.value = '  Windows   VM ';
  field.dispatchEvent(new w.Event('change', { bubbles: true }));
  await waitFor(() => expect(mounted.calls.at(-1)?.connectorSuffix).toBe('Windows VM'));

  // An invalid name says why at once, and a save it rides in keeps the saved name.
  field.value = 'Win/VM';
  field.dispatchEvent(new w.Event('input', { bubbles: true }));
  expect(error.hidden).toBe(false);
  expect(field.getAttribute('aria-invalid')).toBe('true');
  const saves = mounted.calls.length;
  field.dispatchEvent(new w.Event('change', { bubbles: true }));
  await waitFor(() => expect(mounted.calls.length).toBe(saves + 1));
  expect(mounted.calls.at(-1)?.connectorSuffix).toBe('Windows VM');
  field.value = 'Mac';
  field.dispatchEvent(new w.Event('input', { bubbles: true }));
  expect(error.hidden).toBe(true);
  expect(field.getAttribute('aria-invalid')).toBe('false');
});

it('shows a computer name set elsewhere and opens its section, so the suffixed card names are explained', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, connectorSuffix: 'Windows' } });
  await settle();
  expect((doc.getElementById('connectorSuffix') as HTMLInputElement).value).toBe('Windows');
  expect((doc.getElementById('connectorSuffixField') as HTMLDetailsElement).open).toBe(true);
});

it('shows unreadable refresh state and allows one explicit reset, including failure and retry', async () => {
  let finish!: (value: any) => void;
  const reset = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const mounted = await mountChat({ pluginRefreshUnreadable: true }, [], { resetPluginRefresh: reset });
  const doc = mounted.window.document;
  const recovery = doc.getElementById('pluginRefreshRecovery')!;
  const button = doc.getElementById('pluginRefreshReset') as HTMLButtonElement;
  expect(recovery.hidden).toBe(false);
  expect(recovery.textContent).toContain('Could not read plugin-refresh state');
  expect(reset).not.toHaveBeenCalled();
  button.click(); button.click();
  expect(button.disabled).toBe(true); expect(reset).toHaveBeenCalledTimes(1);
  mounted.push({ ...mounted.state, pluginRefreshUnreadable: true });
  expect(button.disabled).toBe(true);
  finish({ ok: false, error: 'private filesystem diagnostics' }); await settle();
  expect(recovery.hidden).toBe(false); expect(button.disabled).toBe(false);
  expect(recovery.textContent).toContain('Could not reset plugin-refresh state');
  expect(recovery.textContent).not.toContain('private filesystem');
  mounted.push({ ...mounted.state, pluginRefreshUnreadable: false });
  expect(recovery.hidden).toBe(true);
  mounted.push({ ...mounted.state, pluginRefreshUnreadable: true });
  expect(recovery.textContent).toContain('Could not read plugin-refresh state');
  button.click(); expect(reset).toHaveBeenCalledTimes(2);
  finish({ ok: true, data: { ...mounted.state, pluginRefreshUnreadable: false } }); await settle();
  expect(recovery.hidden).toBe(true);
  button.click(); expect(reset).toHaveBeenCalledTimes(2);
});

// Codex's turn-completion notifications: on unless switched off in General.
it('notifies when a chat finishes unless switched off', async () => {
  const mounted = await mountChat({});
  const w = mounted.window;
  const notify = w.document.getElementById('turnNotifications') as HTMLInputElement;
  expect(notify.checked).toBe(true);
  notify.checked = false;
  notify.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  expect(mounted.calls.at(-1)?.ui.turnNotifications).toBe(false);
});

it('saves and restores Review Goal completion, off by default', async () => {
  const first = await mountChat({});
  let setting = first.window.document.getElementById('finishHoldOnStop') as HTMLInputElement;
  expect(setting.checked).toBe(false);
  const firstSaveCount = first.calls.length;
  setting.checked = true;
  setting.dispatchEvent(new first.window.Event('change', { bubbles: true }));
  await settle();
  expect(first.calls).toHaveLength(firstSaveCount + 1);
  expect(first.calls.at(-1)?.ui.finishHoldOnStop).toBe(true);

  const firstSaved = first.calls.at(-1)!;
  const secondConfig = structuredClone(first.state.config);
  secondConfig.ui = { ...secondConfig.ui, ...firstSaved.ui };
  first.window.close();
  vi.resetModules();
  const second = await mountChat({ config: secondConfig });
  setting = second.window.document.getElementById('finishHoldOnStop') as HTMLInputElement;
  expect(setting.checked).toBe(true);
  const secondSaveCount = second.calls.length;
  setting.checked = false;
  setting.dispatchEvent(new second.window.Event('change', { bubbles: true }));
  await settle();
  expect(second.calls).toHaveLength(secondSaveCount + 1);
  expect(second.calls.at(-1)?.ui.finishHoldOnStop).toBe(false);

  const secondSaved = second.calls.at(-1)!;
  const thirdConfig = structuredClone(second.state.config);
  thirdConfig.ui = { ...thirdConfig.ui, ...secondSaved.ui };
  second.window.close();
  vi.resetModules();
  const third = await mountChat({ config: thirdConfig });
  expect((third.window.document.getElementById('finishHoldOnStop') as HTMLInputElement).checked).toBe(false);
});

// #1832: the Goal step reviewer is chosen in Settings, off by default, and needs Sub-agents.
it('saves the Goal step reviewer choice and offers to turn on Sub-agents, never by itself', async () => {
  const mounted = await mountChat({});
  const w = mounted.window;
  const reviewer = w.document.getElementById('goalReviewer') as HTMLSelectElement;
  const workersRow = w.document.getElementById('goalReviewerWorkersRow') as HTMLElement;
  const workers = w.document.getElementById('homeMaEnabled') as HTMLInputElement;
  expect(reviewer.value).toBe('');
  // Off asks for nothing; with workers off the row stays hidden.
  expect(workersRow.hidden).toBe(true);
  reviewer.value = 'same';
  reviewer.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  expect(mounted.calls.at(-1)?.goal.reviewerModel).toBe('same');
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, goal: { ...mounted.state.config.goal, reviewerModel: 'same' } } });
  await settle();
  expect(workersRow.hidden).toBe(false);
  expect(workers.checked).toBe(false);
  // Workers go on only from the person's own press.
  const saves = mounted.calls.length;
  (w.document.getElementById('goalReviewerWorkers') as HTMLButtonElement).click();
  await settle();
  expect(mounted.calls).toHaveLength(saves + 1);
  expect(mounted.calls.at(-1)?.multiAgent.enabled).toBe(true);
  expect(mounted.calls.at(-1)?.goal.reviewerModel).toBe('same');
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, multiAgent: { ...mounted.state.config.multiAgent, enabled: true }, goal: { ...mounted.state.config.goal, reviewerModel: 'same' } } });
  await settle();
  expect(workersRow.hidden).toBe(true);
});

// CodeRabbit on #1879: the press hides its own row, and a refused save must not leave Sub-agents shown on.
it('keeps the keyboard on the reviewer choice when its Sub-agents row hides, and unticks Sub-agents when the save is refused', async () => {
  const mounted = await mountChat({});
  const w = mounted.window;
  const reviewer = w.document.getElementById('goalReviewer') as HTMLSelectElement;
  const button = w.document.getElementById('goalReviewerWorkers') as HTMLButtonElement;
  const workers = w.document.getElementById('homeMaEnabled') as HTMLInputElement;
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, goal: { ...mounted.state.config.goal, reviewerModel: 'same' } } });
  await settle();
  // An invalid command rule refuses every save until it is fixed.
  const rules = w.document.getElementById('commandAllowlistRules') as HTMLTextAreaElement;
  rules.value = 'git status; whoami';
  const saves = mounted.calls.length;
  button.focus();
  button.click();
  await settle();
  expect(mounted.calls).toHaveLength(saves);
  expect(workers.checked).toBe(false);
  expect(w.document.activeElement).toBe(button);
  rules.value = '';
  button.click();
  await settle();
  expect(mounted.calls.at(-1)?.multiAgent.enabled).toBe(true);
  expect(w.document.activeElement).toBe(reviewer);
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, multiAgent: { ...mounted.state.config.multiAgent, enabled: true }, goal: { ...mounted.state.config.goal, reviewerModel: 'same' } } });
  await settle();
  expect((w.document.getElementById('goalReviewerWorkersRow') as HTMLElement).hidden).toBe(true);
  expect(w.document.activeElement).toBe(reviewer);
});

// #1402: long turns continue in a fresh one, every 30 minutes unless changed or off.
it('starts a fresh turn after 30 minutes unless changed, and saves Off', async () => {
  const mounted = await mountChat({});
  const w = mounted.window;
  const rotate = w.document.getElementById('rotateTurnMinutes') as HTMLSelectElement;
  expect(rotate.value).toBe('30');
  expect([...rotate.options].map(option => option.value)).toEqual(['0', '20', '30', '45', '60']);
  rotate.value = '0';
  rotate.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  expect(mounted.calls.at(-1)?.ui.rotateTurnMinutes).toBe(0);
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, rotateTurnMinutes: 45 } } });
  expect(rotate.value).toBe('45');
});

// 2.1.39 release round: a value the list does not offer (1 minute, set in the config for a test)
// became Off as soon as any other setting was saved, because the select had no such option.
it('keeps a configured fresh-turn interval the list does not offer when another setting is saved', async () => {
  const mounted = await mountChat({});
  const w = mounted.window;
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, rotateTurnMinutes: 1 } } });
  const rotate = w.document.getElementById('rotateTurnMinutes') as HTMLSelectElement;
  expect(rotate.value).toBe('1');
  expect(rotate.selectedOptions[0]!.textContent).toBe('1 min');
  const notify = w.document.getElementById('turnNotifications') as HTMLInputElement;
  notify.checked = !notify.checked;
  notify.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  expect(mounted.calls.at(-1)?.ui.rotateTurnMinutes).toBe(1);
});

// Codex's "Follow-up behavior", in General.
it('offers the follow-up behavior, starting at joining the running turn, and saves waiting', async () => {
  const mounted = await mountChat({});
  const w = mounted.window;
  const followUp = w.document.getElementById('followUp') as HTMLSelectElement;
  expect(followUp.value).toBe('steer');
  expect([...followUp.options].map(option => option.value)).toEqual(['steer', 'queue']);
  followUp.value = 'queue';
  followUp.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  expect(mounted.calls.at(-1)?.ui.followUp).toBe('queue');
});

// Codex's "Prevent sleep while running": the computer by default, the screen too on request, or off.
it('keeps the computer awake while a chat works, the screen too when chosen, or neither', async () => {
  const mounted = await mountChat({});
  const w = mounted.window;
  const keepAwake = w.document.getElementById('keepAwake') as HTMLSelectElement;
  expect(keepAwake.value).toBe('computer');
  for (const [value, saved] of [['screen', { keepAwake: true, keepScreenAwake: true }], ['off', { keepAwake: false, keepScreenAwake: false }],
    ['computer', { keepAwake: true, keepScreenAwake: false }]] as const) {
    keepAwake.value = value;
    keepAwake.dispatchEvent(new w.Event('change', { bubbles: true }));
    await settle();
    expect(mounted.calls.at(-1)?.ui, value).toMatchObject(saved);
  }
});

// The maintainer's idea (2026-10-14): where a minimized built-in browser goes. Only shown for that browser.
it('offers where the built-in browser minimizes to, only while it is the chosen browser, and saves the tray', async () => {
  const mounted = await mountChat({});
  const w = mounted.window;
  const choice = w.document.getElementById('cosBrowserMinimize') as HTMLSelectElement;
  expect(choice.closest('.setting')!.hasAttribute('hidden')).toBe(true);
  const state = structuredClone(mounted.state);
  state.config.ui = { ...state.config.ui, chatBrowser: 'cos' };
  mounted.push(state);
  await settle();
  expect(choice.closest('.setting')!.hasAttribute('hidden')).toBe(false);
  expect(choice.value).toBe('taskbar');
  expect([...choice.options].map(option => option.value)).toEqual(['taskbar', 'tray']);
  choice.value = 'tray';
  choice.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  expect(mounted.calls.at(-1)?.ui.cosBrowserMinimize).toBe('tray');
});

// #1804 (Haz's review): the choice sits right under the permission to control the mouse and keyboard.
it('offers to ask before using the mouse and keyboard, off by default, under the control permission, and saves it', async () => {
  const mounted = await mountChat({});
  const w = mounted.window;
  const choice = w.document.getElementById('desktopAsk') as HTMLSelectElement;
  const row = choice.closest<HTMLElement>('.desktop-ask-row')!;
  expect(row.previousElementSibling!.querySelector('[data-cap="control"]')).not.toBeNull();
  expect([...choice.options].map(option => option.value)).toEqual(['off', 'active', 'always']);
  expect([...choice.options].map(option => option.textContent)).toEqual(['Off', "Ask while I'm using the computer", 'Always ask']);
  expect(choice.value).toBe('off');
  expect(row.textContent).toContain('Browser steps never ask');
  choice.value = 'active';
  choice.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  expect(mounted.calls.at(-1)?.ui.desktopAsk).toBe('active');
  // A saved choice is shown; where the app cannot tell when the computer was last used, the row is hidden.
  const state = structuredClone(mounted.state);
  state.config.ui = { ...state.config.ui, desktopAsk: 'always' };
  mounted.push(state);
  await settle();
  expect(choice.value).toBe('always');
  expect(row.hidden).toBe(false);
  const linux = structuredClone(state);
  linux.platform = { ...(linux.platform ?? {}), family: 'linux', name: 'Linux', desktopAutomation: false };
  mounted.push(linux);
  await settle();
  expect(row.hidden).toBe(true);
});

// CodeRabbit on #1864 (Haz's keyboard condition): the question waits in the app's window too, reachable by keyboard.
it('shows a waiting desktop question in the app without taking the focus, and answers it from there', async () => {
  let listener: ((pending: unknown) => void) | null = null;
  const answer = vi.fn(async () => ({ ok: true, data: true }));
  const pending = { id: 'ask-1', title: 'Chat On Steroids wants to use your mouse and keyboard', step: 'Open notepad.exe', chat: 'Release notes' };
  const mounted = await mountChat({}, [], {
    desktopAskPending: async () => ({ ok: true, data: pending }),
    onDesktopAskPending: (fn: (pending: unknown) => void) => { listener = fn; return () => {}; },
    answerDesktopAsk: answer
  });
  const doc = mounted.window.document;
  const notice = doc.getElementById('desktopAskNotice')!;
  // Already waiting when the window opened: shown at once.
  await waitFor(() => expect(notice.hidden).toBe(false));
  expect(notice.textContent).toContain('Chat On Steroids wants to use your mouse and keyboard');
  expect(notice.textContent).toContain('Open notepad.exe · Release notes');
  // It never takes the focus by itself: the message box keeps it.
  const box = doc.getElementById('chatInput') as HTMLTextAreaElement;
  box.focus();
  listener!({ ...pending, id: 'ask-2', step: 'Click', chat: '' });
  expect(doc.activeElement).toBe(box);
  expect(notice.textContent).toContain('Click');
  expect(notice.textContent).not.toContain('·');
  // Reachable by keyboard: plain buttons, answered from here.
  const go = doc.getElementById('desktopAskGo') as HTMLButtonElement;
  go.focus();
  expect(doc.activeElement).toBe(go);
  go.click();
  expect(answer).toHaveBeenCalledWith('ask-2', 'go');
  (doc.getElementById('desktopAskNotNow') as HTMLButtonElement).click();
  expect(answer).toHaveBeenLastCalledWith('ask-2', 'not-now');
  // Answered here or in the corner panel: main ends the question and the notice goes.
  listener!(null);
  expect(notice.hidden).toBe(true);
  answer.mockClear();
  go.click();
  expect(answer).not.toHaveBeenCalled();
});

// CodeRabbit on #1864: a refused save (an invalid command rule) must not leave the choice showing what was not saved.
it('shows the saved desktop ask choice again when the save is refused', async () => {
  const mounted = await mountChat({});
  const w = mounted.window;
  const choice = w.document.getElementById('desktopAsk') as HTMLSelectElement;
  (w.document.getElementById('commandAllowlistRules') as HTMLTextAreaElement).value = 'git status; whoami';
  const saves = mounted.calls.length;
  choice.focus();
  choice.value = 'always';
  choice.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  expect(mounted.calls).toHaveLength(saves);
  expect(choice.value).toBe('off');
});

// #1833: Setup's last step offers the first-run tour once; Settings replays it, never offering it again.
it('offers the tour after Setup only while it was never taken, and replays it from Settings', async () => {
  const done = vi.fn(async () => ({ ok: true, data: undefined }));
  const mounted = await mountChat({}, [], { markTourDone: done });
  const w = mounted.window;
  const offer = w.document.getElementById('tourOffer')!;
  w.document.getElementById('readyStart')!.click();
  await settle();
  expect(offer.hidden).toBe(false);
  (w.document.getElementById('tourOfferNo') as HTMLButtonElement).click();
  await settle();
  expect(offer.hidden).toBe(true);
  expect(done).toHaveBeenCalledTimes(1);
  // Once taken, Start a chat offers nothing.
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, tourDone: true } } });
  await settle();
  w.document.getElementById('readyStart')!.click();
  await settle();
  expect(offer.hidden).toBe(true);
  expect(w.document.getElementById('takeTour')!.textContent).toBe('Take the tour again');
});

// CodeRabbit on #1867: Settings' replay starts on the next frame; leaving chat before it must cancel it.
it('cancels a tour replay that has not started yet when the person leaves the chat screen', async () => {
  const done = vi.fn(async () => ({ ok: true, data: undefined }));
  const mounted = await mountChat({}, [], { markTourDone: done });
  const w = mounted.window;
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames[id - 1] = () => undefined; });
  try {
    (w.document.getElementById('takeTour') as HTMLButtonElement).click();
    expect(frames).toHaveLength(1);
    (w.document.querySelector('button[data-tab="general"]') as HTMLButtonElement).click();
    for (const frame of frames.splice(0)) frame(0);
    await settle();
    expect(done).not.toHaveBeenCalled();
    expect(w.document.getElementById('tourCard')!.hidden).toBe(true);
  } finally { vi.unstubAllGlobals(); }
});

// CodeRabbit on #1867: an answer in this window counts at once; a write that failed says so.
it('offers the tour no second time in this window once answered, and says when that answer could not be saved', async () => {
  const done = vi.fn(async () => ({ ok: true, data: undefined }));
  const mounted = await mountChat({}, [], { markTourDone: done });
  const w = mounted.window;
  const offer = w.document.getElementById('tourOffer')!;
  w.document.getElementById('readyStart')!.click();
  await settle();
  (w.document.getElementById('tourOfferNo') as HTMLButtonElement).click();
  await settle();
  // No state push since: Start again offers nothing.
  w.document.getElementById('readyStart')!.click();
  await settle();
  expect(offer.hidden).toBe(true);
  vi.resetModules();
  const failing = await mountChat({}, [], { markTourDone: vi.fn(async () => ({ ok: false, error: 'disk full' })) });
  failing.window.document.getElementById('readyStart')!.click();
  await settle();
  (failing.window.document.getElementById('tourOfferNo') as HTMLButtonElement).click();
  await settle();
  expect([...failing.window.document.querySelectorAll('.toast')].map(node => node.textContent)).toContain("The tour choice couldn't be saved, so it may be offered again.");
});

// Codex's "Enter key behavior", in General.
it('offers which key sends, starting at Enter, and saves Cmd/Ctrl+Enter', async () => {
  const mounted = await mountChat({});
  const w = mounted.window;
  const enter = w.document.getElementById('enterSends') as HTMLSelectElement;
  expect(enter.value).toBe('enter');
  enter.value = 'modifier';
  enter.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  expect(mounted.calls.at(-1)?.ui.enterSends).toBe(false);
});

// #1460: worker chats leave ChatGPT's chat list once retired, only when switched on.
it('offers archiving retired worker chats, off by default, and saves it', async () => {
  const mounted = await mountChat({});
  const w = mounted.window;
  const archive = w.document.getElementById('archiveWorkerChats') as HTMLInputElement;
  expect(archive.checked).toBe(false);
  archive.checked = true;
  archive.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  expect(mounted.calls.at(-1)?.multiAgent.archiveWorkerChats).toBe(true);
});

describe('settings backup dialogs', () => {
  const choice = (over: Record<string, unknown> = {}) => ({ token: '6f9619ff-8b86-4d01-b42d-00cf4fc964ff', file: 'backup.json', appVersion: '2.1.46',
    exportedAt: '2026-10-23T08:00:00.000Z', changed: ['readOnly', 'ui.theme'], wider: [], keyCount: 1, ...over });
  const submit = (doc: Document, form: string) => doc.getElementById(form)!.dispatchEvent(new doc.defaultView!.Event('submit', { bubbles: true, cancelable: true }));
  const typeInto = (doc: Document, id: string, value: string) => {
    const input = doc.getElementById(id) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new doc.defaultView!.Event('input', { bubbles: true }));
  };

  it('exports without keys, and with keys only after a long enough, repeated passphrase', async () => {
    const exportSettings = vi.fn(async (includeKeys: boolean) => ({ ok: true, data: { file: 'backup.json', keyCount: includeKeys ? 2 : 0 } }));
    const mounted = await mountChat({}, [], { exportSettings });
    const doc = mounted.window.document;
    const dialog = doc.getElementById('exportSettingsDialog') as HTMLDialogElement;
    (doc.getElementById('exportSettings') as HTMLButtonElement).click();
    expect(dialog.open).toBe(true);
    expect(doc.getElementById('exportSettingsPassphrase')!.hidden).toBe(true);
    submit(doc, 'exportSettingsForm');
    await waitFor(() => expect(dialog.open).toBe(false));
    expect(exportSettings).toHaveBeenLastCalledWith(false, undefined);
    await waitFor(() => expect(doc.querySelector('.toast')?.textContent).toBe('Saved backup.json.'));

    (doc.getElementById('exportSettings') as HTMLButtonElement).click();
    const keys = doc.getElementById('exportSettingsKeys') as HTMLInputElement;
    keys.checked = true;
    keys.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
    expect(doc.getElementById('exportSettingsPassphrase')!.hidden).toBe(false);
    typeInto(doc, 'exportSettingsPass', 'short');
    submit(doc, 'exportSettingsForm');
    expect(doc.getElementById('exportSettingsError')!.textContent).toBe('Use a passphrase of at least 8 characters.');
    typeInto(doc, 'exportSettingsPass', 'correct horse battery');
    typeInto(doc, 'exportSettingsPassAgain', 'correct horse batterz');
    submit(doc, 'exportSettingsForm');
    expect(doc.getElementById('exportSettingsError')!.textContent).toBe('The two passphrases are not the same.');
    expect(exportSettings).toHaveBeenCalledTimes(1);
    typeInto(doc, 'exportSettingsPassAgain', 'correct horse battery');
    submit(doc, 'exportSettingsForm');
    await waitFor(() => expect(dialog.open).toBe(false));
    expect(exportSettings).toHaveBeenLastCalledWith(true, 'correct horse battery');
    // A closed dialog keeps no passphrase.
    expect((doc.getElementById('exportSettingsPass') as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(doc.querySelector('.toast:last-of-type')?.textContent).toBe('Saved backup.json with 2 saved keys.'));
  });

  it('keeps the export dialog open when the file picker is cancelled, and shows a refusal', async () => {
    const exportSettings = vi.fn().mockResolvedValueOnce({ ok: true, data: null })
      .mockResolvedValueOnce({ ok: false, error: 'The saved keys could not be read, so no backup was made. Try again, or export without them.' });
    const mounted = await mountChat({}, [], { exportSettings });
    const doc = mounted.window.document;
    (doc.getElementById('exportSettings') as HTMLButtonElement).click();
    submit(doc, 'exportSettingsForm');
    await waitFor(() => expect(exportSettings).toHaveBeenCalledTimes(1));
    expect((doc.getElementById('exportSettingsDialog') as HTMLDialogElement).open).toBe(true);
    submit(doc, 'exportSettingsForm');
    await waitFor(() => expect(doc.getElementById('exportSettingsError')!.hidden).toBe(false));
    expect(doc.getElementById('exportSettingsError')!.textContent).toContain('could not be read');
  });

  it('says how many settings change, asks for the passphrase of included keys, and applies the result', async () => {
    const importSettingsBackup = vi.fn().mockResolvedValueOnce({ ok: false, error: 'That passphrase does not open the saved keys in this backup.' });
    const mounted = await mountChat({}, [], { pickSettingsBackup: vi.fn(async () => ({ ok: true, data: choice() })), importSettingsBackup });
    importSettingsBackup.mockResolvedValueOnce({ ok: true, data: { state: { ...mounted.state, config: { ...mounted.state.config, readOnly: true } }, changedCount: 2, keyCount: 1 } });
    const doc = mounted.window.document;
    (doc.getElementById('importSettings') as HTMLButtonElement).click();
    const dialog = doc.getElementById('importSettingsDialog') as HTMLDialogElement;
    await waitFor(() => expect(dialog.open).toBe(true));
    expect(doc.getElementById('importSettingsSource')!.textContent).toMatch(/^backup\.json, saved on /);
    expect(doc.getElementById('importSettingsSummary')!.textContent).toBe("2 settings will change. Folders and this computer's connection to ChatGPT stay as they are.");
    expect(doc.getElementById('importSettingsKeysRow')!.hidden).toBe(false);
    expect(doc.getElementById('importSettingsKeysLabel')!.textContent).toBe('Also import 1 saved key');
    // Saved keys come along only when ticked.
    const keys = doc.getElementById('importSettingsKeys') as HTMLInputElement;
    expect(keys.checked).toBe(false);
    expect(doc.getElementById('importSettingsPassRow')!.hidden).toBe(true);
    keys.checked = true;
    keys.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
    expect(doc.activeElement?.id).toBe('importSettingsPass');
    submit(doc, 'importSettingsForm');
    expect(doc.getElementById('importSettingsError')!.textContent).toBe('Enter the passphrase of this backup.');
    expect(importSettingsBackup).not.toHaveBeenCalled();
    typeInto(doc, 'importSettingsPass', 'wrong horse battery');
    submit(doc, 'importSettingsForm');
    await waitFor(() => expect(doc.getElementById('importSettingsError')!.textContent).toBe('That passphrase does not open the saved keys in this backup.'));
    expect(dialog.open).toBe(true);
    typeInto(doc, 'importSettingsPass', 'correct horse battery');
    submit(doc, 'importSettingsForm');
    await waitFor(() => expect(dialog.open).toBe(false));
    expect(importSettingsBackup).toHaveBeenLastCalledWith(choice().token, true, 'correct horse battery');
    await waitFor(() => expect(doc.querySelector('.toast')?.textContent).toBe('Imported: 2 settings changed. 1 saved key added.'));
    expect((doc.getElementById('importSettingsPass') as HTMLInputElement).value).toBe('');
  });

  it('imports settings alone when the keys are unticked, and offers nothing to do when nothing differs', async () => {
    const pick = vi.fn().mockResolvedValueOnce({ ok: true, data: choice() }).mockResolvedValueOnce({ ok: true, data: choice({ changed: [], keyCount: 0 }) });
    const importSettingsBackup = vi.fn(async () => ({ ok: true, data: { state: mounted.state, changedCount: 2, keyCount: 0 } }));
    const mounted = await mountChat({}, [], { pickSettingsBackup: pick, importSettingsBackup });
    const doc = mounted.window.document;
    (doc.getElementById('importSettings') as HTMLButtonElement).click();
    await waitFor(() => expect((doc.getElementById('importSettingsDialog') as HTMLDialogElement).open).toBe(true));
    expect((doc.getElementById('importSettingsKeys') as HTMLInputElement).checked).toBe(false);
    expect(doc.getElementById('importSettingsPassRow')!.hidden).toBe(true);
    submit(doc, 'importSettingsForm');
    await waitFor(() => expect(importSettingsBackup).toHaveBeenCalledWith(choice().token, false, undefined));
    await waitFor(() => expect((doc.getElementById('importSettingsDialog') as HTMLDialogElement).open).toBe(false));
    (doc.getElementById('importSettings') as HTMLButtonElement).click();
    await waitFor(() => expect((doc.getElementById('importSettingsDialog') as HTMLDialogElement).open).toBe(true));
    expect(doc.getElementById('importSettingsSummary')!.textContent).toMatch(/^Every setting in this backup already matches yours\./);
    expect(doc.getElementById('importSettingsKeysRow')!.hidden).toBe(true);
    expect((doc.getElementById('importSettingsSubmit') as HTMLButtonElement).disabled).toBe(true);
    expect(doc.activeElement?.id).toBe('importSettingsCancel');
  });

  it('says what failed after an import whose settings were saved anyway', async () => {
    const mounted = await mountChat({}, [], { pickSettingsBackup: vi.fn(async () => ({ ok: true, data: choice({ keyCount: 0 }) })),
      importSettingsBackup: vi.fn(async () => ({ ok: true, data: { state: mounted.state, changedCount: 2, keyCount: 0, warnings: ['login registration refused'] } })) });
    const doc = mounted.window.document;
    (doc.getElementById('importSettings') as HTMLButtonElement).click();
    await waitFor(() => expect((doc.getElementById('importSettingsDialog') as HTMLDialogElement).open).toBe(true));
    submit(doc, 'importSettingsForm');
    await waitFor(() => expect(doc.querySelector('.toast')?.textContent).toBe('Imported: 2 settings changed. login registration refused'));
  });

  it('turns Import off once the chosen file has to be chosen again', async () => {
    const importSettingsBackup = vi.fn(async () => ({ ok: false, error: 'Your settings changed after the file was chosen. Choose it again.' }));
    const mounted = await mountChat({}, [], { pickSettingsBackup: vi.fn(async () => ({ ok: true, data: choice({ keyCount: 0 }) })), importSettingsBackup });
    const doc = mounted.window.document;
    (doc.getElementById('importSettings') as HTMLButtonElement).click();
    await waitFor(() => expect((doc.getElementById('importSettingsDialog') as HTMLDialogElement).open).toBe(true));
    submit(doc, 'importSettingsForm');
    await waitFor(() => expect(doc.getElementById('importSettingsError')!.textContent).toBe('Your settings changed after the file was chosen. Choose it again.'));
    expect((doc.getElementById('importSettingsSubmit') as HTMLButtonElement).disabled).toBe(true);
    expect(doc.activeElement?.id).toBe('importSettingsCancel');
    submit(doc, 'importSettingsForm');
    expect(importSettingsBackup).toHaveBeenCalledTimes(1);
  });

  it('names what would give ChatGPT more access, and lists the other changes by Settings tab on request', async () => {
    const pick = vi.fn(async () => ({ ok: true, data: choice({ keyCount: 0, changed: ['capabilities.command', 'readOnly', 'ui.appearance.dark.accent', 'ui.theme', 'goal.model', 'sessions.retainDays'],
      wider: ['capabilities.command', 'readOnly'] }) }));
    const mounted = await mountChat({}, [], { pickSettingsBackup: pick });
    const doc = mounted.window.document;
    (doc.getElementById('importSettings') as HTMLButtonElement).click();
    await waitFor(() => expect((doc.getElementById('importSettingsDialog') as HTMLDialogElement).open).toBe(true));
    expect(doc.getElementById('importSettingsWider')!.hidden).toBe(false);
    expect(doc.getElementById('importSettingsWider')!.textContent).toBe('More access for ChatGPT: Run commands, Read-only mode off.');
    const review = doc.getElementById('importSettingsReview') as HTMLDetailsElement;
    expect([review.hidden, review.open]).toEqual([false, false]);
    expect([...doc.querySelectorAll('#importSettingsChanges li')].map(item => item.textContent))
      .toEqual(['Workspace: 2 settings', 'Appearance: 2 settings', 'Agents & automation: 1 setting', 'General: 1 setting']);
  });

  it('shows why a chosen file cannot be imported, and switches the language a backup brings', async () => {
    const pick = vi.fn().mockResolvedValueOnce({ ok: false, error: 'This file is not a Chat On Steroids settings backup.' })
      .mockResolvedValueOnce({ ok: true, data: choice({ keyCount: 0, changed: ['language'] }) });
    const mounted = await mountChat({}, [], { pickSettingsBackup: pick,
      importSettingsBackup: async () => ({ ok: true, data: { state: { ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, language: 'de' } } }, changedCount: 1, keyCount: 0 } }) });
    const doc = mounted.window.document;
    (doc.getElementById('importSettings') as HTMLButtonElement).click();
    await waitFor(() => expect(doc.querySelector('.toast')?.textContent).toBe('This file is not a Chat On Steroids settings backup.'));
    expect((doc.getElementById('importSettingsDialog') as HTMLDialogElement).open).toBe(false);
    (doc.getElementById('importSettings') as HTMLButtonElement).click();
    await waitFor(() => expect((doc.getElementById('importSettingsDialog') as HTMLDialogElement).open).toBe(true));
    submit(doc, 'importSettingsForm');
    await waitFor(() => expect(doc.documentElement.lang).toBe('de'));
    const { setLanguage } = await import('../src/renderer/i18n.js');
    setLanguage('en');
  });
});

describe('phone notifications in Settings', () => {
  const change = (doc: Document, id: string, value?: string | boolean) => {
    const node = doc.getElementById(id) as HTMLInputElement | HTMLSelectElement;
    if (typeof value === 'boolean') (node as HTMLInputElement).checked = value; else if (value !== undefined) node.value = value;
    node.dispatchEvent(new doc.defaultView!.Event('change', { bubbles: true }));
  };

  const withPhone = async (phonePush: Record<string, unknown>, api: Record<string, (...args: any[]) => any> = {}) => {
    const mounted = await mountChat({}, [], api);
    mounted.state.config = { ...mounted.state.config, ui: { ...mounted.state.config.ui, phonePush } };
    mounted.push(mounted.state);
    return mounted;
  };
  const phone = (over: Record<string, unknown> = {}) => ({ enabled: true, server: 'https://ntfy.sh', topic: 'cos-fixturetopic234567', needsYou: true, failures: true,
    finishedAfterMinutes: 5, onlyWhenAway: true, quietHours: null, includeDetails: false, ...over });

  it('starts off; turning it on picks a long random topic and saves the defaults', async () => {
    const mounted = await mountChat();
    const doc = mounted.window.document;
    expect((doc.getElementById('phonePushEnabled') as HTMLInputElement).checked).toBe(false);
    expect(doc.getElementById('phonePushOptions')!.hidden).toBe(true);
    change(doc, 'phonePushEnabled', true);
    expect(doc.getElementById('phonePushOptions')!.hidden).toBe(false);
    await waitFor(() => expect(mounted.calls.at(-1)?.ui.phonePush?.enabled).toBe(true));
    const saved = mounted.calls.at(-1).ui.phonePush;
    expect(saved.topic).toMatch(/^cos-[a-km-np-z2-9]{20}$/);
    expect(saved).toEqual({ enabled: true, server: 'https://ntfy.sh', topic: saved.topic, needsYou: true, failures: true,
      finishedAfterMinutes: 5, onlyWhenAway: true, quietHours: null, includeDetails: false });
  });

  it('shows the essentials first and keeps server, token and a new topic behind Advanced; Copy copies the topic', async () => {
    const writeClipboard = vi.fn(async () => ({ ok: true, data: true }));
    const mounted = await withPhone(phone(), { writeClipboard });
    const doc = mounted.window.document;
    const advanced = doc.getElementById('phonePushAdvanced') as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
    for (const id of ['phonePushServer', 'phonePushToken', 'phonePushNewTopic']) expect(advanced.contains(doc.getElementById(id))).toBe(true);
    for (const id of ['phonePushTopic', 'phonePushCopyTopic', 'phonePushTest', 'phonePushDetails']) expect(advanced.contains(doc.getElementById(id))).toBe(false);
    (doc.getElementById('phonePushCopyTopic') as HTMLButtonElement).click();
    await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith('cos-fixturetopic234567'));
  });

  it('keeps quiet hours visible and saved with phone notifications off, since sounds follow them too (Haz on #1830)', async () => {
    const mounted = await withPhone(phone({ enabled: false }));
    const doc = mounted.window.document;
    const quiet = doc.getElementById('phonePushQuiet') as HTMLSelectElement;
    expect(doc.getElementById('phonePushOptions')!.hidden).toBe(true);
    expect(doc.getElementById('phonePushOptions')!.contains(quiet)).toBe(false);
    expect(quiet.closest('[hidden]')).toBeNull();
    change(doc, 'phonePushQuiet', '22:00-07:00');
    await waitFor(() => expect(mounted.calls.at(-1)?.ui.phonePush).toMatchObject({ enabled: false, quietHours: { from: '22:00', to: '07:00' } }));
  });

  it('saves when a chat counts as finished, quiet hours shown in local time, and the details switch', async () => {
    const mounted = await withPhone(phone());
    const doc = mounted.window.document;
    const quiet = doc.getElementById('phonePushQuiet') as HTMLSelectElement;
    expect([...quiet.options].map(option => option.textContent)).toContain('10:00 PM – 7:00 AM');
    change(doc, 'phonePushFinished', 'never');
    await waitFor(() => expect(mounted.calls.at(-1)?.ui.phonePush?.finishedAfterMinutes).toBeNull());
    change(doc, 'phonePushQuiet', '22:00-07:00');
    await waitFor(() => expect(mounted.calls.at(-1)?.ui.phonePush?.quietHours).toEqual({ from: '22:00', to: '07:00' }));
    change(doc, 'phonePushDetails', true);
    await waitFor(() => expect(mounted.calls.at(-1)?.ui.phonePush?.includeDetails).toBe(true));
    expect(mounted.calls.at(-1).ui.phonePush.topic).toBe('cos-fixturetopic234567');
  });

  // A cleared server field is sent as it is and refused, never quietly replaced by ntfy.sh: that would
  // move the messages (and, with details on, chat names) to a public server nobody chose.
  it('sends a cleared server as empty instead of replacing it with ntfy.sh', async () => {
    const mounted = await withPhone(phone({ server: 'https://ntfy.example.org' }));
    const doc = mounted.window.document;
    change(doc, 'phonePushServer', '   ');
    await waitFor(() => expect(mounted.calls.at(-1)?.ui.phonePush?.server).toBe(''));
  });

  // A switch the person has focused but not changed still follows a change made elsewhere (another
  // window, a backup import): a stale switch would put "include chat details" back on with the next save.
  it('updates a focused phone control that was not edited, and keeps one that was', async () => {
    const mounted = await withPhone(phone({ includeDetails: true }));
    const doc = mounted.window.document;
    const details = doc.getElementById('phonePushDetails') as HTMLInputElement;
    details.focus();
    mounted.state.config = { ...mounted.state.config, ui: { ...mounted.state.config.ui, phonePush: phone({ includeDetails: false }) } };
    mounted.push(mounted.state);
    expect(details.checked).toBe(false);
    const topic = doc.getElementById('phonePushTopic') as HTMLInputElement;
    topic.focus();
    topic.value = 'cos-typing-in-progress';
    mounted.state.config = { ...mounted.state.config, ui: { ...mounted.state.config.ui, phonePush: phone({ includeDetails: false, topic: 'cos-elsewhere' }) } };
    mounted.push(mounted.state);
    expect(topic.value).toBe('cos-typing-in-progress');
  });

  // A switch changed and saved while it keeps the focus: once the save comes back with that value, it
  // counts as painted, so a later change made elsewhere still reaches it.
  it('follows a later change elsewhere after a focused switch was changed and saved', async () => {
    const mounted = await withPhone(phone({ includeDetails: false }));
    const doc = mounted.window.document;
    const details = doc.getElementById('phonePushDetails') as HTMLInputElement;
    details.focus();
    change(doc, 'phonePushDetails', true);
    await waitFor(() => expect(mounted.calls.at(-1)?.ui.phonePush?.includeDetails).toBe(true));
    mounted.state.config = { ...mounted.state.config, ui: { ...mounted.state.config.ui, phonePush: phone({ includeDetails: true }) } };
    mounted.push(mounted.state);
    mounted.state.config = { ...mounted.state.config, ui: { ...mounted.state.config.ui, phonePush: phone({ includeDetails: false }) } };
    mounted.push(mounted.state);
    expect(details.checked).toBe(false);
  });

  it('keeps quiet hours that are not one of the choices when something else is saved', async () => {
    const mounted = await withPhone(phone({ finishedAfterMinutes: 7, quietHours: { from: '01:30', to: '05:15' } }));
    const doc = mounted.window.document;
    expect((doc.getElementById('phonePushQuiet') as HTMLSelectElement).value).toBe('custom');
    // 7 minutes is not offered: it is shown as its own choice and kept, like the quiet hours.
    const finished = doc.getElementById('phonePushFinished') as HTMLSelectElement;
    expect(finished.value).toBe('7');
    expect(finished.selectedOptions[0]!.textContent).toBe('After 7 minutes of work');
    change(doc, 'phonePushAway', false);
    await waitFor(() => expect(mounted.calls.at(-1)?.ui.phonePush?.onlyWhenAway).toBe(false));
    expect(mounted.calls.at(-1).ui.phonePush.quietHours).toEqual({ from: '01:30', to: '05:15' });
    expect(mounted.calls.at(-1).ui.phonePush.finishedAfterMinutes).toBe(7);
    // Choosing an offered value drops the extra choice again.
    change(doc, 'phonePushFinished', '30');
    await waitFor(() => expect(mounted.calls.at(-1)?.ui.phonePush?.finishedAfterMinutes).toBe(30));
    mounted.state.config = { ...mounted.state.config, ui: { ...mounted.state.config.ui, phonePush: phone({ finishedAfterMinutes: 30 }) } };
    mounted.push(mounted.state);
    expect([...finished.options].map(option => option.value)).toEqual(['never', '0', '5', '15', '30', '60']);
  });

  it('sends a test after saving what was typed, and says when it did not arrive', async () => {
    const testPhonePush = vi.fn().mockResolvedValueOnce({ ok: true, data: undefined })
      .mockResolvedValueOnce({ ok: false, error: 'The ntfy server refused the message. Check the server, the topic and the access token.' });
    const mounted = await withPhone(phone(), { testPhonePush });
    const doc = mounted.window.document;
    (doc.getElementById('phonePushTopic') as HTMLInputElement).value = 'cos-typedbutnotblurred';
    const before = mounted.calls.length;
    (doc.getElementById('phonePushTest') as HTMLButtonElement).click();
    await waitFor(() => expect(doc.getElementById('phonePushTestStatus')!.textContent).toBe('Sent. Check your phone.'));
    expect(mounted.calls.length).toBeGreaterThan(before);
    expect(mounted.calls.at(-1).ui.phonePush.topic).toBe('cos-typedbutnotblurred');
    (doc.getElementById('phonePushTest') as HTMLButtonElement).click();
    await waitFor(() => expect(doc.getElementById('phonePushTestStatus')!.classList.contains('is-warn')).toBe(true));
    expect(doc.getElementById('phonePushTestStatus')!.textContent).toContain('refused the message');
  });

  it('sends no test when the settings could not be saved', async () => {
    const testPhonePush = vi.fn(async () => ({ ok: true, data: undefined }));
    const mounted = await withPhone(phone(), { testPhonePush, saveSettings: async () => ({ ok: false, error: 'Fixture save refused' }) });
    const doc = mounted.window.document;
    (doc.getElementById('phonePushTest') as HTMLButtonElement).click();
    await waitFor(() => expect(doc.getElementById('phonePushTestStatus')!.textContent).toBe('The settings could not be saved, so no test was sent.'));
    expect(doc.getElementById('phonePushTestStatus')!.classList.contains('is-warn')).toBe(true);
    expect(testPhonePush).not.toHaveBeenCalled();
  });

  it('keeps a token typed while the previous one was being saved', async () => {
    let release: () => void = () => {};
    const setPhonePushToken = vi.fn((token: string) => new Promise(resolve => { release = () => resolve({ ok: true, data: { ...mounted.state, hasPhonePushToken: token !== '' } }); }));
    const mounted = await mountChat({}, [], { setPhonePushToken });
    const doc = mounted.window.document;
    const field = doc.getElementById('phonePushToken') as HTMLInputElement;
    field.value = 'tk_first';
    (doc.getElementById('phonePushTokenSave') as HTMLButtonElement).click();
    await waitFor(() => expect(setPhonePushToken).toHaveBeenCalledWith('tk_first'));
    field.value = 'tk_second_draft';
    release();
    await waitFor(() => expect(doc.getElementById('phonePushTokenStatus')!.textContent).toBe('A token is saved. Save an empty field to remove it.'));
    expect(field.value).toBe('tk_second_draft');
  });

  it('saves and removes the access token without ever showing it again', async () => {
    const setPhonePushToken = vi.fn(async (token: string) => ({ ok: true, data: { ...mounted.state, hasPhonePushToken: token !== '' } }));
    const mounted = await mountChat({}, [], { setPhonePushToken });
    const doc = mounted.window.document;
    const field = doc.getElementById('phonePushToken') as HTMLInputElement;
    field.value = 'tk_fixture_token';
    (doc.getElementById('phonePushTokenSave') as HTMLButtonElement).click();
    await waitFor(() => expect(setPhonePushToken).toHaveBeenCalledWith('tk_fixture_token'));
    await waitFor(() => expect(field.value).toBe(''));
    expect(doc.getElementById('phonePushTokenStatus')!.textContent).toBe('A token is saved. Save an empty field to remove it.');
    (doc.getElementById('phonePushTokenSave') as HTMLButtonElement).click();
    await waitFor(() => expect(setPhonePushToken).toHaveBeenLastCalledWith(''));
    await waitFor(() => expect(doc.getElementById('phonePushTokenStatus')!.textContent).toMatch(/^Only if your server needs one/));
  });
});
