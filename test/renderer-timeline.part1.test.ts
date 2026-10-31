import { describe, expect, it, vi } from 'vitest';
import { T0, boot, settle, settleHistoryFrame, summary, text, toolCall, waitFor, type Handoff, type InputEntry, type LocalProject, type SessionEvent, type SessionSummary } from './renderer-timeline.harness.js';

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


it('ignores a pointer release when the timeline owns no pointer press', async () => {
  const { w } = await boot([]);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  w.dispatchEvent(new w.MouseEvent('pointerup'));
  expect(error).not.toHaveBeenCalled();
});

it('makes parent and worker session selectors keyboard-focusable and activates them with Enter/Space', async () => {
  const parent: SessionSummary = { ...summary([]), id: 'parent-session', title: 'Parent', conversationId: 'parent-chat', chatIds: ['parent-chat'] };
  const worker: SessionSummary = { ...summary([]), id: 'worker-session', title: 'Worker', conversationId: 'worker-chat', chatIds: ['worker-chat'],
    origin: { kind: 'worker', fromSessionId: parent.id, agentId: 'worker-1', task: 'Inspect' } };
  const { w } = await boot([], false, [], [], { sessions: [parent, worker] });
  const parentControl = w.document.querySelector<HTMLElement>(`[data-id="${parent.id}"] [data-session-select]`)!;
  expect(parentControl.getAttribute('role')).toBe('button');
  expect(parentControl.tabIndex).toBe(0);
  parentControl.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle();
  expect(w.document.querySelector(`.sess.is-sel[data-id="${parent.id}"]`)).not.toBeNull();

  (w.document.querySelector(`[data-id="${parent.id}"] .worker-toggle`) as HTMLButtonElement).click();
  await settle();
  const workerControl = w.document.querySelector<HTMLElement>(`[data-id="${worker.id}"] [data-session-select]`)!;
  expect(workerControl.tabIndex).toBe(0);
  const activate = new w.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
  workerControl.dispatchEvent(activate);
  expect(activate.defaultPrevented).toBe(true);
  await settle();
  expect(w.document.querySelector(`.sess.is-sel[data-id="${worker.id}"]`)).not.toBeNull();
});

it('shows elapsed runtime and stops the owned background process from the dock', async () => {
  const { w, publishBackgroundProcesses } = await boot([]);
  await publishBackgroundProcesses([{
    processId: 4101,
    incarnation: 91,
    command: 'npm run dev',
    startedAt: Date.now() - 90_000,
    tty: false
  }]);
  const row = w.document.getElementById('backgroundExecStatus')!;
  expect(row.hidden).toBe(false);
  expect(row.querySelector('.background-exec-time')?.textContent).toMatch(/^Running for 1m 3\ds$/);
  const stop = row.querySelector<HTMLButtonElement>('.background-exec-stop')!;
  expect(stop.textContent).toContain('Stop');
  stop.click();
  await settle();
  expect((w as any).api.stopProcess).toHaveBeenCalledWith(summary([]).id, 4101, 91);
  expect(row.hidden).toBe(true);
});

it('expands multiple background processes and stops each one from its own row', async () => {
  const { w, publishBackgroundProcesses } = await boot([]);
  const startedAt = Date.now() - 45_000;
  await publishBackgroundProcesses([
    { processId: 4201, incarnation: 101, command: 'npm run watch', startedAt, tty: false },
    { processId: 4202, incarnation: 102, command: 'node server.js', startedAt: startedAt + 5_000, tty: true },
    { processId: 4203, incarnation: 103, command: 'npm run worker', startedAt: startedAt + 10_000, tty: false }
  ]);
  const summaryRow = w.document.getElementById('backgroundExecStatus')!;
  const list = w.document.getElementById('backgroundExecList')!;
  expect(summaryRow.hidden).toBe(false);
  expect(summaryRow.getAttribute('role')).toBe('button');
  expect(summaryRow.getAttribute('aria-expanded')).toBe('false');
  expect(summaryRow.getAttribute('aria-controls')).toBe('backgroundExecList');
  expect((w.document.getElementById('backgroundExecLiveStatus') as HTMLElement).hidden).toBe(false);
  expect(w.document.getElementById('backgroundExecLiveStatus')?.textContent).toContain('3 background processes running');
  expect(summaryRow.querySelector('.queue-label')?.textContent).toBe('3 background processes running');
  expect(summaryRow.querySelector('.queue-label')?.textContent).not.toContain('npm run watch');
  expect(summaryRow.querySelector<HTMLButtonElement>('.background-exec-stop')!.hidden).toBe(true);
  expect(list.hidden).toBe(true);

  summaryRow.click();
  expect(summaryRow.getAttribute('aria-expanded')).toBe('true');
  expect(list.hidden).toBe(false);
  const processRows = [...list.querySelectorAll<HTMLElement>('.background-exec-process')];
  expect(processRows).toHaveLength(3);
  expect(processRows[0]?.textContent).toContain('#4201 npm run watch');
  expect(processRows[1]?.textContent).toContain('#4202 node server.js');
  expect(processRows[2]?.textContent).toContain('#4203 npm run worker');
  expect(processRows[0]?.querySelector('.background-exec-process-time')?.textContent).toMatch(/^Running for 4\ds$/);
  expect(processRows[0]?.querySelector('.background-exec-stop')?.getAttribute('aria-label')).toContain('#4201 npm run watch');
  expect(processRows[1]?.querySelector('.background-exec-stop')?.getAttribute('aria-label')).toContain('#4202 node server.js');

  const secondStop = processRows[1]!.querySelector<HTMLButtonElement>('.background-exec-stop')!;
  secondStop.focus();
  secondStop.click();
  expect(w.document.activeElement).toBe(secondStop);
  await settle();
  expect((w as any).api.stopProcess).toHaveBeenCalledWith(summary([]).id, 4202, 102);
  expect(w.document.activeElement).toBe(summaryRow);
  expect(summaryRow.querySelector('.queue-label')?.textContent).toBe('2 background processes running');
  expect(summaryRow.getAttribute('role')).toBe('button');
  expect(summaryRow.getAttribute('aria-expanded')).toBe('true');
  expect(list.hidden).toBe(false);
  expect(list.querySelectorAll('.background-exec-process')).toHaveLength(2);
});

it('does not restore background-process Stop focus after navigating away and back', async () => {
  const { w, publishBackgroundProcesses, resolveBackgroundStop } = await boot([], true, [], [], { deferProcessStop: true });
  const startedAt = Date.now() - 30_000;
  await publishBackgroundProcesses([
    { processId: 4301, incarnation: 111, command: 'npm run watch', startedAt, tty: false },
    { processId: 4302, incarnation: 112, command: 'node server.js', startedAt: startedAt + 5_000, tty: false }
  ]);
  const summaryRow = w.document.getElementById('backgroundExecStatus')!;
  summaryRow.click();
  const stop = w.document.querySelectorAll<HTMLButtonElement>('#backgroundExecList .background-exec-stop')[1]!;
  stop.focus();
  stop.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
  await settle();
  expect((w as any).api.stopProcess).toHaveBeenCalledWith(summary([]).id, 4302, 112);

  (w.document.getElementById('newChat') as HTMLButtonElement).click();
  await settle();
  (w.document.querySelector('#sessionList [data-id] [data-session-select]') as HTMLElement).click();
  await settle();
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.focus();
  resolveBackgroundStop();
  await settle();
  expect(w.document.activeElement).toBe(input);
});

it('stacks a running process row with queued plan tasks above the composer', async () => {
  const { w, live, append, publishBackgroundProcesses } = await boot([]);
  await publishBackgroundProcesses([{ processId: 4201, incarnation: 92, command: 'npm run dev', startedAt: Date.now() - 5_000, tty: false }]);
  live.inputs.push(...Array.from({ length: 5 }, (_, index) => ({
    id: `plan-stage-${index}`, sessionId: summary([]).id, text: `Plan task ${index + 1}`, mode: 'after-turn' as const, dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued' as const, owner: null, createdAt: Date.now() + index, conversationId: 'chat-b'
  })));
  await append([]);
  const processRow = w.document.getElementById('backgroundExecStatus')!;
  const queue = w.document.getElementById('finishQueue')!;
  const dock = w.document.querySelector('.composer-dock-body')!;
  expect(processRow.hidden).toBe(false);
  expect(queue.hidden).toBe(false);
  expect(queue.querySelectorAll('.queued-input')).toHaveLength(5);
  expect(queue.textContent).toContain('Plan task 5');
  const visible = [...dock.children].filter(node => !(node as HTMLElement).hidden);
  expect(visible).toContain(processRow);
  expect(visible).toContain(queue);
  expect(visible.indexOf(processRow)).toBeLessThan(visible.indexOf(queue));
});

it('keeps legacy Files, Agents and Review toggles out of the chat while dock controls remain available', async () => {
  const project: LocalProject = { id: '33333333-3333-4333-8333-333333333333', name: 'Workspace', path: '/workspace', createdAt: T0 };
  const { w } = await boot([], false, [], [project]);
  const chat = w.document.querySelector('[data-panel="chat"]')!;
  expect(chat.querySelectorAll('#filePanelToggle, #agentPanelToggle, .file-panel-toggle')).toHaveLength(0);
  expect([...chat.children].filter(node => node.tagName === 'BUTTON')).toHaveLength(0);
  expect(w.document.getElementById('rightDockToggle')).not.toBeNull();
  expect(w.document.getElementById('terminalToggle')).not.toBeNull();
  w.document.getElementById('rightDockToggle')!.click();
  expect(w.document.getElementById('workDockRight')?.hidden).toBe(false);
});

it('patches native reactions in place and hides streamed envelopes without changing authored messages', async () => {
  const user: SessionEvent = { kind: 'user_message', seq: 1, origin: 1, time: T0, source: 'extension', messageId: 'reaction-user', message: text('Question') };
  const answer: SessionEvent = { kind: 'assistant_message', seq: 2, time: T0 + 1, source: 'extension', messageId: 'reaction-answer', message: text('\uE200message_'), final: false };
  const { w, append } = await boot([user, answer]);
  const bubble = w.document.querySelector('.said.is-user')!;
  expect(w.document.querySelector<HTMLElement>('.ev-assistant_message')!.hidden).toBe(true);
  for (const [index, reaction] of ['😂', '❤️', null].entries()) {
    await append([{ ...user, seq: index + 3, origin: 1, reaction }]);
    expect(w.document.querySelector('.said.is-user')).toBe(bubble);
    expect(w.document.querySelector('.message-reaction')?.textContent ?? null).toBe(reaction);
  }
  expect(bubble.textContent).toContain('Question');
  await append([{ ...answer, seq: 7, origin: 2, message: text('\uE200message_reaction\uE202😂\uE201\nThe answer.'), final: true }]);
  expect(w.document.querySelector('.ev-assistant_message .msg')?.textContent?.trim()).toBe('The answer.');
  expect(w.document.querySelector('.message-reaction')).toBeNull(); // Never infer a target from adjacency.
});

it('keeps a reaction on the native question across 100 interim messages, tool calls and injected corrections', async () => {
  const question: SessionEvent = { kind: 'user_message', seq: 1, origin: 1, time: T0, source: 'extension',
    messageId: 'native-question', message: text('Original native question'), reaction: '👀' };
  const middle: SessionEvent[] = Array.from({ length: 100 }, (_, i) => ({ kind: 'assistant_message', seq: i + 2,
    time: T0 + i + 1, source: 'extension', messageId: `interim-${i}`, message: text(`Update ${i}`), final: false }));
  const tools = Array.from({ length: 15 }, (_, i) => ({ ...toolCall(i + 102, `call-${i}`), time: T0 + i + 101 }));
  const injected: SessionEvent = { kind: 'user_message', seq: 117, time: T0 + 116, source: 'app', messageId: 'input:correction',
    inputId: 'correction', inputDelivery: 'confirmed', message: text('An injected correction') };
  const final: SessionEvent = { kind: 'assistant_message', seq: 118, time: T0 + 117, source: 'extension', messageId: 'final',
    message: text('\uE200message_reaction\uE202👀\uE201\nFinished.'), final: true };
  const { w } = await boot([question, ...middle, ...tools, injected, final]);
  const correction = [...w.document.querySelectorAll('.said.is-user')].find(node => node.textContent?.includes('An injected correction'))!;
  expect(correction.querySelector('.message-reaction')).toBeNull();
  expect(w.document.querySelector('.message-reaction')).toBeNull(); // The native question is on an older page.
  const pane = w.document.getElementById('chatBody')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 }, scrollHeight: { value: 10000 } });
  for (let page = 0; page < 3; page++) {
    pane.scrollTop = 0;
    pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 }));
    await settleHistoryFrame(w);
  }
  const badges = [...w.document.querySelectorAll('.message-reaction')];
  expect(badges).toHaveLength(1);
  expect(badges[0]!.closest('.said')!.textContent).toContain('Original native question');
  expect(w.document.getElementById('timeline')!.textContent).not.toContain('message_reaction');
});

it.each(['compaction', 'blocked', 'worker'])('retires %s control status when leaving its session, including late IPC and locale refresh', async kind => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  const controls = { sessionId: summary([]).id, automation: 'off', objective: '',
    blocked: kind === 'compaction' ? '' : kind, job: kind === 'compaction' ? { busy: true } : null };
  api.getSessionControls = async () => ({ ok: true, data: controls });
  await append([]);
  const status = w.document.getElementById('sessionControlStatus')!;
  expect(status.textContent).not.toBe('');
  let release!: (value: unknown) => void;
  api.getSessionControls = () => new Promise(resolve => { release = resolve; });
  await append([]);
  // An ordinary refresh of the same selected owner retains its last known status.
  expect(status.textContent).not.toBe('');
  w.document.getElementById('newChat')!.click();
  expect(status.textContent).toBe('');
  expect(w.document.getElementById('compactSession')!.hidden).toBe(true);
  expect(w.document.getElementById('cancelCompaction')!.hidden).toBe(true);
  release({ ok: true, data: controls }); await settle();
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('zh-CN');
  expect(status.textContent).toBe('');
  setLanguage('en');
  // Returning to A is a new selection epoch; only its new read may restore status.
  (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click();
  expect(status.textContent).toBe('');
  release({ ok: true, data: controls }); await settle();
  expect(status.textContent).not.toBe('');
});

it('localizes only the exact app-authored Goal helper stop note at draw time', async () => {
  const source = 'The helper says the goal is met, but this has not been checked. No follow-up was sent. Review the chat and continue if work remains.';
  const rows = [
    { progressId: 'goal-helper-stop:turn-1', source: 'app' as const, value: source },
    { progressId: 'unrelated:turn-1', source: 'app' as const, value: source },
    { progressId: 'goal-helper-stop:turn-2', source: 'app' as const, value: source + ' Historical detail.' },
    { progressId: 'goal-helper-stop:turn-3', source: 'extension' as const, value: source }
  ];
  const { w } = await boot(rows.map((row, at) => ({
    seq: at + 1, time: T0 + at, source: row.source, kind: 'progress' as const,
    progressId: row.progressId, message: text(row.value)
  })));
  const { setLanguage, t } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  const notes = [...w.document.querySelectorAll('.ev-progress .meta')];
  expect(notes.map(note => note.textContent)).toEqual([t(source), source, rows[2]!.value, source]);
  expect(notes[0]!.textContent).not.toBe(source);
  setLanguage('en');
  expect(notes.map(note => note.textContent)).toEqual(rows.map(row => row.value));
});

// 2.1.47 release round: tool rows were recorded in English and shown that way in every language.
it('shows a recorded tool row in the person\'s language, its path as recorded, and in English again when switched back', async () => {
  const read = toolCall(1, 'read-de') as Extract<SessionEvent, { kind: 'tool_call' }>;
  read.call.summary = { kind: 'read', title: 'Read src/app.ts', detail: 'lines 1–40', metric: '40 lines', tone: 'neutral' };
  const run = toolCall(2, 'run-de') as Extract<SessionEvent, { kind: 'tool_call' }>;
  run.call.tool = 'exec_command';
  run.call.summary = { kind: 'run', title: 'Could not run npm test', metric: '✕ exit 2', tone: 'bad' };
  const { w } = await boot([read, run]);
  const { setLanguage, t, tn } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  const heads = () => [...w.document.querySelectorAll('.ev-tool_call summary')].map(head => ({
    title: head.querySelector('b')?.textContent, detail: head.querySelector('em')?.textContent, metric: head.querySelector('.metric')?.textContent }));
  expect(heads()).toEqual([
    { title: t('Read {0}', ['src/app.ts']), detail: t('lines {0}–{1}', ['1', '40']), metric: tn('{0} line', '{0} lines', 40) },
    { title: t('Could not run {0}', ['npm test']), detail: undefined, metric: t('✕ exit {0}', ['2']) }
  ]);
  expect(heads()[0]!.title).toContain('src/app.ts');
  expect(heads()[0]!.title).not.toBe('Read src/app.ts');
  setLanguage('en');
  expect(heads()).toEqual([
    { title: 'Read src/app.ts', detail: 'lines 1–40', metric: '40 lines' },
    { title: 'Could not run npm test', detail: undefined, metric: '✕ exit 2' }
  ]);
});

it('asks for the selected chat\'s background tab once per switch (#1249)', async () => {
  const first = summary([]), second = { ...summary([]), id: '2026-09-02-test0002', title: 'Other session' };
  const { w } = await boot([], true, [], [], { sessions: [first, second] });
  const api = (w as any).api;
  const followed: string[] = [];
  api.followSessionTab = async (id: string) => { followed.push(id); return { ok: true, data: true }; };
  const row = (id: string) => w.document.querySelector<HTMLElement>(`#sessionList [data-id="${id}"]`)!;
  row(second.id).click();
  row(second.id).click();
  row(first.id).click();
  expect(followed).toEqual([second.id, first.id]);
});

it('clears control projections on an existing-session switch and fences A to B to A responses', async () => {
  const first = summary([]), second = { ...summary([]), id: '2026-09-02-test0002', title: 'Other session' };
  const { w, append } = await boot([], true, [], [], { sessions: [first, second] });
  const api = (w as any).api;
  const busy = { automation: 'off', objective: '', blocked: '', job: { busy: true },
    recovery: [{ kind: 'unattributed', deadline: Date.now() + 60_000 }] };
  api.getSessionControls = async () => ({ ok: true, data: busy });
  await append([]);
  const status = w.document.getElementById('sessionControlStatus')!;
  expect(status.textContent).toContain('Compaction');
  expect(w.document.getElementById('recoveryStatus')!.textContent).toContain('Reload in');
  const pending: Array<(value: unknown) => void> = [];
  api.getSessionControls = () => new Promise(resolve => pending.push(resolve));
  await append([]); // old A refresh
  (w.document.querySelector(`#sessionList [data-id="${second.id}"]`) as HTMLElement).click();
  expect(status.textContent).toBe('');
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(true);
  expect(w.document.getElementById('cancelCompaction')!.hidden).toBe(true);
  (w.document.querySelector(`#sessionList [data-id="${first.id}"]`) as HTMLElement).click();
  expect(pending).toHaveLength(3);
  pending[2]!({ ok: true, data: { ...busy, job: null, recovery: [] } }); await settle();
  pending[1]!({ ok: true, data: busy });
  pending[0]!({ ok: true, data: busy }); await settle();
  expect(status.textContent).toBe('');
  expect(w.document.getElementById('cancelCompaction')!.hidden).toBe(true);
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(true);
});

it('keeps the prior transcript inert until the selected detail arrives and fences A to B to A', async () => {
  const attachment = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'a-only.png', mimeType: 'image/png', size: 42, preview: 'data:image/webp;base64,YQ==' };
  const aEvents: SessionEvent[] = [
    { seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'a-question', message: text('A QUESTION'), attachments: [attachment] },
    { seq: 2, time: T0 + 1, source: 'extension', kind: 'assistant_message', messageId: 'a-answer', message: text('A ANSWER'), state: 'final', final: true }
  ];
  const first = { ...summary(aEvents), title: 'Session A', lastHandoffId: 'handoff-a' };
  const second = { ...summary([]), id: '2026-09-02-test0000', title: 'Session B', lastHandoffId: null };
  const saved: Handoff = { id: 'handoff-a', sessionId: first.id, createdAt: T0, text: 'A HANDOFF', sourceEvents: 2, sourceTokens: 10, notes: [] };
  const app = await boot(aEvents, true, [], [], { sessions: [first, second], handoff: saved });
  const { w } = app;
  const api = (w as any).api;
  api.getSessionControls = async () => ({ ok: true, data: { automation: 'off', objective: '', blocked: '', job: { busy: true }, recovery: [] } });
  await app.append([]);
  const timeline = w.document.getElementById('timeline')!;
  expect(w.document.getElementById('chatTitle')!.textContent).toBe('Session A');
  expect(timeline.textContent).toContain('A QUESTION');
  expect(timeline.querySelector('img[alt="a-only.png"]')).not.toBeNull();
  expect(w.document.getElementById('handoffBox')!.textContent).toContain('A HANDOFF');
  expect(w.document.getElementById('sessionControlStatus')!.textContent).toContain('Compaction');

  type Reply = (value: unknown) => void;
  const details: Array<{ id: string; reply: Reply }> = [];
  const controls: Array<{ id: string; reply: Reply }> = [];
  api.getSession = vi.fn((id: string) => new Promise(resolve => details.push({ id, reply: resolve })));
  api.getSessionControls = vi.fn((id: string) => new Promise(resolve => controls.push({ id, reply: resolve })));
  const detail = (sum: SessionSummary, rows: SessionEvent[]) => ({ ok: true, data: { summary: sum, events: rows, total: rows.length,
    nextFrom: rows.reduce((cursor, event) => Math.max(cursor, event.seq + 1), 0) } });

  // Begin an A refresh, then change ownership twice. A stale response cannot become current
  // merely because the selected id later returns to A.
  app.notifySession();
  await waitFor(() => expect(details.map(entry => entry.id)).toEqual([first.id]));
  (w.document.querySelector(`#sessionList [data-id="${second.id}"]`) as HTMLButtonElement).click();
  expect(w.document.getElementById('chatTitle')!.textContent).toBe('Session B');
  expect(timeline.textContent).toContain('A QUESTION');
  expect(timeline.querySelector('img[alt="a-only.png"]')).not.toBeNull();
  expect(timeline.hasAttribute('inert')).toBe(true);
  expect(timeline.getAttribute('aria-busy')).toBe('true');
  expect(w.document.getElementById('timelineEmpty')!.hidden).toBe(true);
  expect(w.document.getElementById('handoffBox')!.textContent).toBe('');
  expect(w.document.getElementById('sessionControlStatus')!.textContent).toBe('');
  await waitFor(() => expect(details.map(entry => entry.id)).toEqual([first.id, second.id]));
  // The queue read also repaints detail while the destination read remains pending.
  await settle();
  expect(timeline.textContent).toContain('A QUESTION');
  expect(w.document.getElementById('timelineEmpty')!.hidden).toBe(true);

  (w.document.querySelector(`#sessionList [data-id="${first.id}"]`) as HTMLButtonElement).click();
  expect(w.document.getElementById('chatTitle')!.textContent).toBe('Session A');
  expect(timeline.textContent).toContain('A QUESTION');
  await waitFor(() => expect(details.map(entry => entry.id)).toEqual([first.id, second.id, first.id]));

  const staleA: Extract<SessionEvent, { kind: 'user_message' }> = {
    seq: 4, time: T0 + 4, source: 'extension', kind: 'user_message', messageId: 'stale-a', message: text('STALE A QUESTION'), attachments: [attachment]
  };
  details[1]!.reply({ ok: false, error: 'B detail unavailable' });
  details[0]!.reply(detail(first, [staleA]));
  controls[0]!.reply({ ok: true, data: { automation: 'off', objective: '', blocked: '', job: { busy: true } } });
  controls[1]!.reply({ ok: true, data: { automation: 'off', objective: '', blocked: 'blocked', job: null } });
  await settle();
  expect(w.document.getElementById('chatTitle')!.textContent).toBe('Session A');
  expect(timeline.textContent).not.toContain('STALE A QUESTION');
  expect(timeline.textContent).toContain('A QUESTION');
  expect(timeline.hasAttribute('inert')).toBe(true);
  expect(w.document.getElementById('sessionControlStatus')!.textContent).toBe('');

  const current: SessionEvent[] = [{ seq: 3, time: T0 + 3, source: 'extension', kind: 'assistant_message', messageId: 'a-current', message: text('CURRENT A ANSWER'), state: 'final', final: true }];
  details[2]!.reply(detail(first, current));
  controls[2]!.reply({ ok: true, data: { automation: 'off', objective: '', blocked: '', job: null, recovery: [] } });
  await settle();
  expect(timeline.textContent).toContain('CURRENT A ANSWER');
  expect(timeline.textContent).not.toContain('STALE A QUESTION');
  expect(timeline.querySelector('img[alt="a-only.png"]')).toBeNull();
  expect(timeline.hasAttribute('inert')).toBe(false);
  expect(timeline.hasAttribute('aria-busy')).toBe(false);
  expect(w.document.getElementById('timelineEmpty')!.hidden).toBe(true);
});

it.each(['failed', 'empty', 'new-chat'] as const)('retires retained rows after a %s destination without a welcome flash', async outcome => {
  const rows: SessionEvent[] = [{ seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'a', message: text('Previous chat') }];
  const first = summary(rows), second = { ...summary([]), id: 'other', title: 'Other session' };
  const { w } = await boot(rows, true, [], [], { sessions: [first, second] });
  let reply!: (value: unknown) => void;
  (w as any).api.getSession = () => new Promise(resolve => { reply = resolve; });
  const timeline = w.document.getElementById('timeline')!;
  const welcome = w.document.getElementById('timelineEmpty')!;
  (w.document.querySelector(`#sessionList [data-id="${second.id}"]`) as HTMLElement).click();
  await settle();
  expect(timeline.textContent).toContain('Previous chat');
  expect(welcome.hidden).toBe(true);
  if (outcome === 'new-chat') w.document.getElementById('newChat')!.click();
  reply(outcome === 'failed' ? { ok: false, error: 'Read failed' } : { ok: true, data: { summary: second, events: [], total: 0, nextFrom: 0 } });
  await settle();
  expect(timeline.textContent).toBe('');
  expect(timeline.hasAttribute('inert')).toBe(false);
  expect(timeline.hasAttribute('aria-busy')).toBe(false);
  expect(welcome.hidden).toBe(outcome !== 'new-chat');
});

it('keeps the current transcript and handoff mounted when Write Directly focuses the same session', async () => {
  const attachment = { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', name: 'current.png', mimeType: 'image/png', size: 42, preview: 'data:image/webp;base64,YQ==' };
  const rows: SessionEvent[] = [
    { seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'current-question', message: text('CURRENT QUESTION'), attachments: [attachment] },
    toolCall(2, 'current-tool')
  ];
  const current = { ...summary(rows), title: 'Current session', lastHandoffId: 'current-handoff' };
  const saved: Handoff = { id: 'current-handoff', sessionId: current.id, createdAt: T0, text: 'CURRENT HANDOFF', sourceEvents: 2, sourceTokens: 10, notes: [] };
  const app = await boot(rows, true, [], [], { sessions: [current], handoff: saved });
  const { w } = app;
  const api = (w as any).api;
  let reject!: (value: unknown) => void;
  api.getSession = vi.fn(() => new Promise(resolve => { reject = resolve; }));

  app.writeSession(current.id);
  expect(w.document.activeElement).toBe(w.document.getElementById('chatInput'));
  expect(w.document.getElementById('chatTitle')!.textContent).toBe('Current session');
  expect(w.document.getElementById('timeline')!.textContent).toContain('CURRENT QUESTION');
  expect(w.document.querySelector('img[alt="current.png"]')).not.toBeNull();
  expect(w.document.querySelector('details.tool')?.textContent).toContain('Read README.md');
  expect(w.document.getElementById('handoffBox')!.textContent).toContain('CURRENT HANDOFF');
  expect(api.getSession).toHaveBeenCalledWith(current.id, { from: 3, limit: 30 });

  reject({ ok: false, error: 'same-session refresh unavailable' });
  await settle();
  expect(w.document.getElementById('timeline')!.textContent).toContain('CURRENT QUESTION');
  expect(w.document.getElementById('handoffBox')!.textContent).toContain('CURRENT HANDOFF');
});

it('reorders queued tasks by drag and keyboard through the durable IPC operation', async () => {
  const { w, live, append } = await boot([]);
  const sessionId = summary([]).id;
  for (const [index, label] of ['first', 'second'].entries()) live.inputs.push({
    id: `queue-${index}`, sessionId, text: label, mode: 'finish', dueAt: 0, model: null, reasoningEffort: null,
    state: 'queued', owner: null, createdAt: index, conversationId: 'chat-b'
  });
  const reorder = vi.fn(async () => ({ ok: true, data: true }));
  (w as any).api.reorderQueuedInputs = reorder;
  await append([]);
  let labels = w.document.querySelectorAll<HTMLElement>('#finishQueue .queue-label');
  expect(labels[0]!.draggable).toBe(true);
  labels[1]!.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
  await settle();
  expect(reorder).toHaveBeenCalledWith(sessionId, ['queue-1', 'queue-0']);
  const data = new Map<string, string>();
  const transfer = { setData: (key: string, value: string) => data.set(key, value), getData: (key: string) => data.get(key) ?? '', effectAllowed: '', dropEffect: '' };
  labels = w.document.querySelectorAll<HTMLElement>('#finishQueue .queue-label');
  const start = new w.Event('dragstart', { bubbles: true }); Object.defineProperty(start, 'dataTransfer', { value: transfer });
  labels[1]!.dispatchEvent(start);
  const drop = new w.MouseEvent('drop', { bubbles: true, cancelable: true, clientY: 0 }); Object.defineProperty(drop, 'dataTransfer', { value: transfer });
  labels[0]!.parentElement!.dispatchEvent(drop);
  await settle();
  expect(reorder).toHaveBeenCalledTimes(2);
});

it.each([false, true])('closes a saved queue editor while Save has focus (delayed refresh: %s)', async delayedRefresh => {
  const { w, live, append } = await boot([]);
  live.inputs.push({ id: 'edit-task', sessionId: summary([]).id, text: 'Before', mode: 'after-turn', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  (w.document.querySelector('[aria-label="Edit queued task"]') as HTMLButtonElement).click();
  const field = w.document.querySelector<HTMLTextAreaElement>('#finishQueue textarea')!;
  field.value = '  Saved task  ';
  const save = field.nextElementSibling as HTMLButtonElement;
  const edit = vi.fn(async () => { live.inputs[0]!.text = field.value.trim(); return { ok: true, data: true }; });
  (w as any).api.editQueuedInput = edit;
  // A refresh can wait on unrelated outbox work. Its completion is not the save receipt.
  if (delayedRefresh) (w as any).api.listInputs = () => new Promise(() => {});
  save.focus(); save.click(); await settle();
  expect(edit).toHaveBeenCalledWith('edit-task', '  Saved task  ');
  expect(w.document.querySelector('#finishQueue textarea')).toBeNull();
  expect(w.document.querySelector('#finishQueue .queue-label')?.textContent).toBe('Saved task');
});

it('keeps queue edits during refresh and allows only one pending save, retaining failed drafts', async () => {
  const { w, live, append } = await boot([]);
  live.inputs.push({ id: 'edit-task', sessionId: summary([]).id, text: 'Before', mode: 'finish', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  (w.document.querySelector('[aria-label="Edit queued task"]') as HTMLButtonElement).click();
  const field = w.document.querySelector<HTMLTextAreaElement>('#finishQueue textarea')!;
  field.value = 'Keep my edit';
  const save = field.nextElementSibling as HTMLButtonElement;
  let finish!: (result: unknown) => void;
  const edit = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  (w as any).api.editQueuedInput = edit;
  save.focus(); save.click(); save.click();
  expect(edit).toHaveBeenCalledTimes(1);
  expect(save.disabled).toBe(true);
  expect(save.textContent).toBe('Saving…');
  w.document.getElementById('chatInput')!.focus(); await append([]);
  expect(w.document.querySelector('#finishQueue textarea')).toBe(field);
  finish({ ok: false, error: 'Could not save this task' }); await settle();
  expect(field.value).toBe('Keep my edit'); expect(field.readOnly).toBe(false);
  expect(save.disabled).toBe(false); expect(save.textContent).toBe('Save');
  expect(w.document.body.textContent).toContain('Could not save this task');
});

it('shows ordinary after-turn messages in the task dock until actual delivery', async () => {
  const { w, live, append } = await boot([]);
  for (const [index, label] of ['Next task', 'Following task'].entries()) live.inputs.push({
    id: `after-${index}`, sessionId: summary([]).id, text: label, mode: 'after-turn', dueAt: 0,
    model: 'gpt-5.6-sol', reasoningEffort: 'high', state: 'queued', owner: null, createdAt: index, conversationId: 'chat-b'
  });
  await append([]);
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(2);
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Next task');
  live.inputs[0] = { ...live.inputs[0]!, state: 'sent', historyRecorded: true, messageId: 'after-message' };
  await append([{ seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'after-message', inputId: 'after-0', message: text('Next task') }]);
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(1);
  expect(w.document.getElementById('timeline')!.textContent).toContain('Next task');
});

it('identifies automatic Continue without user-task editing or reordering and keeps its cancellation', async () => {
  const { w, live, append } = await boot([]);
  const sessionId = summary([]).id;
  const recovery: InputEntry = { id: 'automatic-continue', sessionId, text: 'Resume the unfinished work.', mode: 'after-turn',
    dueAt: 0, model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b',
    recovery: { questionId: 'source-question', pro: false, busyUntil: Date.now() + 60_000, phase: 'ready' } };
  live.inputs.push(recovery, ...['first', 'second'].map((text, index): InputEntry => ({
    id: `authored-${index}`, sessionId, text, mode: 'after-turn', dueAt: 0, model: null, reasoningEffort: null,
    state: 'queued', owner: null, createdAt: index + 1, conversationId: 'chat-b'
  })));
  const api = (w as any).api;
  api.reorderQueuedInputs = vi.fn(async () => ({ ok: true, data: true }));
  await append([]);
  const card = w.document.querySelector<HTMLElement>('#finishQueue [data-input-id="automatic-continue"]')!;
  expect(card.textContent).toContain('Automatic Continue');
  expect(card.textContent).toContain(recovery.text);
  expect(card.querySelector<HTMLElement>('.queue-label')!.title).toContain('without a final answer');
  expect(card.querySelector('[aria-label="Edit queued task"]')).toBeNull();
  expect(card.querySelector('[draggable="true"]')).toBeNull();
  const second = w.document.querySelector('#finishQueue [data-input-id="authored-1"] .queue-label')!;
  second.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
  await settle();
  expect(api.reorderQueuedInputs).toHaveBeenCalledWith(sessionId, ['authored-1', 'authored-0']);
  w.document.querySelector<HTMLButtonElement>('#finishQueue [aria-label="Cancel automatic Continue"]')!.click();
  await settle();
  expect(api.cancelInput).toHaveBeenCalledWith(recovery.id);
  expect(live.inputs[0]!.state).toBe('cancelled');
  expect(w.document.querySelector('#finishQueue [data-input-id="automatic-continue"]')).toBeNull();
  expect(w.document.querySelectorAll('#finishQueue [aria-label="Edit queued task"]')).toHaveLength(2);
});

// #1826: a run of the chat's schedule says so in its queue row, and when it went out late.
it('labels a scheduled run in the queue, with when it was due when it is late', async () => {
  const { w, live, append } = await boot([]);
  const dueAt = new Date(2026, 9, 24, 9, 0).getTime();
  const run: InputEntry = { id: 'scheduled-run', sessionId: summary([]).id, text: 'Check the open issues', mode: 'auto',
    dueAt: 0, model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b',
    scheduled: { scheduleId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', dueAt, late: false } };
  live.inputs.push(run);
  await append([]);
  const label = () => w.document.querySelector('#inputQueue [data-input-id="scheduled-run"] .pending-message-origin')?.textContent;
  expect(label()).toBe('Scheduled');
  expect(w.document.querySelector('#inputQueue [data-input-id="scheduled-run"] .pending-message-text')?.textContent).toBe('Check the open issues');
  live.inputs[0] = { ...run, scheduled: { ...run.scheduled!, late: true } };
  await append([]);
  expect(label()).toBe(`Scheduled · late, was due ${new Date(dueAt).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}`);
  // Waiting for a running turn, the run is a task card that carries the same label.
  live.inputs[0] = { ...run, mode: 'after-turn' };
  await append([]);
  expect(w.document.querySelector('#finishQueue [data-input-id="scheduled-run"] .queue-label')?.textContent).toBe('Scheduled · Check the open issues');
});

// #1826: a sent run keeps its label in the chat, on time or late, and a typed message has none.
it('keeps the scheduled label on the sent message in the chat', async () => {
  const dueAt = new Date(2026, 9, 24, 9, 0).getTime();
  const sent: SessionEvent = { kind: 'user_message', seq: 1, origin: 1, time: T0, source: 'app', messageId: 'scheduled-sent', inputId: 'scheduled-run',
    message: text('Check the open issues'), scheduled: { dueAt, late: false } };
  const typed: SessionEvent = { kind: 'user_message', seq: 2, origin: 2, time: T0 + 1, source: 'app', messageId: 'typed', message: text('And this one?') };
  const { w, append } = await boot([sent, typed]);
  const labels = () => [...w.document.querySelectorAll('.said.is-user')].map(bubble => bubble.querySelector('.said-origin')?.textContent ?? null);
  expect(labels()).toEqual(['Scheduled', null]);
  await append([{ ...sent, seq: 3, origin: 1, scheduled: { dueAt, late: true } }]);
  expect(labels()).toEqual([`Scheduled · late, was due ${new Date(dueAt).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}`, null]);
});

// #1402: the app's own fresh-turn continue is no one's typed message. Waiting, it shows as the
// message it is; dropped, it raises no delivery notice, because the app tries again by itself.
it('shows a fresh-turn continue while it waits and raises no notice when it is dropped', async () => {
  const { w, live, append } = await boot([]);
  const rotation: InputEntry = { id: 'fresh-turn', sessionId: summary([]).id, text: 'Continue the task from where you are.', mode: 'auto',
    dueAt: 0, model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b', purpose: 'rotation' };
  live.inputs.push(rotation);
  await append([]);
  expect(w.document.querySelector('#inputQueue [data-input-id="fresh-turn"]')?.textContent).toContain('Continue the task');
  live.inputs[0] = { ...rotation, state: 'cancelled', error: 'Not sent: browser preparation timed out. This attempt was cancelled.' };
  await append([]);
  expect(w.document.querySelector('#inputQueue [data-input-id="fresh-turn"]')).toBeNull();
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Not sent');
});

it('keeps a transport-deferred immediate upload visible with cancellation instead of an invalid task editor', async () => {
  const { w, live, append } = await boot([]);
  live.inputs.push({ id: 'native-correction', sessionId: summary([]).id, text: 'Waiting upload', mode: 'after-turn', requestedMode: 'auto',
    dueAt: 0, model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b',
    attachments: [{ id: 'native-file', name: 'notes.txt', mimeType: 'text/plain', size: 12 }] });
  await append([]);
  const row = w.document.querySelector('#inputQueue [data-input-id="native-correction"]');
  expect(row?.textContent).toContain('Waiting upload');
  expect(row?.textContent).toContain('notes.txt');
  expect(w.document.querySelector('#finishQueue [data-input-id="native-correction"]')).toBeNull();
  (row!.querySelector('[aria-label="Cancel delivery"]') as HTMLButtonElement).click();
  await settle();
  expect(live.inputs[0]?.state).toBe('cancelled');
  expect(w.document.querySelector('[data-input-id="native-correction"]')).toBeNull();
});

it('keeps cancelled Continue attempts at their own times across a long session instead of stacking them under the current chat', async () => {
  const rows: SessionEvent[] = [0, 1, 2, 3].map(index => ({
    seq: index + 1, time: T0 + index * 60_000, source: 'extension', kind: 'user_message',
    messageId: `night-question-${index}`, message: text(`NIGHT QUESTION ${index}`)
  }));
  const { w, live, append } = await boot(rows);
  for (let index = 0; index < 3; index++) live.inputs.push({
    id: `retired-continue-${index}`, sessionId: summary(rows).id, text: `UNSENT CONTINUE ${index}`,
    mode: 'after-turn', dueAt: T0 + index * 60_000 + 1000, createdAt: T0 + index * 60_000 + 1000,
    model: null, reasoningEffort: null, state: 'cancelled', owner: null, conversationId: `old-chat-${index}`,
    error: 'Automatic Continue cancelled: the source turn, activity or setting changed.',
    recovery: { questionId: `night-question-${index}`, pro: false, busyUntil: T0 + index * 60_000 + 61_000, phase: 'ready' }
  });
  await append([]);
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('UNSENT CONTINUE');
  const timeline = w.document.getElementById('timeline')!;
  for (let index = 0; index < 3; index++) {
    const card = timeline.querySelector<HTMLElement>(`[data-input-id="retired-continue-${index}"]`)!;
    expect(card).not.toBeNull();
    expect(card.querySelector('time')?.textContent).toBe(new Date(live.inputs[index]!.createdAt).toLocaleString('en'));
    const content = timeline.textContent!;
    expect(content.indexOf(`NIGHT QUESTION ${index}`)).toBeLessThan(content.indexOf(`UNSENT CONTINUE ${index}`));
    expect(content.indexOf(`UNSENT CONTINUE ${index}`)).toBeLessThan(content.indexOf(`NIGHT QUESTION ${index + 1}`));
  }
});

it.each(['trash', 'empty-save'])('removes a queued message during editing via %s even while a refresh is delayed', async action => {
  const { w, live, append } = await boot([]);
  live.inputs.push({ id: 'remove-edit', sessionId: summary([]).id, text: 'Delete me', mode: 'after-turn', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  (w.document.querySelector('[aria-label="Edit queued task"]') as HTMLButtonElement).click();
  const field = w.document.querySelector<HTMLTextAreaElement>('#finishQueue textarea')!;
  (w as any).api.listInputs = () => new Promise(() => {});
  if (action === 'empty-save') field.value = ' \n\t ';
  const button = action === 'trash' ? w.document.querySelector('#finishQueue [aria-label="Remove queued task"]') : field.nextElementSibling;
  expect(button).not.toBeNull();
  (button as HTMLButtonElement).click(); await settle();
  expect((w as any).api.cancelInput).toHaveBeenCalledWith('remove-edit');
  expect(live.inputs[0]?.state).toBe('cancelled');
  expect(w.document.querySelector('#finishQueue textarea')).toBeNull();
  expect(w.document.getElementById('finishQueue')!.hidden).toBe(true);
});

it.each(['cancelled', 'browser'])('retires the editor when Save learns the queued message became %s', async state => {
  const { w, live, append } = await boot([]);
  live.inputs.push({ id: 'retired-edit', sessionId: summary([]).id, text: 'Original', mode: 'after-turn', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  (w.document.querySelector('[aria-label="Edit queued task"]') as HTMLButtonElement).click();
  const field = w.document.querySelector<HTMLTextAreaElement>('#finishQueue textarea')!;
  field.value = 'Late edit';
  (w as any).api.editQueuedInput = async () => {
    live.inputs[0]!.state = state as InputEntry['state'];
    return { ok: true, data: false };
  };
  (field.nextElementSibling as HTMLButtonElement).click(); await settle();
  expect(w.document.querySelector('#finishQueue textarea')).toBeNull();
  expect(live.inputs[0]?.text).toBe('Original');
  if (state === 'cancelled') expect(w.document.querySelector('#finishQueue [data-input-id="retired-edit"]')).toBeNull();
  else expect(w.document.querySelector('#finishQueue [data-input-id="retired-edit"]')).not.toBeNull();
  // The edit the user typed is not lost: an empty composer takes it, and a notice says why.
  expect(w.document.querySelector<HTMLTextAreaElement>('#chatInput')!.value).toBe('Late edit');
  expect(w.document.querySelector('.toast')?.textContent).toContain('your edit is in the composer');
});

it('keeps the composer\'s own draft when a late queued edit cannot be saved', async () => {
  const { w, live, append } = await boot([]);
  live.inputs.push({ id: 'late-edit', sessionId: summary([]).id, text: 'Original', mode: 'after-turn', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  const composer = w.document.querySelector<HTMLTextAreaElement>('#chatInput')!;
  composer.value = 'My next message'; composer.dispatchEvent(new w.Event('input', { bubbles: true }));
  (w.document.querySelector('[aria-label="Edit queued task"]') as HTMLButtonElement).click();
  const field = w.document.querySelector<HTMLTextAreaElement>('#finishQueue textarea')!;
  field.value = 'Late edit';
  (w as any).api.editQueuedInput = async () => { live.inputs[0]!.state = 'browser'; return { ok: true, data: false }; };
  (field.nextElementSibling as HTMLButtonElement).click(); await settle();
  expect(composer.value).toBe('My next message');
  expect(w.document.querySelector('.toast')?.textContent).toContain('before your edit was saved');
  expect(w.document.querySelector('.toast')?.textContent).not.toContain('in the composer');
});

it('retires a queued editor synchronously on New Chat and ignores its delayed save after returning', async () => {
  const { w, live, append } = await boot([]);
  live.inputs.push({ id: 'old-editor', sessionId: summary([]).id, text: 'Original', mode: 'finish', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  (w.document.querySelector('[aria-label="Edit queued task"]') as HTMLButtonElement).click();
  let resolveSave!: (value: unknown) => void;
  (w as any).api.editQueuedInput = () => new Promise(resolve => { resolveSave = resolve; });
  const field = w.document.querySelector<HTMLTextAreaElement>('#finishQueue textarea')!;
  field.value = 'Old save'; (field.nextElementSibling as HTMLButtonElement).click();
  w.document.getElementById('newChat')!.click();
  expect(w.document.querySelector('#finishQueue textarea')).toBeNull();
  expect(w.document.getElementById('finishQueue')!.hidden).toBe(true);
  (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click(); await settle();
  (w.document.querySelector('[aria-label="Edit queued task"]') as HTMLButtonElement).click();
  const fresh = w.document.querySelector<HTMLTextAreaElement>('#finishQueue textarea')!;
  fresh.value = 'New edit'; resolveSave({ ok: true, data: true }); await settle();
  expect(w.document.querySelector('#finishQueue textarea')).toBe(fresh);
  expect(fresh.value).toBe('New edit');
});

it('keeps canonical image attachments above the user text bubble for the selected session', async () => {
  const app = await boot([]);
  const { w } = app;
  const message: SessionEvent = { seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'input:one', inputId: 'one', message: text('Inspect this'), assets: [{ id: 'abcdef.bin', mimeType: 'image/webp', bytes: 12 }] };
  const getImage = vi.fn(async () => ({ ok: true, data: 'data:image/webp;base64,YQ==' }));
  // Match the real IPC result envelope used by this harness.
  (w as any).api.getSessionImage = getImage;
  await app.append([message]);
  const attachments = w.document.querySelector('.message-attachments')!;
  expect(attachments.tagName).toBe('DIV');
  expect(attachments.querySelector('summary')).toBeNull();
  expect(attachments.nextElementSibling?.classList.contains('user-message-text')).toBe(true);
  await settle();
  expect(getImage).toHaveBeenCalledWith(summary([]).id, 'abcdef.bin');
  expect(attachments.querySelector('img')?.getAttribute('src')).toBe('data:image/webp;base64,YQ==');
});

it('reserves every saved user-image slot before IPC and keeps missing previews inside their slots', async () => {
  const app = await boot([]);
  const pending: Array<(value: unknown) => void> = [];
  (app.w as any).api.getSessionImage = vi.fn(() => new Promise(resolve => pending.push(resolve)));
  await app.append([{ seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'two-images',
    message: text('Inspect both'), assets: ['one.webp', 'two.webp'].map(id => ({ id, mimeType: 'image/webp', bytes: 12 })) }]);
  const attachments = app.w.document.querySelector('.message-attachments')!;
  const slots = [...attachments.querySelectorAll('.user-image-slot')];
  expect(slots).toHaveLength(2);
  expect(attachments.children).toHaveLength(2);
  pending[0]!({ ok: true, data: null }); await settle();
  expect(slots[0]!.textContent).toContain('Image unavailable');
  pending[1]!({ ok: true, data: 'data:image/webp;base64,YQ==' }); await settle();
  expect(slots[1]!.querySelector('img')).not.toBeNull();
  expect([...attachments.children]).toEqual(slots);
});

it('keeps a retained fallback and its unsaved notice inside the reserved user-image footprint', async () => {
  const app = await boot([]);
  const dataUrl = 'data:image/webp;base64,YQ==';
  app.live.inputs.push({ id: 'fallback-input', sessionId: summary([]).id, state: 'sent', owner: null,
    text: 'Fallback', mode: 'auto', model: null, reasoningEffort: null, dueAt: T0, createdAt: T0,
    conversationId: 'chat-b', messageId: 'fallback-message', toolImages: [{ name: 'fallback.webp', dataUrl }] });
  (app.w as any).api.getSessionImage = vi.fn(async () => ({ ok: true, data: null }));
  await app.append([{ seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'fallback-message',
    inputId: 'fallback-input', message: text('Fallback'), assets: [{ id: 'missing.webp', mimeType: 'image/webp', bytes: 12 }] }]);
  const attachments = app.w.document.querySelector('.message-attachments')!;
  expect(attachments.children).toHaveLength(1);
  const slot = attachments.firstElementChild!;
  expect(slot.className).toBe('user-image-slot');
  expect(slot.querySelector('img')?.getAttribute('src')).toBe(dataUrl);
  expect(slot.querySelector('.retained-image-notice')?.textContent).toBe('Not saved to history');
});

it.each([false, true])('keeps retained image previews at the canonical row across queue/history arrival and off-tail reload (historyFirst=%s)', async historyFirst => {
  const app = await boot([]);
  const { w, live, append } = app;
  const row: InputEntry = { id: 'image-input', sessionId: summary([]).id, state: 'sent', owner: null, text: 'Original image request',
    mode: 'auto', model: null, reasoningEffort: null, dueAt: T0, createdAt: T0, deliveredAt: T0 + 10, conversationId: 'chat-b',
    messageId: 'input:image-input', historyRecorded: false, historyAnchored: true,
    toolImages: [{ name: 'retained.webp', dataUrl: 'data:image/webp;base64,YQ==' }] };
  const message: SessionEvent = { seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: row.messageId,
    inputId: row.id, inputDelivery: 'confirmed', message: text(row.text) };
  if (historyFirst) await append([message]);
  live.inputs.push(row);
  await append(historyFirst ? [] : [message]);
  expect(w.document.querySelectorAll('#timeline .said.is-user img')).toHaveLength(1);
  expect(w.document.querySelector('#timeline .said.is-user img')?.getAttribute('src')).toBe(row.toolImages![0]!.dataUrl);
  const retainedNotice = w.document.querySelector('#timeline .retained-image-notice')!;
  expect(retainedNotice.textContent).toBe('Not saved to history');
  expect(retainedNotice.parentElement?.className).toBe('user-image-slot');
  expect(retainedNotice.previousElementSibling?.tagName).toBe('IMG');
  expect(w.document.querySelector('#inputQueue')!.textContent).not.toContain(row.text);
  // Queue changes must repaint the same canonical row, never borrow another owner.
  live.inputs[0] = { ...row, sessionId: 'another-session' };
  await append([]);
  expect(w.document.querySelector('#timeline .said.is-user img')).toBeNull();
  live.inputs[0] = row; await append([]);
  const api = (w as any).api;
  api.getSessionImage = vi.fn(async () => ({ ok: true, data: row.toolImages![0]!.dataUrl }));
  await append([{ ...message, seq: 2, origin: 1, assets: [{ id: 'saved.webp', mimeType: 'image/webp', bytes: 1 }] }]);
  expect(w.document.querySelectorAll('#timeline .said.is-user img')).toHaveLength(1);
  expect(w.document.querySelector('#timeline .retained-image-notice')).toBeNull();
  await append(Array.from({ length: 180 }, (_, i): SessionEvent => ({ seq: i + 3, time: T0 + i + 20, kind: 'user_message',
    source: 'extension', messageId: `newer-${i}`, message: text(`Newer ${i}`) })));
  const original = api.getSession;
  api.getSession = async (id: string, options: any) => {
    const result = await original(id, options);
    if (options?.from === undefined && options?.before === undefined) result.data.events = result.data.events.slice(-160);
    return result;
  };
  w.document.getElementById('newChat')!.click(); await settle();
  (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click(); await settle();
  expect(w.document.querySelector('#timeline')!.textContent).not.toContain(row.text);
  expect(w.document.querySelector('#inputQueue')!.textContent).not.toContain(row.text);
});

describe("a new chat's first message held for its project's ChatGPT Project", () => {
  const project: LocalProject = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000777', name: 'Website', path: '/work/website', createdAt: T0,
    chatgpt: { state: 'requested', requestId: 'cccccccc-bbbb-4ccc-8ddd-000000000777', updatedAt: T0 } };
  const failed = { ...project, chatgpt: { state: 'failed', requestId: 'cccccccc-bbbb-4ccc-8ddd-000000000777', error: 'x', updatedAt: T0 } } as LocalProject;
  // Removed from the sidebar before its ChatGPT Project existed: nothing creates it any more and
  // there is no menu to retry from, so the message says how it can still go out. Adding the folder
  // again restores the project and its pending ChatGPT Project.
  const removed = "This chat's project was removed from the sidebar. Add its folder again to send this message, or cancel it.";
  it.each([
    ['being created', project, 'Creating this project in ChatGPT…'],
    ['that could not be created', failed, "This project's ChatGPT Project isn't available. Retry it from the project's menu."],
    ['removed while it was being created', { ...project, ungrouped: true }, removed],
    ['removed after it could not be created', { ...failed, ungrouped: true }, removed]
  ] as const)('says why it waits for a project %s', async (_case, row, expected) => {
    const { w, live, append } = await boot([], false, [], [row as LocalProject], { summary: { conversationId: null, projectId: project.id } });
    // The chat sits in its project while the project is in the sidebar, under Chats once it is removed.
    w.document.querySelector<HTMLElement>('.project-group .project-heading')?.click(); await settle();
    w.document.querySelector<HTMLElement>('.sess[data-id]')!.click(); await settle();
    const chat = await import('../src/renderer/chat.js');
    const state = (await (w as any).api.getState()).data;
    chat.chatApply({ ...state, bridge: { ...state.bridge, present: true } });
    live.inputs.push({ id: 'first-message', sessionId: summary(live.events).id, state: 'queued', owner: 'page', text: 'Hi',
      mode: 'auto', model: null, reasoningEffort: null, dueAt: T0, createdAt: T0, conversationId: null, projectId: project.id });
    await append([]);
    await waitFor(() => expect(w.document.querySelector('#inputQueue .pending-message')?.textContent ?? '').toContain(expected), { timeout: 5000 });
  });
});

it("shows the chat's schedule as one quiet line, with Pause and Edit, and a missed run (#1826)", async () => {
  // A Wednesday at 08:00, so the weekday run at 09:00 is later today: the time alone (2.1.47 round).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 28, 8, 0));
  try {
    const asked = Date.now() - 12_000;
    const { w, live, append } = await boot([
      { kind: 'user_message', seq: 1, origin: 1, time: asked, source: 'extension', messageId: 'q-sched', message: text('Check the issues') }
    ]);
    const api = (w as any).api;
    const sessionId = summary(live.events).id;
    const line = () => w.document.getElementById('scheduleLine')!;
    // No schedule: no line.
    api.getSchedule = vi.fn(() => Promise.resolve({ ok: true, data: null }));
    await append([]); await append([]);
    expect(line().hidden).toBe(true);
    const schedule = { id: '0b6c4e1c-1f1e-4a4f-9d39-3c2f0e1a2b3c', sessionId, text: 'Check the issues', repeat: { kind: 'weekdays', at: '09:00' },
      until: null, paused: false, createdAt: Date.now() - 86_400_000, lastDueAt: null };
    api.getSchedule = vi.fn(() => Promise.resolve({ ok: true, data: schedule }));
    api.pauseSchedule = vi.fn(() => Promise.resolve({ ok: true, data: { ...schedule, paused: true } }));
    await append([]); await append([]);
    expect(line().hidden).toBe(false);
    expect(line().textContent).toMatch(/^Scheduled · every weekday at 09:00( AM)? · next (\S+ )?09:00/);
    // A next run later today is its time alone; on another day it names the day (2.1.47 round).
    const next = w.document.getElementById('scheduleLineText')!.textContent!.match(/· next (.+)$/)![1]!;
    expect(next).toMatch(/^09:00( AM)?$/);
    // Friday 10:00: the next weekday run is Monday's, so the day is named (CodeRabbit).
    vi.setSystemTime(new Date(2026, 9, 30, 10, 0));
    await append([]); await append([]);
    expect(w.document.getElementById('scheduleLineText')!.textContent).toMatch(/· next Mon,? 09:00( AM)?$/);
    // Pause and Edit are the dock's own icon actions, like the Goal row's, named for screen readers.
    const pause = () => w.document.getElementById('scheduleLinePause')!;
    const edit = w.document.getElementById('scheduleLineEdit')!;
    expect(pause().classList.contains('dock-action')).toBe(true);
    expect(edit.classList.contains('dock-action')).toBe(true);
    expect(pause().getAttribute('aria-label')).toBe('Pause schedule');
    expect(pause().title).toBe('Pause schedule');
    expect(pause().querySelector('.ico')).not.toBeNull();
    expect(edit.getAttribute('aria-label')).toBe('Edit schedule');
    expect(edit.querySelector('.ico')).not.toBeNull();
    pause().click();
    await append([]);
    expect(api.pauseSchedule).toHaveBeenCalledWith(sessionId, true);
    api.getSchedule = vi.fn(() => Promise.resolve({ ok: true, data: { ...schedule, paused: true } }));
    await append([]); await append([]);
    expect(line().textContent).toMatch(/^Paused · every weekday at 09:00/);
    expect(pause().getAttribute('aria-label')).toBe('Resume schedule');
    expect(pause().title).toBe('Resume schedule');
    // A run missed while the app was closed says so, beside the next time.
    const missed = new Date(); missed.setHours(9, 0, 0, 0);
    api.getSchedule = vi.fn(() => Promise.resolve({ ok: true, data: { ...schedule, missedDueAt: missed.getTime() } }));
    await append([]); await append([]);
    expect(line().textContent).toContain('missed 09:00');
  } finally { vi.useRealTimers(); }
});

it('says when the send check holds an automatic message, with its reason', async () => {
  // #1794: a held Continue or fresh turn shows why it waits, so the person can cancel it or fix the program.
  const asked = Date.now() - 12_000;
  const { w, live, append } = await boot([
    { kind: 'user_message', seq: 1, origin: 1, time: asked, source: 'extension', messageId: 'q-held', message: text('Build it') }
  ]);
  const api = (w as any).api;
  const chat = await import('../src/renderer/chat.js');
  const state = (await api.getState()).data;
  const checked = (url: string | undefined) => chat.chatApply({ ...state, bridge: { ...state.bridge, present: true },
    config: { ...state.config, ui: { ...state.config.ui, sendCheckUrl: url } } });
  checked('http://127.0.0.1:8123/check');
  const hold = (attempt: number, reason: string, answered: boolean) => ({ attempt, nextAt: Date.now() + 30_000, reason, answered });
  const held: InputEntry = { id: 'held-one', sessionId: summary(live.events).id, state: 'queued', owner: null, text: 'Continue',
    mode: 'after-turn', model: null, reasoningEffort: null, dueAt: T0, createdAt: T0, conversationId: 'chat-a',
    recovery: { questionId: 'q-held', pro: false, busyUntil: 0, phase: 'ready' }, sendCheck: hold(2, 'quiet hours', true) };
  const card = () => w.document.querySelector('#finishQueue .queued-input')!.textContent ?? '';
  live.inputs.push(held);
  await append([]); await append([]);
  expect(card()).toContain('Held by your send check: quiet hours');
  live.inputs[0] = { ...held, sendCheck: hold(3, '', false) };
  await append([]); await append([]);
  expect(card()).toContain('Held: your send check did not answer');
  live.inputs[0] = { ...held, sendCheck: hold(4, '', true) };
  await append([]); await append([]);
  expect(card()).toContain('Held by your send check');
  // The fresh turn after a long one waits in the message queue, and says the same there.
  live.inputs[0] = { id: 'rotation-one', sessionId: summary(live.events).id, state: 'queued', owner: null, text: 'Continue in a fresh turn',
    mode: 'auto', model: null, reasoningEffort: null, dueAt: T0, createdAt: T0, conversationId: 'chat-a', purpose: 'rotation',
    authoredSource: 'none', sendCheck: hold(1, 'budget', true) };
  await append([]); await append([]);
  expect(w.document.querySelector('#inputQueue .pending-message')?.textContent ?? '').toContain('Held by your send check: budget');
  // The person clears the check's address: the app releases the message at once, and the queue stops saying it is held (CodeRabbit).
  checked(undefined); await append([]); await append([]);
  expect(w.document.querySelector('#inputQueue .pending-message')?.textContent ?? '').not.toContain('Held');
  // A hold whose next ask has come is no longer a hold either.
  checked('http://127.0.0.1:8123/check');
  live.inputs[0] = { ...live.inputs[0]!, sendCheck: { attempt: 2, nextAt: Date.now() - 1, reason: 'budget', answered: true } };
  await append([]); await append([]);
  expect(w.document.querySelector('#inputQueue .pending-message')?.textContent ?? '').not.toContain('Held');
});

it('says why a queued message waits: no extension, or a running tool call', async () => {
  const asked = Date.now() - 12_000;
  const { w, live, append } = await boot([
    { seq: 1, time: asked - 100, source: 'extension', kind: 'turn_start', turnId: 'held-turn' },
    { kind: 'user_message', seq: 2, origin: 2, time: asked, source: 'extension', turnId: 'held-turn', messageId: 'q-now', message: text('Run the tests') }
  ]);
  const api = (w as any).api;
  const chat = await import('../src/renderer/chat.js');
  const state = (await api.getState()).data;
  const present = (on: boolean) => chat.chatApply({ ...state, bridge: { ...state.bridge, present: on } });
  const queued: InputEntry = { id: 'queued-one', sessionId: summary(live.events).id, state: 'queued', owner: 'page', text: 'After the tests',
    mode: 'auto', model: null, reasoningEffort: null, dueAt: T0, createdAt: T0, conversationId: 'chat-a' };
  const status = () => w.document.querySelector('#inputQueue .pending-message')!.textContent ?? '';
  live.inputs.push(queued);
  // No extension connected: nothing can leave yet.
  present(false); await append([]);
  expect(status()).toContain('Waiting for the browser extension to connect');
  expect(w.document.querySelector('#inputQueue .pending-message')!.classList.contains('is-waiting')).toBe(true);
  // Connected, with one of this chat's tool calls running: the message waits for it (#1231).
  api.runningTools = () => Promise.resolve({ ok: true, data: [{ title: 'Running npm test', kind: 'run', since: Date.now() - 5_000 }] });
  present(true); await append([]); await append([]);
  expect(status()).toContain('Waiting for the running tool call to finish');
  // A mid-turn send does not wait for calls, so it claims no such reason.
  live.inputs[0] = { ...queued, directTurn: { id: 'held-turn', startedAt: asked } };
  await append([]); await append([]);
  expect(status()).not.toContain('Waiting for the running tool call');
  // The call ended: back to the plain clock, with Queued as its label.
  live.inputs[0] = queued;
  api.runningTools = () => Promise.resolve({ ok: true, data: [] });
  await append([]); await append([]);
  expect(status()).not.toContain('Waiting for');
  expect(w.document.querySelector('#inputQueue .pending-message-status')!.getAttribute('aria-label')).toBe('Queued');
  expect(w.document.querySelector('#inputQueue .pending-message')!.classList.contains('is-waiting')).toBe(false);
});

it.each([false, true])('hands a delivered bubble to exact native history without a blank or duplicate (historyFirst=%s)', async historyFirst => {
  const { w, live, append } = await boot([]);
  const row: InputEntry = { id: 'delivery-one', sessionId: summary([]).id, state: 'browser', owner: 'page', text: 'Follow-up once',
    mode: 'auto', model: null, reasoningEffort: null, dueAt: T0, createdAt: T0, conversationId: 'chat-b' };
  live.inputs.push(row); await append([]);
  const original = w.document.querySelector('#inputQueue .pending-message');
  await append([]);
  expect(w.document.querySelector('#inputQueue .pending-message')).toBe(original);
  const message: SessionEvent = { seq: 1, time: T0 + 1, source: 'app', kind: 'user_message', messageId: 'native-followup',
    inputId: row.id, message: text(row.text) };
  if (historyFirst) await append([message]);
  else {
    live.inputs[0] = { ...row, state: 'sent', messageId: 'native-followup', historyAnchored: true, deliveredAt: T0 + 1 };
    await append([]);
  }
  const count = () => [...w.document.querySelectorAll('#timeline .said.is-user, #inputQueue .pending-message')].filter(node => node.textContent?.includes(row.text)).length;
  expect(count()).toBe(1);
  if (historyFirst) live.inputs[0] = { ...row, state: 'sent', messageId: 'native-followup', historyAnchored: true, deliveredAt: T0 + 1 };
  await append(historyFirst ? [] : [message]);
  expect(count()).toBe(1);
  expect(w.document.querySelector('#inputQueue .pending-message')).toBeNull();
});

it.each([undefined, 4])('never resurrects committed off-page inputs beside genuinely waiting inputs when old timestamps reappear (historySeq=%s)', async historySeq => {
  const events = Array.from({ length: 180 }, (_, i): SessionEvent => ({ ...toolCall(i + 10, `receipt-${i}`), time: T0 - 100 }));
  const { w, live, append } = await boot(events);
  const base = { sessionId: summary([]).id, owner: null, mode: 'auto' as const, model: null, reasoningEffort: null,
    dueAt: T0, createdAt: T0, conversationId: 'chat-b' };
  live.inputs.push({ ...base, id: 'old-delivered', text: 'Already delivered correction', state: 'sent',
    messageId: 'input:old-delivered', deliveredAt: T0 + 20, historyAnchored: true, historyRecorded: true, historySeq },
    { ...base, id: 'still-waiting', text: 'Genuinely waiting correction', state: 'queued' },
    { ...base, id: 'history-in-flight', text: 'Receipt preceding history snapshot', state: 'sent',
      messageId: 'input:history-in-flight', deliveredAt: T0 + 30, historyAnchored: true, historySeq: 200 });
  for (let i = 0; i < 2; i++) {
    await append([]);
    const queue = w.document.querySelector('#inputQueue')!;
    expect(queue.textContent).not.toContain('Already delivered correction');
    expect(queue.textContent).toContain('Genuinely waiting correction');
    expect(queue.textContent).toContain('Receipt preceding history snapshot');
  }
  await append([{ seq: 200, origin: 200, time: T0 + 30, kind: 'user_message', source: 'app',
    inputId: 'history-in-flight', messageId: 'input:history-in-flight', message: text('Receipt preceding history snapshot') }]);
  expect(w.document.querySelector('#inputQueue')!.textContent).not.toContain('Receipt preceding history snapshot');
  expect(w.document.querySelector('#timeline')!.textContent).toContain('Receipt preceding history snapshot');
});

it('does not request conversation-only controls for a local chat without a provider binding', async () => {
  const reserved = { ...summary([]), conversationId: null, chatIds: [], origin: { kind: 'desktop' as const, fromSessionId: null, agentId: null, task: '' } };
  const { w, append } = await boot([], true, [], [], { sessions: [reserved] });
  const controls = vi.fn(async () => ({ ok: false, error: 'session_not_recorded' }));
  (w as any).api.getSessionControls = controls;
  await append([]); await append([]);
  expect(controls).not.toHaveBeenCalled();
  expect(w.document.getElementById('compactSession')!.hidden).toBe(true);
});

it('removes a withdrawn newest chat after sidebar pagination while preserving the older page', async () => {
  const opening = { ...summary([]), id: 'reserved-opening', title: 'Withdrawn', updatedAt: T0 + 3,
    conversationId: null, chatIds: [], origin: { kind: 'desktop' as const, fromSessionId: null, agentId: null, task: '' } };
  const retained = { ...summary([]), id: 'retained-chat', updatedAt: T0 + 2 };
  const older = { ...summary([]), id: 'older-chat', updatedAt: T0 + 1 };
  const { w, append } = await boot([], false, [], [], { sessions: [opening, retained] });
  let withdrawn = false, complete = false;
  (w as any).api.listSessions = async (options: any) => ({ ok: true, data: {
    sessions: options?.cursor ? [older] : withdrawn ? [retained] : [opening, retained],
    total: complete ? 1 : withdrawn ? 2 : 3, nextCursor: options?.cursor || complete ? null : { updatedAt: retained.updatedAt, id: retained.id },
    activeId: null, pressure: [], blocked: []
  } });
  await append([]);
  w.document.getElementById('sessionList')!.closest('.scroll')!.dispatchEvent(new w.Event('scroll'));
  await settle();
  expect(w.document.querySelector('[data-id="older-chat"]')).not.toBeNull();
  withdrawn = true; await append([]);
  expect(w.document.querySelector('[data-id="reserved-opening"]')).toBeNull();
  expect(w.document.querySelector('[data-id="older-chat"]')).not.toBeNull();
  complete = true; await append([]);
  expect(w.document.querySelector('[data-id="older-chat"]')).toBeNull();
  expect(w.document.querySelector('[data-id="retained-chat"]')).not.toBeNull();
});

it('reserves geometry and hydrates multiple native generated images independently in source order', async () => {
  const app = await boot([]);
  const { w } = app;
  const pending = new Map<string, (value: unknown) => void>();
  (w as any).api.getSessionImage = vi.fn((_sessionId: string, assetId: string) => new Promise(resolve => pending.set(assetId, resolve)));
  const messageId = '3150f756-bf2d-45fa-ac0f-45010b2239fb';
  const events: SessionEvent[] = [
    { seq: 1, time: T0, source: 'extension', kind: 'native_image', messageId,
      providerAssetId: 'file_blue', providerRole: 'tool', providerChannel: 'final', width: 1254, height: 1254,
      previewStatus: 'available', previewWidth: 12, previewHeight: 12, asset: { id: 'blue.webp', mimeType: 'image/webp', bytes: 12 } },
    { seq: 2, time: T0 + 1, source: 'extension', kind: 'native_image', messageId,
      providerAssetId: 'file_orange', providerRole: 'tool', providerChannel: 'final', width: 1024, height: 768,
      previewStatus: 'available', previewWidth: 16, previewHeight: 12, asset: { id: 'orange.webp', mimeType: 'image/webp', bytes: 12 } }
  ];
  await app.append(events);

  const rows = [...w.document.querySelectorAll<HTMLElement>('.said.native-image')];
  expect(rows).toHaveLength(2);
  expect(w.document.querySelectorAll('.generated-image-gallery')).toHaveLength(1);
  expect(w.document.querySelector('.generated-image-gallery')?.querySelectorAll('.ev-native_image')).toHaveLength(2);
  const frames = rows.map(row => row.querySelector<HTMLElement>('.generated-image-frame')!);
  expect(frames.map(frame => frame.style.aspectRatio)).toEqual(['1254 / 1254', '1024 / 768']);
  expect(frames.every(frame => frame.textContent === 'Image preview is loading')).toBe(true);

  pending.get('orange.webp')?.({ ok: true, data: 'data:image/webp;base64,b3Jhbmdl' });
  await settle();
  expect(frames[1]!.querySelector('img')?.getAttribute('src')).toContain('b3Jhbmdl');
  expect(frames[0]!.querySelector('img')).toBeNull();
  pending.get('blue.webp')?.({ ok: true, data: 'data:image/webp;base64,Ymx1ZQ==' });
  await settle();
  expect(frames[0]!.querySelector('img')?.getAttribute('src')).toContain('Ymx1ZQ==');
});

it('keeps generated-image metadata visible when recording storage is full', async () => {
  const app = await boot([]);
  await app.append([{ seq: 1, time: T0, source: 'extension', kind: 'native_image',
    messageId: '5150f756-bf2d-45fa-ac0f-45010b2239fb', providerAssetId: 'file_quota_fixture',
    providerRole: 'tool', providerChannel: 'final', providerStatus: 'finished_successfully',
    width: 1254, height: 1254, previewStatus: 'unavailable', previewError: 'quota' }]);
  const row = app.w.document.querySelector('.said.native-image')!;
  expect(row.textContent).toContain('recording storage is full');
  expect(row.querySelector('.generated-image-frame')).toBeTruthy();
  expect(row.querySelector('img')).toBeNull();
  expect(row.querySelector('.generated-image-frame')?.classList.contains('is-unavailable')).toBe(true);
  expect(row.querySelector('button')?.textContent).toBe('Free storage');
});

it.each([
  ['oversized', 'exceeds the recording limit', false],
  ['not_loaded', 'Image preview unavailable', false],
  ['removed', 'removed from local storage', true]
] as const)('offers Free storage only where storage is the reason (%s)', async (previewError, says, offers) => {
  // VM, 2026-10-20: a picture the page could not shrink showed Free storage, which cannot help.
  const app = await boot([]);
  await app.append([{ seq: 1, time: T0, source: 'extension', kind: 'native_image',
    messageId: '5150f756-bf2d-45fa-ac0f-45010b2239fb', providerAssetId: `file_${previewError}_fixture`,
    providerRole: 'tool', providerChannel: 'final', providerStatus: 'finished_successfully',
    width: 1448, height: 1086, previewStatus: 'unavailable', previewError }]);
  const row = app.w.document.querySelector('.said.native-image')!;
  expect(row.textContent).toContain(says);
  expect(!!row.querySelector('button')).toBe(offers);
});

it('does not group images across an intervening authored message or another turn', async () => {
  const app = await boot([]);
  const image = (seq: number, turnId: string): SessionEvent => ({ seq, time: T0 + seq,
    source: 'extension', kind: 'native_image', messageId: `image-${seq}`, providerAssetId: `file-${seq}`,
    providerRole: 'tool', turnId, previewStatus: 'pending' });
  await app.append([image(1, 'a'), image(2, 'a'),
    { seq: 3, time: T0 + 3, source: 'extension', kind: 'assistant_message', messageId: 'text-3',
      turnId: 'a', final: false, message: { text: 'Between images', chars: 14, truncated: false } },
    image(4, 'a'), image(5, 'b')]);
  const galleries = [...app.w.document.querySelectorAll('.generated-image-gallery')];
  expect(galleries.map(gallery => gallery.querySelectorAll('.ev-native_image').length)).toEqual([2, 1, 1]);
  expect(galleries[0]?.nextElementSibling?.textContent).toContain('Between images');
});

it('retains one exact-message gallery when only one image gains a proven turn', async () => {
  const app = await boot([]);
  const first: SessionEvent = { seq: 1, time: T0, source: 'extension', kind: 'native_image',
    messageId: 'shared-image-message', providerAssetId: 'file-one', providerRole: 'tool', previewStatus: 'pending' };
  await app.append([first, { ...first, seq: 2, time: T0 + 1, providerAssetId: 'file-two' }]);
  const gallery = app.w.document.querySelector('.generated-image-gallery');
  await app.append([{ ...first, seq: 3, origin: 1, turnId: 'proven-turn', previewStatus: 'unavailable', previewError: 'quota' }]);
  expect(app.w.document.querySelectorAll('.generated-image-gallery')).toHaveLength(1);
  expect(app.w.document.querySelector('.generated-image-gallery')).toBe(gallery);
  expect(gallery?.querySelectorAll('.ev-native_image')).toHaveLength(2);
});

it('shows a native image-only message immediately as a card without a guessed caption or image fetch', async () => {
  const app = await boot([]);
  await app.append([{ seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'native-image-only',
    message: text(''), attachments: [{ id: 'native-provider-file', name: 'example.png', size: 123, mimeType: 'image/png' }] }]);
  const row = app.w.document.querySelector('.said.is-user')!;
  expect(row.querySelector('.attachment-card')?.textContent).toContain('example.png');
  expect(row.querySelector('.user-message-text')).toBeNull();
  expect(row.querySelector('img')).toBeNull();
});

it.each(['image', 'txt', 'mixed', 'new-chat', 'after-turn'])('routes the composer attachment action truthfully (%s)', async kind => {
  const app = await boot([], kind !== 'new-chat');
  const image = { id: '11111111-2222-4333-8444-555555555555', name: 'image.png', mimeType: 'image/png', size: 42 };
  const txt = { ...image, id: '22222222-2222-4333-8444-555555555555', name: 'notes.txt', mimeType: 'text/plain' };
  const files = kind === 'txt' ? [txt] : kind === 'mixed' ? [image, txt] : [image];
  (app.w as any).api.chooseFiles = async () => ({ ok: true, data: files });
  app.w.document.getElementById('attachImages')!.click(); await settle();
  expect(app.w.document.getElementById('immediateDeliveryLabel')!.textContent).toBe(
    kind === 'new-chat' ? 'Send' : ['txt', 'mixed'].includes(kind) ? 'After this turn' : 'Inject now');
  if (kind === 'after-turn') (app.w.document.getElementById('sendMode') as HTMLSelectElement).value = 'after-turn';
  app.w.document.getElementById('composer')!.dispatchEvent(new app.w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(app.live.sent).toHaveLength(1);
  expect(app.live.sent[0]).toMatchObject({ text: 'Please look at the attached files.', attachments: files });
  expect(app.live.sent[0]!.attachmentDelivery).toBe(kind === 'image' ? 'tool' : undefined);
});

it('restores the image draft after rejected injection and removes native-only delivery when the document is removed', async () => {
  const app = await boot([]);
  const image = { id: '11111111-2222-4333-8444-555555555555', name: 'image.png', mimeType: 'image/png', size: 42 };
  const txt = { ...image, id: '22222222-2222-4333-8444-555555555555', name: 'notes.txt', mimeType: 'text/plain' };
  (app.w as any).api.getSessionControls = async () => ({ ok: true, data: { sessionId: summary([]).id, activeTurnId: 'held-turn', canInject: true, queueAtFinish: true } });
  await app.append([]);
  (app.w as any).api.chooseFiles = async () => ({ ok: true, data: [image, txt] });
  app.w.document.getElementById('attachImages')!.click(); await settle();
  expect(app.w.document.getElementById('afterTurnLabel')!.textContent).toBe('After this turn');
  expect(app.w.document.getElementById('queueAtFinish')!.hidden).toBe(true);
  (app.w.document.querySelector('[aria-label="Remove notes.txt"]') as HTMLButtonElement).click();
  expect(app.w.document.getElementById('immediateDeliveryLabel')!.textContent).toBe('Inject now');
  (app.w as any).api.sendInput = async () => ({ ok: false, error: 'Image is too large for injection' });
  const field = app.w.document.getElementById('chatInput') as HTMLTextAreaElement;
  field.value = 'Use the original image';
  app.w.document.getElementById('composer')!.dispatchEvent(new app.w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(field.value).toBe('Use the original image');
  expect(app.w.document.querySelectorAll('#composerImages .image-remove')).toHaveLength(1);
  expect(app.w.document.querySelector('[aria-label="Remove image.png"]')).not.toBeNull();
});

it.each([7, 10, 11])('uses the same visible delivery choice and payload for %s attached images', async count => {
  const { w, live } = await boot([]);
  const files = Array.from({ length: count }, (_, index) => ({
    id: `image-${index}`, name: `image-${index}.png`, mimeType: 'image/png', size: 42
  }));
  (w as any).api.chooseFiles = async () => ({ ok: true, data: files });
  w.document.getElementById('attachImages')!.click(); await settle();
  const inject = w.document.querySelector<HTMLElement>('[data-delivery="tool"]')!;
  expect(inject.hidden).toBe(count > 10);
  expect(w.document.getElementById('immediateDeliveryLabel')!.textContent).toBe(count > 10 ? 'After this turn' : 'Inject now');
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]?.attachments).toEqual(files);
  expect(live.sent[0]?.delivery).toBe(count > 10 ? undefined : 'tool');
});

// 2026-10-31: a chat whose next step was not picked up offers one click to go on, in words.
it.each([['continue', 'Continue now', 'sent', 'Sent.'], ['queue', 'Try now', 'retrying', 'Trying again now.']] as const)(
  'offers %s on a slowed pickup and says what it did', async (next, label, did, said) => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  const id = summary([]).id;
  api.getSessionControls = async () => ({ ok: true, data: { sessionId: id, automation: 'off', objective: '', blocked: '', job: null,
    recovery: [{ kind: 'pickup-stopped', deadline: Date.now() - 60_000, attempts: 3, next }] } });
  const pickupNow = vi.fn(async () => ({ ok: true, data: { ok: true, did } }));
  api.pickupNow = pickupNow;
  await append([]);
  const button = await waitFor(() => {
    const found = w.document.querySelector<HTMLButtonElement>('#recoveryStatus .dock-action.is-labelled');
    expect(found?.textContent).toBe(label);
    return found!;
  });
  button.click();
  await waitFor(() => expect(pickupNow).toHaveBeenCalledWith(id));
  await waitFor(() => expect(w.document.querySelector('.toast')?.textContent).toBe(said));
});

it('says why a pickup could not be tried now', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  api.getSessionControls = async () => ({ ok: true, data: { sessionId: summary([]).id, automation: 'off', objective: '', blocked: '', job: null,
    recovery: [{ kind: 'pickup-stopped', deadline: Date.now() - 60_000, attempts: 3, next: 'goal' }] } });
  api.pickupNow = async () => ({ ok: true, data: { ok: false, error: 'ChatGPT limits this chat for a few minutes. The app tries again right after.' } });
  await append([]);
  const button = await waitFor(() => w.document.querySelector<HTMLButtonElement>('#recoveryStatus .dock-action.is-labelled')!);
  button.click();
  await waitFor(() => expect(w.document.querySelector('.toast')?.textContent).toBe('ChatGPT limits this chat for a few minutes. The app tries again right after.'));
});
