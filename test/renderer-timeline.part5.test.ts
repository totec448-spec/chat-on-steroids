import { describe, expect, it, vi } from 'vitest';
import { JSDOM, T0, boot, groupTitle, latestCallTitle, lineMoves, nativeStep, pressInComposer, sendDuringTurn, settle, settleHistoryFrame, slash, summary, text, toolCall, typed, typedDuringTurn, waitFor, type InputEntry, type LocalProject, type SessionEvent, type SessionSummary } from './renderer-timeline.harness.js';

vi.mock('../src/renderer/workspace-terminal.js', () => ({ createWorkspaceTerminal: () => ({
  update: vi.fn(), show: vi.fn(), hide: vi.fn(), hasTabs: () => false,
  tabs: () => [], newTab: () => null, selectTab: vi.fn(), closeTab: vi.fn()
}) }));
vi.mock('../src/renderer/pet.js', () => ({ initPet: () => Object.assign(() => {}, { toggle: () => {}, isVisible: () => false }) }));
vi.mock('../src/renderer/file-code-editor.js', () => ({
  createProjectDiffViewer: async ({ parent, baseText, currentText }: { parent: HTMLElement; baseText: string; currentText: string }) => {
    const view = parent.ownerDocument.createElement('pre');
    view.textContent = `${baseText}\n---\n${currentText}`;
    parent.append(view);
    return { destroy: () => view.remove(), language: 'TypeScript' };
  }
}));


it('shows a just-started turn working right after your message, never in the header first', async () => {
  // The controls report a running turn before any of its rows reached the timeline.
  const { w } = await boot([]);
  const line = w.document.querySelector<HTMLElement>('.turn-status')!;
  expect(line.textContent).toMatch(/^Working/);
  expect(line.classList.contains('is-working')).toBe(true);
  expect(line.previousElementSibling?.id).toBe('inputQueue');
  expect(w.document.getElementById('chatState')!.classList.contains('is-mirrored')).toBe(true);
});

it('anchors the worked line to your message when the page reports an empty turn and untagged work', async () => {
  // Measured in a live session: the page opened and closed an empty turn right after the message,
  // then every row of the real work arrived with no turn id at all.
  const asked = T0;
  const rows: SessionEvent[] = [
    { kind: 'user_message', seq: 1, origin: 1, time: asked, source: 'extension', turnId: 'message-scope-id', messageId: 'ask-5', message: text('Legal, mais uma vez') },
    { seq: 2, time: asked + 200, source: 'extension', kind: 'turn_start', turnId: 'ghost-turn' },
    { seq: 3, time: asked + 300, source: 'extension', kind: 'turn_end', turnId: 'ghost-turn', outcome: 'completed' },
    { kind: 'assistant_message', seq: 4, time: asked + 2_000, source: 'extension', messageId: 'plan-5', message: text('Claro. Vou repetir em um quinto arquivo.'), final: true, state: 'final' },
    { kind: 'assistant_message', seq: 5, time: asked + 21_000, source: 'extension', messageId: 'done-5', message: text('Feito novamente.'), final: true, state: 'final' }
  ];
  const { w, append } = await boot(rows);
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({ ok: true,
    data: { sessionId: id, automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null } });
  await append([]);
  const lines = [...w.document.querySelectorAll<HTMLElement>('#timeline .turn-worked')];
  expect(lines.map(line => line.textContent)).toEqual(['Worked for 21s']);
  expect(lines[0]!.previousElementSibling?.matches('.ev-user_message')).toBe(true);
  expect(lines[0]!.nextElementSibling?.textContent).toContain('quinto arquivo');
});

it('titles a finished round with the native step that ends it, by position and in any language', async () => {
  // ChatGPT closes a round of work with a recap and titles the block with it. It is picked by where
  // it sits, never by its wording: the step that ends the round, once prose follows. Spanish labels.
  const note = (seq: number, label: string): SessionEvent => ({ seq, time: T0 + seq * 1000, source: 'extension', kind: 'page_tool', messageId: `note-${seq}`, label });
  const prose: SessionEvent = { kind: 'assistant_message', seq: 5, time: T0 + 5000, source: 'extension', messageId: 'after-round', message: text('Listo.'), final: true, state: 'final' };
  const { w } = await boot([note(1, 'Planificando la comprobación'), toolCall(2, 'call-a'), toolCall(3, 'call-b'), note(4, 'Se ejecutó la comprobación exacta'), prose]);
  const group = w.document.querySelector<HTMLDetailsElement>('#timeline details.tool-group')!;
  expect(group.querySelector('.activity-title')!.textContent).toBe('Se ejecutó la comprobación exacta');
  expect(group.querySelector('.activity-symbol .ph-check-circle')).not.toBeNull();
  // The recap heads the group rather than repeating inside it; the calls and the earlier note stay,
  // and a step written before any call keeps the globe.
  const inside = [...group.querySelectorAll<HTMLElement>('.tool-group-body .thinking-line')];
  expect(inside.map(line => line.textContent)).toEqual(['Planificando la comprobación']);
  expect(inside[0]!.querySelector('.ph-globe-hemisphere-west')).not.toBeNull();
  expect(group.querySelectorAll('.tool-group-body .ev-tool_call')).toHaveLength(2);
});

it('names a round still in progress after its latest real action, until prose ends it', async () => {
  // The turn still works and nothing follows the step: it is a note, whatever it says, not a recap.
  const { w, append } = await boot([toolCall(2, 'call-a'), toolCall(3, 'call-b'), nativeStep(4, 'Executed exact command check')]);
  expect(latestCallTitle(w.document)).toBeTruthy();
  expect(groupTitle(w.document)).toBe(latestCallTitle(w.document));
  const pending = [...w.document.querySelectorAll<HTMLElement>('#timeline .tool-group-body .thinking-line')];
  expect(pending.map(line => line.textContent)).toEqual(['Executed exact command check']);
  expect(pending[0]!.querySelector('.ph-check-circle')).toBeNull();
  // Once prose follows, the same step ends a finished round and titles it.
  await append([{ kind: 'assistant_message', seq: 5, time: T0 + 5000, source: 'extension', messageId: 'after-round', message: text('Done.'), final: true, state: 'final' }]);
  expect(groupTitle(w.document)).toBe('Executed exact command check');
});

it('names a finished round that ends in a call after that call, and keeps the globe on a step before its calls', async () => {
  const { w } = await boot([nativeStep(1, 'Searched 3 websites'), toolCall(2, 'call-a'), toolCall(3, 'call-b'),
    { kind: 'assistant_message', seq: 5, time: T0 + 5000, source: 'extension', messageId: 'after-search', message: text('Done.'), final: true, state: 'final' }]);
  expect(latestCallTitle(w.document)).toBeTruthy();
  expect(groupTitle(w.document)).toBe(latestCallTitle(w.document));
  expect(w.document.querySelector('#timeline .tool-group-body .thinking-line .ph-globe-hemisphere-west')).not.toBeNull();
});

it('offers a way back to the end of the chat that clears any reserved space', async () => {
  const { w } = await boot([]);
  const jump = w.document.getElementById('jumpLatest') as HTMLButtonElement;
  expect(jump).not.toBeNull();
  expect(jump.getAttribute('aria-label')).toBe('Jump to latest');
  expect(jump.closest('#chatBody')).not.toBeNull();
  const content = w.document.getElementById('timelineContent')!;
  content.style.setProperty('--timeline-scroll-reserve', '300px');
  jump.click();
  expect(content.style.getPropertyValue('--timeline-scroll-reserve')).toBe('');
});

it('keeps the chat reading state out of Agents & automation, which shares its scroll pane', async () => {
  const { w, append } = await boot([{ kind: 'assistant_message', seq: 1, time: T0 + 1000, source: 'extension', messageId: 'first', message: text('Hello'), final: false }]);
  const pane = w.document.getElementById('chatBody')!;
  const jump = w.document.getElementById('jumpLatest')!;
  // The real navigation: the Agents & automation tab, then Back to chat.
  const view = (name: string) => (w.document.querySelector(name === 'settings' ? 'nav button[data-tab="settings"]' : '#backToChat') as HTMLButtonElement).click();
  Object.defineProperties(pane, { clientHeight: { value: 400, configurable: true }, scrollHeight: { value: 2000, configurable: true } });
  pane.scrollTop = 1600;
  // Settings open at their top, not at the chat's end, and offer no way back to a chat end.
  view('settings');
  expect(pane.scrollTop).toBe(0);
  expect(jump.classList.contains('is-shown')).toBe(false);
  // Reading the settings upwards is not reading the chat.
  pane.scrollTop = 900;
  pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -120 }));
  pane.dispatchEvent(new w.Event('scroll'));
  expect(jump.classList.contains('is-shown')).toBe(false);
  // Back in the chat, it is still at its end and still follows new output.
  view('timeline');
  expect(pane.scrollTop).toBe(2000);
  await append([{ kind: 'assistant_message', seq: 2, time: T0 + 2000, source: 'extension', messageId: 'later', message: text('More output'), final: false }]);
  expect(pane.scrollTop).toBe(pane.scrollHeight);
  expect(jump.classList.contains('is-shown')).toBe(false);
});

it('opens round participants in the existing dock without moving the prime reader or draft', async () => {
  const report = (seq: number, worker: string): SessionEvent => ({ kind: 'agent_message', seq, time: T0 + seq * 1000,
    source: 'app', from: worker, to: 'prime', messageId: `report-${seq}`, delivery: 'delivered', message: text('Verified the build') });
  const rows: SessionEvent[] = [toolCall(1, 'read-first'), report(2, 'worker-1'), report(3, 'worker-2'), report(4, 'worker-1'),
    { kind: 'assistant_message', seq: 5, time: T0 + 5000, source: 'extension', messageId: 'round-break', message: text('Next, verify it.'), final: false },
    toolCall(6, 'read-second'), report(7, 'worker-2')];
  const prime = summary(rows);
  const workers = [1, 2, 3].map(n => ({ ...summary([]), id: `worker-local-${n}`, title: `worker-${n}`, conversationId: `worker-chat-${n}`,
    origin: { kind: 'worker' as const, fromSessionId: prime.id, agentId: `worker-${n}`, task: 'Verify build' } }));
  const { w, append } = await boot(rows, true, [], [], { sessions: [prime, ...workers] });
  const api = (w as any).api, original = api.getSession;
  api.getSession = vi.fn((id: string, options: unknown) => original(id, options));
  expect(w.document.getElementById('inlineAgents')).toBeNull();
  expect(w.document.querySelectorAll('#chatBody .agent-panel')).toHaveLength(0);
  const indicators = [...w.document.querySelectorAll<HTMLButtonElement>('#timeline .activity-workers')];
  // One pill per round, whatever the count: the team icon and how many workers it involved.
  expect(indicators.map(button => button.textContent)).toEqual(['2', '1']);
  expect(indicators[0]!.getAttribute('aria-label')).toBe('2 sub-agents in this round');
  // One worker reads as one, not "1 sub-agents" (seen on the 2.1.27 canary).
  expect(indicators[1]!.getAttribute('aria-label')).toBe('1 sub-agent in this round');
  expect(indicators[0]!.type).toBe('button');
  expect(indicators[0]!.querySelectorAll('.ico')).toHaveLength(1);
  expect(indicators[0]!.querySelector('.agent-avatar')).toBeNull();
  const firstRound = indicators[0]!.closest<HTMLDetailsElement>('.tool-group')!;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Keep the prime draft'; input.dispatchEvent(new w.Event('input'));
  const pane = w.document.getElementById('chatBody')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 }, scrollHeight: { value: 2000 } });
  pane.scrollTop = 300;
  indicators[0]!.focus(); indicators[0]!.click(); await settle();
  expect(firstRound.open).toBe(false);
  expect(api.getSession).not.toHaveBeenCalled();
  const highlighted = () => [...w.document.querySelectorAll<HTMLElement>('#workDockRight .is-round-worker')].map(row => row.dataset.workerSession);
  expect(highlighted()).toEqual(['worker-local-1', 'worker-local-2']);
  expect(w.document.querySelector(`.sess.is-sel[data-id="${prime.id}"]`)).not.toBeNull();
  expect(input.value).toBe('Keep the prime draft');
  expect(pane.scrollTop).toBe(300);
  indicators[1]!.click(); await settle();
  expect(highlighted()).toEqual(['worker-local-2']);
  indicators[1]!.focus();
  await append([{ kind: 'assistant_message', seq: 8, time: T0 + 8000, source: 'extension', messageId: 'live-output', message: text('More prime output'), final: false }]);
  expect(pane.scrollTop).toBe(300);
  expect(w.document.activeElement).toBe(indicators[1]);
  expect(highlighted()).toEqual(['worker-local-2']);
  (w.document.getElementById('jumpLatest') as HTMLButtonElement).click();
  await append([{ kind: 'assistant_message', seq: 9, time: T0 + 9000, source: 'extension', messageId: 'tail-output', message: text('Following again'), final: false }]);
  expect(pane.scrollTop).toBe(pane.scrollHeight);
  // A detached control cannot act, even while its parent is still selected.
  firstRound.remove(); indicators[0]!.click();
  expect(highlighted()).toEqual(['worker-local-2']);
  const staleActivation = indicators[1]!.onclick!;
  w.document.getElementById('newChat')!.click(); await settle();
  (w.document.querySelector(`#sessionList [data-id="${prime.id}"] [data-session-select]`) as HTMLElement).click(); await settle();
  const currentIndicators = [...w.document.querySelectorAll<HTMLButtonElement>('#timeline .activity-workers')];
  currentIndicators[1]!.click(); await settle();
  expect(highlighted()).toEqual(['worker-local-2']);
  // Exercise the captured A callback after A → B → A, with a connected current node.
  staleActivation.call(currentIndicators[0]!, new w.MouseEvent('click') as unknown as PointerEvent);
  expect(highlighted()).toEqual(['worker-local-2']);

});

it('keeps round inspection at the tail during a dock-induced viewport resize', async () => {
  const observers: Array<{ targets: Set<Element>; notify: () => void }> = [];
  vi.stubGlobal('ResizeObserver', class {
    targets = new Set<Element>();
    constructor(callback: () => void) { observers.push({ targets: this.targets, notify: callback }); }
    observe(target: Element): void { this.targets.add(target); }
    unobserve(target: Element): void { this.targets.delete(target); }
    disconnect(): void { this.targets.clear(); }
  });
  try {
    const rows: SessionEvent[] = [toolCall(1, 'round-resize'), { kind: 'agent_message', seq: 2, time: T0 + 2000,
      source: 'app', from: 'worker-1', to: 'prime', messageId: 'resize-report', delivery: 'delivered', message: text('Verified') }];
    const prime = summary(rows);
    const worker = { ...summary([]), id: 'resize-worker', origin: { kind: 'worker' as const, fromSessionId: prime.id, agentId: 'worker-1', task: 'Verify' } };
    const { w } = await boot(rows, true, [], [], { sessions: [prime, worker] });
    const pane = w.document.getElementById('chatBody')!;
    let height = 400;
    Object.defineProperties(pane, { clientHeight: { get: () => height }, scrollHeight: { value: 2000 } });
    const resize = observers.find(observer => observer.targets.size === 1 && observer.targets.has(pane))!;
    expect(resize).toBeDefined();
    resize.notify();
    // Chromium clamps the initial follow to the tail; inspection there is still an explicit read.
    pane.scrollTop = 1600; pane.dispatchEvent(new w.Event('scroll'));
    (w.document.querySelector('#timeline .activity-workers') as HTMLButtonElement).click();
    height = 350; resize.notify();
    expect(pane.scrollTop).toBe(1600);
    (w.document.getElementById('jumpLatest') as HTMLButtonElement).click();
    height = 300; resize.notify();
    expect(pane.scrollTop).toBe(pane.scrollHeight);
  } finally { vi.unstubAllGlobals(); }
});

it.each([
  { setting: undefined, reader: 'moved', follows: true },
  { setting: undefined, reader: 'wheel', follows: false },
  { setting: undefined, reader: 'delayed-wheel', follows: false },
  { setting: undefined, reader: 'delayed-touch', follows: false },
  { setting: undefined, reader: 'delayed-key', follows: false },
  { setting: undefined, reader: 'delayed-scrollbar', follows: false },
  { setting: false, reader: 'moved', follows: false }
])('follows new output unless the reader scrolled away (setting $setting, view $reader)', async ({ setting, reader, follows }) => {
  // 2026-10-02: in a busy chat the view often stopped short of the end although the reader had not
  // scrolled. Anything that moved it (an interrupted smooth scroll, a clamp during heavy repaints)
  // made the next repaint read "scrolled away". With "Follow new output" only the reader's own
  // scrolling counts; switched off, the per-repaint check stays as it was.
  const rows = Array.from({ length: 40 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `follow-${i}`, message: text(`Follow item ${i + 1}`) }));
  const { w, append } = await boot(rows, true, [], [], setting === undefined ? {} : { followOutput: setting });
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 },
    scrollHeight: { get: () => timeline.querySelectorAll('[data-timeline-key]').length * 100 } });
  pane.scrollTop = pane.scrollHeight; pane.dispatchEvent(new w.Event('scroll'));
  await settle();
  // Chromium queues scroll delivery until a rendering opportunity. The Windows hidden-window
  // verifier delivered it a second after the wheel, outside the old 300 ms intent heuristic.
  // Advance only the sampled clock, not timers or the frame: this is one delayed render step.
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    if (reader.endsWith('wheel')) pane.dispatchEvent(new w.WheelEvent('wheel'));
    if (reader === 'delayed-touch') pane.dispatchEvent(new w.Event('touchmove'));
    if (reader === 'delayed-key') pane.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'PageUp' }));
    if (reader === 'delayed-scrollbar') pane.dispatchEvent(new w.PointerEvent('pointerdown', { pointerId: 7, button: 0 }));
    if (reader.startsWith('delayed-')) clock.mockReturnValue(now + 1000);
    pane.scrollTop = 300;
    pane.dispatchEvent(new w.Event('scroll'));
    if (reader === 'delayed-scrollbar') w.dispatchEvent(new w.PointerEvent('pointerup', { pointerId: 7, button: 0 }));
    pane.dispatchEvent(new w.Event('scrollend'));
  } finally { clock.mockRestore(); }
  await append([{ seq: 100, time: T0 + 100, source: 'extension', kind: 'assistant_message', messageId: 'follow-answer', message: text('A growing answer'), final: false }]);
  expect(pane.scrollTop).toBe(follows ? pane.scrollHeight : 300);
});

it.each(['scrollend', 'no-movement-frame'])(
  'does not borrow a finished reader gesture for programmatic movement (%s)', async end => {
    const rows = Array.from({ length: 40 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
      source: 'extension', kind: 'user_message', messageId: `ended-${i}`, message: text(`Item ${i + 1}`) }));
    const { w, append } = await boot(rows);
    const pane = w.document.getElementById('chatBody')!;
    const timeline = w.document.getElementById('timeline')!;
    Object.defineProperties(pane, { clientHeight: { value: 400 },
      scrollHeight: { get: () => timeline.querySelectorAll('[data-timeline-key]').length * 100 } });
    pane.scrollTop = pane.scrollHeight;
    pane.dispatchEvent(new w.WheelEvent('wheel'));
    if (end === 'scrollend') {
      pane.dispatchEvent(new w.Event('scroll'));
      pane.dispatchEvent(new w.Event('scrollend'));
    } else {
      // Input that moved nothing expires after two frames and at least 100 ms.
      const armed = w.performance.now();
      for (let frames = 0; frames < 3 || w.performance.now() - armed < 150; frames++)
        await new Promise<void>(resolve => w.requestAnimationFrame(() => resolve()));
    }
    // No fresh input: a repaint/clamp is not the reader moving away from the end.
    pane.scrollTop = 300; pane.dispatchEvent(new w.Event('scroll'));
    await append([{ seq: 100, time: T0 + 100, source: 'extension', kind: 'assistant_message',
      messageId: 'ended-answer', message: text('A growing answer'), final: false }]);
    expect(pane.scrollTop).toBe(pane.scrollHeight);
  }
);

it('counts a smooth wheel scroll that starts a frame after its wheel event as reading', async () => {
  // A smooth scroll's first movement comes a frame after the wheel event. Expiring the wheel at that
  // frame meant one notch up never counted, and the next delivery pulled the reader back down.
  const rows = Array.from({ length: 40 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `notch-${i}`, message: text(`Item ${i + 1}`) }));
  const { w, append } = await boot(rows);
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 },
    scrollHeight: { get: () => timeline.querySelectorAll('[data-timeline-key]').length * 100 } });
  pane.scrollTop = pane.scrollHeight;
  pane.dispatchEvent(new w.WheelEvent('wheel'));
  await new Promise<void>(resolve => w.requestAnimationFrame(() => resolve()));
  pane.scrollTop = 300; pane.dispatchEvent(new w.Event('scroll'));
  await append([{ seq: 100, time: T0 + 100, source: 'extension', kind: 'assistant_message',
    messageId: 'notch-answer', message: text('A growing answer'), final: false }]);
  expect(pane.scrollTop).toBe(300);
});

it('keeps a slow scrolling gesture through its final position at the end', async () => {
  const rows = Array.from({ length: 40 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `inertia-${i}`, message: text(`Item ${i + 1}`) }));
  const { w, append } = await boot(rows);
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 },
    scrollHeight: { get: () => timeline.querySelectorAll('[data-timeline-key]').length * 100 } });
  const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    pane.dispatchEvent(new w.WheelEvent('wheel'));
    pane.scrollTop = 300; pane.dispatchEvent(new w.Event('scroll'));
    await new Promise<void>(resolve => w.requestAnimationFrame(() => resolve()));
    clock.mockReturnValue(now + 2000);
    pane.scrollTop = pane.scrollHeight - pane.clientHeight;
    pane.dispatchEvent(new w.Event('scroll'));
    pane.dispatchEvent(new w.Event('scrollend'));
  } finally { clock.mockRestore(); }
  await append([{ seq: 100, time: T0 + 100, source: 'extension', kind: 'assistant_message',
    messageId: 'inertia-answer', message: text('A growing answer'), final: false }]);
  expect(pane.scrollTop).toBe(pane.scrollHeight);
});

it.each([false, true])('keeps a scrollbar press until release, even before its first movement (released: %s)', async released => {
  const rows = Array.from({ length: 40 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `pointer-${i}`, message: text(`Item ${i + 1}`) }));
  const { w, append } = await boot(rows);
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 },
    scrollHeight: { get: () => timeline.querySelectorAll('[data-timeline-key]').length * 100 } });
  pane.scrollTop = pane.scrollHeight;
  pane.dispatchEvent(new w.PointerEvent('pointerdown', { pointerId: 7, button: 0 }));
  await new Promise<void>(resolve => w.requestAnimationFrame(() => resolve()));
  if (released) w.dispatchEvent(new w.PointerEvent('pointerup', { pointerId: 7, button: 0 }));
  pane.scrollTop = 300; pane.dispatchEvent(new w.Event('scroll'));
  w.dispatchEvent(new w.PointerEvent('pointerup', { pointerId: 7, button: 0 }));
  pane.dispatchEvent(new w.Event('scrollend'));
  await append([{ seq: 100, time: T0 + 100, source: 'extension', kind: 'assistant_message',
    messageId: 'pointer-answer', message: text('A growing answer'), final: false }]);
  expect(pane.scrollTop).toBe(released ? pane.scrollHeight : 300);
});

it.each(['pending', 'escape', 'outside-click', 'scrollbar-click'])(
  'handles a middle-click toggle whose first movement comes after release (%s)', async mode => {
    const rows = Array.from({ length: 40 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
      source: 'extension', kind: 'user_message', messageId: `middle-${i}`, message: text(`Item ${i + 1}`) }));
    const { w, append } = await boot(rows);
    const pane = w.document.getElementById('chatBody')!;
    const timeline = w.document.getElementById('timeline')!;
    Object.defineProperties(pane, { clientHeight: { value: 400 },
      scrollHeight: { get: () => timeline.querySelectorAll('[data-timeline-key]').length * 100 } });
    pane.scrollTop = pane.scrollHeight;
    pane.dispatchEvent(new w.PointerEvent('pointerdown', { pointerId: 7, button: 1 }));
    w.dispatchEvent(new w.PointerEvent('pointerup', { pointerId: 7, button: 1 }));
    await new Promise<void>(resolve => w.requestAnimationFrame(() => resolve()));
    if (mode === 'escape') w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
    if (mode === 'outside-click') w.document.body.dispatchEvent(new w.PointerEvent('pointerdown', { pointerId: 7, button: 0, bubbles: true }));
    if (mode === 'scrollbar-click') pane.dispatchEvent(new w.PointerEvent('pointerdown', { pointerId: 7, button: 0 }));
    pane.scrollTop = 300; pane.dispatchEvent(new w.Event('scroll'));
    if (mode === 'scrollbar-click') w.dispatchEvent(new w.PointerEvent('pointerup', { pointerId: 7, button: 0 }));
    pane.dispatchEvent(new w.Event('scrollend'));
    await append([{ seq: 100, time: T0 + 100, source: 'extension', kind: 'assistant_message',
      messageId: 'middle-answer', message: text('A growing answer'), final: false }]);
    expect(pane.scrollTop).toBe(mode === 'pending' || mode === 'scrollbar-click' ? 300 : pane.scrollHeight);
  }
);

it('does not lend a reader gesture to a new selection after A to B to A', async () => {
  const rows = Array.from({ length: 40 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `epoch-${i}`, message: text(`Item ${i + 1}`) }));
  const first = summary(rows), second = { ...summary(rows), id: '2026-09-02-test0002', title: 'Other chat' };
  const { w, append } = await boot(rows, true, [], [], { sessions: [first, second] });
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 },
    scrollHeight: { get: () => timeline.querySelectorAll('[data-timeline-key]').length * 100 } });
  pane.dispatchEvent(new w.WheelEvent('wheel'));
  pane.scrollTop = 300; pane.dispatchEvent(new w.Event('scroll'));
  for (const id of [second.id, first.id]) {
    w.document.querySelector<HTMLElement>(`#sessionList [data-id="${id}"]`)!.click();
    await settle();
  }
  pane.scrollTop = 300; pane.dispatchEvent(new w.Event('scroll'));
  await append([{ seq: 100, time: T0 + 100, source: 'extension', kind: 'assistant_message',
    messageId: 'epoch-answer', message: text('A growing answer'), final: false }]);
  expect(pane.scrollTop).toBe(pane.scrollHeight);
});

it('opens the next chat at its end after the reader scrolled away from a sent message', async () => {
  const rows = Array.from({ length: 40 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `reading-${i}`, message: text(`Reading item ${i + 1}`) }));
  const first = summary(rows), second = { ...summary(rows), id: '2026-09-02-test0002', title: 'Other chat' };
  const { w, append } = await boot(rows, false, [], [], { sessions: [first, second] });
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 },
    scrollHeight: { get: () => timeline.querySelectorAll('[data-timeline-key]').length * 100 } });
  const select = async (id: string) => {
    (w.document.querySelector(`#sessionList [data-id="${id}"]`) as HTMLElement).click();
    await settle();
  };
  await select(first.id);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Hold this one'; input.dispatchEvent(new w.Event('input'));
  (w.document.getElementById('chatSend') as HTMLButtonElement).click();
  await settle();
  // The reader scrolls up with the wheel, releasing the hold on the sent message.
  pane.dispatchEvent(new w.WheelEvent('wheel'));
  pane.scrollTop = 300;
  pane.dispatchEvent(new w.Event('scroll'));
  await select(second.id);
  expect(pane.scrollTop).toBe(pane.scrollHeight);
  // Its answer keeps growing: the reader who just opened it follows the end.
  await append([{ seq: 100, time: T0 + 100, source: 'extension', kind: 'assistant_message', messageId: 'grown', message: text('A new answer'), final: false }]);
  expect(pane.scrollTop).toBe(pane.scrollHeight);
});

it('keeps the working line under your message while a failed delivery notice stays in the queue (2026-10-12)', async () => {
  // A failed "continue" kept its notice in the queue. Counted as a message on its way, it parked the
  // running turn's line after the queue, below the question, and every repaint moved it again.
  const asked = Date.now() - 12_000;
  const app = await boot([
    { seq: 1, time: asked - 100, source: 'extension', kind: 'turn_start', turnId: 'held-turn' },
    { kind: 'user_message', seq: 2, origin: 2, time: asked, source: 'extension', turnId: 'held-turn', messageId: 'q-live', message: text('Finish the three steps') }
  ]);
  const { w } = app;
  app.live.inputs.push({ id: 'failed-continue', sessionId: '2026-09-02-test0001', text: 'Continue from where you left off.',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null, state: 'failed', owner: null, createdAt: asked - 60_000,
    conversationId: 'chat-b', error: 'Not injected: the selected turn ended before an eligible tool call.' });
  await app.append([]);
  expect(w.document.querySelector('#inputQueue .pending-message.is-delivery-error')).not.toBeNull();
  const line = w.document.querySelector<HTMLElement>('.turn-status')!;
  expect(line.closest('#timeline')).not.toBeNull();
  expect(line.previousElementSibling?.matches('.ev-user_message')).toBe(true);
  const moves = lineMoves(w);
  await app.append([]); await app.append([]); await app.append([]);
  expect(moves.stop()).toBe(0);
});

it("keeps a long running turn's line at the top of its loaded rows, not under its newest action (2026-10-12)", async () => {
  // A 45-minute turn pushed its question out of the loaded rows. "Working for" fell to the bottom,
  // after the newest action, and jumped back under the question whenever that was loaded again.
  const asked = Date.now() - 45 * 60_000;
  const calls = Array.from({ length: 220 }, (_, i): SessionEvent => ({ ...toolCall(i + 3, `long-${i}`), time: asked + (i + 1) * 1000, turnId: 'long-turn' }));
  const app = await boot([
    { seq: 1, time: asked - 100, source: 'extension', kind: 'turn_start', turnId: 'long-turn' },
    { kind: 'user_message', seq: 2, origin: 2, time: asked, source: 'extension', turnId: 'long-turn', messageId: 'q-long', message: text('Build all thirty quests') },
    ...calls
  ]);
  const { w } = app;
  const timeline = w.document.getElementById('timeline')!;
  expect(timeline.querySelector('.ev-user_message')).toBeNull();
  const line = w.document.querySelector<HTMLElement>('.turn-status')!;
  expect(line.closest('#timeline')).not.toBeNull();
  const rows = [...timeline.querySelectorAll('[data-timeline-key], .turn-status, .turn-now')];
  expect(rows[0]).toBe(line);
  expect(rows.at(-1)?.matches('.turn-now')).toBe(true);
  const moves = lineMoves(w);
  await app.append([]); await app.append([]);
  expect(moves.stop()).toBe(0);
});

it('keeps a running turn’s line under its question while a message sent into it waits (2026-10-12)', async () => {
  // A message sent mid-round pulled the running turn's line below it, as if the chat had moved on to
  // the new message; the rows jumped back once it was delivered or cancelled.
  const asked = Date.now() - 200_000;
  const app = await boot([
    { seq: 1, time: asked - 100, source: 'extension', kind: 'turn_start', turnId: 'running-turn' },
    { kind: 'user_message', seq: 2, origin: 2, time: asked, source: 'extension', turnId: 'running-turn', messageId: 'q-run', message: text('Port the reference client') },
    { ...toolCall(3, 'mid-call'), turnId: 'running-turn' }
  ]);
  const { w } = app;
  app.live.inputs.push({ id: 'mid-round', sessionId: '2026-09-02-test0001', text: 'Here is where the reference files are.',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null, state: 'browser', owner: 'page', createdAt: Date.now(), conversationId: 'chat-a' });
  await app.append([]);
  expect(w.document.querySelector('#inputQueue .pending-message:not(.is-delivery-error)')).not.toBeNull();
  const line = w.document.querySelector<HTMLElement>('.turn-status')!;
  expect(line.closest('#timeline')).not.toBeNull();
  expect(line.previousElementSibling?.matches('.ev-user_message')).toBe(true);
  const moves = lineMoves(w);
  await app.append([]); await app.append([]);
  expect(moves.stop()).toBe(0);
});

it('does not move a parked working line on every repaint', async () => {
  // A turn with no row yet parks its line after the queue; repainting it in place used to re-insert
  // it each time, restarting its shimmer and Thinking's breathing several times a second.
  const app = await boot([]);
  const { w } = app;
  expect(w.document.querySelector('.turn-status')!.previousElementSibling?.id).toBe('inputQueue');
  const moves = lineMoves(w);
  await app.append([]); await app.append([]); await app.append([]);
  expect(moves.stop()).toBe(0);
  expect(w.document.querySelector('.turn-status')!.previousElementSibling?.id).toBe('inputQueue');
});

it("never hangs the running turn's clock under an older question read further up (2026-10-12)", async () => {
  // Reading a page of history up the chat, its newest loaded question is an old, finished one. The live
  // "Working for" went right under it, as if that old exchange were still running.
  const rows = Array.from({ length: 360 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `origin-${i}`, message: text(`Origin row ${i + 1}.`) }));
  const { w } = await boot(rows);
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 },
    scrollHeight: { get: () => Math.max(400, timeline.querySelectorAll('[data-timeline-key]').length * 20) } });
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    const index = [...timeline.querySelectorAll('[data-timeline-key]')].indexOf(this);
    const top = index < 0 ? 0 : index * 20 - pane.scrollTop;
    return { top, bottom: top + 20, height: 20 } as DOMRect;
  };
  // At the end the running turn's line sits under the newest question.
  expect(w.document.querySelector('.turn-status')!.closest('#timeline')).not.toBeNull();
  for (let index = 0; index < 8 && !timeline.textContent?.includes('Origin row 200.'); index++) {
    pane.scrollTop = 0;
    pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 }));
    await settleHistoryFrame(w);
  }
  expect(timeline.textContent).not.toContain('Origin row 360.');
  expect(w.document.querySelector('#timeline .turn-status')).toBeNull();
});

// A long turn's answer was opened early and filled only at the end. The live update carrying the
// finished answer was skipped as "an old revision owned by an older page", so the chat seemed to
// stop at its last work heading with no summary.
it("shows a long turn's final answer when it arrives live, at the end of the turn", async () => {
  const TURN = 'g-long-0-1';
  // Like the store, every row of the turn names its turn's start (`turnOrigin`).
  const opened: SessionEvent = { seq: 2, time: T0 + 2000, source: 'extension', kind: 'assistant_message', messageId: 'answer', turnId: TURN, turnOrigin: 1, final: false, message: text('Restoring the fleet first.') };
  const work = Array.from({ length: 120 }, (_, i) => ({ ...toolCall(3 + i, `call-${i}`), turnId: TURN, turnOrigin: 1 }) as SessionEvent);
  const { w, live, append } = await boot([{ seq: 1, time: T0 + 1000, source: 'extension', kind: 'turn_start', turnId: TURN }, opened, ...work]);
  const timeline = w.document.getElementById('timeline')!;
  expect(timeline.textContent).not.toContain('Restoring the fleet first.');
  // The store rewrites the same message: same origin, new sequence, final text.
  live.events.splice(live.events.indexOf(opened), 1);
  await append([
    { seq: 123, origin: 2, contentSeq: 123, time: T0 + 2000, source: 'extension', kind: 'assistant_message', messageId: 'answer', turnId: TURN, turnOrigin: 1, final: true,
      message: text('Restoring the fleet first. Done: 53 devices are back.') } as SessionEvent,
    { seq: 124, time: T0 + 124_000, source: 'extension', kind: 'turn_end', turnId: TURN, turnOrigin: 1, outcome: 'completed' } as SessionEvent
  ]);
  expect(timeline.textContent).toContain('Done: 53 devices are back.');
  const rows = [...timeline.querySelectorAll('[data-timeline-key]')];
  const answerRow = rows.findIndex(row => row.textContent?.includes('Done: 53 devices are back.'));
  const lastWork = rows.map((row, index) => row.matches('.tool-group, [data-timeline-key^="event:"][class*="tool"]') ? index : -1).reduce((a, b) => Math.max(a, b), -1);
  expect(answerRow).toBeGreaterThan(lastWork);
});

// Like Codex's Steer: a message waiting for the end of the turn can be sent into it now.
it('offers Send now on a queued message while the running turn can take it', async () => {
  const { w, live, append } = await boot([]);
  const api = (w as any).api;
  let directly = false;
  api.getSessionControls = async () => ({ ok: true, data: { sessionId: summary([]).id,
    activeTurnId: 'plain-turn', canInject: false, canSendDirectly: directly, queueAtFinish: false } });
  live.inputs.push({ id: 'waiting', sessionId: summary([]).id, text: 'Also check the logs', mode: 'after-turn', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  const sendNow = () => w.document.querySelector<HTMLButtonElement>('#finishQueue [aria-label="Send now"]:not([hidden])');
  // A turn that cannot be joined (or no turn at all): the message just waits.
  expect(sendNow()).toBeNull();

  directly = true;
  await append([]);
  const steer = vi.fn(async () => { live.inputs[0]!.mode = 'auto'; return { ok: true, data: true }; });
  api.sendQueuedInputNow = steer;
  sendNow()!.click(); sendNow()?.click();
  await settle();
  expect(steer).toHaveBeenCalledTimes(1);
  expect(steer).toHaveBeenCalledWith('waiting');
});

it('says so when a queued message can no longer join the running turn', async () => {
  const { w, live, append } = await boot([]);
  const api = (w as any).api;
  api.getSessionControls = async () => ({ ok: true, data: { sessionId: summary([]).id,
    activeTurnId: 'plain-turn', canInject: false, canSendDirectly: true, queueAtFinish: false } });
  live.inputs.push({ id: 'waiting', sessionId: summary([]).id, text: 'Also check the logs', mode: 'after-turn', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  api.sendQueuedInputNow = async () => ({ ok: true, data: false });
  w.document.querySelector<HTMLButtonElement>('#finishQueue [aria-label="Send now"]:not([hidden])')!.click();
  await settle();
  expect(w.document.body.textContent).toContain('The turn ended before this message could join it. It stays queued.');
});

// Codex's Find in chat: ⌘F (Ctrl+F) searches the open chat's whole recording, newest match first.
it('finds in the open chat with Cmd/Ctrl+F, steps through matches and closes with Escape', async () => {
  const rows: SessionEvent[] = [
    { seq: 1, time: T0 + 1000, source: 'extension', kind: 'user_message', messageId: 'q1', message: text('Check the Windows installer') },
    { seq: 2, time: T0 + 2000, source: 'extension', kind: 'assistant_message', messageId: 'a1', final: true, message: text('The windows installer builds.') },
    { seq: 3, time: T0 + 3000, source: 'extension', kind: 'user_message', messageId: 'q2', message: text('Now the docs') }
  ];
  const { w } = await boot(rows);
  const api = (w as any).api;
  const find = vi.fn(async () => ({ ok: true, data: [
    { seq: 1, kind: 'user_message', messageId: 'q1', position: 1 },
    { seq: 2, kind: 'assistant_message', messageId: 'a1', position: 2 }
  ] }));
  api.findInChat = find;
  const bar = w.document.getElementById('chatFind')!;
  expect(bar.hidden).toBe(true);
  // The app reads the platform as isMac() does: ⌘F there, Ctrl+F elsewhere; both keys at once is neither.
  const mac = /^Mac/.test(globalThis.navigator.platform);
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
  expect(bar.hidden).toBe(true);
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'f', ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true }));
  expect(bar.hidden).toBe(false);
  const field = w.document.getElementById('chatFindField') as HTMLInputElement;
  expect(w.document.activeElement).toBe(field);
  field.value = 'windows installer';
  field.dispatchEvent(new w.Event('input', { bubbles: true }));
  await waitFor(() => expect(w.document.getElementById('chatFindCount')!.textContent).toBe('2 of 2'));
  expect(find).toHaveBeenCalledWith(summary(rows).id, 'windows installer');
  field.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await waitFor(() => expect(w.document.getElementById('chatFindCount')!.textContent).toBe('1 of 2'));
  field.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
  await waitFor(() => expect(w.document.getElementById('chatFindCount')!.textContent).toBe('2 of 2'));
  find.mockResolvedValueOnce({ ok: true, data: [] });
  field.value = 'linux';
  field.dispatchEvent(new w.Event('input', { bubbles: true }));
  await waitFor(() => expect(w.document.getElementById('chatFindCount')!.textContent).toBe('No matches'));
  field.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(bar.hidden).toBe(true);
});

it('sends a message into the running turn by default', async () => {
  const { app, sent } = await sendDuringTurn(undefined);
  expect(sent.mode).toBe('auto');
  expect((app.w.document.getElementById('sendMode') as HTMLSelectElement).value).toBe('auto');
});

it('queues a message for after the turn when that is the chosen follow-up behavior', async () => {
  const { sent } = await sendDuringTurn('queue');
  expect(sent.mode).toBe('after-turn');
});

it.each([
  [{ metaKey: true }, undefined, 'after-turn'], [{ ctrlKey: true }, undefined, 'after-turn'],
  [{ metaKey: true }, 'queue', 'auto'], [{ ctrlKey: true }, 'queue', 'auto']
] as const)('sends the other way with %o + Shift + Enter (default %s)', async (modifier, followUp, mode) => {
  expect((await sendDuringTurn(followUp, { ...modifier, shiftKey: true })).sent.mode).toBe(mode);
});

it('runs a typed /goal sent with Cmd/Ctrl+Shift+Enter during a turn and sends the rest the other way', async () => {
  const { w, live } = await typedDuringTurn('/goal Reply with exactly: done');
  expect(w.document.getElementById('sendOptions')!.hidden).toBe(false);
  expect((w.document.getElementById('chatAutomation') as HTMLSelectElement).value).toBe('goal');
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ text: 'Reply with exactly: done', automation: 'goal', mode: 'after-turn' });
});

it('runs a typed /rename sent with Cmd/Ctrl+Shift+Enter during a turn without sending anything', async () => {
  const { w, live, input } = await typedDuringTurn('/rename');
  expect(w.document.querySelector('#sessionList .sess-rename')).not.toBeNull();
  expect(live.sent).toHaveLength(0);
  expect(input.value).toBe('');
});

it('keeps a Skill named like a command a directive with Cmd/Ctrl+Shift+Enter, sent the other way', async () => {
  const { live } = await typedDuringTurn('/goal Reply with exactly: done', [{ id: 'goal', name: 'Goal' }]);
  expect(live.sent.at(-1)).toMatchObject({ text: '/goal Reply with exactly: done', mode: 'after-turn' });
});

// /image (#1701): a picture request in words the app can't recognize goes without the app, so
// ChatGPT's own image tool is on for that one message.
it('sends a typed /image message as a picture request, without the command', async () => {
  const { w, live, input } = await slash('image');
  input.value = '/image You have the concept now, design it';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle(); await settle();
  expect(live.sent.at(-1)).toMatchObject({ text: 'You have the concept now, design it', imageRequest: true });
  // The next ordinary message is not one.
  input.value = 'Thanks, now describe it';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle(); await settle();
  expect(live.sent.at(-1)).toMatchObject({ text: 'Thanks, now describe it' });
  expect(live.sent.at(-1)).not.toHaveProperty('imageRequest');
});

it('puts /image in front of the draft when picked from the menu, and sends nothing for a bare /image', async () => {
  const { w, live, input, row } = await slash('image');
  row!.click(); await settle();
  expect(input.value).toBe('/image ');
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle(); await settle();
  expect(live.sent).toHaveLength(0);
  expect(input.value).toBe('/image ');
});

it('lists the Codex slash commands in the composer menu', async () => {
  const { w, input } = await slash('');
  const listed = [...w.document.querySelectorAll<HTMLElement>('#skillPicker .slash-menu-option')].map(row => row.title);
  expect(listed).toEqual(expect.arrayContaining(['/plan', '/goal', '/loop', '/compact', '/model', '/reasoning', '/new', '/rename', '/pin',
    '/status', '/review', '/init', '/usage', '/plugins', '/pet', '/feedback', '/copy', '/export', '/find']));
  expect(input.value).toBe('/');
});

it('opens the model picker with /model (/reasoning opens the same picker)', async () => {
  for (const command of ['model', 'reasoning']) {
    const { w, row } = await slash(command);
    row!.click(); await settle();
    expect((w.document.getElementById('modelMenu') as HTMLDetailsElement).open).toBe(true);
    break;
  }
});

it('renames the open chat with /rename', async () => {
  const { w, row, input } = await slash('rename');
  row!.click(); await settle();
  expect(w.document.querySelector('#sessionList .sess-rename')).not.toBeNull();
  expect(input.value).toBe('');
});

it('pins the open chat with /pin', async () => {
  const { w, row } = await slash('pin');
  row!.click(); await settle();
  expect(w.document.body.textContent).toContain('Chat pinned');
});

it('shows the context status with /status', async () => {
  const { w, row } = await slash('status');
  row!.click(); await settle();
  expect(w.document.getElementById('contextMeterButton')!.getAttribute('aria-expanded')).toBe('true');
});

it('starts a review request with /review and keeps what was typed after it', async () => {
  const app = await boot([]);
  (app.w as any).api.skillLibrary = async () => ({ ok: true, data: { skills: [], roots: [], errors: [], includeInstructions: true } });
  const input = app.w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = '/review'; input.setSelectionRange(7, 7); input.dispatchEvent(new app.w.Event('input', { bubbles: true }));
  await settle();
  app.w.document.querySelector<HTMLElement>('#skillPicker .slash-menu-option[title="/review"]')!.click(); await settle();
  expect(input.value).toMatch(/^Review the uncommitted changes in this project/);
});

it('opens New chat, Usage, Plugins, Pets and the diagnostics report from their commands', async () => {
  const { w, row } = await slash('usage');
  row!.click(); await settle();
  expect(w.document.querySelector<HTMLElement>('.app')!.dataset.screen).toBe('settings');
  expect(w.document.querySelector('[data-tab="usage"]')!.classList.contains('is-sel') || w.document.querySelector('[data-tab="usage"]')!.getAttribute('aria-selected') === 'true').toBe(true);
});

it('runs a typed /goal as the Goal command and sends the rest as its message', async () => {
  const { w, live } = await typed('/goal Reply with exactly: done');
  expect((w.document.getElementById('chatAutomation') as HTMLSelectElement).value).toBe('goal');
  expect(live.sent.at(-1)).toMatchObject({ text: 'Reply with exactly: done', automation: 'goal' });
  expect(live.sent.some((sent: any) => /^\/goal/.test(sent.text))).toBe(false);
});

it('drafts a plan from the rest of a typed /plan, and leaves a bare /goal waiting for its message', async () => {
  const app = await boot([]);
  (app.w as any).api.skillLibrary = async () => ({ ok: true, data: { skills: [], roots: [], errors: [], includeInstructions: true } });
  const drafted: string[] = [];
  (app.w as any).api.draftTaskPlan = async (text: string) => { drafted.push(text); return { ok: false, error: 'stopped in test' }; };
  const input = app.w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const submit = () => app.w.document.getElementById('composer')!.dispatchEvent(new app.w.Event('submit', { bubbles: true, cancelable: true }));
  input.value = '/plan Add a settings page'; submit(); await settle(); await settle();
  expect(drafted).toEqual(['Add a settings page']);
  app.w.document.getElementById('newChat')!.click(); await settle();
  input.value = '/goal'; submit(); await settle(); await settle();
  expect((app.w.document.getElementById('chatAutomation') as HTMLSelectElement).value).toBe('goal');
  expect(app.live.sent).toHaveLength(0);
  expect(input.value).toBe('');
});

it('keeps Plan armed and drafts the plan when /plan is typed with Plan already armed', async () => {
  const app = await boot([]);
  (app.w as any).api.skillLibrary = async () => ({ ok: true, data: { skills: [], roots: [], errors: [], includeInstructions: true } });
  const drafted: string[] = [];
  (app.w as any).api.draftTaskPlan = async (text: string) => { drafted.push(text); return { ok: false, error: 'stopped in test' }; };
  const input = app.w.document.getElementById('chatInput') as HTMLTextAreaElement;
  app.w.document.getElementById('createPlan')!.click(); await settle();
  input.value = '/plan refactor the parser';
  app.w.document.getElementById('composer')!.dispatchEvent(new app.w.Event('submit', { bubbles: true, cancelable: true }));
  await settle(); await settle();
  expect(app.live.sent).toHaveLength(0);
  expect(drafted).toEqual(['refactor the parser']);
});

it('runs a typed /rename on the open chat without sending anything', async () => {
  const { w, live, input } = await typed('/rename', [], true);
  expect(w.document.querySelector('#sessionList .sess-rename')).not.toBeNull();
  expect(live.sent).toHaveLength(0);
  expect(input.value).toBe('');
});

it('keeps a typed /goal a Skill directive when a Skill has that name', async () => {
  const { live } = await typed('/goal Reply with exactly: done', [{ id: 'goal', name: 'Goal' }]);
  expect(live.sent.at(-1)).toMatchObject({ text: '/goal Reply with exactly: done' });
});

it('offers chat-only commands only while a chat is open', async () => {
  const { w } = await slash('', false);
  const listed = [...w.document.querySelectorAll<HTMLElement>('#skillPicker .slash-menu-option')].map(row => row.title);
  expect(listed).toEqual(expect.arrayContaining(['/new', '/model', '/review']));
  expect(listed).not.toEqual(expect.arrayContaining(['/rename']));
  expect(listed).not.toContain('/pin');
  expect(listed).not.toContain('/status');
  for (const command of ['/copy', '/export', '/find']) expect(listed).not.toContain(command);
});

// /copy, /export and /find run the open chat's answer copy, Markdown export and Find in chat.
it('copies the newest finished answer with /copy and says so', async () => {
  const { w, row } = await slash('copy');
  const api = (w as any).api;
  api.exportMarkdown = vi.fn(async () => ({ ok: true, data: { done: 'copied' } }));
  row!.click(); await settle();
  expect(api.exportMarkdown).toHaveBeenCalledWith({ id: summary([]).id, scope: 'latest', target: 'clipboard' });
  expect(w.document.body.textContent).toContain('Answer copied');
});

it('saves the whole chat as Markdown with a typed /export, sending nothing', async () => {
  const app = await boot([]);
  const api = (app.w as any).api;
  api.skillLibrary = async () => ({ ok: true, data: { skills: [], roots: [], errors: [], includeInstructions: true } });
  api.exportMarkdown = vi.fn(async () => ({ ok: true, data: { done: 'saved', name: 'chat.md' } }));
  const input = app.w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = '/export';
  app.w.document.getElementById('composer')!.dispatchEvent(new app.w.Event('submit', { bubbles: true, cancelable: true }));
  await settle(); await settle();
  expect(api.exportMarkdown).toHaveBeenCalledWith({ id: summary([]).id, scope: 'session', target: 'file' });
  expect(app.w.document.body.textContent).toContain('Saved chat.md');
  expect(app.live.sent).toHaveLength(0);
});

it('drops a typed /export when another chat opens while the Skills load', async () => {
  const first = summary([]), second = { ...summary([]), id: '2026-09-02-test0002', title: 'Other session' };
  const app = await boot([], true, [], [], { sessions: [first, second] });
  const api = (app.w as any).api;
  let release!: (value: unknown) => void;
  api.skillLibrary = () => new Promise(resolve => { release = resolve; });
  api.exportMarkdown = vi.fn(async () => ({ ok: true, data: { done: 'saved', name: 'chat.md' } }));
  const input = app.w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = '/export';
  app.w.document.getElementById('composer')!.dispatchEvent(new app.w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  (app.w.document.querySelector(`#sessionList [data-id="${second.id}"]`) as HTMLElement).click();
  release({ ok: true, data: { skills: [], roots: [], errors: [], includeInstructions: true } });
  await settle(); await settle();
  expect(api.exportMarkdown).not.toHaveBeenCalled();
  expect(app.live.sent).toHaveLength(0);
});

it('drops a typed /export and keeps the new draft when the draft changes while the Skills load', async () => {
  const app = await boot([]);
  const api = (app.w as any).api;
  let release!: (value: unknown) => void;
  api.skillLibrary = () => new Promise(resolve => { release = resolve; });
  api.exportMarkdown = vi.fn(async () => ({ ok: true, data: { done: 'saved', name: 'chat.md' } }));
  const input = app.w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = '/export';
  app.w.document.getElementById('composer')!.dispatchEvent(new app.w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  input.value = 'Keep this draft';
  input.dispatchEvent(new app.w.Event('input', { bubbles: true }));
  release({ ok: true, data: { skills: [], roots: [], errors: [], includeInstructions: true } });
  await settle(); await settle();
  expect(api.exportMarkdown).not.toHaveBeenCalled();
  expect(input.value).toBe('Keep this draft');
  expect(app.live.sent).toHaveLength(0);
});

it('opens Find in chat with /find, its field focused', async () => {
  const { w, row, input } = await slash('find');
  row!.click(); await settle();
  expect(w.document.getElementById('chatFind')!.hidden).toBe(false);
  expect(w.document.activeElement).toBe(w.document.getElementById('chatFindField'));
  expect(input.value).toBe('');
});

it('sends with Enter by default', async () => {
  expect(await pressInComposer(undefined, {})).toEqual({ sent: 1, prevented: true });
});
it('keeps Shift+Enter as a new line', async () => {
  expect(await pressInComposer(undefined, { shiftKey: true })).toEqual({ sent: 0, prevented: false });
});
it('adds a line with Enter when Cmd/Ctrl+Enter is chosen to send', async () => {
  expect(await pressInComposer(false, {})).toEqual({ sent: 0, prevented: false });
});
it.each([{ metaKey: true }, { ctrlKey: true }])('sends with %o + Enter when that is chosen', async modifier => {
  expect(await pressInComposer(false, modifier)).toEqual({ sent: 1, prevented: true });
});

// Polish 2.1.37: the new Enter-key choice and the slash menu meet in the same keystroke.
it.each([true, false])('runs the highlighted slash command with Enter whatever Enter sends (enterSends=%s)', async enterSends => {
  const app = await boot([], true, [], [], { enterSends });
  (app.w as any).api.skillLibrary = async () => ({ ok: true, data: { skills: [], roots: [], errors: [], includeInstructions: true } });
  const input = app.w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = '/status'; input.setSelectionRange(7, 7); input.dispatchEvent(new app.w.Event('input', { bubbles: true }));
  await settle();
  const event = new app.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  await settle(300);
  expect(event.defaultPrevented).toBe(true);
  expect(app.live.sent).toHaveLength(0);
  expect(app.w.document.getElementById('contextMeterButton')!.getAttribute('aria-expanded')).toBe('true');
  expect(input.value).toBe('');
});

describe('branch in new chat (#482)', () => {
  const chat = '6ad337fe-47a4-83ed-a21f-c2e24d5829a4';
  const replyId = '2b06482d-0dc6-4847-bf7a-2e1a0f671e89';
  const ask: SessionEvent = { kind: 'user_message', seq: 1, origin: 1, time: T0, source: 'extension', turnId: 'done-turn', messageId: 'ask', message: text('Plan the release') };
  const reply = (messageId = replyId): SessionEvent => ({ kind: 'assistant_message', seq: 2, time: T0 + 1_000, source: 'extension', turnId: 'done-turn', messageId, message: text('Tag first, then build.'), final: true, state: 'final' });
  const end: SessionEvent = { seq: 3, time: T0 + 2_000, source: 'extension', kind: 'turn_end', turnId: 'done-turn', outcome: 'completed' };
  const branchButton = (w: { document: Document }) => w.document.querySelector<HTMLButtonElement>('.answer-actions .answer-branch');
  const submit = async (w: Window & typeof globalThis, value: string) => {
    (w.document.getElementById('chatInput') as HTMLTextAreaElement).value = value;
    w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
  };

  it('starts a new chat from a completed answer and sends its first message at that reply', async () => {
    const { w, live } = await boot([ask, reply(), end], true, [], [], { summary: { conversationId: chat } });
    const button = branchButton(w)!;
    expect(button.getAttribute('aria-label')).toBe('Branch in new chat');
    button.click(); await settle();
    expect(w.document.getElementById('chatTitle')!.textContent).toBe('New chat');
    const notice = w.document.getElementById('branchDraft')!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('Loop under test');
    await submit(w as any, 'Try the other approach.');
    expect(live.sent.at(-1)).toMatchObject({ sessionId: null, text: 'Try the other approach.',
      branch: { sessionId: summary([]).id, conversationId: chat, messageId: replyId } });
  });

  it('goes back to the reply it came from when the person cancels the branch', async () => {
    const { w, live } = await boot([ask, reply(), end], true, [], [], { summary: { conversationId: chat } });
    const api = (w as any).api;
    api.locateMessage = vi.fn(async () => ({ ok: true, data: { seq: 2, kind: 'assistant_message', messageId: replyId, position: 2 } }));
    branchButton(w)!.click(); await settle();
    w.document.querySelector<HTMLButtonElement>('#branchDraft .branch-draft-cancel')!.click(); await settle();
    expect(w.document.getElementById('branchDraft')!.hidden).toBe(true);
    expect(w.document.querySelector(`.sess.is-sel[data-id="${summary([]).id}"]`)).not.toBeNull();
    expect(api.locateMessage).toHaveBeenCalledWith(summary([]).id, replyId);
    // An ordinary new chat afterwards carries no branch.
    w.document.getElementById('newChat')!.click(); await settle();
    await submit(w as any, 'Just a new chat.');
    expect(live.sent.at(-1)).not.toHaveProperty('branch');
  });

  // 2.1.41 release round, macOS: Cancel branch opened the chat at the reply, on a page of older
  // history. A message sent from there reached ChatGPT and was answered, but neither showed: a
  // page of history takes no live rows. Sending returns the chat to its end first.
  it('shows a message sent after cancelling a branch, even when the reply sat on an older page', async () => {
    const filler: SessionEvent[] = [];
    for (let n = 0; n < 40; n += 1) {
      const seq = 4 + n * 3, turnId = `later-turn-${n}`;
      filler.push({ kind: 'user_message', seq, origin: seq, time: T0 + seq * 1_000, source: 'extension', turnId, messageId: `later-ask-${n}`, message: text(`Later question ${n}`) },
        { kind: 'assistant_message', seq: seq + 1, time: T0 + (seq + 1) * 1_000, source: 'extension', turnId,
          messageId: `0000000${String(n).padStart(1, '0')}-0dc6-4847-bf7a-2e1a0f671e89`.slice(-36), message: text(`Later answer ${n}`), final: true, state: 'final' },
        { seq: seq + 2, time: T0 + (seq + 2) * 1_000, source: 'extension', kind: 'turn_end', turnId, outcome: 'completed' });
    }
    const { w, live } = await boot([ask, reply(), end, ...filler], true, [], [], { summary: { conversationId: chat } });
    const api = (w as any).api;
    // The branch came from the first reply, far above the page the chat opens on.
    api.locateMessage = vi.fn(async () => ({ ok: true, data: { seq: 2, kind: 'assistant_message', messageId: replyId, position: 2 } }));
    const timeline = () => w.document.getElementById('timeline')!.textContent!;
    expect(timeline()).toContain('Later answer 39');
    [...w.document.querySelectorAll<HTMLButtonElement>('.answer-actions .answer-branch')].at(-1)!.click(); await settle();
    w.document.querySelector<HTMLButtonElement>('#branchDraft .branch-draft-cancel')!.click(); await settle(); await settle();
    expect(timeline()).toContain('Tag first, then build.');
    expect(timeline()).not.toContain('Later answer 39');
    // At the bottom of that page the newer rows are still not loaded: the way back to the end shows.
    expect(w.document.getElementById('jumpLatest')!.classList.contains('is-shown')).toBe(true);
    await submit(w as any, 'Continue from here.');
    await settle(); await settle();
    expect(live.sent.at(-1)).toMatchObject({ text: 'Continue from here.' });
    // Back at the end: the latest exchange and the message just sent are in view.
    expect(timeline()).toContain('Later answer 39');
  });

  it('drops the branch and stays a plain new chat when the chat it came from is deleted', async () => {
    const { w, live, notifySession } = await boot([ask, reply(), end], true, [], [], { summary: { conversationId: chat } });
    branchButton(w)!.click(); await settle();
    // The source chat is deleted while the branch is still a draft.
    (w as any).api.listSessions = async () => ({ ok: true, data: { sessions: [], activeId: null, pressure: [] } });
    notifySession(); await settle(700);
    // The notice no longer names a chat that is gone, and the first message starts a plain chat.
    expect(w.document.getElementById('branchDraft')!.hidden).toBe(true);
    expect(w.document.getElementById('chatTitle')!.textContent).toBe('New chat');
    await submit(w as any, 'Just a new chat.');
    expect(live.sent.at(-1)).not.toHaveProperty('branch');
  });

  it.each([
    ['a reply without a native id', { reply: 'assistant:interim:1', summary: { conversationId: chat } }],
    ['a chat without a native ChatGPT id', { reply: replyId, summary: {} }],
    ['a worker chat', { reply: replyId, summary: { conversationId: chat, origin: { kind: 'worker', fromSessionId: null, agentId: 'worker-1', task: 'x' } } }]
  ] as const)('offers no branch for %s', async (_name, setup) => {
    const { w } = await boot([ask, reply(setup.reply), end], true, [], [], { summary: setup.summary as Partial<SessionSummary> });
    expect(w.document.querySelector('.answer-actions')).not.toBeNull();
    expect(branchButton(w)).toBeNull();
  });

  // History ChatGPT copied into a branch, and an adopted chat's earlier answers, are recorded
  // without a turn: before, they had no actions at all, so nothing could branch from or copy them.
  it('offers copy, export and branch on an answer recorded without a turn', async () => {
    const earlierId = '6ad3a59b-0000-83eb-8bc4-8c84e68dd911';
    const loose: SessionEvent = { kind: 'assistant_message', seq: 4, time: T0 + 3_000, source: 'extension', messageId: earlierId,
      message: text('An earlier answer.'), final: true, state: 'final' };
    const { w, live } = await boot([loose, ask, reply(), end], true, [], [], { summary: { conversationId: chat } });
    const api = (w as any).api;
    api.exportMarkdown = vi.fn(async () => ({ ok: true, data: { done: 'copied' } }));
    const bars = [...w.document.querySelectorAll('.answer-actions')];
    expect(bars).toHaveLength(2);
    const bar = bars.find(node => node.closest('.said')!.textContent!.includes('An earlier answer'))!;
    bar.querySelector<HTMLButtonElement>('.answer-action')!.click(); await settle();
    expect(api.exportMarkdown).toHaveBeenCalledWith(expect.objectContaining({ scope: 'answer', messageId: earlierId, turnId: undefined }));
    bar.querySelector<HTMLButtonElement>('.answer-branch')!.click(); await settle();
    await submit(w as any, 'From the earlier answer.');
    expect(live.sent.at(-1)).toMatchObject({ branch: { conversationId: chat, messageId: earlierId } });
  });

  it('links a branched chat back to the reply it came from', async () => {
    const source = { ...summary([]), id: '2026-10-17-source01', title: 'Release plan', conversationId: chat };
    const branched = { ...summary([]), id: '2026-10-17-branch01', title: 'Other approach', conversationId: '6ad388c2-faf8-83ed-bb4f-9efff4ad92de',
      origin: { kind: 'desktop' as const, fromSessionId: source.id, agentId: null, task: '', branchOf: { conversationId: chat, messageId: replyId } } };
    const { w } = await boot([ask, reply(), end], false, [], [], { sessions: [branched, source] });
    const api = (w as any).api;
    api.locateMessage = vi.fn(async () => ({ ok: true, data: { seq: 2, kind: 'assistant_message', messageId: replyId, position: 2 } }));
    (w.document.querySelector(`#sessionList [data-id="${branched.id}"]`) as HTMLElement).click(); await settle();
    const link = w.document.getElementById('chatBranchOrigin') as HTMLButtonElement;
    expect(link.hidden).toBe(false);
    expect(link.textContent).toContain('Release plan');
    link.click(); await settle();
    expect(w.document.querySelector(`.sess.is-sel[data-id="${source.id}"]`)).not.toBeNull();
    expect(api.locateMessage).toHaveBeenCalledWith(source.id, replyId);
    expect(link.hidden).toBe(true);
  });

  it('sends a retry from a branch that has not started yet at the same reply', async () => {
    const source = { ...summary([]), id: '2026-10-17-source01', title: 'Release plan', conversationId: chat };
    const pending = { ...summary([]), id: '2026-10-17-branch01', title: 'Other approach', conversationId: null, chatIds: [], selectedModel: undefined,
      origin: { kind: 'desktop' as const, fromSessionId: source.id, agentId: null, task: '', branchOf: { conversationId: chat, messageId: replyId } } };
    const { w, live } = await boot([], false, [], [], { sessions: [pending, source] });
    (w.document.querySelector(`#sessionList [data-id="${pending.id}"]`) as HTMLElement).click(); await settle();
    // Its failed first message left no observed model: the person picks one, as for any resend.
    for (const [id, value] of [['composerModel', 'gpt-5.6-sol'], ['composerReasoning', 'high']] as const) {
      const select = w.document.getElementById(id) as HTMLSelectElement;
      select.value = value; select.dispatchEvent(new w.Event('change', { bubbles: true }));
    }
    await settle();
    await submit(w as any, 'Again, please.');
    expect(live.sent.at(-1)).toMatchObject({ sessionId: pending.id, branch: { sessionId: source.id, conversationId: chat, messageId: replyId } });
  });
});

describe('edit and resubmit (#365)', () => {
  const q = (seq: number, messageId: string, value: string, turnId: string, extra: object = {}): SessionEvent =>
    ({ kind: 'user_message', seq, origin: seq, time: T0 + seq * 1000, source: 'extension', turnId, messageId, message: text(value), ...extra }) as SessionEvent;
  const a = (seq: number, messageId: string, value: string, turnId: string): SessionEvent =>
    ({ kind: 'assistant_message', seq, time: T0 + seq * 1000, source: 'extension', turnId, messageId, message: text(value), final: true, state: 'final' }) as SessionEvent;
  const end = (seq: number, turnId: string): SessionEvent => ({ seq, time: T0 + seq * 1000, source: 'extension', kind: 'turn_end', turnId, outcome: 'completed' }) as SessionEvent;
  const said = (w: { document: Document }) => [...w.document.querySelectorAll('#timeline > .ev-user_message, #timeline > .ev-assistant_message, #timeline > .earlier-version')]
    .map(node => node.classList.contains('earlier-version') ? `earlier:${node.querySelector('summary')!.textContent!.trim()}` : node.querySelector('.said')!.textContent!.replace(/\s+/g, ' ').trim().slice(0, 40));

  it('folds the version an edit replaced, and what followed it, under the edited question', async () => {
    const events = [q(1, 'q-1', 'First question', 't1'), a(2, 'a-1', 'First answer', 't1'), end(3, 't1'),
      q(4, 'q-2', 'Fix the logn bug', 't2'), a(5, 'a-2', 'Which bug?', 't2'), end(6, 't2'),
      q(7, 'q-2b', 'Fix the login bug', 't3', { replaces: 'q-2' }), a(8, 'a-3', 'Done, here is the fix.', 't3'), end(9, 't3')];
    const { w } = await boot(events, true);
    const rows = said(w);
    expect(rows[0]).toContain('First question');
    expect(rows[1]).toContain('First answer');
    expect(rows[2]).toContain('Fix the login bug');
    expect(rows[3]).toBe('earlier:Earlier version · 2 messages');
    expect(rows[4]).toContain('Done, here is the fix.');
    expect(rows).toHaveLength(5);
    expect(w.document.querySelector('#timeline > .ev-user_message:nth-of-type(n) .message-edited, #timeline .message-edited')?.textContent).toBe('Edited version');
    // Directly under the edited question, before the line of the turn that answers it.
    const editedRow = [...w.document.querySelectorAll('#timeline > .ev-user_message')].find(row => row.textContent!.includes('Fix the login bug'))!;
    expect(editedRow.nextElementSibling?.classList.contains('earlier-version')).toBe(true);
    const fold = w.document.querySelector<HTMLDetailsElement>('#timeline > .earlier-version')!;
    expect(fold.open).toBe(false);
    fold.open = true; fold.dispatchEvent(new w.Event('toggle')); await settle();
    const shown = [...fold.querySelectorAll('.said')].map(node => node.textContent!.replace(/\s+/g, ' ').trim());
    expect(shown).toHaveLength(2);
    expect(shown[0]).toContain('Fix the logn bug');
    expect(shown[1]).toContain('Which bug?');
  });

  it('folds every earlier version of a question edited twice into one row', async () => {
    const events = [q(1, 'q-1', 'Ask', 't1'), a(2, 'a-1', 'Answer one', 't1'), end(3, 't1'),
      q(4, 'q-1b', 'Ask again', 't2', { replaces: 'q-1' }), a(5, 'a-2', 'Answer two', 't2'), end(6, 't2'),
      q(7, 'q-1c', 'Ask a third time', 't3', { replaces: 'q-1b' }), a(8, 'a-3', 'Answer three', 't3'), end(9, 't3')];
    const { w } = await boot(events, true);
    expect(said(w)).toEqual([expect.stringContaining('Ask a third time'), 'earlier:Earlier versions · 4 messages', expect.stringContaining('Answer three')]);
  });

  const chat = '6ad337fe-47a4-83ed-a21f-c2e24d5829a4';
  const Q1 = '6ad3a59b-0001-83eb-8bc4-8c84e68dd911', Q2 = '6ad3a59b-0002-83eb-8bc4-8c84e68dd911';
  const A1 = '6ad3a59b-00a1-83eb-8bc4-8c84e68dd911', A2 = '6ad3a59b-00a2-83eb-8bc4-8c84e68dd911';
  const exchange = () => [q(1, Q1, 'First question', 't1'), a(2, A1, 'First answer', 't1'), end(3, 't1'),
    q(4, Q2, 'Fix the logn bug', 't2'), a(5, A2, 'Which bug?', 't2'), end(6, 't2')];
  const submit = async (w: Window & typeof globalThis, value?: string) => {
    if (value !== undefined) (w.document.getElementById('chatInput') as HTMLTextAreaElement).value = value;
    w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
  };
  const editButton = (w: { document: Document }, text: string) => [...w.document.querySelectorAll('#timeline > .ev-user_message')]
    .find(row => row.textContent!.includes(text))?.querySelector<HTMLButtonElement>('.question-edit') ?? null;

  it('edits one of your questions from the composer and sends it as ChatGPT\'s edit of that question', async () => {
    const { w, live } = await boot(exchange(), true, [], [], { summary: { conversationId: chat } });
    (w.document.getElementById('chatInput') as HTMLTextAreaElement).value = 'A draft I was writing';
    editButton(w, 'First question')!.click(); await settle();
    const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
    expect(input.value).toBe('First question');
    const notice = w.document.getElementById('editDraft')!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('Editing your message · replaces 3 later messages');
    // The question being edited is marked in the chat, so an earlier one is easy to find.
    const marked = () => [...w.document.querySelectorAll('#timeline .ev-user_message.is-being-edited')].map(row => row.textContent!.includes('First question'));
    expect(marked()).toEqual([true]);
    await submit(w as any, 'First question, edited');
    expect(live.sent.at(-1)).toMatchObject({ sessionId: summary([]).id, text: 'First question, edited', mode: 'auto', edit: { messageId: Q1 } });
    expect(notice.hidden).toBe(true);
    expect(marked()).toEqual([]);
    // The draft that was there before the edit comes back.
    expect(input.value).toBe('A draft I was writing');
  });

  it('says so when the latest question is edited, and gives the draft back when the edit is cancelled', async () => {
    const { w, live } = await boot(exchange(), true, [], [], { summary: { conversationId: chat } });
    const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
    input.value = 'Unfinished';
    editButton(w, 'Fix the logn bug')!.click(); await settle();
    expect(w.document.getElementById('editDraft')!.textContent).toContain('Editing your message · replaces 1 later message');
    w.document.querySelector<HTMLButtonElement>('#editDraft .edit-draft-cancel')!.click(); await settle();
    expect(w.document.getElementById('editDraft')!.hidden).toBe(true);
    expect(input.value).toBe('Unfinished');
    await submit(w as any, 'Just a follow-up');
    expect(live.sent.at(-1)).not.toHaveProperty('edit');
  });

  it('sends Review\'s conflict request as a new message, even from an edit and a narrow window', async () => {
    // It went into the edit, so Send replaced the question and every message after it.
    const project: LocalProject = { id: '55555555-5555-4555-8555-555555555555', name: 'Workspace', path: '/workspace', createdAt: T0 };
    const { w, live } = await boot(exchange(), true, [], [project], { summary: { conversationId: chat } });
    const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });
    w.api.getProjectGitSnapshot = () => ok({ projectId: project.id, state: 'ready', truncated: false, revision: 'merging',
      changes: [{ status: 'C', path: 'src/both.ts', additions: null, deletions: null, binary: false }] });
    w.api.getProjectGitDiff = () => ok({ projectId: project.id, status: 'C', path: 'src/both.ts', additions: null, deletions: null,
      binary: false, tooLarge: false, baseText: 'ours', currentText: '<<<<<<< HEAD' });
    Object.defineProperty(w, 'matchMedia', { configurable: true,
      value: (query: string) => ({ matches: query.includes('850px'), addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
    const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
    input.value = 'Unfinished';
    editButton(w, 'First question')!.click(); await settle();
    w.document.querySelector<HTMLButtonElement>('.work-dock-quick[data-view="review"]')!.click(); await settle();
    w.document.querySelector<HTMLButtonElement>('.review-panel .file-change-row[data-path="src/both.ts"]')!.click(); await settle();
    [...w.document.querySelectorAll<HTMLButtonElement>('.review-panel .file-preview-actions button')].find(button => button.title === 'Ask chat to resolve')!.click();
    await settle();
    expect(w.document.getElementById('editDraft')!.hidden).toBe(true);
    expect(input.value).toMatch(/^Help me resolve the merge conflict in src\/both\.ts\..*\n\nUnfinished$/s);
    expect(w.document.querySelector('.has-work-dock')).toBeNull();
    expect(w.document.activeElement).toBe(input);
    await submit(w as any);
    expect(live.sent.at(-1)).not.toHaveProperty('edit');
    expect(live.sent.at(-1)?.text).toContain('Help me resolve the merge conflict in src/both.ts.');
  });

  it('does not put Review\'s conflict request in the composer while a prepared plan is waiting to be sent', async () => {
    // Send starts the prepared plan, so the request the composer showed would never have been sent.
    const project: LocalProject = { id: '55555555-5555-4555-8555-555555555555', name: 'Workspace', path: '/workspace', createdAt: T0 };
    const { w, live } = await boot([], false, [], [project]);
    const api = (w as any).api;
    (w.document.querySelector(`.project-heading > [data-new-project="${project.id}"]`) as HTMLButtonElement).click(); await settle();
    (await api.getState()).data.config.ui.finishTool = true;
    const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });
    api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Build foundation', 'Verify it'] }));
    api.getProjectGitSnapshot = () => ok({ projectId: project.id, state: 'ready', truncated: false, revision: 'merging',
      changes: [{ status: 'C', path: 'src/both.ts', additions: null, deletions: null, binary: false }] });
    api.getProjectGitDiff = () => ok({ projectId: project.id, status: 'C', path: 'src/both.ts', additions: null, deletions: null,
      binary: false, tooLarge: false, baseText: 'ours', currentText: '<<<<<<< HEAD' });
    const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
    input.value = 'Build the whole task';
    input.dispatchEvent(new w.Event('input'));
    w.document.getElementById('createPlan')!.click();
    w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await settle();
    expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Build foundation');
    w.document.querySelector<HTMLButtonElement>('.work-dock-quick[data-view="review"]')!.click(); await settle();
    w.document.querySelector<HTMLButtonElement>('.review-panel .file-change-row[data-path="src/both.ts"]')!.click(); await settle();
    [...w.document.querySelectorAll<HTMLButtonElement>('.review-panel .file-preview-actions button')].find(button => button.title === 'Ask chat to resolve')!.click();
    await settle();
    expect(input.value).toBe('');
    expect(w.document.querySelector('.toast')?.textContent).toBe('Start or cancel the prepared plan first, then ask again.');
    expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Build foundation');
    expect(live.sent).toHaveLength(0);
  });

  it('offers no Edit in a worker chat', async () => {
    const { w } = await boot(exchange(), true, [], [], { summary: { conversationId: chat, origin: { kind: 'worker', fromSessionId: null, agentId: 'worker-1', task: 'x' } } });
    expect(editButton(w, 'First question')).toBeNull();
  });

  it('offers no Edit for a question without a native id', async () => {
    const { w } = await boot([q(1, 'user:local:1', 'Local question', 't1'), a(2, A1, 'Answer', 't1'), end(3, 't1')], true, [], [], { summary: { conversationId: chat } });
    expect(editButton(w, 'Local question')).toBeNull();
  });

  it('offers Edit on the newest version only, never inside the earlier versions it folded', async () => {
    const { w } = await boot([...exchange(), q(7, '6ad3a59b-0003-83eb-8bc4-8c84e68dd911', 'Fix the login bug', 't3', { replaces: Q2 }), a(8, '6ad3a59b-00a3-83eb-8bc4-8c84e68dd911', 'Fixed.', 't3'), end(9, 't3')],
      true, [], [], { summary: { conversationId: chat } });
    expect(editButton(w, 'Fix the login bug')).not.toBeNull();
    const fold = w.document.querySelector<HTMLDetailsElement>('#timeline > .earlier-version')!;
    fold.open = true; fold.dispatchEvent(new w.Event('toggle')); await settle();
    expect(fold.querySelector('.question-edit')).toBeNull();
  });

  it('leaves edit mode when another chat is opened', async () => {
    const other = { ...summary([]), id: '2026-10-17-other001', title: 'Other chat', conversationId: '6ad388c2-faf8-83ed-bb4f-9efff4ad92de' };
    const { w, live } = await boot(exchange(), true, [], [], { summary: { conversationId: chat }, sessions: [{ ...summary([]), conversationId: chat }, other] });
    editButton(w, 'First question')!.click(); await settle();
    (w.document.querySelector(`#sessionList [data-id="${other.id}"]`) as HTMLElement).click(); await settle();
    expect(w.document.getElementById('editDraft')!.hidden).toBe(true);
    await submit(w as any, 'Hello there');
    expect(live.sent.at(-1)).not.toHaveProperty('edit');
  });

  it('shows an edit whose replaced version is not in the loaded history as edited, without a fold', async () => {
    const { w } = await boot([q(7, 'q-2b', 'Fix the login bug', 't3', { replaces: 'q-gone' }), a(8, 'a-3', 'Done.', 't3'), end(9, 't3')], true);
    expect(said(w)).toEqual([expect.stringContaining('Fix the login bug'), expect.stringContaining('Done.')]);
    expect(w.document.querySelector('#timeline .message-edited')?.textContent).toBe('Edited version');
  });

  // The page failed an edit's delivery; the failed row keeps `edit`, and retrying must keep it an edit.
  const failedInput = (text: string, extra: Partial<InputEntry> = {}): InputEntry => ({ id: 'failed-edit', sessionId: summary([]).id, requestedSessionId: null,
    projectId: null, text, automation: 'off', model: 'gpt-5.6-sol', reasoningEffort: 'high', mode: 'auto', dueAt: 1, createdAt: T0 + 7000, state: 'failed',
    owner: 'old-page', conversationId: chat, error: 'ChatGPT did not offer Edit for that message.', ...extra }) as InputEntry;
  const retryDelivery = async (w: Window & typeof globalThis) => {
    w.document.querySelector<HTMLButtonElement>('[aria-label="Retry delivery"]')!.click(); await settle();
  };

  it('retries a failed edit as an edit of the same question', async () => {
    const { w, live, append } = await boot(exchange(), true, [], [], { summary: { conversationId: chat } });
    live.inputs = [failedInput('First question, edited', { edit: { messageId: Q1 } })]; await append([]);
    await retryDelivery(w as any);
    const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
    expect(input.value).toBe('First question, edited');
    const notice = w.document.getElementById('editDraft')!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('Editing your message · replaces 3 later messages');
    expect(w.document.querySelector('[aria-label="Retry delivery"]')).toBeNull();
    await submit(w as any);
    expect(live.sent.at(-1)).toMatchObject({ text: 'First question, edited', mode: 'auto', edit: { messageId: Q1 } });
    expect(notice.hidden).toBe(true);
  });

  it('retries a failed ordinary message as an ordinary message', async () => {
    const { w, live, append } = await boot(exchange(), true, [], [], { summary: { conversationId: chat } });
    live.inputs = [failedInput('A follow-up', { error: 'Delivery failed' })]; await append([]);
    await retryDelivery(w as any);
    expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).value).toBe('A follow-up');
    expect(w.document.getElementById('editDraft')!.hidden).toBe(true);
    await submit(w as any);
    expect(live.sent.at(-1)).toMatchObject({ text: 'A follow-up' });
    expect(live.sent.at(-1)).not.toHaveProperty('edit');
  });

  // An edit in progress is an unsent draft: retrying must neither replace it nor inherit it.
  it.each([
    ['a failed edit', { edit: { messageId: Q1 } }],
    ['a failed ordinary message', {}]
  ])('keeps an edit in progress, with the draft it will give back, when %s is retried', async (_name, extra) => {
    const { w, live, append } = await boot(exchange(), true, [], [], { summary: { conversationId: chat } });
    const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
    input.value = 'My draft';
    editButton(w, 'Fix the logn bug')!.click(); await settle();
    input.value = ''; input.dispatchEvent(new w.Event('input', { bubbles: true }));
    live.inputs = [failedInput('Retried words', extra)]; await append([]);
    await retryDelivery(w as any);
    expect(w.document.querySelector('.toast')?.textContent).toContain('Send or clear your current draft before retrying this message.');
    expect(input.value).toBe('');
    expect(w.document.querySelector('[aria-label="Retry delivery"]')).not.toBeNull();
    const notice = w.document.getElementById('editDraft')!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('Editing your message · replaces 1 later message');
    expect([...w.document.querySelectorAll('#timeline .ev-user_message.is-being-edited')].map(row => row.textContent!.includes('Fix the logn bug'))).toEqual([true]);
    // Cancelling still gives back the draft the edit began with.
    w.document.querySelector<HTMLButtonElement>('#editDraft .edit-draft-cancel')!.click(); await settle();
    expect(input.value).toBe('My draft');
  });

  it('does not restore a failed edit while the question it edited is in older history that is not loaded', async () => {
    const filler = Array.from({ length: 40 }, (_, i) => a(2 + i, `6ad3a59b-01${String(i).padStart(2, '0')}-83eb-8bc4-8c84e68dd911`, `Answer ${i}`, 't1'));
    const { w, live, append } = await boot([q(1, Q1, 'First question', 't1'), ...filler, end(42, 't1')], true, [], [], { summary: { conversationId: chat } });
    expect(w.document.getElementById('timeline')!.textContent).not.toContain('First question');
    live.inputs = [failedInput('First question, edited', { edit: { messageId: Q1 } })]; await append([]);
    await retryDelivery(w as any);
    expect(w.document.querySelector('.toast')?.textContent).toContain('Scroll up to the message you edited, then retry.');
    expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).value).toBe('');
    expect(w.document.getElementById('editDraft')!.hidden).toBe(true);
    expect(w.document.querySelector('[aria-label="Retry delivery"]')).not.toBeNull();
    await submit(w as any, 'Unrelated');
    expect(live.sent.at(-1)).not.toHaveProperty('edit');
  });

  it('counts every later message of a retried edit, whatever the agent filter shows', async () => {
    const worker = { ...a(5, A2, 'Which bug?', 't2'), agent: 'worker-1' } as SessionEvent;
    const { w, live, append } = await boot([q(1, Q1, 'First question', 't1'), a(2, A1, 'First answer', 't1'), end(3, 't1'),
      q(4, Q2, 'Fix the logn bug', 't2'), worker, end(6, 't2')], true, [], [], { developerMode: true, summary: { conversationId: chat } });
    w.document.querySelector<HTMLButtonElement>('#chatAgentFilter [data-agent="worker-1"]')!.click(); await settle();
    expect(w.document.getElementById('timeline')!.textContent).not.toContain('First question');
    live.inputs = [failedInput('First question, edited', { edit: { messageId: Q1 } })]; await append([]);
    await retryDelivery(w as any);
    expect(w.document.getElementById('editDraft')!.textContent).toContain('Editing your message · replaces 3 later messages');
  });

  it('restores a failed edit whose question can no longer be edited as a new message, and says so', async () => {
    const replaced = [...exchange(), q(7, '6ad3a59b-0003-83eb-8bc4-8c84e68dd911', 'Fix the login bug', 't3', { replaces: Q2 }), end(8, 't3')];
    const { w, live, append } = await boot(replaced, true, [], [], { summary: { conversationId: chat } });
    live.inputs = [failedInput('Fix the login bug please', { edit: { messageId: Q2 } })]; await append([]);
    await retryDelivery(w as any);
    expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).value).toBe('Fix the login bug please');
    expect(w.document.getElementById('editDraft')!.hidden).toBe(true);
    expect(w.document.querySelector('.toast')?.textContent).toContain('can no longer be edited');
    await submit(w as any);
    expect(live.sent.at(-1)).not.toHaveProperty('edit');
  });

  it('recalls no earlier message with ArrowUp while a question is being edited, even with the edit cleared', async () => {
    const { w } = await boot(exchange(), true, [], [], { summary: { conversationId: chat } });
    editButton(w, 'First question')!.click(); await settle();
    const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
    input.value = ''; input.dispatchEvent(new w.Event('input', { bubbles: true }));
    const event = new w.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(input.value).toBe('');
  });
});

describe('prompt recall in the composer', () => {
  const ask = (seq: number, value: string, extra: object = {}): SessionEvent =>
    ({ kind: 'user_message', seq, time: T0 + seq * 1000, source: 'extension', turnId: `t${seq}`, messageId: `q-${seq}`, message: text(value), ...extra }) as SessionEvent;
  const answer = (seq: number, value: string): SessionEvent =>
    ({ kind: 'assistant_message', seq, time: T0 + seq * 1000, source: 'extension', turnId: `t${seq - 1}`, messageId: `a-${seq}`, message: text(value), final: true, state: 'final' }) as SessionEvent;
  // A message with only a file and no text is not recalled.
  const chat = () => [ask(1, 'First question'), answer(2, 'First answer'),
    ask(3, '', { attachments: [{ id: 'f-1', name: 'notes.txt', mimeType: 'text/plain', size: 4 }] }), answer(4, 'Read it.'),
    ask(5, 'Second question'), answer(6, 'Second answer')];
  const composer = (w: { document: Document }) => w.document.getElementById('chatInput') as HTMLTextAreaElement;
  /** Presses a key in the composer; true when the app took it over from the textarea. */
  const press = (w: JSDOM['window'], key: string, init: KeyboardEventInit = {}) => {
    const event = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    composer(w).dispatchEvent(event);
    return event.defaultPrevented;
  };
  /** The outbox row that sent the message `messageId`, delivered and recorded. */
  const sentInput = (messageId: string, extra: Partial<InputEntry> = {}): InputEntry => ({ id: `input-${messageId}`, sessionId: summary([]).id, projectId: null,
    text: 'Sent text', automation: 'off', model: null, reasoningEffort: null, mode: 'auto', dueAt: 1, createdAt: T0, state: 'sent', owner: 'page', conversationId: null,
    messageId, deliveredAt: T0, historyRecorded: true, ...extra }) as InputEntry;

  it('fills an empty composer with your last message on ArrowUp, caret at the start, without sending it', async () => {
    const { w, live } = await boot(chat());
    expect(press(w, 'ArrowUp')).toBe(true);
    expect(composer(w).value).toBe('Second question');
    expect([composer(w).selectionStart, composer(w).selectionEnd]).toEqual([0, 0]);
    await settle();
    expect(live.sent).toEqual([]);
  });

  it('goes further back with each ArrowUp and stops at your first message', async () => {
    const { w } = await boot(chat());
    press(w, 'ArrowUp');
    expect(press(w, 'ArrowUp')).toBe(true);
    expect(composer(w).value).toBe('First question');
    expect(press(w, 'ArrowUp')).toBe(false);
    expect(composer(w).value).toBe('First question');
  });

  it('comes forward with ArrowDown and gives back the empty composer past the newest message', async () => {
    const { w } = await boot(chat());
    press(w, 'ArrowUp'); press(w, 'ArrowUp');
    // Up left the caret at the start: the first Down is the textarea's own, taking it to the end.
    expect(press(w, 'ArrowDown')).toBe(false);
    composer(w).setSelectionRange(14, 14);
    expect(press(w, 'ArrowDown')).toBe(true);
    expect(composer(w).value).toBe('Second question');
    expect(composer(w).selectionStart).toBe('Second question'.length);
    expect(press(w, 'ArrowDown')).toBe(true);
    expect(composer(w).value).toBe('');
    expect(press(w, 'ArrowDown')).toBe(false);
  });

  it('leaves the arrows to a typed draft', async () => {
    const { w } = await boot(chat());
    composer(w).value = 'A draft I am writing';
    composer(w).dispatchEvent(new w.Event('input', { bubbles: true }));
    expect(press(w, 'ArrowUp')).toBe(false);
    expect(composer(w).value).toBe('A draft I am writing');
  });

  it.each([{ isComposing: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }])('recalls nothing with %o', async init => {
    const { w } = await boot(chat());
    expect(press(w, 'ArrowUp', init)).toBe(false);
    expect(composer(w).value).toBe('');
  });

  it.each([false, true])('recalls nothing into a composer holding an attached file (attached after a recall: %s)', async recalledFirst => {
    const { w } = await boot(chat());
    if (recalledFirst) expect(press(w, 'ArrowUp')).toBe(true);
    (w as any).api.chooseFiles = async () => ({ ok: true, data: [{ id: '11111111-2222-4333-8444-555555555555', name: 'image.png', mimeType: 'image/png', size: 42 }] });
    w.document.getElementById('attachImages')!.click(); await settle();
    expect(press(w, 'ArrowUp')).toBe(false);
    expect(composer(w).value).toBe(recalledFirst ? 'Second question' : '');
  });

  it('gives the arrows back once the recalled message is edited', async () => {
    const { w } = await boot(chat());
    expect(press(w, 'ArrowUp')).toBe(true);
    composer(w).value = 'Second question, shorter please';
    composer(w).dispatchEvent(new w.Event('input', { bubbles: true }));
    expect(press(w, 'ArrowUp')).toBe(false);
    expect(press(w, 'ArrowDown')).toBe(false);
    expect(composer(w).value).toBe('Second question, shorter please');
  });

  // A recall ends with the composer's next change: the same text typed again by hand is a draft.
  it.each(['sent', 'cleared'])('leaves the arrows to the same text typed again after a recall was %s', async how => {
    const { w } = await boot(chat());
    const input = composer(w);
    expect(press(w, 'ArrowUp')).toBe(true);
    if (how === 'sent') { w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await settle(); }
    else { input.select(); input.setRangeText(''); input.dispatchEvent(new w.Event('input', { bubbles: true })); }
    expect(input.value).toBe('');
    input.value = 'Second question'; input.dispatchEvent(new w.Event('input', { bubbles: true }));
    expect(press(w, 'ArrowUp')).toBe(false);
    expect(input.value).toBe('Second question');
  });

  it('recalls only the messages the agent filter shows', async () => {
    const { w } = await boot([ask(1, 'Main question', { agent: 'prime' }), answer(2, 'Main answer'), ask(3, 'Unattributed question'), answer(4, 'Unattributed answer')],
      true, [], [], { developerMode: true });
    w.document.querySelector<HTMLButtonElement>('#chatAgentFilter [data-agent="prime"]')!.click(); await settle();
    expect(press(w, 'ArrowUp')).toBe(true);
    expect(composer(w).value).toBe('Main question');
    expect(press(w, 'ArrowUp')).toBe(false);
  });

  // A recalled message ending in a slash or @file fragment opens that menu; its arrows stay the menu's.
  it('leaves the arrows to an open slash menu with no matches after a recall', async () => {
    const { w } = await boot([ask(1, 'First question'), answer(2, 'First answer'), ask(3, 'Use /zzz'), answer(4, 'Done.')]);
    (w as any).api.skillLibrary = async () => ({ ok: true, data: { skills: [], roots: [], errors: [], includeInstructions: true } });
    press(w, 'ArrowUp'); press(w, 'ArrowUp');
    composer(w).setSelectionRange(14, 14);
    expect(press(w, 'ArrowDown')).toBe(true); await settle();
    expect(composer(w).value).toBe('Use /zzz');
    expect(w.document.getElementById('skillPicker')!.hidden).toBe(false);
    expect(press(w, 'ArrowDown')).toBe(false);
    expect(composer(w).value).toBe('Use /zzz');
  });

  it('keeps a refused recalled message in the composer when ArrowDown is pressed', async () => {
    const { w } = await boot(chat());
    expect(press(w, 'ArrowUp')).toBe(true);
    (w as any).api.sendInput = async () => ({ ok: false, error: 'Not delivered' });
    w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await settle();
    expect(composer(w).value).toBe('Second question');
    expect(press(w, 'ArrowDown')).toBe(false);
    expect(composer(w).value).toBe('Second question');
  });

  it('moves the caret through a recalled message of several lines before going further back', async () => {
    const { w } = await boot([ask(1, 'First question'), answer(2, 'First answer'), ask(3, 'Line one\nLine two'), answer(4, 'Done.')]);
    press(w, 'ArrowUp');
    expect(composer(w).value).toBe('Line one\nLine two');
    composer(w).setSelectionRange(17, 17);
    expect(press(w, 'ArrowUp')).toBe(false);
    composer(w).setSelectionRange(0, 0);
    expect(press(w, 'ArrowUp')).toBe(true);
    expect(composer(w).value).toBe('First question');
  });

  // A long one-line message wraps onto several rows: only its very start or end hands the arrows
  // back to recall, so a lower or upper wrapped row still moves the caret.
  it.each([['ArrowUp', 40], ['ArrowDown', 40], ['ArrowUp', 'end'], ['ArrowDown', 0]] as const)('leaves %s to the caret inside a long recalled prompt (caret at %s)', async (key, at) => {
    const long = 'Summarize the release notes for every package in the workspace and group them by area';
    const { w } = await boot([ask(1, 'First question'), answer(2, 'First answer'), ask(3, long), answer(4, 'Done.')]);
    press(w, 'ArrowUp');
    const caret = at === 'end' ? long.length : at;
    composer(w).setSelectionRange(caret, caret);
    expect(press(w, key)).toBe(false);
    expect(composer(w).value).toBe(long);
  });

  // The slash/file menu reads the caret on the input event, so the caret must already be at the start.
  it('opens no slash menu for a message ending in /… that ArrowUp recalls with the caret at the start', async () => {
    const { w } = await boot([ask(1, 'First question'), answer(2, 'First answer'), ask(3, 'Use /zzz'), answer(4, 'Done.')]);
    (w as any).api.skillLibrary = async () => ({ ok: true, data: { skills: [], roots: [], errors: [], includeInstructions: true } });
    expect(press(w, 'ArrowUp')).toBe(true);
    expect(composer(w).value).toBe('Use /zzz');
    expect(composer(w).selectionStart).toBe(0);
    expect(w.document.getElementById('skillPicker')!.hidden).toBe(true);
    await settle();
    expect(w.document.getElementById('skillPicker')!.hidden).toBe(true);
  });

  it('keeps its place when a message is recorded while you page through recall', async () => {
    const { w, append } = await boot(chat());
    expect(press(w, 'ArrowUp')).toBe(true);
    await append([ask(7, 'Third question'), answer(8, 'Third answer')]);
    expect(composer(w).value).toBe('Second question');
    expect(press(w, 'ArrowUp')).toBe(true);
    expect(composer(w).value).toBe('First question');
    composer(w).setSelectionRange(14, 14);
    expect(press(w, 'ArrowDown')).toBe(true);
    expect(composer(w).value).toBe('Second question');
    expect(press(w, 'ArrowDown')).toBe(true);
    expect(composer(w).value).toBe('');
    // A new recall starts from the newest message again.
    expect(press(w, 'ArrowUp')).toBe(true);
    expect(composer(w).value).toBe('Third question');
  });

  it.each([
    ['a Goal continue', { finishOwner: { turnId: 't5', periodic: false, mode: 'goal' } }],
    ['a Goal check you asked for', { finishOwner: { turnId: 't5', periodic: false, mode: 'goal', userRequested: true } }],
    ['a Loop continue', { finishOwner: { turnId: 't5', periodic: true, mode: 'loop' } }],
    ['a fresh-turn continue', { authoredSource: 'none', purpose: 'rotation' }],
    ['a recovery continue', { recovery: { questionId: 'q-5', pro: false, busyUntil: 0, phase: 'resumed' } }],
    ['a plan stage', { authoredSource: 'none', mode: 'finish' }]
  ] as const)('skips %s, which the app wrote', async (_, extra) => {
    const { w, live, append } = await boot([...chat(), ask(7, 'Continue with the next step'), answer(8, 'Next step done.')]);
    live.inputs = [sentInput('q-5'), sentInput('q-7', extra as Partial<InputEntry>)]; await append([]);
    expect(press(w, 'ArrowUp')).toBe(true);
    expect(composer(w).value).toBe('Second question');
  });

  it('recalls a correction sent together with the next queued checkpoint', async () => {
    const { w, live, append } = await boot([...chat(), ask(7, 'Use the staging database'), answer(8, 'Switched.')]);
    live.inputs = [sentInput('q-7', { id: 'correction', companionInputId: 'checkpoint' }), sentInput('q-7', { id: 'checkpoint', authoredSource: 'none', mode: 'finish' })];
    await append([]);
    expect(press(w, 'ArrowUp')).toBe(true);
    expect(composer(w).value).toBe('Use the staging database');
  });

  it('skips the tasks of a worker chat but recalls what you typed there', async () => {
    const { w, live, append } = await boot(chat(), true, [], [], { origin: { kind: 'worker', fromSessionId: null, agentId: 'worker-1', task: 'Inspect' } });
    expect(press(w, 'ArrowUp')).toBe(false);
    expect(composer(w).value).toBe('');
    live.inputs = [sentInput('q-5')]; await append([]);
    expect(press(w, 'ArrowUp')).toBe(true);
    expect(composer(w).value).toBe('Second question');
    expect(press(w, 'ArrowUp')).toBe(false);
  });

  it('skips a worker task the agent filter shows', async () => {
    const { w } = await boot([ask(1, 'Main question', { agent: 'prime' }), answer(2, 'Main answer'), ask(3, 'Inspect the parser', { agent: 'worker-1' }), answer(4, 'Inspected.')],
      true, [], [], { developerMode: true });
    w.document.querySelector<HTMLButtonElement>('#chatAgentFilter [data-agent="worker-1"]')!.click(); await settle();
    expect(press(w, 'ArrowUp')).toBe(false);
    expect(composer(w).value).toBe('');
  });

  it('announces each recalled message to screen readers, and nothing once it ends', async () => {
    const { w } = await boot(chat());
    const region = w.document.getElementById('recallAnnounce')!;
    expect(region.getAttribute('aria-live')).toBe('polite');
    press(w, 'ArrowUp');
    expect(region.textContent).toBe('Second question');
    press(w, 'ArrowUp');
    expect(region.textContent).toBe('First question');
    composer(w).setSelectionRange(14, 14);
    press(w, 'ArrowDown'); press(w, 'ArrowDown');
    expect(composer(w).value).toBe('');
    expect(region.textContent).toBe('');
    press(w, 'ArrowUp');
    expect(region.textContent).toBe('Second question');
    composer(w).value = 'Second question, shorter please';
    composer(w).dispatchEvent(new w.Event('input', { bubbles: true }));
    expect(region.textContent).toBe('');
  });

  it('ends a recall when the agent filter changes', async () => {
    const { w } = await boot([ask(1, 'Main question', { agent: 'prime' }), answer(2, 'Main answer'), ask(3, 'Unattributed question'), answer(4, 'Unattributed answer')],
      true, [], [], { developerMode: true });
    expect(press(w, 'ArrowUp')).toBe(true);
    expect(composer(w).value).toBe('Unattributed question');
    w.document.querySelector<HTMLButtonElement>('#chatAgentFilter [data-agent="prime"]')!.click(); await settle();
    expect(press(w, 'ArrowUp')).toBe(false);
    expect(composer(w).value).toBe('Unattributed question');
  });

  it('leaves an arrow to a slash menu that was showing, even when the caret moved off its fragment', async () => {
    const { w } = await boot([ask(1, 'First question'), answer(2, 'First answer'), ask(3, 'Use /zzz'), answer(4, 'Done.')]);
    (w as any).api.skillLibrary = async () => ({ ok: true, data: { skills: [], roots: [], errors: [], includeInstructions: true } });
    press(w, 'ArrowUp'); press(w, 'ArrowUp');
    composer(w).setSelectionRange(14, 14);
    expect(press(w, 'ArrowDown')).toBe(true); await settle();
    expect(w.document.getElementById('skillPicker')!.hidden).toBe(false);
    // Home moves the caret without an input event; the menu is still on screen.
    composer(w).setSelectionRange(0, 0);
    expect(press(w, 'ArrowUp')).toBe(false);
    expect(composer(w).value).toBe('Use /zzz');
  });

  it('reads out the same message again when it is recalled in the next chat', async () => {
    const other = { ...summary([]), id: '2026-10-17-other001', title: 'Other chat' };
    const { w } = await boot(chat(), true, [], [], { sessions: [summary(chat()), other] });
    const region = w.document.getElementById('recallAnnounce')!;
    press(w, 'ArrowUp');
    expect(region.textContent).toBe('Second question');
    (w.document.querySelector(`#sessionList [data-id="${other.id}"]`) as HTMLElement).click(); await settle();
    // The other chat's empty composer: the region must change before the same text can be read again.
    expect(region.textContent).toBe('');
    expect(press(w, 'ArrowUp')).toBe(true);
    expect(region.textContent).toBe('Second question');
  });

  it('leaves the arrows to the caret until the outbox has been read', async () => {
    let release!: () => void;
    const { w, live } = await boot([...chat(), ask(7, 'Continue with the next step'), answer(8, 'Next step done.')], true, [], [], { holdInputs: new Promise<void>(resolve => { release = resolve; }) });
    // Without the outbox the Goal continue would count as typed.
    expect(press(w, 'ArrowUp')).toBe(false);
    expect(composer(w).value).toBe('');
    live.inputs = [sentInput('q-5'), sentInput('q-7', { finishOwner: { turnId: 't5', periodic: false, mode: 'goal' } })];
    release(); await settle();
    expect(press(w, 'ArrowUp')).toBe(true);
    expect(composer(w).value).toBe('Second question');
  });

  it('skips an app send whose row this window read before its receipt, by the recorded input id', async () => {
    const { w, live, append } = await boot([...chat(), ask(7, 'Continue with the next step', { inputId: 'goal-row' }), answer(8, 'Next step done.')]);
    live.inputs = [sentInput('q-5'), sentInput('q-7', { id: 'goal-row', state: 'browser', messageId: undefined, deliveredAt: undefined, finishOwner: { turnId: 't5', periodic: false, mode: 'goal' } })];
    await append([]);
    expect(press(w, 'ArrowUp')).toBe(true);
    expect(composer(w).value).toBe('Second question');
  });

  it.each([
    ['a fresh-turn continue', 'Continue the task from where you are. (Chat On Steroids starts a fresh turn so the reply is not cut off.)'],
    ['a Goal continue', 'Continue with the next step of the Goal.']
  ])('skips %s whose row the outbox no longer keeps', async (_, value) => {
    // The recorder keeps the input id and the sent text on the message, whoever wrote it.
    const { w, live, append } = await boot([...chat(), ask(7, value, { inputId: 'trimmed-row', inputDelivery: 'confirmed', authoredText: value }), answer(8, 'Next step done.')]);
    live.inputs = [sentInput('q-5')]; await append([]);
    expect(press(w, 'ArrowUp')).toBe(true);
    expect(composer(w).value).toBe('Second question');
  });

  // Mac release round, 2026-10-19: a Goal follow-up came back first. Its page types it, so it has
  // no outbox row or input id at all; the recorder marks it `automatic` instead.
  it('skips a Goal or Loop follow-up its page typed', async () => {
    const { w, live, append } = await boot([...chat(), ask(7, 'Continue with step two of the goal', { automatic: true }), answer(8, 'Step two done.')]);
    live.inputs = [sentInput('q-5')]; await append([]);
    expect(press(w, 'ArrowUp')).toBe(true);
    expect(composer(w).value).toBe('Second question');
  });
});

// "Show message times" (2026-10-30): a message's time reads as hours and minutes, the full date and
// seconds on hover.
it('labels each message with its hour and minute, and the full date in its title', async () => {
  const at = T0 + 3_723_000;
  const { w } = await boot([
    { seq: 1, time: at, source: 'extension', kind: 'user_message', turnId: 't1', message: { text: 'Hello', chars: 5, truncated: false } } as any
  ]);
  const time = await waitFor(() => { const node = w.document.querySelector('.ev-user_message > time'); expect(node).toBeTruthy(); return node!; });
  expect(time.textContent).toBe(new Date(at).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' }));
  expect(time.getAttribute('title')).toBe(new Date(at).toLocaleString('en'));
  expect(time.getAttribute('datetime')).toBe(new Date(at).toISOString());
});

// CodeRabbit on #1948: a damaged saved time never breaks the chat; a message shows when it was written
// (the page's own time) over when the app saw it; and the time follows a language change.
it('keeps a damaged time from breaking the chat, shows when a message was written, and follows the language', async () => {
  const written = T0 + 60_000;
  const { w } = await boot([
    { seq: 1, time: 1e20, source: 'extension', kind: 'user_message', turnId: 't1', message: { text: 'Hello', chars: 5, truncated: false } } as any,
    { seq: 2, time: T0 + 3_600_000, authoredAt: written, source: 'extension', kind: 'assistant_message', turnId: 't1', messageId: 'answer-1',
      final: true, state: 'final', message: { text: 'Answer', chars: 6, truncated: false } } as any
  ]);
  const answerTime = await waitFor(() => { const node = w.document.querySelector('.ev-assistant_message > time'); expect(node).toBeTruthy(); return node!; });
  const damaged = w.document.querySelector('.ev-user_message > time')!;
  expect(w.document.querySelector('.ev-user_message .said')).toBeTruthy();
  expect([damaged.textContent, damaged.getAttribute('title'), damaged.getAttribute('datetime')]).toEqual(['', null, null]);
  expect(answerTime.textContent).toBe(new Date(written).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' }));
  expect(answerTime.getAttribute('aria-label')).toBe(new Date(written).toLocaleString('en'));
  const language = w.document.getElementById('uiLanguage') as HTMLSelectElement;
  language.value = 'de';
  language.dispatchEvent(new w.Event('change', { bubbles: true }));
  expect(answerTime.textContent).toBe(new Date(written).toLocaleTimeString('de', { hour: 'numeric', minute: '2-digit' }));
  expect(answerTime.getAttribute('title')).toBe(new Date(written).toLocaleString('de'));
});

// 2.1.49 round: answers carry ChatGPT's own time, questions the app's. Mixed, an answer could read a
// minute before its question. Live rows keep the app's clock; only a message the app saw long after
// it was written (after a reload) shows when it was written.
it('keeps one clock for live rows and shows the written time only for a message seen much later', async () => {
  const question = T0 + 62_000, answerWritten = T0 + 58_000;
  const { w } = await boot([
    { seq: 1, time: question, source: 'extension', kind: 'user_message', turnId: 't1', message: { text: 'Hello', chars: 5, truncated: false } } as any,
    { seq: 2, time: question + 3_000, authoredAt: answerWritten, source: 'extension', kind: 'assistant_message', turnId: 't1', messageId: 'answer-1',
      final: true, state: 'final', message: { text: 'Answer', chars: 6, truncated: false } } as any
  ]);
  const clock = (at: number) => new Date(at).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });
  const answer = await waitFor(() => { const node = w.document.querySelector('.ev-assistant_message > time'); expect(node).toBeTruthy(); return node!; });
  expect(answer.textContent).toBe(clock(question + 3_000));
  expect(w.document.querySelector('.ev-user_message > time')!.textContent).toBe(clock(question));
});

// CodeRabbit on #1958: a computer clock minutes behind ChatGPT's makes the written time later than
// the seen one; that is not a message seen late, so the row keeps the app's clock.
it('keeps the app clock when ChatGPT reports a written time later than the app saw the message', async () => {
  const seen = T0 + 62_000;
  const { w } = await boot([
    { seq: 1, time: seen, source: 'extension', kind: 'user_message', turnId: 't1', message: { text: 'Hello', chars: 5, truncated: false } } as any,
    { seq: 2, time: seen + 3_000, authoredAt: seen + 6 * 60_000, source: 'extension', kind: 'assistant_message', turnId: 't1', messageId: 'answer-1',
      final: true, state: 'final', message: { text: 'Answer', chars: 6, truncated: false } } as any
  ]);
  const clock = (at: number) => new Date(at).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });
  const answer = await waitFor(() => { const node = w.document.querySelector('.ev-assistant_message > time'); expect(node).toBeTruthy(); return node!; });
  expect(answer.textContent).toBe(clock(seen + 3_000));
});
