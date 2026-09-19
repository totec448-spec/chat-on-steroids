/** Focused adaptation of @ehkogh's observed shell fixtures in #318 (c18f289c).
 * Only page identity, authored messages, tool evidence and the native picker.
 * No cache-derived message history, invented receipts or alternate presentation. */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

const domSource = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const fiberSource = readFileSync(new URL('../extension/fiber.js', import.meta.url), 'utf8');
const contentSource = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const THREAD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const USER = '11111111-1111-4111-8111-111111111111';
const TURN = '22222222-2222-4222-8222-222222222222';
const CALL = '33333333-3333-4333-8333-333333333333';
const ANSWER = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
let page: JSDOM;
afterEach(() => page?.window.close());

function fixture() {
  page = new JSDOM(`<div id="root"><aside id="app-shell-sidebar"></aside><main data-app-shell-main-surface>
    <div data-thread-find-target="conversation"><div data-turn-key="${USER}"><div data-content-search-turn-key="${TURN}">
      <div data-content-search-unit-key="${TURN}:0:user"><div data-user-message-bubble><div class="whitespace-pre-wrap">hello</div></div></div>
      <div><span hidden data-chatgpt-agent-turn-start></span><button aria-expanded="true">Worked for 1s</button>
        <div data-markdown-text-style="assistant-message">Commentary without a provider message id</div></div>
      <div data-content-search-unit-key="${TURN}:2:assistant"><div data-markdown-text-style="assistant-message">Answer</div></div>
    </div></div></div>
    <form data-chatgpt-composer><div data-composer-body><div contenteditable="true" role="textbox" data-composer-markdown><p><br></p></div>
      <button type="button" data-composer-navigation-target="add-context">+</button>
      <button type="button" aria-haspopup="menu" data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning" data-selected-reasoning-effort="medium">Mittel</button>
      <button type="submit" aria-label="Senden">Senden</button>
    </div></form></main></div>`, { url: `https://chatgpt.com/c/${THREAD}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = page.window, doc = win.document;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{}]; } });
  win.postMessage = data => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { data, source: win as any, origin: win.location.origin })));
  const chain = (props: any, parent: any = null) => ({ memoizedProps: props, return: parent });
  const queries: any[] = [];
  const cache = { getAll: () => queries };
  const top = chain({ client: { getQueryCache: () => cache } });
  const entry = { id: TURN, conversationId: THREAD, turn: { status: 'in_progress', messageIds: [USER, CALL, ANSWER], items: [
    { type: 'user-message', messageId: USER, serverMessageId: USER, message: 'hello' },
    { type: 'chatgpt-reasoning-group', items: [
      { type: 'reasoning', presentation: 'preamble', content: 'Commentary without a provider message id' },
      { type: 'mcp-tool-call', callId: CALL, completed: false, invocation: { server: 'Chat On Steroids Core', tool: 'link_x/read', arguments: { private: 'NEVER_COPY_TOOL_ARGS' } }, result: null }
    ] },
    { type: 'assistant-message', messageId: ANSWER, content: 'Answer', phase: 'final_answer', completed: false }
  ] as any[] } };
  const row = chain({ entry }, top);
  (doc.querySelector('[data-turn-key]') as any).__reactFiber$fixture = row;
  (doc.querySelector('[data-content-search-unit-key$=":assistant"] [data-markdown-text-style]') as any).__reactFiber$fixture = chain({ item: entry.turn.items[2], conversationId: THREAD }, row);
  const versions = [{ id: '5.6', label: 'GPT-5.6 Sol', selected: true }, { id: 'future', label: '未来モデル', selected: false }];
  const selections = [
    [ { model: 'gpt-5-6-thinking', modelLabel: '5.6 Sol', reasoningEffort: 'medium', powerSettingIndex: 1 },
      { model: 'gpt-5-6-thinking', modelLabel: '5.6 Sol', reasoningEffort: 'high', powerSettingIndex: 2 } ],
    [ { model: 'future-thinking', modelLabel: '未来モデル', reasoningEffort: 'high', powerSettingIndex: 1 },
      { model: 'future-pro', modelLabel: '未来 Pro', reasoningEffort: 'pro', powerSettingIndex: 2 } ]
  ];
  const props: any = { powerSelections: selections[0], selectedLabelCandidate: selections[0]![0], selectedPowerSelection: null,
    modelListConfig: { options: versions }, modelSelectionDisabled: false };
  const trigger = doc.querySelector('[data-codex-intelligence-trigger]') as HTMLButtonElement;
  (trigger as any).__reactFiber$fixture = chain(props, top);
  const actions = vi.fn();
  const render = () => {
    let panel = doc.querySelector('[data-model-picker-view]') as HTMLElement;
    if (!panel) { panel = doc.createElement('div'); panel.setAttribute('data-model-picker-view', 'simple'); panel.setAttribute('role', 'menu'); doc.body.append(panel); }
    // The portal intentionally has no picker owner; only the trigger does.
    panel.innerHTML = '<div role="menuitem" data-model-picker-view-toggle>Version</div><div role="menuitem" aria-keyshortcuts="ArrowLeft ArrowRight"></div>';
    panel.querySelector('[data-model-picker-view-toggle]')!.addEventListener('click', () => {
      panel.replaceChildren();
      for (const [index, version] of versions.entries()) {
        const option = doc.createElement('div'); option.setAttribute('role', 'menuitemradio'); option.textContent = version.label;
        option.addEventListener('keydown', (event: any) => { if (event.key !== 'Enter') return;
          actions('version'); versions.forEach(v => { v.selected = v === version; }); props.powerSelections = selections[index];
          props.selectedPowerSelection = selections[index]![0]; render(); }); panel.append(option);
      }
    });
    panel.querySelector('[aria-keyshortcuts]')!.addEventListener('keydown', (event: any) => {
      const selected = props.selectedPowerSelection ?? props.selectedLabelCandidate;
      const at = props.powerSelections.indexOf(selected) + (event.key === 'ArrowRight' ? 1 : -1);
      if (!props.powerSelections[at]) return; actions('effort'); props.selectedPowerSelection = props.powerSelections[at]; render();
    });
  };
  trigger.addEventListener('keydown', event => { if (event.key === 'Enter') render(); });
  doc.addEventListener('keydown', event => { if (event.key === 'Escape') doc.querySelector('[data-model-picker-view]')?.remove(); });
  win.eval(fiberSource); win.eval(domSource);
  let serial = 0;
  const ask = (source = 'clf-fiber-ask') => new Promise<any>((resolve, reject) => {
    const nonce = `shell-${++serial}`, expected = source.replace('-ask', '-reply');
    const timer = setTimeout(() => { win.removeEventListener('message', receive as any); reject(new Error('Missing helper reply')); }, 2500);
    const receive = (event: MessageEvent) => { if (event.data?.source !== expected || event.data.nonce !== nonce) return;
      clearTimeout(timer); win.removeEventListener('message', receive as any); resolve(event.data); };
    win.addEventListener('message', receive as any); win.postMessage({ source, nonce }, win.location.origin);
  });
  return { api: (win as any).CLF_DOM, doc, win, entry, row, top, props, versions, selections, trigger, actions, queries, ask };
}

it('reads the real shell composer, messages and tools through existing contracts without a cache', async () => {
  const f = fixture();
  expect(f.api.composer()).toBe(f.doc.querySelector('[contenteditable]'));
  expect(f.api.messages()).toEqual([]); // Slot keys alone are not provider identities.
  const { turns, rows } = await f.ask();
  expect(rows).toEqual([]); expect(turns).toHaveLength(1);
  expect(turns[0]).toMatchObject({ turnId: TURN, conversationId: THREAD, conversationConflict: false, endMessageId: null });
  expect(turns[0].messages.map((m: any) => [m.role, m.rawMessageId, m.rawText])).toEqual([['user', USER, 'hello'], ['assistant', ANSWER, 'Answer']]);
  expect(turns[0].calls).toEqual([{ messageId: CALL, tool: 'read', order: 0, answered: false, requestId: null, createTime: null }]);
  expect(JSON.stringify(turns)).not.toContain('NEVER_COPY_TOOL_ARGS');
  expect(JSON.stringify(turns)).not.toContain('Commentary without a provider');
  expect(f.api.turns().map((t: any) => t.role)).toEqual(['user', 'assistant']);
  expect(f.api.messages().map((m: any) => [m.id, m.role, m.text])).toEqual([[USER, 'user', 'hello'], [ANSWER, 'assistant', 'Answer']]);
  expect(f.api.presentationTurns()).toEqual([]); // No alternate Overwrite/UI implementation.
});

it.each(['in_progress', 'cancelled', 'complete', 'unknown', undefined])('does not invent a tool receipt from turn status %s', async status => {
  const f = fixture(); (f.entry.turn as any).status = status;
  const turn = (await f.ask()).turns[0];
  expect(turn.calls[0].answered).toBe(false); expect(turn.endMessageId).toBeNull();
});
it('requires the final item and successful turn, while retaining exact messages on reload', async () => {
  const f = fixture(); f.entry.turn.items[2].completed = true;
  expect((await f.ask()).turns[0].endMessageId).toBeNull();
  f.entry.turn.status = 'complete';
  const completed = (await f.ask()).turns[0]; expect(completed.endMessageId).toBe(ANSWER);
  expect(completed.calls[0].answered).toBe(false);
  expect((await f.ask()).turns[0].messages.map((m: any) => m.messageId)).toEqual(completed.messages.map((m: any) => m.messageId));
  f.entry.turn.items.push({ type: 'assistant-message', messageId: OTHER, content: 'retry underway', phase: 'final_answer', completed: false });
  expect((await f.ask()).turns[0].endMessageId).toBeNull();
});
it('reports an explicit per-call completion without a synthetic result message', async () => {
  const f = fixture(); f.entry.turn.items[1].items[1].completed = true;
  const turn = (await f.ask()).turns[0]; expect(turn.calls[0].answered).toBe(true);
  expect(turn.messages).toHaveLength(2); expect(turn.endMessageId).toBeNull();
});
it('never takes message content or final status from an unrelated cached branch', async () => {
  const f = fixture();
  f.queries.push({ queryKey: ['chatgpt-conversation', THREAD], state: { data: { mapping: { [USER]: {
    id: USER, children: [OTHER], message: { id: USER, author: { role: 'user' }, content: { content_type: 'text', parts: ['hello'] } }
  }, [OTHER]: { id: OTHER, children: [], message: { id: OTHER, author: { role: 'assistant' }, content: { content_type: 'text', parts: ['UNSELECTED BRANCH'] }, end_turn: true, status: 'finished_successfully' } } } } } });
  const turn = (await f.ask()).turns[0]; expect(JSON.stringify(turn)).not.toContain('UNSELECTED BRANCH'); expect(turn.endMessageId).toBeNull();
});
it('requires the exact local-to-server identity and refuses conflicting native owners', async () => {
  const f = fixture(), local = `local-chatgpt:${OTHER}`;
  f.entry.conversationId = local;
  expect((await f.ask()).turns[0].conversationId).toBeNull();
  f.queries.push({ queryKey: ['chatgpt-conversation-details', { clientConversationId: local, serverConversationId: THREAD }], state: {} });
  expect((await f.ask()).turns[0].conversationId).toBe(THREAD);
  f.queries.push({ queryKey: ['chatgpt-conversation-details', { clientConversationId: local, serverConversationId: OTHER }], state: {} });
  const disputed = (await f.ask()).turns[0]; expect(disputed.conversationId).toBeNull(); expect(disputed.conversationConflict).toBe(true);
});
it('invalidates reused DOM stamps when the typed row changes identity or contains duplicate message ids', async () => {
  const f = fixture(); await f.ask();
  f.entry.id = OTHER;
  expect((await f.ask()).turns).toEqual([]); expect(f.api.messages()).toEqual([]);
  f.entry.id = TURN; f.entry.turn.items.push({ ...f.entry.turn.items[2], content: 'different answer' });
  expect((await f.ask()).turns).toEqual([]);
});
it('uses typed running state rather than a translated Stop caption', async () => {
  const f = fixture(); const send = f.doc.querySelector('button[type="submit"]')!;
  send.outerHTML = '<button type="button" aria-label="Anhalten">Anhalten</button>';
  await f.ask(); expect(f.api.generating()).toBe(true); expect(f.api.composerSubmitReady()).toBe(false);
  expect(f.api.stopButton()).toBeNull(); // No guessed action target.
});
it('leaves classic messages readable when quoted markup contains shell-looking attributes', () => {
  const f = fixture(); f.doc.body.innerHTML = '<section data-testid="conversation-turn-1" data-turn="assistant"><div data-message-id="actual" data-message-author-role="assistant"><div class="markdown">real answer<div id="app-shell-sidebar"></div><div data-turn-key="quoted"></div></div></div></section>';
  expect(f.api.turns()).toHaveLength(1); expect(f.api.messages()[0].text).toContain('real answer');
});
it('does not borrow a shell row owner for a nested exchange inside authored prose', async () => {
  const f = fixture();
  const quote = f.doc.createElement('div'); quote.setAttribute('data-turn-key', 'quoted');
  quote.innerHTML = `<div data-content-search-turn-key="${TURN}"><div data-content-search-unit-key="${TURN}:0:user">quoted user</div></div>`;
  (quote as any).__reactFiber$fixture = f.row;
  f.doc.querySelector('[data-content-search-unit-key$=":assistant"] [data-markdown-text-style]')!.append(quote);
  expect((await f.ask()).turns).toHaveLength(1);
  expect(f.api.turns()).toHaveLength(2);
  expect(quote.hasAttribute('data-clf-fiber-turn')).toBe(false);
});
it('discovers both native versions, selects exact worker lanes and restores the original setting', async () => {
  const f = fixture();
  const original = await f.ask('clf-picker-ask'); expect(original.picker.currentBucket).toBe(1);
  const models = await f.api.inspectModelSettings(); expect(models).toHaveLength(3);
  expect(models.map((m: any) => m.id)).toEqual(['gpt-5-6-thinking', 'future-thinking', 'future-pro']);
  expect(await f.api.selectModelSettings('future-pro', 'pro')).toBe(true);
  expect(f.api.visibleModelSelection()).toEqual({ model: 'future-pro', reasoningEffort: 'pro' });
  expect(await f.api.selectModelSettings('future-pro', 'high')).toBe(false);
  expect(f.doc.querySelector('[data-model-picker-view]')).toBeNull();
  expect(f.api.visibleModelSelection()).toEqual({ model: 'future-pro', reasoningEffort: 'pro' });
});
it.each(['duplicate-version', 'duplicate-bucket', 'contradictory-selection', 'unknown-effort', 'disabled'])('rejects unknown/ambiguous picker evidence: %s', async mode => {
  const f = fixture();
  if (mode === 'duplicate-version') f.versions[1]!.selected = true;
  if (mode === 'duplicate-bucket') f.selections[0]![1]!.powerSettingIndex = 1;
  if (mode === 'contradictory-selection') f.props.selectedPowerSelection = { ...f.selections[0]![0], powerSettingIndex: 99 };
  if (mode === 'unknown-effort') f.selections[0]![0]!.reasoningEffort = 'made-up';
  if (mode === 'disabled') f.props.modelSelectionDisabled = true;
  const picker = (await f.ask('clf-picker-ask')).picker;
  expect(mode === 'disabled' ? picker?.choices.some((c: any) => c.available) : picker).toBe(mode === 'disabled' ? false : null);
  expect(f.actions).not.toHaveBeenCalled();
});
it('records a native shell conversation and UUID tool origin through the real isolated recorder', async () => {
  const f = fixture(), win = f.win as any, sent: any[] = [];
  f.entry.turn.status = 'complete'; f.entry.turn.items[2].completed = true;
  let hook: any, runtime: any;
  win.CLF_TEST_HOOK = (value: any) => { hook = value; };
  win.setInterval = () => 0;
  win.chrome = { runtime: { id: 'shell-fixture', onMessage: { addListener(value: any) { runtime = value; }, removeListener() {} },
    sendMessage: async (message: any) => {
      sent.push(message);
      if (message.type === 'status') return { connected: true, paired: true, pending: 0 };
      if (message.type === 'activity') return { ok: true, data: { entries: [], stream: [] } };
      if (message.type === 'correlate') return { ok: true, data: { conversationId: THREAD, confirmed: message.calls.map((call: any) => call.requestId) } };
      return { ok: true, pending: 0, durable: true };
    } }, storage: { onChanged: { addListener() {}, removeListener() {} } } };
  win.eval(contentSource);
  await vi.waitFor(() => expect(hook).toBeTruthy());
  await hook.refreshFiber(); await hook.pullActivity(); hook.observe(); await hook.flush();
  const events = () => sent.filter(m => m.type === 'events').flatMap(m => m.entries.map((entry: any) => entry.event));
  await vi.waitFor(() => {
    expect(events()).toContainEqual(expect.objectContaining({ kind: 'user_message', messageId: USER, text: 'hello' }));
    expect(events()).toContainEqual(expect.objectContaining({ kind: 'assistant_message', providerMessageId: ANSWER, text: 'Answer', final: true }));
    expect(events()).toContainEqual(expect.objectContaining({ kind: 'tool_evidence', calls: expect.arrayContaining([expect.objectContaining({ messageId: CALL, tool: 'read', answered: false })]) }));
  });
  win.postMessage({ type: 'cos-request-origin', conversationId: THREAD, requestIds: [OTHER], observedAt: Date.now() }, win.location.origin);
  await vi.waitFor(() => expect(sent.some(m => m.type === 'correlate' && JSON.stringify(m).includes(OTHER))).toBe(true));
  const catalog = await new Promise(resolve => runtime({ type: 'clf-model-catalog', nonce: OTHER, expiresAt: Date.now() + 10000 }, {}, resolve));
  expect(catalog).toEqual({ ok: true });
  expect(sent.find(m => m.type === 'model_catalog')?.models).toHaveLength(3);
  hook.setRenderStream(true); hook.renderStreams();
  expect(f.doc.querySelector('[data-turn-key] .clf-stream')).toBeNull();
  expect(JSON.stringify(events())).not.toContain('NEVER_COPY_TOOL_ARGS');
  win.__CLF_CONTENT_RECORDER__.stop();
});
