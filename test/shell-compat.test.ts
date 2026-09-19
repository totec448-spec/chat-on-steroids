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
  return { api: (win as any).CLF_DOM, doc, win, entry, row, top, props, versions, selections, trigger, actions, queries, ask, chain };
}

// Models the observed Markdown editor's native text/break serialization, not
// the app's receipt check. No exported scripts, credentials or chat text are used.
function editing(f: ReturnType<typeof fixture>) {
  const box = f.api.composer() as HTMLElement;
  const serialize = (node: Node, literal = false, display = false): string => {
    if (node.nodeType === 3) return literal || display ? node.textContent || '' : (node.textContent || '').replace(/[\\*_`#]/g, '\\$&');
    if (!(node instanceof f.win.HTMLElement)) return '';
    if (node.tagName === 'BR') return literal || display ? '\n' : '\\\n';
    return [...node.childNodes].map(child => serialize(child, literal || node.matches('span[data-prompt-literal-paste]'), display)).join('');
  };
  Object.defineProperty(box, 'innerText', { get: () => serialize(box, false, true) });
  f.doc.execCommand = vi.fn((command, _ui, html) => {
    const selection = f.doc.getSelection();
    if (f.doc.activeElement !== box || !selection) return false;
    if (command === 'selectAll') { selection.selectAllChildren(box); return true; }
    if (!['insertHTML', 'delete'].includes(command) || !selection.rangeCount) return false;
    const range = selection.getRangeAt(0); range.deleteContents();
    if (command === 'insertHTML') {
      const template = f.doc.createElement('template'); template.innerHTML = html || ''; range.insertNode(template.content);
    }
    return true;
  });
  return { box, serialize: () => serialize(box) };
}

async function recorder(f: ReturnType<typeof fixture>, replies: Record<string, (m: any) => any> = {}) {
  const win = f.win as any, sent: any[] = [];
  let hook: any, listener: any;
  win.CLF_TEST_HOOK = (value: any) => { hook = value; };
  win.setInterval = () => 0;
  win.chrome = { runtime: { id: 'shell-fixture', onMessage: { addListener(value: any) { listener = value; }, removeListener() {} },
    sendMessage: async (message: any) => {
      sent.push(message);
      if (replies[message.type]) return replies[message.type]!(message);
      if (message.type === 'status') return { connected: true, paired: true, pending: 0 };
      if (message.type === 'activity') return { ok: true, data: { entries: [], stream: [], pendingTools: 0 } };
      if (message.type === 'correlate') return { ok: true, data: { conversationId: THREAD, confirmed: message.calls.map((call: any) => call.requestId) } };
      return { ok: true, pending: 0, durable: true };
    } }, storage: { onChanged: { addListener() {}, removeListener() {} } } };
  win.eval(contentSource);
  await vi.waitFor(() => expect(hook).toBeTruthy());
  await hook.refreshFiber(); await hook.pullActivity(); hook.observe(); await hook.flush();
  return { sent, hook, runtime: (message: any) => new Promise<any>(resolve => listener(message, {}, resolve)),
    events: () => sent.filter(m => m.type === 'events').flatMap(m => m.entries.map((entry: any) => entry.event)) };
}

function addExchange(f: ReturnType<typeof fixture>, ordinal: number, text: string) {
  const id = (part: number) => `99999999-1111-4111-8111-${String(ordinal * 10 + part).padStart(12, '0')}`;
  const userId = id(1), turnId = id(2), answerId = id(3);
  const node = f.doc.createElement('div'); node.setAttribute('data-turn-key', userId);
  node.innerHTML = `<div data-content-search-turn-key="${turnId}"><div data-content-search-unit-key="${turnId}:0:user"><div data-user-message-bubble><div class="whitespace-pre-wrap"></div></div></div><span hidden data-chatgpt-agent-turn-start></span><div data-content-search-unit-key="${turnId}:1:assistant"><div data-markdown-text-style="assistant-message"></div></div></div>`;
  node.querySelector('.whitespace-pre-wrap')!.textContent = text;
  const entry = { id: turnId, conversationId: THREAD, turn: { status: 'in_progress', messageIds: [userId, answerId], items: [
    { type: 'user-message', messageId: userId, serverMessageId: userId, message: text },
    { type: 'assistant-message', messageId: answerId, content: 'Working', phase: 'final_answer', completed: false }
  ] } };
  (node as any).__reactFiber$fixture = f.chain({ entry }, f.top);
  f.doc.querySelector('[data-thread-find-target]')!.append(node);
  return { userId, answerId, entry, finish() { entry.turn.status = 'complete'; entry.turn.items[1]!.completed = true;
    entry.turn.items[1]!.content = 'Finished'; node.querySelector('[data-markdown-text-style]')!.textContent = 'Finished'; } };
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
it('reads request metadata only for the mounted shell message ids in the exact native cache', async () => {
  const f = fixture();
  const message = { id: CALL, author: { role: 'assistant' }, recipient: 'api_tool.call_tool',
    metadata: { request_id: OTHER }, create_time: 1700000000,
    content: { content_type: 'code', text: '{"path":"/Chat On Steroids Core/link_x/read","args":{"secret":"NEVER_COPY"}}' } };
  f.queries.push({ queryKey: ['chatgpt-conversation', THREAD], state: { data: { mapping: {
    [CALL]: { id: CALL, message },
    [OTHER]: { id: OTHER, message: { ...message, id: OTHER, metadata: { request_id: 'wfr_UNSELECTED' } } }
  } } } });
  const turn = (await f.ask()).turns[0];
  expect(turn.requests).toEqual([{ requestId: OTHER, messageId: CALL, createTime: 1700000000 }]);
  expect(turn.calls[0]).toMatchObject({ messageId: CALL, requestId: OTHER, answered: false });
  expect(JSON.stringify(turn)).not.toContain('NEVER_COPY');
  expect(JSON.stringify(turn)).not.toContain('wfr_UNSELECTED');
  const recorded = await recorder(f);
  await vi.waitFor(() => expect(recorded.sent).toContainEqual(expect.objectContaining({ type: 'correlate',
    conversationId: THREAD, calls: expect.arrayContaining([expect.objectContaining({ requestId: OTHER })]) })));
  (f.win as any).__CLF_CONTENT_RECORDER__.stop();
  f.queries[0].queryKey[1] = OTHER;
  expect((await f.ask()).turns[0].requests).toEqual([]);
  f.queries[0].queryKey[1] = THREAD; f.queries[0].state.data.mapping[CALL].message.id = OTHER;
  expect((await f.ask()).turns[0].requests).toEqual([]);
});
it.each(['duplicate-cache', 'conflicting-conversation', 'duplicate-id', 'unavailable-cache'])('keeps the transcript without ambiguous optional request metadata (%s)', async kind => {
  const f = fixture();
  const query = { queryKey: ['chatgpt-conversation', THREAD], state: { data: { conversation_id: THREAD, mapping: {
    [CALL]: { id: CALL, message: { id: CALL, metadata: { request_id: OTHER } } }
  } } } };
  f.queries.push(query);
  if (kind === 'duplicate-cache') f.queries.push(query);
  if (kind === 'conflicting-conversation') query.state.data.conversation_id = OTHER;
  if (kind === 'duplicate-id') f.entry.turn.messageIds.push(CALL);
  if (kind === 'unavailable-cache') f.top.memoizedProps.client.getQueryCache = () => { throw new Error('retired'); };
  const turn = (await f.ask()).turns[0];
  expect(turn.requests).toEqual([]); expect(turn.messages).toHaveLength(2); expect(turn.endMessageId).toBeNull();
});
it('recognizes the shell recipient spelling without admitting similarly named connectors', async () => {
  const f = fixture(), step = f.entry.turn.items[1].items[1];
  step.invocation.server = 'Chat_On_Steroids_Core'; step.invocation.tool = 'read';
  expect((await f.ask()).turns[0].calls).toHaveLength(1);
  step.invocation.server = 'Chat_On_Steroids_Core_Backup';
  expect((await f.ask()).turns[0].calls).toEqual([]);
});
it('retires shell busy evidence when its owner becomes unreadable or another question is mounted', async () => {
  const f = fixture(); await f.ask(); expect(f.api.generating()).toBe(true);
  f.entry.id = OTHER; await f.ask(); expect(f.api.generating()).toBe(false);
  f.entry.id = TURN; await f.ask(); expect(f.api.generating()).toBe(true);
  const next = addExchange(f, 5, 'Another question'); next.finish(); await f.ask();
  expect(f.api.generating()).toBe(false);
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
it('preserves prepared multiline text through the shell editor serializer', () => {
  const f = fixture(), edit = editing(f);
  const value = '[[COS_CONTEXT:42]]\n# Worker instructions\n- Keep **literal** text, C:\\work and `<tag>`.\n[[/COS_CONTEXT]]\n\nContinue the task.';
  expect(f.api.insertPrompt(value, true)).toBe(true);
  expect(edit.serialize()).toBe(value);
  expect(f.doc.execCommand).toHaveBeenCalledOnce();
  expect(edit.box.querySelector('tag')).toBeNull();
});
it('hides only a verified shell prompt frame and restores a recycled user bubble', async () => {
  const f = fixture(), unit = f.doc.querySelector('[data-content-search-unit-key$=":user"]')!;
  const raw = unit.querySelector('.whitespace-pre-wrap')!;
  const full = '[[COS_CONTEXT:13]]\nPrivate setup\n[[/COS_CONTEXT]]\n\nAuthored request';
  f.entry.turn.items[0].message = full; raw.textContent = full;
  f.api.presentUserPrompts();
  expect(unit.querySelector('[data-clf-user-text]')).toBeNull(); // A layout key cannot authorize rewriting.
  await f.ask();
  f.api.presentUserPrompts((message: { id: string }) => message.id === USER ? full : null);
  expect(unit.querySelector('[data-clf-user-text]')?.textContent).toBe('Authored request');
  expect(raw.hasAttribute('data-clf-prompt-hidden')).toBe(true);
  expect(f.api.messages().find((message: any) => message.id === USER)?.text).toBe(full);
  f.entry.turn.items[0].message = 'A new question'; raw.textContent = 'A new question';
  f.api.presentUserPrompts(() => 'A new question');
  expect(unit.querySelector('[data-clf-user-text]')).toBeNull();
  expect(raw.hasAttribute('data-clf-prompt-hidden')).toBe(false);
});
it('delivers three successive shell inputs with exact receipts and completed answers', async () => {
  const f = fixture(), edit = editing(f);
  f.entry.turn.status = 'complete'; f.entry.turn.items[2].completed = true;
  let offered: any, latest: ReturnType<typeof addExchange>, count = 0;
  const submitted: string[] = [];
  f.doc.querySelector('button[type="submit"]')!.addEventListener('click', event => {
    event.preventDefault(); const text = edit.serialize(); submitted.push(text);
    latest = addExchange(f, ++count, text); edit.box.replaceChildren();
  });
  const r = await recorder(f, { desktop_input: m => ({ ok: true, data: m.authorize || m.ack || m.fail ? { ok: true } : { input: offered } }) });
  for (let at = 1; at <= 3; at++) {
    const text = at === 1 ? '[[COS_CONTEXT:13]]\nPrivate setup\n[[/COS_CONTEXT]]\n\n# First **request**' : `Follow-up ${at}\nKeep C:\\work and **literal** text.`;
    offered = { id: `88888888-1111-4111-8111-${String(at).padStart(12, '0')}`, owner: `owner-${at}`, text,
      model: 'gpt-5-6-thinking', reasoningEffort: 'high', purpose: 'user', images: [] };
    const pending = r.runtime({ type: 'clf-desktop-input', id: offered.id, conversationId: THREAD });
    await vi.waitFor(() => expect(submitted).toHaveLength(at), { timeout: 5000 });
    await r.hook.refreshFiber(); r.hook.observe();
    expect(await pending).toEqual({ ok: true });
    expect(submitted.at(-1)).toBe(text);
    expect(r.sent.filter(m => m.type === 'desktop_input' && m.ack && m.id === offered.id)).toHaveLength(1);
    latest!.finish(); await r.hook.refreshFiber(); r.hook.observe(); await r.hook.flush();
    await vi.waitFor(() => expect(r.events()).toContainEqual(expect.objectContaining({ kind: 'assistant_message', providerMessageId: latest!.answerId, final: true })), { timeout: 3000 });
    expect(f.api.generating()).toBe(false); expect(edit.box.textContent).toBe('');
  }
  expect(r.sent.filter(m => m.type === 'desktop_input' && m.fail)).toEqual([]);
  expect(r.events().filter((e: any) => e.kind === 'turn_end' && e.outcome === 'completed')).toHaveLength(3);
  (f.win as any).__CLF_CONTENT_RECORDER__.stop();
}, 15000);
it('bootstraps a shell worker with literal instructions and the exact native conversation', async () => {
  const f = fixture(), edit = editing(f), commandId = 'shell-worker-command';
  f.doc.querySelector('[data-thread-find-target]')!.replaceChildren();
  page.reconfigure({ url: `https://chatgpt.com/?clf=${commandId}` });
  const text = '[[COS_CONTEXT:13]]\nPrivate setup\n[[/COS_CONTEXT]]\n\n# Worker\nRead **one** file.';
  const submitted: string[] = [];
  f.doc.querySelector('button[type="submit"]')!.addEventListener('click', event => {
    event.preventDefault(); submitted.push(edit.serialize()); addExchange(f, 4, submitted[0]!); edit.box.replaceChildren();
    f.win.history.pushState({}, '', `/c/${THREAD}`);
  });
  const r = await recorder(f, { redeem: () => ({ ok: true, command: { id: commandId, type: 'worker', text,
    agent: 'worker-1', model: 'gpt-5-6-thinking', reasoningEffort: 'high' } }) });
  await vi.waitFor(() => expect(r.sent).toContainEqual(expect.objectContaining({ type: 'ack', id: commandId, status: 'sent', conversationId: THREAD, agent: 'worker-1' })), { timeout: 5000 });
  expect(submitted).toEqual([text]);
  expect(r.sent.filter(m => m.type === 'ack' && m.status === 'failed')).toEqual([]);
  (f.win as any).__CLF_CONTENT_RECORDER__.stop();
}, 10000);
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
