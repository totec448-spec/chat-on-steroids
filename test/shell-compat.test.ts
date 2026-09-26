/** Focused adaptation of @ehkogh's observed shell fixtures in #318 (c18f289c).
 * Only page identity, authored messages, tool evidence and the native picker.
 * No cache-derived message history, invented receipts or alternate presentation. */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

const domSource = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const fiberSource = readFileSync(new URL('../extension/fiber.js', import.meta.url), 'utf8');
const contentSource = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const usageSource = readFileSync(new URL('../extension/usage.js', import.meta.url), 'utf8');
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

async function recorder(f: ReturnType<typeof fixture>, replies: Record<string, (m: any) => any> = {}, initialize = true) {
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
  if (initialize) { await hook.refreshFiber(); await hook.pullActivity(); hook.observe(); await hook.flush(); }
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

function firstMissingPicker(f: ReturnType<typeof fixture>) {
  return new Promise<void>(resolve => {
    const receive = (event: MessageEvent) => {
      if (event.data?.source !== 'clf-picker-reply' || event.data.picker !== null) return;
      f.win.removeEventListener('message', receive as any); resolve();
    };
    f.win.addEventListener('message', receive as any);
  });
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
  expect(f.api.presentationTurns().map((t: any) => t.role)).toEqual(['user', 'assistant']);
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

// The exported native page subscribes to its live message mapping separately from
// the history query. React publishes that value in hook state / compiler memo data.
function liveShellMapping(f: ReturnType<typeof fixture>, compiler = false) {
  const thought = '66666666-1111-4111-8111-111111111111';
  const preamble = '77777777-1111-4111-8111-111111111111';
  const plain = (id: string, role: string, text: string, channel?: string) => ({ id, message: {
    id, author: { role }, channel, content: { content_type: 'text', parts: [text] }, metadata: {}, create_time: 1700000000
  } });
  const mapping: any = {
    [USER]: plain(USER, 'user', 'hello'), [ANSWER]: plain(ANSWER, 'assistant', 'Answer', 'final'),
    [CALL]: { id: CALL, message: { id: CALL, author: { role: 'assistant' }, recipient: 'api_tool.call_tool',
      metadata: { request_id: OTHER }, content: { content_type: 'code', text: '{"path":"/Chat On Steroids Core/link_x/read","args":{"private":"DO_NOT_COPY"}}' } } },
    [thought]: { id: thought, message: { id: thought, author: { role: 'assistant' },
      content: { content_type: 'thoughts', thoughts: [{ summary: 'Inspecting the project', content: 'PRIVATE_REASONING_CONTENT' }] }, metadata: {} } },
    [preamble]: plain(preamble, 'assistant', 'I will inspect the project.', 'commentary')
  };
  f.entry.turn.messageIds = [USER, thought, preamble, CALL, ANSWER];
  f.entry.turn.items[1].items.unshift({ type: 'reasoning', presentation: 'thought', content: 'Inspecting the project', completed: false });
  f.entry.turn.items[1].items[1].content = 'I will inspect the project.';
  const owner: any = f.chain({ conversationId: THREAD }, f.top);
  for (let at = 0; at < f.entry.turn.messageIds.length; at++) {
    const id = f.entry.turn.messageIds[at]!; mapping[id].parent = f.entry.turn.messageIds[at - 1] ?? null;
  }
  const snapshot = { renderedConversation: { mapping, current_node: ANSWER }, renderedTurns: [{ id: TURN, turn: f.entry.turn }] };
  if (compiler) owner.updateQueue = { memoCache: { data: [[null, THREAD, mapping, snapshot]] } };
  else owner.memoizedState = { memoizedState: snapshot, next: null };
  f.row.return = owner;
  return { mapping, owner, thought, preamble, snapshot };
}

it.each([false, true])('captures live shell request metadata and public activity before a history query exists (compiler=%s)', async compiler => {
  const f = fixture(), { thought, preamble } = liveShellMapping(f, compiler);
  const turn = (await f.ask()).turns[0];
  expect(f.queries).toEqual([]);
  expect(turn.calls[0]).toMatchObject({ requestId: OTHER, messageId: CALL, answered: false });
  expect(turn.activities).toEqual([{ messageId: thought, label: 'Inspecting the project', order: 1 }]);
  expect(turn.messages.map((m: any) => [m.rawMessageId, m.order])).toEqual([[USER, 0], [preamble, 2], [ANSWER, 4]]);
  expect(turn.messages.find((m: any) => m.rawMessageId === preamble)?.rawText).toBe('I will inspect the project.');
  expect(JSON.stringify(turn)).not.toMatch(/PRIVATE_REASONING_CONTENT|DO_NOT_COPY/);
  const r = await recorder(f);
  await vi.waitFor(() => expect(r.sent).toContainEqual(expect.objectContaining({ type: 'correlate',
    conversationId: THREAD, calls: expect.arrayContaining([expect.objectContaining({ requestId: OTHER })]) })));
  expect(r.events()).toContainEqual(expect.objectContaining({ kind: 'page_tool', messageId: thought, text: 'Inspecting the project' }));
  (f.win as any).__CLF_CONTENT_RECORDER__.stop();
});

// React keeps the host's original Fiber pointer across commits. The current root
// and child lists are the published tree; memo bailouts can keep old return links.
function bufferedShell(f: ReturnType<typeof fixture>, sharedChild = false) {
  const { owner, snapshot } = liveShellMapping(f, true);
  const native = f.doc.querySelector('[data-turn-key]')!;
  const oldHost: any = { tag: 5, stateNode: native, memoizedProps: {}, return: f.row };
  const nextEntry = sharedChild ? f.entry : structuredClone(f.entry);
  const nextSnapshot = { renderedConversation: structuredClone(snapshot.renderedConversation),
    renderedTurns: [{ id: TURN, turn: nextEntry.turn }] };
  nextSnapshot.renderedConversation.mapping[CALL].message.metadata.request_id = 'wfr_committed_update';
  const state: any = { current: null };
  const oldRoot: any = { tag: 3, stateNode: state, return: null, child: owner };
  const nextRoot: any = { tag: 3, stateNode: state, return: null };
  const nextOwner: any = { tag: 0, memoizedProps: { conversationId: THREAD }, return: nextRoot,
    updateQueue: { memoCache: { data: [[nextSnapshot]] } } };
  const nextRow: any = sharedChild ? f.row : { tag: 0, memoizedProps: { entry: nextEntry }, return: nextOwner };
  const nextHost: any = sharedChild ? oldHost : { tag: 5, stateNode: native, memoizedProps: {}, return: nextRow };
  owner.tag = 0; owner.return = oldRoot; owner.child = f.row;
  Object.assign(f.row, { tag: 0, child: oldHost });
  nextRoot.child = nextOwner; nextOwner.child = nextRow; nextRow.child = nextHost;
  for (const [a, b] of [[oldRoot, nextRoot], [owner, nextOwner], ...(!sharedChild ? [[f.row, nextRow], [oldHost, nextHost]] : [])]) {
    a.alternate = b; b.alternate = a;
  }
  state.current = oldRoot;
  (native as any).__reactFiber$fixture = oldHost;
  return { state, oldRoot, nextRoot, oldHost, nextHost, owner, nextOwner, nextEntry, nextSnapshot, native };
}

it.each([false, true])('reads committed shell metadata across real React double-buffer shapes (shared child=%s)', async sharedChild => {
  const f = fixture(), tree = bufferedShell(f, sharedChild);
  expect((await f.ask()).turns[0].calls[0].requestId).toBe(OTHER);
  // Work in progress is already reachable but has not been committed.
  expect((await f.ask()).turns[0].requests.some((row: any) => row.requestId === 'wfr_committed_update')).toBe(false);
  tree.state.current = tree.nextRoot;
  expect((await f.ask()).turns[0].calls[0].requestId).toBe('wfr_committed_update');
  // Preserve React's own pointers. The reader must not reparent a shared subtree.
  expect((tree.native as any).__reactFiber$fixture).toBe(tree.oldHost);
  expect(f.row.return).toBe(tree.owner);
  tree.state.current = tree.oldRoot;
  expect((await f.ask()).turns[0].calls[0].requestId).toBe(OTHER);
});

it.each(['foreign-current', 'unmounted', 'inconsistent-root', 'sibling-cycle'])('does not substitute stale React evidence for %s', async state => {
  const f = fixture(), tree = bufferedShell(f);
  await f.ask();
  tree.state.current = tree.nextRoot;
  if (state === 'foreign-current') tree.nextEntry.id = 'different-mounted-turn';
  if (state === 'unmounted') tree.nextRoot.child = null;
  if (state === 'inconsistent-root') tree.state.current = { tag: 3 };
  if (state === 'sibling-cycle') { const sibling: any = {}; sibling.sibling = sibling; tree.nextOwner.child = sibling; }
  expect((await f.ask()).turns).toEqual([]);
  expect(f.api.messages()).toEqual([]);
});

it.each([false, true])('correlates a witnessed shell send before its client conversation resolves (compiler=%s)', async compiler => {
  const f = fixture(), edit = editing(f), { owner } = liveShellMapping(f, compiler);
  f.entry.conversationId = `local-chatgpt:${OTHER}`;
  owner.memoizedProps.conversationId = f.entry.conversationId;
  const native = f.doc.querySelector('[data-turn-key]')!;
  native.remove();
  f.doc.querySelector('button[type="submit"]')!.addEventListener('click', event => {
    event.preventDefault();
    f.doc.querySelector('[data-thread-find-target]')!.append(native);
    edit.box.replaceChildren();
  });
  const r = await recorder(f);
  expect(f.api.insertPrompt('hello', true)).toBe(true);
  f.doc.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  // The native send and existing transcript observer must discover the new
  // shell identities. Manually asking Fiber here hides the admission deadlock.
  await vi.waitFor(async () => {
    await r.hook.flush();
    expect(r.events().filter((event: any) => event.kind === 'turn_start')).toHaveLength(1);
  });
  await vi.waitFor(() => expect(r.sent.filter(m => m.type === 'correlate')).toContainEqual(expect.objectContaining({
    conversationId: THREAD, calls: expect.arrayContaining([expect.objectContaining({ requestId: OTHER })])
  })));
  const localTurnId = r.events().find((event: any) => event.kind === 'turn_start').turnId;
  expect(r.events().filter((event: any) => event.kind === 'tool_evidence')).toContainEqual(expect.objectContaining({
    turnId: localTurnId, calls: expect.arrayContaining([expect.objectContaining({ messageId: CALL, requestId: OTHER })])
  }));
  expect(f.queries).toEqual([]);
  expect(JSON.stringify(r.sent)).not.toMatch(/PRIVATE_REASONING_CONTENT|DO_NOT_COPY/);
  (f.win as any).__CLF_CONTENT_RECORDER__.stop();
});

it('holds provisional shell request metadata until this document owns the native send', async () => {
  const f = fixture(), { owner } = liveShellMapping(f, true);
  f.entry.conversationId = `local-chatgpt:${OTHER}`;
  owner.memoizedProps.conversationId = f.entry.conversationId;
  // A readable mounted snapshot without a Send witness is not a route binding.
  const r = await recorder(f);
  await r.hook.refreshFiber(); await r.hook.flush();
  expect(r.sent.filter(m => m.type === 'correlate')).toEqual([]);
  expect(r.events().filter((event: any) => event.kind === 'tool_evidence')
    .flatMap((event: any) => event.calls).some((call: any) => call.requestId === OTHER)).toBe(false);
  (f.win as any).__CLF_CONTENT_RECORDER__.stop();
});

it.each(['live', 'history', 'wrong-recipient', 'unselected', 'duplicate'])
  ('reads the mounted native Code Mode invocation metadata without its result body (%s)', async state => {
    const f = fixture(), { mapping } = liveShellMapping(f, true);
    const execution = '88888888-3333-4333-8333-333333333333';
    const requestId = 'wfr_native_execution';
    mapping[execution] = { id: execution, message: { id: execution, author: { role: 'assistant' },
      recipient: state === 'wrong-recipient' ? 'functions.other' : 'functions.exec',
      metadata: { request_id: requestId }, content: { content_type: 'code' } } };
    Object.defineProperty(mapping[execution].message.content, 'text', { get() { throw Error('Execution code must remain unread'); } });
    const item = { type: 'dynamic-tool-call', callId: execution, tool: 'exec', completed: false };
    if (state !== 'unselected') f.entry.turn.items[1].items.push(item);
    if (state === 'duplicate') f.entry.turn.items[1].items.push(item);
    if (state === 'history') {
      f.row.return = f.top;
      f.queries.push({ queryKey: ['chatgpt-conversation', THREAD], state: { data: { mapping } } });
    }
    const result = await f.ask();
    const requests = result.turns.flatMap((turn: any) => turn.requests);
    expect(requests.some((request: any) => request.requestId === requestId)).toBe(['live', 'history'].includes(state));
    expect(JSON.stringify(result)).not.toContain('Execution code');
  });

it.each(['foreign-owner', 'missing-user', 'wrong-user', 'two-mappings', 'getter', 'duplicate-selected-id'])('does not borrow live shell metadata from %s', async kind => {
  const f = fixture(), { mapping, owner, snapshot } = liveShellMapping(f);
  if (kind === 'foreign-owner') owner.memoizedProps.conversationId = OTHER;
  if (kind === 'missing-user') delete mapping[USER];
  if (kind === 'wrong-user') mapping[USER].message.id = OTHER;
  if (kind === 'two-mappings') owner.memoizedState.next = { memoizedState: { ...snapshot, renderedConversation: { ...snapshot.renderedConversation, mapping: { ...mapping, [CALL]: {
    id: CALL, message: { ...mapping[CALL].message, metadata: { request_id: 'wfr_conflict' } }
  } } } }, next: null };
  if (kind === 'getter') Object.defineProperty(mapping, USER, { get() { throw Error('not a published value'); } });
  if (kind === 'duplicate-selected-id') f.entry.turn.messageIds.push(CALL);
  const turn = (await f.ask()).turns[0];
  expect(turn).toBeDefined(); expect(turn.requests).toEqual([]); expect(turn.activities).toEqual([]);
});

it.each(['final', 'preamble', 'tools-only'])('places recorded shell tools after their user and beside the exact native response (%s)', async state => {
  const f = fixture(), { preamble } = liveShellMapping(f, true), owner = 'local-shell-tools';
  f.entry.turn.status = 'complete'; f.entry.turn.items[2].completed = true;
  const section = f.doc.querySelector('[data-turn-key]')!;
  const user = section.querySelector('[data-content-search-unit-key$=":user"]')!;
  const answer = section.querySelector('[data-content-search-unit-key$=":assistant"]')!;
  const publicNode = section.querySelector('[data-markdown-text-style]')!;
  publicNode.textContent = 'I will inspect the project.';
  (publicNode as any).__reactFiber$fixture = f.chain({ item: f.entry.turn.items[1].items[1], localConversationId: THREAD }, f.row);
  const stream: any[] = [{ seq: 2, time: 102, kind: 'turn_start', turnId: owner }];
  if (state === 'preamble') stream.push({ seq: 3, time: 103, kind: 'assistant_message', turnId: owner,
    messageId: preamble, text: publicNode.textContent, state: 'streaming', final: false });
  stream.push({ seq: 4, time: 104, kind: 'tool_call', turnId: owner, callId: 'local-call', requestId: OTHER,
    tool: 'read', outcome: 'ok', durationMs: 4, summary: { kind: 'read', title: 'Read project source' } });
  if (state === 'final') stream.push({ seq: 5, time: 105, kind: 'assistant_message', turnId: owner,
    messageId: ANSWER, providerMessageId: ANSWER, text: 'Answer', state: 'final', final: true });
  if (state !== 'final') { answer.remove(); f.entry.turn.items.pop(); }
  if (state !== 'preamble') { publicNode.remove(); f.entry.turn.items[1].items.splice(0, 2); }
  const r = await recorder(f, { activity: () => ({ ok: true, data: { entries: [], stream,
    userAnchors: [{ seq: 1, time: 100, messageId: USER }], pendingTools: 0, job: null } }) });
  r.hook.setRenderStream(true); await r.hook.pullActivity(); r.hook.renderStreams();
  const root = section.querySelector('.clf-stream');
  expect(root?.textContent).toContain('Read project source');
  expect(user.compareDocumentPosition(root!) & f.win.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  if (state === 'final') expect(root!.compareDocumentPosition(answer) & f.win.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  if (state === 'preamble') expect(publicNode.compareDocumentPosition(root!) & f.win.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(f.queries).toEqual([]);
  r.hook.setRenderStream(false); r.hook.renderStreams();
  expect(section.querySelector('.clf-stream')).toBeNull();
  expect(user.isConnected).toBe(true);
  (f.win as any).__CLF_CONTENT_RECORDER__.stop();
});

it.each(['current', 'older-turn', 'wrong-parent', 'cycle', 'unselected-branch'])('reads early metadata only on the native selected path of this exact turn (%s)', async state => {
  const f = fixture(), { mapping, snapshot } = liveShellMapping(f, true), early = '88888888-1111-4111-8111-111111111111';
  mapping[early] = { id: early, parent: ANSWER, message: { id: early, author: { role: 'assistant' }, channel: 'analysis',
    metadata: { request_id: 'wfr_early_native' }, content: { content_type: 'text', parts: ['PRIVATE_EARLY_ANALYSIS'] } } };
  if (state !== 'unselected-branch') snapshot.renderedConversation.current_node = early;
  if (state === 'older-turn') snapshot.renderedTurns.push({ id: OTHER, turn: { ...f.entry.turn } });
  if (state === 'wrong-parent') mapping[early].parent = OTHER;
  if (state === 'cycle') mapping[early].parent = early;
  const result = (await f.ask()).turns[0];
  expect(result.requests.some((r: any) => r.requestId === 'wfr_early_native')).toBe(state === 'current');
  expect(JSON.stringify(result)).not.toContain('PRIVATE_EARLY_ANALYSIS');
});

it.each(['hidden', 'raw-cot', 'unknown-presentation', 'hidden-group', 'different-public-label'])('does not export private or unrepresented reasoning (%s)', async kind => {
  const f = fixture(), { mapping, thought } = liveShellMapping(f);
  const group = f.entry.turn.items[1], message = mapping[thought].message;
  if (kind === 'hidden') message.metadata.is_visually_hidden_from_conversation = true;
  if (kind === 'raw-cot') message.metadata.summary_type = 'raw_cot';
  if (kind === 'unknown-presentation') group.items[0].presentation = 'private';
  if (kind === 'hidden-group') group.reasoningRecap = { type: 'hide_all' };
  if (kind === 'different-public-label') group.items[0].content = 'A different summary';
  expect((await f.ask()).turns[0].activities).toEqual([]);
});
it('keeps a public preamble under the existing stable source identity when its raw streaming id rotates', async () => {
  const f = fixture(), { mapping, preamble } = liveShellMapping(f, true);
  mapping[preamble].message.metadata = { working_turn_id: TURN, turn_exchange_id: OTHER };
  const first = (await f.ask()).turns[0].messages.find((m: any) => m.rawMessageId === preamble);
  expect(first.stable).toBe(true);
  const replacement = '99999999-2222-4222-8222-111111111111';
  mapping[replacement] = { ...mapping[preamble], id: replacement, message: { ...mapping[preamble].message, id: replacement } };
  delete mapping[preamble]; mapping[CALL].parent = replacement;
  f.entry.turn.messageIds = f.entry.turn.messageIds.map((id: string) => id === preamble ? replacement : id);
  const second = (await f.ask()).turns[0].messages.find((m: any) => m.rawMessageId === replacement);
  expect(second.messageId).toBe(first.messageId); expect(second.stable).toBe(true);
});
it('removes a public preamble placement stamp when the native typed owner is replaced', async () => {
  const f = fixture(), { preamble } = liveShellMapping(f, true);
  const node = f.doc.querySelector('[data-markdown-text-style]')!;
  (node as any).__reactFiber$fixture = f.chain({ item: f.entry.turn.items[1].items[1] }, f.row);
  await f.ask(); expect(node.getAttribute('data-clf-fiber-message')).toContain(preamble);
  f.entry.turn.items[1].items[1] = { ...f.entry.turn.items[1].items[1] };
  await f.ask(); expect(node.hasAttribute('data-clf-fiber-message')).toBe(false);
  expect(node.isConnected).toBe(true);
});
it('uses the same exact call before and after history hydration and refuses a conflicting history request', async () => {
  const f = fixture(), { mapping } = liveShellMapping(f, true);
  const before = (await f.ask()).turns[0];
  const cached = { id: CALL, message: { id: CALL, metadata: { request_id: OTHER } } };
  f.queries.push({ queryKey: ['chatgpt-conversation', THREAD], state: { data: { conversation_id: THREAD, mapping: { [CALL]: cached } } } });
  const after = (await f.ask()).turns[0];
  expect(after.calls).toEqual(before.calls); expect(after.activities).toEqual(before.activities);
  cached.message.metadata.request_id = 'wfr_conflicting_history';
  const disputed = (await f.ask()).turns[0];
  expect(disputed.requests).toEqual([]); expect(disputed.calls[0].requestId).toBeNull();
  expect(mapping[CALL].message.metadata.request_id).toBe(OTHER);
});

// Native dump 811613: N() retains the invocation's callId but replaces its
// sourceMessage with the tool result and publishes widgetStateSource.messageId.
// The rendered turn's messageIds are the source ids, not the invocation ids.
function pairedShellCall(f: ReturnType<typeof fixture>) {
  const { mapping, owner } = liveShellMapping(f, true);
  const resultId = '88888888-3333-4333-8333-333333333333';
  const step = f.entry.turn.items[1].items.find((item: any) => item.type === 'mcp-tool-call');
  step.completed = true;
  step.widgetStateSource = { messageId: resultId };
  step.invocationResourceUri = '/Chat On Steroids Core/link_x/read';
  mapping[resultId] = { id: resultId, parent: CALL, message: { id: resultId,
    author: { role: 'tool', name: 'api_tool.call_tool' }, recipient: 'all',
    metadata: { invoked_resource: { app_name: 'Chat On Steroids Core', resource_uri: step.invocationResourceUri } },
    content: { content_type: 'text', parts: ['PRIVATE_TOOL_RESULT'] } } };
  mapping[ANSWER].parent = resultId;
  f.entry.turn.messageIds = f.entry.turn.messageIds.map(id => id === CALL ? resultId : id);
  f.entry.turn.status = 'complete'; f.entry.turn.items[2].completed = true;
  // A reopened historical row can lack the live renderer's selected-path snapshot.
  delete owner.updateQueue;
  f.queries.push({ queryKey: ['chatgpt-conversation', THREAD], state: { data: { mapping } } });
  return { mapping, step, resultId };
}

it.each(['request', 'result', 'embedded'] as const)('keeps native paired shell request ownership after reload (%s metadata)', async source => {
  const f = fixture(), { mapping, step, resultId } = pairedShellCall(f);
  if (source !== 'request') {
    delete mapping[CALL]; mapping[resultId].message.metadata.request_id = OTHER;
    if (source === 'embedded') step.callId = 'native-mcp-call-not-a-provider-message';
  }
  const turn = (await f.ask()).turns[0];
  expect(turn.calls).toEqual([expect.objectContaining({ messageId: step.callId, requestId: OTHER, answered: true })]);
  expect(turn.requests).toContainEqual(expect.objectContaining({ requestId: OTHER }));
  expect(JSON.stringify(turn)).not.toMatch(/PRIVATE_TOOL_RESULT|NEVER_COPY_TOOL_ARGS|DO_NOT_COPY/);
  const r = await recorder(f);
  await vi.waitFor(() => expect(r.sent).toContainEqual(expect.objectContaining({ type: 'correlate',
    conversationId: THREAD, calls: expect.arrayContaining([expect.objectContaining({ requestId: OTHER })]) })));
  expect(r.events()).toContainEqual(expect.objectContaining({ kind: 'tool_evidence',
    calls: expect.arrayContaining([expect.objectContaining({ messageId: step.callId, requestId: OTHER })]) }));
  (f.win as any).__CLF_CONTENT_RECORDER__.stop();
});

it.each(['unselected-source', 'wrong-tool', 'wrong-server', 'wrong-role', 'conflicting-request', 'duplicate-source'])('does not borrow paired shell invocation metadata from %s', async scenario => {
  const f = fixture(), { mapping, step, resultId } = pairedShellCall(f);
  if (scenario === 'unselected-source') step.widgetStateSource.messageId = OTHER;
  if (scenario === 'wrong-tool') mapping[CALL].message.content.text = '{"path":"/Chat On Steroids Core/link_x/agents","args":{}}';
  if (scenario === 'wrong-server') mapping[CALL].message.content.text = '{"path":"/Chat On Steroids Core Backup/link_x/read","args":{}}';
  if (scenario === 'wrong-role') mapping[CALL].message.author.role = 'user';
  if (scenario === 'conflicting-request') mapping[resultId].message.metadata.request_id = 'wfr_conflicting_result';
  if (scenario === 'duplicate-source') f.entry.turn.items[1].items.push({ ...step, callId: OTHER });
  const turn = (await f.ask()).turns[0];
  expect(turn.calls.every((call: any) => call.requestId === null)).toBe(true);
  expect(turn.requests.some((request: any) => request.requestId === OTHER)).toBe(false);
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
/**
 * Stop, on a composer that says it in another language.
 *
 * The newer composer puts voice, send and stop in one slot as the same `type="button"`; only the
 * label and the icon change, and the label is translated. Captured from a Turkish page on
 * 2026-09-25: `aria-label="Durdur"` while streaming, `aria-label="Sesli iletisimi baslat"` when
 * idle. With only an English label list to go on, stop was never found — so `generating()` said
 * no while a reply was streaming, and nothing could end the turn through the page.
 *
 * The square is the part nobody translates. The dictation control in the same slot draws four
 * paths and carries `data-state`; this asserts both directions, because a send or voice button
 * mistaken for stop would report a generation that never ends.
 */
it('finds the stop control by its square when the label is translated', () => {
  const f = fixture();
  const form = f.doc.querySelector('form[data-chatgpt-composer]')!;
  const slot = 'cursor-interaction size-token-button-composer flex items-center justify-center rounded-full bg-composer-primary p-0.5';
  form.insertAdjacentHTML('beforeend',
    `<button type="button" class="${slot} relative" aria-label="Sesli iletisimi baslat" data-state="closed">` +
    '<svg aria-hidden="true" class="icon-primary-action"><path d="M10 2.5v6"></path><path d="M6 6v2"></path>' +
    '<path d="M14 6v2"></path><path d="M10 12v5"></path></svg></button>');
  expect(f.api.generating(), 'the dictation control was read as stop').toBe(false);
  expect(f.api.stopButton()).toBeNull();

  form.querySelector('button[aria-label="Sesli iletisimi baslat"]')!.outerHTML =
    `<button type="button" class="${slot}" aria-label="Durdur">` +
    '<svg class="icon-primary-action" viewBox="0 0 20 20"><path d="M4.5 5.75C4.5 5.05964 5.05964 4.5 5.75 4.5H14.25C14.9404 4.5 15.5 5.05964 15.5 5.75V14.25C15.5 14.9404 14.9404 15.5 14.25 15.5H5.75C5.05964 15.5 4.5 14.9404 4.5 14.25V5.75Z"></path></svg></button>';
  expect(f.api.generating(), 'a translated stop button was not recognised').toBe(true);
  expect(f.api.stopButton()?.getAttribute('aria-label')).toBe('Durdur');
});

/**
 * Send, on the same composer, in another language.
 *
 * All three `SEND` strategies fail on the newer composer: the `data-testid` is gone, nothing in
 * that slot is `type="submit"` any more, and `aria-label^="Send"` is translated. `submitDraft`
 * waits on `sendButton()` and deliberately has no Enter fallback, so when it finds nothing the
 * prompt simply stands in the composer for ever. Reported in #415 on an English install — "opens
 * a new GPT web tab and doesnt send any messages" — and captured on a Turkish page in #393.
 *
 * Send has no icon signature worth trusting, so it is identified by the state it is the only
 * occupant of: text in the composer and nothing generating. Both other tenants of the slot are
 * asserted here to stay out of it, because a dictation button clicked as send starts a recording
 * and a stop square clicked as send ends somebody's turn.
 */
it('finds the send control by its slot when the label is translated', () => {
  const f = fixture(), edit = editing(f);
  const form = f.doc.querySelector('form[data-chatgpt-composer]')!;
  const slot = 'cursor-interaction size-token-button-composer flex items-center justify-center rounded-full bg-composer-primary p-0.5';
  // The newer composer has none of the three things SEND looks for.
  f.doc.querySelector('button[type="submit"]')!.remove();
  expect(f.api.sendButton(), 'a composer with no send control offered one anyway').toBeNull();

  // Empty composer: this slot is dictation, and it is not a send target.
  form.insertAdjacentHTML('beforeend',
    `<button type="button" class="${slot} relative" aria-label="Sesli iletisimi baslat" data-state="closed">` +
    '<svg aria-hidden="true" class="icon-primary-action"><path d="M10 2.5v6"></path><path d="M6 6v2"></path>' +
    '<path d="M14 6v2"></path><path d="M10 12v5"></path></svg></button>');
  expect(f.api.sendButton(), 'the dictation control was read as send').toBeNull();

  // Text typed, and the slot now holds send with a translated label and an arrow.
  form.querySelector('button[data-state="closed"]')!.remove();
  expect(f.api.insertPrompt('Devam et', true)).toBe(true);
  expect(edit.box.innerText).toContain('Devam et');
  form.insertAdjacentHTML('beforeend',
    `<button type="button" class="${slot}" aria-label="Gönder">` +
    '<svg class="icon-primary-action" viewBox="0 0 20 20"><path d="M8.5 16.5v-9l-3.25 3.25"></path></svg></button>');
  expect(f.api.sendButton()?.getAttribute('aria-label'), 'a translated send button was not recognised').toBe('Gönder');

  // The stop square in that same slot is never a send target.
  form.querySelector('button[aria-label="Gönder"]')!.outerHTML =
    `<button type="button" class="${slot}" aria-label="Durdur">` +
    '<svg class="icon-primary-action" viewBox="0 0 20 20"><path d="M4.5 5.75C4.5 5.05964 5.05964 4.5 5.75 4.5H14.25C14.9404 4.5 15.5 5.05964 15.5 5.75V14.25C15.5 14.9404 14.9404 15.5 14.25 15.5H5.75C5.05964 15.5 4.5 14.9404 4.5 14.25V5.75Z"></path></svg></button>';
  expect(f.api.sendButton(), 'the stop square was read as send').toBeNull();

  // And an English label still wins outright, without consulting the slot at all.
  form.querySelector('button[aria-label="Durdur"]')!.outerHTML =
    '<button type="button" aria-label="Send prompt">send</button>';
  expect(f.api.sendButton()?.getAttribute('aria-label')).toBe('Send prompt');
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
it.each([false, true])('bootstraps a shell worker with literal instructions and the exact native conversation (cold=%s)', async cold => {
  const f = fixture(), edit = editing(f), commandId = 'shell-worker-command';
  const options = f.props.modelListConfig;
  const missing = cold ? firstMissingPicker(f) : null;
  if (cold) f.props.modelListConfig = null;
  f.doc.querySelector('[data-thread-find-target]')!.replaceChildren();
  page.reconfigure({ url: `https://chatgpt.com/?clf=${commandId}` });
  const text = '[[COS_CONTEXT:13]]\nPrivate setup\n[[/COS_CONTEXT]]\n\n# Worker\nRead **one** file.';
  const submitted: string[] = [];
  f.doc.querySelector('button[type="submit"]')!.addEventListener('click', event => {
    event.preventDefault(); submitted.push(edit.serialize()); addExchange(f, 4, submitted[0]!); edit.box.replaceChildren();
    f.win.history.pushState({}, '', `/c/${THREAD}`);
  });
  const recording = recorder(f, { redeem: () => ({ ok: true, command: { id: commandId, type: 'worker', text,
    agent: 'worker-1', model: 'gpt-5-6-thinking', reasoningEffort: 'high' } }) });
  if (missing) {
    await missing; expect(submitted).toEqual([]);
    f.props.modelListConfig = options; f.trigger.setAttribute('data-state', 'closed');
  }
  const r = await recording;
  await vi.waitFor(() => expect(r.sent).toContainEqual(expect.objectContaining({ type: 'ack', id: commandId, status: 'sent', conversationId: THREAD, agent: 'worker-1' })), { timeout: 5000 });
  expect(submitted).toEqual([text]);
  expect(r.sent.filter(m => m.type === 'ack' && m.status === 'failed')).toEqual([]);
  (f.win as any).__CLF_CONTENT_RECORDER__.stop();
}, 10000);

it.each(['immediate', 'hydrating', 'foreign', 'retired'])('binds the fresh background worker from native receipt events with throttled timers (%s)', async state => {
  const f = fixture(), edit = editing(f), { owner } = liveShellMapping(f, true);
  const commandId = 'event-owned-worker', text = 'Read this diagnostic and report through agents.';
  const native = f.doc.querySelector('[data-turn-key]')!;
  native.remove(); page.reconfigure({ url: `https://chatgpt.com/?clf=${commandId}` });
  f.entry.conversationId = `local-chatgpt:${OTHER}`; owner.memoizedProps.conversationId = f.entry.conversationId;
  f.entry.turn.items[0].message = text;
  native.querySelector('.whitespace-pre-wrap')!.textContent = text;
  Object.defineProperty(f.doc, 'visibilityState', { configurable: true, value: 'hidden' });
  const nativeTimeout = f.win.setTimeout.bind(f.win);
  f.win.setTimeout = ((fn: TimerHandler, delay?: number) => Number(delay) >= 500 ? 98765 : nativeTimeout(fn, delay)) as typeof f.win.setTimeout;
  let clicked = 0;
  f.doc.querySelector('button[type="submit"]')!.addEventListener('click', event => {
    event.preventDefault(); clicked++; edit.box.replaceChildren();
    if (state === 'immediate') {
      f.win.history.pushState({}, '', `/c/${THREAD}`); f.doc.querySelector('[data-thread-find-target]')!.append(native);
    }
  });
  const r = await recorder(f, { redeem: () => ({ ok: true, command: { id: commandId, type: 'worker', text, agent: 'worker-1' } }) }, false);
  try {
    await vi.waitFor(() => expect(clicked).toBe(1));
    if (state !== 'immediate') {
      expect(r.sent.filter(message => message.type === 'ack')).toEqual([]);
      if (state === 'retired') (f.win as any).__CLF_CONTENT_RECORDER__.stop();
      if (state === 'foreign') {
        f.entry.conversationId = THREAD; owner.memoizedProps.conversationId = THREAD;
        f.win.history.pushState({}, '', `/c/${OTHER}`);
      } else f.win.history.pushState({}, '', `/c/${THREAD}`);
      f.doc.querySelector('[data-thread-find-target]')!.append(native);
    }
    if (state === 'foreign' || state === 'retired') {
      await new Promise(resolve => setTimeout(resolve, 350));
      expect(r.sent.filter(message => message.type === 'ack' && message.status === 'sent')).toEqual([]);
    } else {
      await vi.waitFor(() => expect(r.sent.filter(message => message.type === 'ack')).toEqual([
        expect.objectContaining({ id: commandId, status: 'sent', conversationId: THREAD, agent: 'worker-1' })
      ]), { timeout: 2000 });
      await vi.waitFor(() => expect(r.sent.some(message => message.type === 'correlate' &&
        message.conversationId === THREAD && message.calls.some((call: any) => call.requestId === OTHER))).toBe(true));
      expect(clicked).toBe(1); expect(f.doc.visibilityState).toBe('hidden');
    }
  } finally { (f.win as any).__CLF_CONTENT_RECORDER__.stop(); }
});

it('opens a local project from a cold shell page and binds its exact first send before recording', async () => {
  const f = fixture(), edit = editing(f), inputId = '88888888-1111-4111-8111-000000000001';
  const options = f.props.modelListConfig; f.props.modelListConfig = null;
  const missing = firstMissingPicker(f);
  f.doc.querySelector('[data-thread-find-target]')!.replaceChildren();
  page.reconfigure({ url: `https://chatgpt.com/?cos-input=${inputId}` });
  const setup = '# Project instructions\n' + 'Preserve **literal** paths and project ownership.\n'.repeat(300);
  const text = `[[COS_CONTEXT:${setup.length}]]\n${setup}\n[[/COS_CONTEXT]]\n\nInspect the project.`;
  const input = { id: inputId, owner: 'project-owner', opening: true, projectId: OTHER, text,
    model: 'gpt-5-6-thinking', reasoningEffort: 'high', purpose: 'user', images: [] };
  const submitted: string[] = [];
  f.doc.querySelector('button[type="submit"]')!.addEventListener('click', event => {
    event.preventDefault(); submitted.push(edit.serialize());
    const exchange = addExchange(f, 7, submitted[0]!);
    exchange.entry.conversationId = `local-chatgpt:${OTHER}`;
    f.queries.push({ queryKey: ['chatgpt-conversation-details', { clientConversationId: exchange.entry.conversationId, serverConversationId: THREAD }] });
    edit.box.replaceChildren(); f.win.history.pushState({}, '', `/c/${THREAD}`);
  });
  const r = await recorder(f, {
    desktop_input: m => ({ ok: true, data: m.authorize || m.ack || m.fail ? { ok: true } : { input } }),
    bind: m => ({ ok: true, bound: 0, projectBound: m.projectInput?.id })
  });
  const delivery = r.runtime({ type: 'clf-desktop-input', id: inputId, conversationId: null });
  await missing; expect(submitted).toEqual([]);
  f.props.modelListConfig = options; f.trigger.setAttribute('data-state', 'closed');
  await vi.waitFor(() => expect(submitted).toHaveLength(1));
  await r.hook.refreshFiber(); r.hook.observe();
  expect(await delivery).toEqual({ ok: true });
  expect(submitted).toEqual([text]);
  expect(r.sent.filter(m => m.type === 'desktop_input' && m.authorize)).toHaveLength(1);
  expect(r.sent.filter(m => m.type === 'desktop_input' && m.ack)).toHaveLength(1);
  expect(r.sent.filter(m => m.type === 'desktop_input' && m.fail)).toEqual([]);
  expect(r.sent.filter(m => m.type === 'bind')).toContainEqual(expect.objectContaining({
    conversationId: THREAD, projectInput: { id: inputId, owner: 'project-owner' }
  }));
  expect(r.hook.desktopProjectInputForTest()).toBeNull();
  (f.win as any).__CLF_CONTENT_RECORDER__.stop();
}, 10000);
it('correlates an early shell stream request through the real observer and recorder without cached messages', async () => {
  const f = fixture(), win = f.win as any;
  const r = await recorder(f);
  const frames = ['event: delta_encoding\ndata: "v1"\n\n',
    `event: delta\ndata: ${JSON.stringify({ v: { conversation_id: THREAD, message: { metadata: { request_id: OTHER }, content: { parts: ['NEVER_COPY_STREAM_TEXT'] } } } })}\n\n`];
  let index = 0;
  win.TextDecoder = TextDecoder;
  win.fetch = async () => ({ ok: true, url: 'https://chatgpt.com/backend-api/f/conversation',
    headers: { get: () => 'text/event-stream' }, clone: () => ({ body: { getReader: () => ({
      read: async () => index < frames.length ? { done: false, value: new TextEncoder().encode(frames[index++]!) } : { done: true },
      cancel: async () => undefined
    }) } }) });
  win.eval(usageSource);
  await win.fetch('/backend-api/f/conversation', { method: 'POST' });
  await vi.waitFor(() => expect(r.sent.filter(m => m.type === 'correlate')).toContainEqual(expect.objectContaining({
    conversationId: THREAD, calls: expect.arrayContaining([expect.objectContaining({ requestId: OTHER })])
  })));
  expect(f.queries).toEqual([]);
  expect(JSON.stringify(r.sent)).not.toContain('NEVER_COPY_STREAM_TEXT');
  win.__CLF_CONTENT_RECORDER__.stop();
});
it('sends a marked shell handoff once and captures its exact completed brief instead of the preceding answer', async () => {
  const f = fixture(), edit = editing(f), token = '0123456789abcdef0123456789abcdef';
  f.entry.turn.status = 'complete'; f.entry.turn.items[2].completed = true;
  const prompt = `[[CLF-HANDOFF:${token}]]\n\nWrite the brief. Keep **Markdown** and C:\\work intact.`;
  const brief = 'TASK: retain the requested project. RESULT: completed the first change. NEXT: verify the remaining work.';
  const submitted: string[] = [], summaries: string[] = [];
  let source: ReturnType<typeof addExchange>, state = 'not-attempted';
  f.doc.querySelector('button[type="submit"]')!.addEventListener('click', event => {
    event.preventDefault(); submitted.push(edit.serialize()); source = addExchange(f, 8, submitted[0]!); edit.box.replaceChildren();
  });
  const r = await recorder(f, { compact: m => {
    if (m.sourceAttempt) { state = 'attempted-unresolved'; return { ok: true, data: { allowed: true } }; }
    if (m.sourceDispatch) { state = 'dispatched-unresolved'; return { ok: true, data: { armed: true } }; }
    if (m.sourceMessageId) { state = 'sent'; return { ok: true, data: {} }; }
    if (typeof m.summary === 'string') { summaries.push(m.summary); return { ok: true, data: { job: { stage: 'opening', busy: true } } }; }
    return { ok: true, data: { token, ...(m.ticket ? {} : { prompt }), sourceSend: { state },
      job: { stage: 'handoff-pending', busy: true, automatic: false, sourceSend: { state } } } };
  } });
  const pending = r.hook.startCompact();
  await vi.waitFor(() => expect(submitted).toEqual([prompt]), { timeout: 3000 });
  await r.hook.refreshFiber(); r.hook.observe(); await pending;
  expect(summaries).toEqual([]);
  source!.finish(); source!.entry.turn.items[1]!.content = brief;
  await r.hook.refreshFiber(); r.hook.observe();
  await vi.waitFor(() => expect(summaries).toEqual([brief]));
  expect(r.sent.filter(m => m.sourceDispatch)).toHaveLength(1);
  expect(r.sent).toContainEqual(expect.objectContaining({ type: 'compact', token, sourceMessageId: source!.userId }));
  await r.hook.refreshFiber(); r.hook.observe();
  expect(submitted).toEqual([prompt]); expect(summaries).toEqual([brief]);
  (f.win as any).__CLF_CONTENT_RECORDER__.stop();
}, 10000);

it.each(['streaming', 'cancelled', 'conflicting-conversation'])('does not promote an unproven shell final identity: %s', async scenario => {
  const f = fixture();
  f.entry.turn.status = scenario === 'cancelled' ? 'cancelled' : 'complete';
  f.entry.turn.items[2].completed = scenario !== 'streaming';
  if (scenario === 'conflicting-conversation') f.row.memoizedProps.conversationId = OTHER;
  const { turns } = await f.ask();
  expect(turns[0].messages.filter((message: any) => message.role === 'assistant').every((message: any) => message.stable === false)).toBe(true);
});

it.each([false, true])('commits a shell resume and records its response before identity hydration (provisional=%s)', async provisional => {
  const f = fixture(), edit = editing(f), commandId = 'shell-resume-command', token = '0123456789abcdef0123456789abcdef';
  f.doc.querySelector('[data-thread-find-target]')!.replaceChildren();
  page.reconfigure({ url: `https://chatgpt.com/?clf=${commandId}` });
  const text = `[[CLF-RESUME:${token}]]\n\nTASK: continue **the project**. NEXT: verify the remaining work.\n` +
    'Keep the completed changes and verify the next part.\n'.repeat(800);
  let committed = false, historyBeforeCommit = false;
  let resumed: ReturnType<typeof addExchange>;
  const submitted: string[] = [];
  f.doc.querySelector('button[type="submit"]')!.addEventListener('click', event => {
    event.preventDefault(); submitted.push(edit.serialize()); resumed = addExchange(f, 9, submitted[0]!); edit.box.replaceChildren();
    if (provisional) resumed.entry.conversationId = `local-chatgpt:${OTHER}`;
    f.win.history.pushState({}, '', `/c/${THREAD}`);
  });
  const r = await recorder(f, {
    redeem: () => ({ ok: true, command: { id: commandId, type: 'resume', text, agent: null,
      model: 'gpt-5-6-thinking', reasoningEffort: 'high' } }),
    compact: m => {
      if (m.destinationAttempt) return { ok: true, data: { allowed: true } };
      if (m.destinationDispatch) return { ok: true, data: { armed: true } };
      if (m.destinationMessageId && m.token === token && m.conversationId === THREAD) committed = true;
      return { ok: true, data: { committed, conversationId: THREAD, commandId } };
    },
    events: m => { if (!committed && m.entries.some((entry: any) => entry.event?.kind === 'user_message')) historyBeforeCommit = true;
      return { ok: true, pending: 0, durable: true }; }
  });
  await vi.waitFor(() => expect(r.sent.filter(m => m.type === 'ack')).toContainEqual(
    expect.objectContaining({ id: commandId, status: 'sent', conversationId: THREAD })), { timeout: 5000 });
  expect(submitted).toEqual([text]); expect(committed).toBe(true); expect(historyBeforeCommit).toBe(false);
  expect(r.sent.filter(m => m.destinationDispatch)).toHaveLength(1);
  expect(r.sent).toContainEqual(expect.objectContaining({ type: 'compact', token, destinationMessageId: '99999999-1111-4111-8111-000000000091' }));
  await r.hook.pullActivity(); r.hook.observe(); await r.hook.flush();
  const starts = r.events().filter((event: any) => event.kind === 'turn_start');
  expect(starts).toHaveLength(1);
  const localTurnId = starts[0].turnId;
  resumed!.finish(); await r.hook.refreshFiber(); r.hook.observe(); await r.hook.flush();
  expect(r.events()).toContainEqual(expect.objectContaining({ kind: 'assistant_message',
    providerMessageId: resumed!.answerId, turnId: localTurnId, final: true, goalEligible: true }));
  expect(r.events()).toContainEqual(expect.objectContaining({ kind: 'turn_end', turnId: localTurnId, outcome: 'completed' }));
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
it.each([false, true])('rechecks the cold shell picker owner when its account state hydrates (cancelled=%s)', async cancelled => {
  const f = fixture(), options = f.props.modelListConfig;
  f.props.modelListConfig = null;
  const edit = editing(f); edit.box.textContent = 'Preserve this existing draft';
  const missing = firstMissingPicker(f);
  let current = true;
  const result = f.api.selectModelSettings('gpt-5-6-thinking', 'high', () => current);
  await missing;
  current = !cancelled;
  f.props.modelListConfig = options;
  f.trigger.setAttribute('data-state', 'closed');
  expect(await result).toBe(!cancelled);
  expect(edit.box.textContent).toBe('Preserve this existing draft');
  expect(f.doc.querySelector('[data-model-picker-view]')).toBeNull();
  if (cancelled) expect(f.actions).not.toHaveBeenCalled();
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
