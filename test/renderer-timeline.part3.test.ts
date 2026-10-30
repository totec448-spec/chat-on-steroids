import { describe, expect, it, vi } from 'vitest';
import { JSDOM, T0, boot, settle, summary, text, toolCall, waitFor, type InputArgs, type InputEntry, type SessionEvent } from './renderer-timeline.harness.js';

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


it('keeps an unfolded tool row as the same open node while the chat keeps appending', async () => {
  const { w, append } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'session_start', conversationId: 'chat-a', title: 'Loop under test' },
    toolCall(2, 'call-1')
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const before = timeline.querySelector('.ev-tool_call details.tool') as HTMLDetailsElement;
  expect(before.open).toBe(false);
  before.open = true;
  before.dispatchEvent(new w.Event('toggle'));

  await append([toolCall(3, 'call-2'), toolCall(4, 'call-3')]);
  const rows = timeline.querySelectorAll('.ev-tool_call');
  expect(rows).toHaveLength(3);
  const after = rows[0]!.querySelector('details.tool') as HTMLDetailsElement;
  // Not rebuilt: the very node the user unfolded, still unfolded.
  expect(after).toBe(before);
  expect(after.open).toBe(true);
  const group = timeline.querySelector('details.tool-group') as HTMLDetailsElement;
  expect(group.open).toBe(true);
  group.open = false;
  group.dispatchEvent(new w.Event('toggle'));
  const detached: Node[] = [];
  const observer = new w.MutationObserver(records => records.forEach(record => detached.push(...record.removedNodes)));
  observer.observe(timeline, { childList: true, subtree: true });
  await append([toolCall(5, 'call-4')]);
  observer.disconnect();
  expect(detached.some(node => node === group || node === before || (node as Element).contains?.(before))).toBe(false);
  expect(timeline.querySelector('details.tool-group')).toBe(group);
  expect(group.open).toBe(false);
  expect(group.querySelector('.activity-title')!.textContent).toBe('Read README.md');
  expect(group.querySelector('.activity-count')!.textContent).toBe('4');
  expect(group.querySelector('summary')!.title).toContain('4 actions');
});

it('colors removed lines separately from added lines without changing other tool metrics', async () => {
  const edit = toolCall(1, 'edit-lines') as Extract<SessionEvent, { kind: 'tool_call' }>;
  edit.call.tool = 'apply_patch';
  edit.call.summary = { kind: 'edit', tone: 'good', title: 'Edited 2 files', metric: '+28 −11' };
  edit.call.changes = [{ path: '/repo/file.ts', added: 28, removed: 11, approximate: false }];
  const removal = toolCall(2, 'removed-lines') as Extract<SessionEvent, { kind: 'tool_call' }>;
  removal.call.tool = 'apply_patch';
  removal.call.summary = { kind: 'delete', tone: 'warn', title: 'Deleted file.ts', metric: '~−7' };
  removal.call.changes = [{ path: '/repo/removed.ts', added: 0, removed: 7, approximate: true }];
  const read = toolCall(3, 'read-lines') as Extract<SessionEvent, { kind: 'tool_call' }>;
  read.call.summary = { kind: 'read', tone: 'neutral', title: 'Read file.ts', metric: '12 lines' };

  const { w } = await boot([edit, removal, read]);
  const rows = [...w.document.querySelectorAll<HTMLDetailsElement>('details.tool')];
  expect(rows).toHaveLength(3);
  expect(rows[0]!.querySelector('summary .metric')?.textContent).toBe('+28 −11');
  expect(rows[0]!.querySelector('summary .metric-added')?.textContent).toBe('+28');
  expect(rows[0]!.querySelector('summary .metric-removed')?.textContent).toBe('−11');
  // The outcome metric already states this delta, so the per-call count beside the title stays out.
  expect(rows[0]!.querySelector('summary .tool-change-count')).toBeNull();
  expect(rows[1]!.querySelector('summary .metric')?.textContent).toBe('~−7');
  // A delta metric formatted differently from the count ("~−7" beside "+0 −7") is still one number.
  expect(rows[1]!.querySelector('summary .tool-change-count')).toBeNull();
  expect(rows[1]!.querySelector('summary .metric-removed')?.textContent).toBe('−7');
  expect(rows[2]!.querySelector('summary .metric')?.textContent).toBe('12 lines');
  expect(rows[2]!.querySelector('summary .metric-added, summary .metric-removed')).toBeNull();

  rows[0]!.open = true;
  rows[0]!.dispatchEvent(new w.Event('toggle'));
  expect(rows[0]!.querySelector('.edit-card .metric-added')?.textContent).toBe('+28');
  expect(rows[0]!.querySelector('.edit-card .metric-removed')?.textContent).toBe('−11');
  rows[1]!.open = true;
  rows[1]!.dispatchEvent(new w.Event('toggle'));
  expect(rows[1]!.querySelector('.edit-card summary')?.textContent).toContain('(approx.)');
  expect(rows[1]!.querySelector('.edit-card .metric-removed')?.textContent).toBe('−7');
});

it('opens a round with the ChatGPT caption and keeps its mixed tool and agent activity in one latest-action disclosure', async () => {
  const { w, append } = await boot([
    { seq: 1, time: T0, source: 'extension', kind: 'progress', message: text('Checking the implementation') },
    toolCall(2, 'first'),
    { seq: 3, time: T0 + 3000, source: 'app', kind: 'agent_message', messageId: 'agent-update', from: 'worker-2', to: 'prime', delivery: 'delivered', message: text('Found the root cause') },
    toolCall(4, 'last')
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const group = timeline.querySelector<HTMLDetailsElement>('.tool-group')!;
  expect(group.open).toBe(false);
  // The caption is what ChatGPT said before the step: it stands as the round's opening line.
  expect(timeline.children[0]!.className).toContain('ev-progress');
  expect(timeline.children[0]!.textContent).toContain('Checking the implementation');
  expect(group.querySelector('.activity-title')!.textContent).toBe(group.querySelector('.ev-tool_call:last-of-type .tool > summary b')!.textContent);
  expect(group.querySelector('.agent-communication summary')!.textContent).toContain('Message from worker-2');
  expect(group.querySelector('.agent-avatar')).not.toBeNull();
  expect(group.querySelectorAll('.ev')).toHaveLength(3);
  await append([
    { seq: 5, time: T0 + 5000, source: 'extension', kind: 'progress', message: text('Now validating') },
    toolCall(6, 'next'), toolCall(7, 'next-2')
  ]);
  expect(timeline.querySelectorAll('.tool-group')).toHaveLength(2);
  expect(timeline.children[0]!.className).toContain('ev-progress');
});

// The maintainer asked to answer ChatGPT's approval card from the app (2026-10-14): the row shows
// the card's words and offers Deny and Allow once for exactly that card. Never "always".
describe('ChatGPT\'s approval card in the timeline', () => {
  const waitingRow = { seq: 1, time: T0, source: 'app', kind: 'progress', progressId: 'approval-wait:chat-a:1',
    message: text('ChatGPT is waiting for you to allow or deny a tool call in this chat. Nothing continues until you answer it there.') } as SessionEvent;

  it('shows the card\'s words with Deny and Allow once, and answers that exact card once', async () => {
    let card: any = { id: 'card-1234567', lines: ['Gmail', 'Allow ChatGPT to use Gmail?', 'Creates a draft.'], allow: true, answer: null };
    const answers: string[][] = [];
    const { w } = await boot([waitingRow], true, [], [], {
      approvalCard: () => card,
      answerApproval: (_id, cardId, choice) => { answers.push([cardId, choice]); card = { ...card, answer: { choice, outcome: null } }; return { ok: true }; }
    });
    const timeline = w.document.getElementById('timeline')!;
    await waitFor(() => expect(timeline.querySelector('.approval-card')?.textContent).toContain('Allow ChatGPT to use Gmail?'));
    // The recorded English is unchanged; the row now says the answer can be given here too.
    expect(timeline.querySelector('.approval-wait')?.textContent).toContain('here or in the browser');
    const buttons = () => [...timeline.querySelectorAll<HTMLButtonElement>('.approval-card button')];
    expect(buttons().map(button => button.textContent)).toEqual(['Deny', 'Allow once']);
    expect(buttons().every(button => !button.disabled)).toBe(true);
    buttons()[1]!.click();
    await waitFor(() => expect(answers).toEqual([['card-1234567', 'allow']]));
    expect(buttons().every(button => button.disabled)).toBe(true);
    expect(timeline.querySelector('.approval-card')?.textContent).toContain('Sending your answer to ChatGPT');
    // The page found a different card: nothing was pressed, and the row says so.
    card = { ...card, answer: { choice: 'allow', outcome: 'card_changed' } };
    await waitFor(() => expect(timeline.querySelector('.approval-card')?.textContent).toContain('Nothing was pressed'), { timeout: 4000 });
  });

  it('keeps only the newest unanswered approval row live; older ones read as past, without buttons', async () => {
    // VM, 2026-10-20: two app restarts while one card waited left three "waiting" rows, each with
    // its own Deny and Allow once for the same card. A row from an earlier episode was never answered
    // there, so it says ChatGPT asked, not that it is waiting or answered.
    const older = { ...waitingRow, seq: 1, progressId: 'approval-wait:chat-a:1' } as SessionEvent;
    const middle = { ...waitingRow, seq: 2, progressId: 'approval-wait:chat-a:2' } as SessionEvent;
    const newest = { ...waitingRow, seq: 3, progressId: 'approval-wait:chat-a:3' } as SessionEvent;
    const { w } = await boot([older, middle, newest], true, [], [], {
      approvalCard: () => ({ id: 'card-1', lines: ['Allow ChatGPT to use Chat On Steroids Core?', 'Start a worker.'], allow: true, answer: null })
    });
    const timeline = w.document.getElementById('timeline')!;
    await waitFor(() => expect(timeline.querySelectorAll('.approval-card')).toHaveLength(1));
    const rows = [...timeline.querySelectorAll('.approval-wait')];
    expect(rows).toHaveLength(3);
    expect(rows.filter(row => row.classList.contains('is-waiting'))).toHaveLength(1);
    expect(rows[2]!.classList.contains('is-waiting')).toBe(true);
    for (const row of rows.slice(0, 2)) {
      expect(row.textContent).toBe('ChatGPT asked for a tool approval in this chat.');
      expect(row.querySelector('button')).toBeNull();
    }
  });

  it('offers only Deny where ChatGPT itself disabled Allow once', async () => {
    const { w } = await boot([waitingRow], true, [], [], {
      approvalCard: () => ({ id: 'card-7654321', lines: ['Gmail', 'Allow ChatGPT to use Gmail?', 'External app access is unavailable in this conversation'], allow: false, answer: null })
    });
    const timeline = w.document.getElementById('timeline')!;
    await waitFor(() => expect(timeline.querySelector('.approval-card button')).not.toBeNull());
    const [deny, allow] = [...timeline.querySelectorAll<HTMLButtonElement>('.approval-card button')];
    expect(deny!.disabled).toBe(false);
    expect(allow!.disabled).toBe(true);
    expect(timeline.querySelector('.approval-card')?.textContent).toContain('ChatGPT does not allow it in this chat');
  });
});

it('shows a strict-mode refusal notice in the interface language', async () => {
  // VM, 2026-10-20: a German interface showed this notice in English; the app records it in English.
  const { UNTRUSTED_NOTICE } = await import('../src/shared/trust-notices.js');
  const { w } = await boot([{ seq: 1, time: T0, source: 'app', kind: 'progress', progressId: 'strict-chat-refusal:one',
    message: text(UNTRUSTED_NOTICE) } as SessionEvent]);
  const timeline = w.document.getElementById('timeline')!;
  await waitFor(() => expect(timeline.textContent).toContain('untrusted chat was refused'));
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  try {
    await waitFor(() => expect(timeline.textContent).toContain('Chat vertrauen'));
    expect(timeline.textContent).not.toContain('untrusted chat was refused');
  } finally { setLanguage('en'); }
});

it('never titles a tool group with the app\'s own recovery note', async () => {
  // #882: after a run of reloads, every tool group read "Reloaded chat to recover an interrupted
  // response.", because the note in front of a group was taken for ChatGPT's phase caption.
  // Repair notes are shown in developer mode, where that reporter saw it.
  const { w } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'progress', progressId: 'browser-repair:chat:one',
      message: text('Reloaded chat to recover an interrupted response.') },
    toolCall(2, 'first'), toolCall(3, 'last')
  ], true, [], [], { developerMode: true });
  const timeline = w.document.getElementById('timeline')!;
  const group = timeline.querySelector<HTMLDetailsElement>('.tool-group')!;
  const title = group.querySelector('.activity-title')!.textContent;
  expect(title).not.toContain('Reloaded chat');
  expect(title).toBe(group.querySelector('.ev-tool_call:last-of-type .tool > summary b')?.textContent ?? title);
  // The note itself stays in the transcript, in front of the group.
  expect(timeline.children[0]!.textContent).toContain('Reloaded chat to recover an interrupted response.');
});

it('closes a stopped turn with a line saying it stopped, after any late work, and keeps the request line', async () => {
  // 2026-10-09: "ChatGPT has not yet confirmed that generation stopped" was the last word on a
  // turn the page had already ended as stopped. The request stays where it was made; the end of
  // the turn says it stopped once nothing runs any more.
  const request = 'Stop requested. The finish hold was released; ChatGPT has not yet confirmed that generation stopped.';
  const stoppedLine = 'Stopped. ChatGPT no longer shows this turn running.';
  const { w, append } = await boot([
    { seq: 1, time: T0, source: 'extension', kind: 'turn_start', turnId: 'g-stop' },
    { ...toolCall(2, 'before-stop'), turnId: 'g-stop' } as SessionEvent,
    { seq: 3, time: T0 + 3000, source: 'app', kind: 'progress', turnId: 'g-stop', progressId: 'finish-release:g-stop', message: text(request) }
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const lines = () => [...timeline.querySelectorAll('.ev')].map(row => row.textContent ?? '');
  const last = () => lines().at(-1)!;
  expect(lines().some(line => line.includes(stoppedLine))).toBe(false);
  await append([{ seq: 4, time: T0 + 3200, source: 'extension', kind: 'turn_end', turnId: 'g-stop', outcome: 'stopped' }]);
  expect(last()).toContain(stoppedLine);
  expect(lines().filter(line => line.includes(request))).toHaveLength(1);
  // A call ChatGPT dispatched before it obeyed reopens the turn: nothing says it stopped yet.
  await append([
    { ...toolCall(5, 'late'), time: T0 + 4000, turnId: 'g-stop' } as SessionEvent,
    { seq: 6, time: T0 + 4000, source: 'app', kind: 'turn_start', turnId: 'g-stop' }
  ]);
  expect(lines().some(line => line.includes(stoppedLine))).toBe(false);
  // The page ends it again: the line closes the turn, after the late call.
  await append([{ seq: 7, time: T0 + 9000, source: 'extension', kind: 'turn_end', turnId: 'g-stop', outcome: 'stopped' }]);
  expect(lines().filter(line => line.includes(stoppedLine))).toHaveLength(1);
  expect(last()).toContain(stoppedLine);
  expect(lines().filter(line => line.includes(request))).toHaveLength(1);
});

// CodeRabbit on #1918: the fold reads the recorded title, not the shown one, so it folds in every language.
it('folds status polls in another language too, and names the fold in it', async () => {
  const status = (seq: number): SessionEvent => {
    const event = toolCall(seq, `status-de-${seq}`) as Extract<SessionEvent, { kind: 'tool_call' }>;
    return { ...event, call: { ...event.call, tool: 'agents', summary: { kind: 'agent', tone: 'neutral', title: 'Checked agent status' } } };
  };
  const { w, append } = await boot([status(1), status(2), status(3), status(4)]);
  const { setLanguage, t } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  try {
    // Painted in German: the rows show German titles, and they still fold.
    await append([status(5)]);
    const fold = w.document.getElementById('timeline')!.querySelector<HTMLDetailsElement>('.routine-activity');
    expect(fold).not.toBeNull();
    expect(fold!.querySelector('.routine-count')!.textContent).toBe('×5');
    expect(fold!.querySelector('.activity-title')!.textContent).toBe(t('Checked agent status'));
    expect(fold!.querySelector('.activity-title')!.textContent).not.toBe('Checked agent status');
    setLanguage('en');
    expect(fold!.querySelector('.activity-title')!.textContent).toBe('Checked agent status');
  } finally { setLanguage('en'); }
});

it('folds five consecutive status polls while retaining each exact tool row', async () => {
  const status = (seq: number): SessionEvent => {
    const event = toolCall(seq, `status-${seq}`) as Extract<SessionEvent, { kind: 'tool_call' }>;
    return { ...event, call: { ...event.call, tool: 'agents', summary: { kind: 'agent', tone: 'neutral', title: 'Checked agent status' } } };
  };
  const { w, append } = await boot([status(1), status(2), status(3), status(4)]);
  const timeline = w.document.getElementById('timeline')!;
  expect(timeline.querySelector('.routine-activity')).toBeNull();
  await append([status(5)]);
  const fold = timeline.querySelector<HTMLDetailsElement>('.routine-activity')!;
  expect(fold.querySelector('.routine-count')!.textContent).toBe('×5');
  expect(fold.querySelectorAll('.ev-tool_call')).toHaveLength(5);
  fold.open = true;
  fold.dispatchEvent(new w.Event('toggle'));
  await append([status(6)]);
  expect(timeline.querySelector('.routine-activity')).toBe(fold);
  expect(fold.open).toBe(true);
  expect(fold.querySelectorAll('.ev-tool_call')).toHaveLength(6);
  expect(fold.querySelector('.routine-count')!.textContent).toBe('×6');
  const failed = status(7) as Extract<SessionEvent, { kind: 'tool_call' }>;
  await append([{ ...failed, call: { ...failed.call, outcome: 'tool_rejected', summary: { ...failed.call.summary, tone: 'bad' } } }]);
  expect(fold.querySelectorAll('.ev-tool_call')).toHaveLength(6);
  expect(timeline.querySelectorAll('.ev-tool_call')).toHaveLength(7);
});

it("shows a created file's line count once when the outcome metric already states it", async () => {
  const created = toolCall(1, 'created-file') as Extract<SessionEvent, { kind: 'tool_call' }>;
  created.call.tool = 'apply_patch';
  created.call.summary = { kind: 'create', tone: 'good', title: 'Created CHANGELOG-0.4.5.txt', metric: '+39' };
  created.call.changes = [{ path: 'CHANGELOG-0.4.5.txt', added: 39, removed: 0, approximate: false }];
  const { w } = await boot([created]);
  const row = w.document.querySelector<HTMLDetailsElement>('details.tool')!;
  expect(row.querySelectorAll('summary .metric-added')).toHaveLength(1);
  expect(row.querySelector('summary .tool-change-count')).toBeNull();
  expect(row.querySelector('summary .metric')?.textContent).toBe('+39');
});

it('keeps an artifact action as the activity title rather than its tool tag', async () => {
  const shell = toolCall(3, 'shell') as Extract<SessionEvent, { kind: 'tool_call' }>;
  const { w } = await boot([toolCall(2, 'read'), { ...shell, call: {
    ...shell.call, tool: 'exec_command', summary: { kind: 'run', tone: 'good', title: 'Ran build checks' },
    changes: [{ path: 'src/app.ts', added: 2, removed: 1, approximate: true }]
  } }]);
  const group = w.document.querySelector('.tool-group')!;
  expect(group.querySelector('.activity-title')!.textContent).toBe('Ran build checks');
  expect(group.querySelector('.tool-tag')!.textContent).toBe('shell');
  expect(group.querySelector('.tool-change-count')!.textContent).toContain('approx.');
});

it('controls the selected session without submitting another user message', async () => {
  const { w, live } = await boot([]);
  const mode = w.document.getElementById('chatAutomation') as HTMLSelectElement;
  mode.value = 'loop'; mode.dispatchEvent(new w.Event('change'));
  await settle();
  expect(live.controlCalls).toEqual([{ id: summary([]).id, action: 'loop' }]);
  expect(live.sent).toEqual([]);
  w.document.getElementById('compactSession')!.click(); await settle();
  expect(live.controlCalls.at(-1)).toEqual({ id: summary([]).id, action: 'compact' });
  expect((w.document.getElementById('compactSession') as HTMLButtonElement).disabled).toBe(true);
  expect((w.document.getElementById('cancelCompaction') as HTMLElement).hidden).toBe(false);
  w.document.getElementById('cancelCompaction')!.click(); await settle();
  expect(live.controlCalls.at(-1)).toEqual({ id: summary([]).id, action: 'cancel' });
  w.document.getElementById('newChat')!.click(); await settle();
  expect((w.document.getElementById('sessionControls') as HTMLElement).hidden).toBe(false);
});

it('offers deliberate helper retry only for the selected source session', async () => {
  const sourceSessionId = summary([]).id;
  const { w, live } = await boot([], true, [
    { id: 'paused-selected', sourceSessionId },
    { id: 'paused-other', sourceSessionId: 'another-session' }
  ]);
  const queue = w.document.getElementById('inputQueue')!;
  expect(queue.textContent).toContain('Its old chat may still be running');
  expect(queue.querySelectorAll('button')).toHaveLength(1);
  expect(live.controlCalls).toEqual([]);
  (queue.querySelector('button') as HTMLButtonElement).click();
  await settle();
  expect(live.controlCalls).toEqual([{ id: sourceSessionId, action: 'retry:paused-selected' }]);
  expect(queue.querySelectorAll('button')).toHaveLength(0);
});

it('does not expose the retired End turn menu action', async () => {
  const { w, live } = await boot([]);
  expect(w.document.getElementById('releaseFinish')).toBeNull();
  expect(live.controlCalls).toEqual([]);
  expect(live.sent).toEqual([]);
});

it('updates an offered injection receipt in its existing transcript position', async () => {
  const message: SessionEvent = { seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'input:receipt-test', message: text('Injected instruction'), inputDelivery: 'offered' };
  const app = await boot([message, toolCall(2, 'later-work')]);
  expect(app.w.document.querySelector('.input-receipt')?.getAttribute('aria-label')).toBe('Sent to the active turn · awaiting receipt');
  app.live.events[0] = { ...message, seq: 3, inputDelivery: 'confirmed' };
  await app.append([]);
  expect(app.w.document.querySelectorAll('.input-receipt')).toHaveLength(1);
  expect(app.w.document.querySelector('.input-receipt')?.getAttribute('aria-label')).toBe('Delivery confirmed');
});

it.each(['menu', 'send'])('queues an Astra finish message through %s using the existing staged queue', async action => {
  const app = await boot([]);
  const { w, live } = app;
  const api = (w as any).api;
  const original = api.getSessionControls;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, queueAtFinish: true, canInject: true } });
  await app.append([]);
  expect(w.document.getElementById('queueAtFinish')!.hidden).toBe(false);
  expect(w.document.getElementById('afterTurnLabel')!.textContent).toBe('Queue at Session finish');
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'The next stage';
  input.dispatchEvent(new w.Event('input'));
  if (action === 'menu') w.document.getElementById('queueAtFinish')!.click();
  else {
    (w.document.getElementById('sendMode') as HTMLSelectElement).value = 'after-turn';
    w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  }
  await settle();
  expect(live.sent.at(-1)).toMatchObject({ text: 'The next stage', mode: 'finish' });
});

it('shows injection only for an exact active turn, never merely recent chat activity', async () => {
  const { w, append } = await boot([toolCall(1, 'recent-call')]);
  const options = w.document.getElementById('sendOptions')!;
  expect(options.hidden).toBe(false);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'An authored follow-up'; input.dispatchEvent(new w.Event('input'));
  expect(options.hidden).toBe(false);
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({ ok: true, data: { sessionId: id, automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null } });
  await append([toolCall(2, 'more-recent-call')]);
  expect(options.hidden).toBe(true);
  expect((w.document.getElementById('sendMode') as HTMLSelectElement).value).toBe('auto');
});

// A text for the running turn goes through ChatGPT's composer (#1231), so a running turn offers
// Send directly alone; Inject now stays for a Pro turn, which keeps tool injection.
it('shows Send directly alone for a running turn, keeps After this turn selected, and offers Inject now on a Pro turn', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  const original = api.getSessionControls;
  let pro = false;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data,
    activeTurnId: 'plain-turn', canInject: pro, canSendDirectly: !pro, queueAtFinish: false } });
  await append([]);
  const options = w.document.getElementById('sendOptions')!;
  expect(options.hidden).toBe(false);
  expect(options.querySelector('[data-delivery="auto"]')!.textContent).toBe('Send directly');
  expect((options.querySelector('[data-delivery="tool"]') as HTMLElement).hidden).toBe(true);
  await append([toolCall(1, 'first-mcp-call')]);
  expect(options.querySelector('[data-delivery="auto"]')!.textContent).toBe('Send directly');
  (options.querySelector('[data-delivery="after-turn"]') as HTMLButtonElement).click();
  await append([]);
  expect((w.document.getElementById('sendMode') as HTMLSelectElement).value).toBe('after-turn');
  pro = true;
  await append([toolCall(2, 'second-mcp-call')]);
  expect((options.querySelector('[data-delivery="tool"]') as HTMLElement).hidden).toBe(false);
  expect(options.querySelector('[data-delivery="auto"]')!.textContent).toBe('Inject now');
  expect((w.document.getElementById('sendMode') as HTMLSelectElement).value).toBe('after-turn');
});

it("retires the running turn's lines when the turn ends after its rows were drawn (2026-10-12)", async () => {
  // The turn's end reached the header ("Worked for") after the last rows were drawn; the timeline kept
  // "Working for" and "Thinking" frozen under the finished answer until another event arrived.
  const asked = Date.now() - 60_000;
  const app = await boot([
    { seq: 1, time: asked - 100, source: 'extension', kind: 'turn_start', turnId: 'ending-turn' },
    { kind: 'user_message', seq: 2, origin: 2, time: asked, source: 'extension', turnId: 'ending-turn', messageId: 'q-end', message: text('Finish the step') }
  ]);
  const { w } = app;
  const api = (w as any).api;
  const original = api.getSessionControls;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, activeTurnId: 'ending-turn' } });
  await app.append([{ seq: 3, time: asked + 50_000, source: 'extension', kind: 'assistant_message', turnId: 'ending-turn', messageId: 'a-end', final: true, message: text('Step finished.') },
    { seq: 4, time: asked + 51_000, source: 'extension', kind: 'turn_end', turnId: 'ending-turn', outcome: 'completed' }]);
  // The rows were drawn while the controls still said the turn runs.
  expect(w.document.querySelector('#timeline .turn-status.is-working')).not.toBeNull();
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, activeTurnId: null } });
  // An app state update re-reads only the controls, as the live app did when the turn ended.
  const chat = await import('../src/renderer/chat.js');
  chat.chatApply((await api.getState()).data);
  await settle(); await settle();
  expect(w.document.getElementById('chatState')!.textContent).toMatch(/^Worked for /);
  expect(w.document.querySelector('#timeline .turn-status.is-working')).toBeNull();
  expect(w.document.querySelector('#timeline .turn-now')).toBeNull();
});

// #1787: a chat's page stopped reporting, the app gave up recovering it and its activity window ran
// out, but nothing new was written to the chat. The caption had read the controls once and went on
// saying "Working for …" for six hours.
it('stops counting a turn the app no longer sees running, even when nothing new arrives in the chat', async () => {
  const { w } = await boot([{ seq: 1, time: Date.now() - 60_000, source: 'extension', kind: 'turn_start', turnId: 'held-turn' }]);
  expect(w.document.getElementById('chatState')!.textContent).toMatch(/^Working for /);
  const api = (w as any).api;
  const original = api.getSessionControls;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, activeTurnId: null } });
  try {
    vi.setSystemTime(Date.now() + 5 * 60_000);
    await waitFor(() => expect(w.document.getElementById('chatState')!.textContent).not.toMatch(/^Working for /), { timeout: 5_000 });
  } finally { vi.useRealTimers(); }
});

it('says a chat stopped when recovery gave up on its unfinished turn, and drops that once the page is back', async () => {
  const { w, append } = await boot([{ seq: 1, time: Date.now() - 60_000, source: 'extension', kind: 'turn_start', turnId: 'held-turn' }]);
  const api = (w as any).api;
  const original = api.getSessionControls;
  let stopped = true;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, activeTurnId: null, pageless: stopped } });
  await append([]);
  const caption = () => w.document.getElementById('chatState')!;
  expect(caption().textContent).toBe("Stopped · open this chat's tab again to continue");
  expect(caption().classList.contains('is-bad')).toBe(true);
  expect(caption().classList.contains('is-working')).toBe(false);
  stopped = false;
  await append([]);
  expect(caption().textContent).toBe('');
});

it('takes the stopped line away when the page is back, even when nothing new arrives in the chat', async () => {
  const { w, append } = await boot([{ seq: 1, time: Date.now() - 60_000, source: 'extension', kind: 'turn_start', turnId: 'held-turn' }]);
  const api = (w as any).api;
  const original = api.getSessionControls;
  let stopped = true;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, activeTurnId: null, pageless: stopped } });
  await append([]);
  expect(w.document.getElementById('chatState')!.textContent).toBe("Stopped · open this chat's tab again to continue");
  stopped = false;
  try {
    vi.setSystemTime(Date.now() + 60_000);
    await waitFor(() => expect(w.document.getElementById('chatState')!.textContent).toBe(''), { timeout: 5_000 });
  } finally { vi.useRealTimers(); }
});

it('says a reopened turn stopped rather than how long it worked', async () => {
  const at = Date.now() - 120_000;
  const { w, append } = await boot([
    { seq: 1, time: at, source: 'extension', kind: 'turn_start', turnId: 'reopened-turn' },
    { seq: 2, time: at + 10_000, source: 'extension', kind: 'turn_end', turnId: 'reopened-turn', outcome: 'completed' },
    { seq: 3, time: at + 20_000, source: 'extension', kind: 'turn_start', turnId: 'reopened-turn' }
  ]);
  const api = (w as any).api;
  const original = api.getSessionControls;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, activeTurnId: null, pageless: true } });
  await append([]);
  expect(w.document.getElementById('chatState')!.textContent).toBe("Stopped · open this chat's tab again to continue");
});

it('shows the stopped line at the top of the loaded rows when its question is further up', async () => {
  const asked = Date.now() - 45 * 60_000;
  const calls = Array.from({ length: 220 }, (_, i): SessionEvent => ({ ...toolCall(i + 3, `long-${i}`), time: asked + (i + 1) * 1000, turnId: 'long-turn' }));
  const app = await boot([
    { seq: 1, time: asked - 100, source: 'extension', kind: 'turn_start', turnId: 'long-turn' },
    { kind: 'user_message', seq: 2, origin: 2, time: asked, source: 'extension', turnId: 'long-turn', messageId: 'q-long', message: text('Build all thirty quests') },
    ...calls
  ], true, [], [], { summary: { activeTurnId: 'long-turn' } });
  const { w } = app;
  const api = (w as any).api;
  const original = api.getSessionControls;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, activeTurnId: null, pageless: true } });
  await app.append([]); await app.append([]);
  const timeline = w.document.getElementById('timeline')!;
  expect(timeline.querySelector('.ev-user_message')).toBeNull();
  const rows = [...timeline.querySelectorAll('[data-timeline-key], .turn-stopped, .turn-status')];
  expect(rows[0]?.matches('.turn-stopped')).toBe(true);
  expect(rows[0]?.textContent).toBe("Stopped · open this chat's tab again to continue");
  expect(timeline.querySelector('.turn-status.is-working')).toBeNull();
});

// The 2.1.45 caption counted a six-hour turn as "Working for 372m 3s" (#1787 screenshots).
it('counts a turn longer than an hour in hours and minutes', async () => {
  const { w, append } = await boot([{ seq: 1, time: T0, source: 'extension', kind: 'turn_start', turnId: 'held-turn' }]);
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({ ok: true, data: { sessionId: id, automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null } });
  await append([{ seq: 2, time: T0 + (6 * 3600 + 12 * 60 + 3) * 1000, source: 'extension', kind: 'turn_end', turnId: 'held-turn', outcome: 'completed' }]);
  expect(w.document.getElementById('chatState')!.textContent).toBe('Worked for 6h 12m 3s');
});

it('shows elapsed work for the exact recorded turn without exposing lifecycle rows', async () => {
  const { w, append } = await boot([{ seq: 1, time: T0, source: 'extension', kind: 'turn_start', turnId: 'held-turn' }]);
  expect(w.document.getElementById('chatState')!.textContent).toMatch(/^Working for /);
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({ ok: true, data: { sessionId: id, automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null } });
  await append([{ seq: 2, time: T0 + 65_000, source: 'extension', kind: 'turn_end', turnId: 'held-turn', outcome: 'completed' }]);
  expect(w.document.getElementById('chatState')!.textContent).toBe('Worked for 1m 5s');
});


/**
 * A chat whose page stopped reporting turns still says it is working.
 *
 * Every branch of this caption needs a turn to describe, and a page that stopped reporting
 * supplies none — so the line either fell silent or went on describing the previous turn as
 * finished while the chat kept working. Measured on 2026-09-25: a conversation resumed after an
 * automatic compaction made 650 exactly attributed tool calls over two and a half hours with no
 * turn reported by its page, and the app said nothing about any of it. The person then sits in
 * front of a chat that looks idle and waits for work that is already happening.
 *
 * The recorded tool clock is what the page is not: `lastToolCallAt` comes from calls the
 * request-id join has already tied to this exact conversation.
 */
it('says a chat is working when its page reports no turn but its tools keep arriving', async () => {
  const ended: SessionEvent[] = [
    { seq: 1, time: T0, source: 'extension', kind: 'turn_start', turnId: 'page-turn' },
    { seq: 2, time: T0 + 5_000, source: 'extension', kind: 'turn_end', turnId: 'page-turn', outcome: 'completed' }
  ];
  const row = { ...summary(ended), lastToolCallAt: null as number | null };
  const { w, append } = await boot(ended, true, [], [], { sessions: [row] });
  // No turn from the page's side, which is the whole subject.
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({ ok: true,
    data: { sessionId: id, automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null } });
  const note = w.document.getElementById('chatState')!;

  // The turn the page did report is over, and nothing has happened since.
  await append([]);
  expect(note.textContent).toBe('Worked for 5s');

  row.lastToolCallAt = Date.now() - 20_000;
  await append([]);
  expect(note.textContent, 'a blind chat still claimed to be finished').toBe('Working…');
  expect(note.classList.contains('is-working')).toBe(true);

  // Old enough to be the record of a chat that has since stopped: the caption lets go again.
  row.lastToolCallAt = Date.now() - 10 * 60_000;
  await append([]);
  expect(note.textContent).toBe('Worked for 5s');
});

it('says a chat worked as soon as its page reports the end after its last tool call', async () => {
  // A normal turn: tools run, then the page reports the end. The last call is recent, but the
  // reported end is newer, so nothing is unaccounted for and the caption must not wait out
  // the blind window.
  const start = Date.now() - 40_000;
  const turn: SessionEvent[] = [
    { seq: 1, time: start, source: 'extension', kind: 'turn_start', turnId: 'page-turn' },
    { seq: 2, time: start + 38_000, source: 'extension', kind: 'turn_end', turnId: 'page-turn', outcome: 'completed' }
  ];
  const row = { ...summary(turn), lastToolCallAt: start + 33_000 as number | null };
  const { w, append } = await boot(turn, true, [], [], { sessions: [row] });
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({ ok: true,
    data: { sessionId: id, automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null } });
  const note = w.document.getElementById('chatState')!;
  await append([]);
  expect(note.textContent).toBe('Worked for 38s');
  expect(note.classList.contains('is-working')).toBe(false);

  // A call after that reported end is still work the page has not accounted for.
  row.lastToolCallAt = start + 39_000;
  await append([]);
  expect(note.textContent).toBe('Working…');
});

it('stops directly from the empty composer without a second Stop menu action', async () => {
  const { w } = await boot([]);
  const stop = vi.fn(async () => ({ ok: true, data: {} }));
  (w as any).api.stopSessionTurn = stop;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const send = w.document.getElementById('chatSend') as HTMLButtonElement;
  expect(send.getAttribute('aria-label')).toBe('Stop turn');
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle(); expect(stop).not.toHaveBeenCalled();
  input.value = 'Keep this draft'; input.dispatchEvent(new w.Event('input'));
  expect(send.getAttribute('aria-label')).toBe('Send message');
  expect(w.document.getElementById('sendOptions')!.hidden).toBe(false);
  expect(w.document.getElementById('stopTurnAction')).toBeNull();
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  expect(w.document.getElementById('sendOptions')!.hidden).toBe(false);
  send.click();
  await settle();
  expect(stop).toHaveBeenCalledWith('2026-09-02-test0001', 'held-turn');
  expect(input.value).toBe('');
});

it('offers Stop for a turn the page still holds after the app stopped counting it as work, without saying Working (2.1.47 round)', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  const stop = vi.fn(async () => ({ ok: true, data: {} }));
  api.stopSessionTurn = stop;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { sessionId: id, conversationId: 'chat-a', automation: 'off', objective: '',
    activeTurnId: null, heldTurnId: 'page-held-turn', finishHeld: false, blocked: '', job: null } });
  await append([]); await append([]);
  const send = w.document.getElementById('chatSend') as HTMLButtonElement;
  expect(send.dataset.action).toBe('stop');
  expect(send.getAttribute('aria-label')).toBe('Stop turn');
  expect(w.document.getElementById('chatState')!.classList.contains('is-working')).toBe(false);
  send.click();
  await settle();
  expect(stop).toHaveBeenCalledWith('2026-09-02-test0001', 'page-held-turn');
  // Nothing held: the ordinary Send.
  api.getSessionControls = async (id: string) => ({ ok: true, data: { sessionId: id, conversationId: 'chat-a', automation: 'off', objective: '',
    activeTurnId: null, heldTurnId: null, finishHeld: false, blocked: '', job: null } });
  await append([]); await append([]);
  expect(send.dataset.action).toBe('send');
});

it('stops a held turn from the button with Plan armed, and stops nothing else when that turn changed meanwhile (CodeRabbit)', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  const stop = vi.fn(async () => ({ ok: true, data: {} }));
  const plan = vi.fn(async () => ({ ok: true, data: null }));
  api.stopSessionTurn = stop; api.draftTaskPlan = plan;
  const controls = (turns: { activeTurnId: string | null; heldTurnId: string | null }) => async (id: string) => ({ ok: true,
    data: { sessionId: id, conversationId: 'chat-a', automation: 'off', objective: '', finishHeld: false, blocked: '', job: null, ...turns } });
  api.getSessionControls = controls({ activeTurnId: null, heldTurnId: 'page-held-turn' });
  await append([]); await append([]);
  (w.document.getElementById('createPlan') as HTMLButtonElement).click();
  await settle();
  const send = w.document.getElementById('chatSend') as HTMLButtonElement;
  expect(send.dataset.action).toBe('stop');
  send.click(); await settle();
  expect(stop).toHaveBeenCalledWith('2026-09-02-test0001', 'page-held-turn');
  expect(plan).not.toHaveBeenCalled();
  // Shown for the held turn, but by the time it is read again a different turn runs: that one is not stopped.
  stop.mockClear();
  api.getSessionControls = controls({ activeTurnId: 'replacement-turn', heldTurnId: null });
  send.click(); await settle();
  expect(stop).not.toHaveBeenCalled();
});

describe('Esc in the empty composer during a turn', () => {
  const esc = (w: JSDOM['window'], init: KeyboardEventInit = {}) => {
    const event = new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });
    w.document.getElementById('chatInput')!.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const status = (w: JSDOM['window']) => w.document.getElementById('composerStatus')!.textContent;

  it('stops the running turn on a second Esc, and only says so on the first', async () => {
    const { w } = await boot([]);
    const stop = vi.fn(async () => ({ ok: true, data: {} }));
    (w as any).api.stopSessionTurn = stop;
    expect(esc(w)).toBe(true);
    await settle();
    expect(stop).not.toHaveBeenCalled();
    expect(status(w)).toBe('Press Esc again to stop the turn');
    expect(esc(w)).toBe(true);
    await settle();
    expect(stop).toHaveBeenCalledWith('2026-09-02-test0001', 'held-turn');
    expect(status(w)).toBe('');
  });

  it.each([false, true])('stops the turn it was pressed for before the controls are read again (Plan armed: %s)', async (armPlan) => {
    const { w, live } = await boot([]);
    const api = (w as any).api;
    const stop = vi.fn(async () => ({ ok: true, data: {} }));
    api.stopSessionTurn = stop;
    const plan = vi.fn(async () => ({ ok: true, data: null }));
    api.draftTaskPlan = plan;
    if (armPlan) (w.document.getElementById('createPlan') as HTMLButtonElement).click();
    await settle();
    expect(w.document.getElementById('chatSend')!.dataset.action).toBe('stop');
    // A turn the window has not seen yet: Stop goes to the turn on screen, not to whatever a reread finds.
    const controls = api.getSessionControls;
    api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await controls(id)).data, activeTurnId: 'unseen-turn' } });
    esc(w); esc(w);
    await settle();
    expect(stop).toHaveBeenCalledWith('2026-09-02-test0001', 'held-turn');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(plan).not.toHaveBeenCalled();
    expect(live.sent).toEqual([]);
  });

  it('disarms on the arrows prompt recall takes, even when they leave the composer empty again', async () => {
    const asked = [{ kind: 'user_message', seq: 1, time: T0 + 1000, source: 'extension', turnId: 't1', messageId: 'q-1', message: text('An earlier question') },
      { kind: 'assistant_message', seq: 2, time: T0 + 2000, source: 'extension', turnId: 't1', messageId: 'a-2', message: text('An answer'), final: true, state: 'final' }] as SessionEvent[];
    const { w } = await boot(asked);
    const stop = vi.fn(async () => ({ ok: true, data: {} }));
    (w as any).api.stopSessionTurn = stop;
    const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
    const arrow = (key: string) => { const event = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }); input.dispatchEvent(event); return event.defaultPrevented; };
    esc(w);
    expect(arrow('ArrowUp')).toBe(true);
    expect(input.value).toBe('An earlier question');
    input.setSelectionRange(input.value.length, input.value.length);
    expect(arrow('ArrowDown')).toBe(true);
    expect(input.value).toBe('');
    expect(status(w)).toBe('');
    // A fresh first press: it only asks.
    expect(esc(w)).toBe(true);
    await settle();
    expect(stop).not.toHaveBeenCalled();
    expect(status(w)).toBe('Press Esc again to stop the turn');
  });

  it('does not let an Esc armed for one turn stop the next turn', async () => {
    const { w, append } = await boot([]);
    const api = (w as any).api;
    const stop = vi.fn(async () => ({ ok: true, data: {} }));
    api.stopSessionTurn = stop;
    esc(w);
    const controls = api.getSessionControls;
    api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await controls(id)).data, activeTurnId: 'next-turn' } });
    await append([]);
    expect(w.document.getElementById('chatSend')!.dataset.action).toBe('stop');
    // The press after the new turn started only asks again; the next one stops that turn.
    expect(esc(w)).toBe(true);
    await settle();
    expect(stop).not.toHaveBeenCalled();
    expect(status(w)).toBe('Press Esc again to stop the turn');
    esc(w);
    await settle();
    expect(stop).toHaveBeenCalledWith('2026-09-02-test0001', 'next-turn');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('does not stop for Esc with a draft, a held Esc, a key between, modifiers or a late second Esc', async () => {
    const { w } = await boot([]);
    const stop = vi.fn(async () => ({ ok: true, data: {} }));
    (w as any).api.stopSessionTurn = stop;
    const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
    input.value = 'Keep this draft'; input.dispatchEvent(new w.Event('input'));
    expect(esc(w)).toBe(false); esc(w);
    expect(status(w)).toBe('');
    input.value = ''; input.dispatchEvent(new w.Event('input'));
    esc(w); esc(w, { repeat: true }); esc(w, { repeat: true });
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Shift', bubbles: true, cancelable: true }));
    expect(status(w)).toBe('');
    esc(w); expect(esc(w, { ctrlKey: true })).toBe(false);
    const now = performance.now.bind(performance);
    let skew = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now() + skew);
    try {
      esc(w); skew = 1_600;
      // Too late to stop: this press only asks again.
      expect(esc(w)).toBe(true);
      expect(status(w)).toBe('Press Esc again to stop the turn');
    } finally { clock.mockRestore(); }
    await settle();
    expect(stop).not.toHaveBeenCalled();
  });
});

it('shows Stop immediately for a queued first send, switches to Send for a new draft, and cancels through the same button', async () => {
  const { w, live } = await boot([], false);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const send = w.document.getElementById('chatSend') as HTMLButtonElement;
  const form = w.document.getElementById('composer')!;
  input.value = 'First request';
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  expect(send.dataset.action).toBe('stop');
  expect(send.disabled).toBe(false);
  await settle();
  expect(send.dataset.action).toBe('stop');
  expect(w.document.querySelector('#inputQueue button')?.textContent).not.toBe('Cancel');
  input.value = 'Second request'; input.dispatchEvent(new w.Event('input'));
  expect(send.dataset.action).toBe('send');
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  expect(send.dataset.action).toBe('stop');
  const cancel = vi.fn(async (id: string) => { live.inputs = live.inputs.map(row => row.id === id ? { ...row, state: 'cancelled' } : row); return { ok: true, data: true }; });
  (w as any).api.cancelInput = cancel;
  send.click();
  await settle();
  expect(cancel).toHaveBeenCalledWith(live.sent[0]!.id);
  expect(send.dataset.action).toBe('send');
});

it('opens the saved task editor from the Goal dock and still closes it on outside clicks', async () => {
  const { w } = await boot([]);
  (w.document.querySelector('#automationSwitch [data-mode="goal"]') as HTMLButtonElement).click();
  await settle();
  const menu = w.document.getElementById('composerSettings') as HTMLDetailsElement;
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  const edit = w.document.querySelector('#activeGoalRow button[aria-label="Edit task"]') as HTMLButtonElement;
  expect(edit).not.toBeNull();
  menu.open = false;
  edit.click();
  expect(menu.open).toBe(true);
  expect(w.document.activeElement).toBe(objective);
  w.document.body.click();
  expect(menu.open).toBe(false);
  await settle();
});

it.each(['off', 'goal', 'loop'])('retains the first-message draft and task across chat navigation (%s)', async mode => {
  const { w, live } = await boot([], false, [], [], { reserveOpenings: true });
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  const automation = w.document.getElementById('chatAutomation') as HTMLSelectElement;
  const delivery = w.document.getElementById('loopDelivery') as HTMLSelectElement;
  (w.document.querySelector(`#automationSwitch [data-mode="${mode}"]`) as HTMLButtonElement).click();
  input.value = 'First message\nwith pasted context'; input.dispatchEvent(new w.Event('input'));
  objective.value = 'Keep the original task'; objective.dispatchEvent(new w.Event('input'));
  delivery.value = 'after-turn'; delivery.dispatchEvent(new w.Event('change'));
  const visitExisting = () => (w.document.querySelector(`[data-id="${summary([]).id}"]`) as HTMLButtonElement).click();
  const returnToDraft = () => w.document.getElementById('newChat')!.click();
  visitExisting(); await settle();
  expect(input.value).toBe('');
  input.value = 'Separate existing-chat draft';
  returnToDraft(); await settle();
  returnToDraft(); await settle();
  expect(input.value).toBe('First message\nwith pasted context');
  expect(objective.value).toBe('Keep the original task');
  expect(automation.value).toBe(mode);
  expect(delivery.value).toBe('after-turn');
  visitExisting(); await settle();
  expect(input.value).toBe('Separate existing-chat draft');
  returnToDraft(); await settle();
  input.value = ''; objective.value = '';
  visitExisting(); returnToDraft(); await settle();
  expect(input.value).toBe(''); expect(objective.value).toBe('');
  input.value = 'Actually send this';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.sent.at(-1)).toMatchObject({ text: 'Actually send this', automation: mode });
  returnToDraft(); await settle();
  expect(input.value).toBe(''); expect(objective.value).toBe(''); expect(automation.value).toBe('off');
});

it('retains the New Chat objective through Goal, Off and Goal toggles', async () => {
  const { w } = await boot([], false);
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Build and verify the requested feature';
  objective.dispatchEvent(new w.Event('input'));
  for (const mode of ['goal', 'off', 'goal']) {
    (w.document.querySelector(`#automationSwitch [data-mode="${mode}"]`) as HTMLButtonElement).click();
    await settle();
    expect(objective.value).toBe('Build and verify the requested feature');
    expect(objective.hidden).toBe(mode === 'off');
    expect(w.document.getElementById('saveSessionObjective')!.hidden).toBe(mode === 'off');
    expect((w.document.getElementById('chatAutomation') as HTMLSelectElement).value).toBe(mode);
  }
  expect(w.document.getElementById('clearSessionObjective')).toBeNull();
  expect(w.document.getElementById('showHandoff')).toBeNull();
});

it('keeps editable stages and sends the original request with the full workflow exactly once', async () => {
  const { w, live } = await boot([], false);
  const api = (w as any).api;
  (await api.getState()).data.config.ui.finishTool = true;
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Build foundation', 'Verify it'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Build the whole task';
  input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(0);
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toMatch(/Start plan|Review stages/);
  const edit = w.document.querySelector<HTMLButtonElement>('[aria-label="Edit stage 1"]')!;
  edit.click();
  const stage = w.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit stage 1"]')!;
  stage.value = 'Build the edited foundation'; stage.dispatchEvent(new w.Event('input'));
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).toBe('Start full plan');
  (w.document.querySelector(`[data-id="${summary([]).id}"]`) as HTMLButtonElement).click();
  await settle();
  w.document.getElementById('newChat')!.click(); await settle();
  expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Build the edited foundation');
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ text: 'Build the edited foundation', stages: ['Verify it'], objective: 'Build the whole task', authoredSource: 'objective' });
  expect(w.document.getElementById('taskPlanPreview')!.hidden).toBe(true);
  expect(w.document.getElementById('finishQueue')!.hidden).toBe(false);
  expect(w.document.getElementById('finishQueue')!.textContent).toContain('Verify it');
  expect(w.document.querySelector('[aria-label="Plan stage · waiting for the first message to be sent"]')).not.toBeNull();
});

it.each([true, false])('hands plan presentation to queued stages while sending and restores a rejected draft (accepted=%s)', async accepted => {
  const { w, live, append } = await boot([], false);
  const api = (w as any).api;
  const stages = ['Define the build', 'Assign first worker', 'Assign second worker', 'Integrate', 'Verify', 'Acceptance'];
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: stages }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Build the whole task'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  const preview = w.document.getElementById('taskPlanPreview')!;
  expect(preview.hidden).toBe(false);
  expect(preview.querySelectorAll('.plan-stage')).toHaveLength(6);
  let finish!: (result: unknown) => void;
  let first!: InputEntry;
  api.sendInput = vi.fn((args: InputArgs) => {
    live.sent.push(args);
    first = { ...args, state: 'queued', owner: null, createdAt: Date.now(), conversationId: 'chat-b' };
    // An outbox observation can arrive before the original send IPC response. Its
    // checkpoint projection must not coexist with the editable six-stage draft.
    live.inputs = [first];
    return new Promise(resolve => { finish = resolve; });
  });
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await append([]);
  expect(preview.hidden).toBe(true);
  expect(preview.querySelectorAll('.plan-stage')).toHaveLength(0);
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(5);
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ text: stages[0], stages: stages.slice(1) });
  if (!accepted) live.inputs = [];
  finish(accepted ? { ok: true, data: first } : { ok: false, error: 'Fixture send rejected' });
  await settle();
  expect(preview.hidden).toBe(accepted);
  expect(preview.querySelectorAll('.plan-stage')).toHaveLength(accepted ? 0 : 6);
  if (!accepted) expect(input.value).toBe('');
});

it.each(['delivery', 'model', 'refresh-failed', 'enqueue-failed'])('retries the durable full plan without pasting stage one (%s)', async failure => {
  const { w, live, append } = await boot([], true);
  const api = (w as any).api;
  const original: InputEntry = { id: 'failed-plan', sessionId: summary([]).id, requestedSessionId: null, opening: true, projectId: null, text: 'Implement everything',
    objective: 'Original complete request', stages: ['Verify gameplay', 'Verify voice', 'Final review'], automation: 'off',
    model: 'gpt-5.6-sol', reasoningEffort: 'high', mode: 'auto', dueAt: 1, createdAt: 1, state: 'failed',
    owner: 'old-page', conversationId: null, error: failure === 'model' || failure === 'refresh-failed'
      ? 'Requested model or reasoning could not be confirmed' : 'Delivery failed' };
  live.inputs = [original]; await append([]);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'An independent draft'; input.dispatchEvent(new w.Event('input'));
  api.requestChatModels = vi.fn(async () => ({ ok: true, data: failure === 'refresh-failed'
    ? { state: 'unavailable', models: [], error: 'Unavailable' }
    : { state: 'ready', models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['high'] }] } }));
  if (failure === 'enqueue-failed') api.sendInput = vi.fn(async () => ({ ok: false, error: 'Connection failed' }));
  const retry = w.document.querySelector<HTMLButtonElement>('[aria-label="Retry delivery"]')!;
  retry.click(); retry.click(); await settle(); await append([]);
  expect(input.value).toBe('An independent draft');
  if (failure === 'refresh-failed' || failure === 'enqueue-failed') {
    expect(live.sent).toHaveLength(0);
    expect(w.document.querySelector('[aria-label="Retry delivery"]')).not.toBeNull();
    expect(live.inputs[0]!.stages).toEqual(original.stages);
    expect(w.localStorage.getItem('dismissed-input-notices') ?? '').not.toContain(original.id);
  } else {
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0]).toMatchObject({ text: original.text, objective: original.objective, stages: original.stages,
      automation: 'off', model: original.model, reasoningEffort: 'high', mode: 'auto' });
    expect(live.sent[0]!.id).not.toBe(original.id);
    expect(live.sent[0]).not.toHaveProperty('owner');
    expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(3);
  }
  expect(api.requestChatModels).toHaveBeenCalledTimes(failure === 'model' || failure === 'refresh-failed' ? 1 : 0);
});

it('the Plan toggle only arms planning; Send generates from the draft', async () => {
  const { w } = await boot([], false);
  const api = (w as any).api;
  api.draftTaskPlan = vi.fn(() => new Promise(() => {}));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const plan = w.document.getElementById('createPlan') as HTMLButtonElement;
  input.value = 'Existing draft'; input.dispatchEvent(new w.Event('input'));
  plan.click(); await settle();
  expect(api.draftTaskPlan).not.toHaveBeenCalled();
  expect(plan.getAttribute('aria-pressed')).toBe('true');
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  expect(plan.getAttribute('aria-pressed')).toBe('true');
  input.value = 'Plan this'; input.dispatchEvent(new w.Event('input'));
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', cancelable: true })); await settle();
  expect(api.draftTaskPlan).toHaveBeenCalledWith('Plan this', expect.anything(), expect.any(String));
});

it('the mode-menu pencil edits an objective without switching automation until Save', async () => {
  const { w, live } = await boot([]);
  const api = (w as any).api;
  api.setSessionObjective = vi.fn(async () => ({ ok: true, data: {} }));
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  (w.document.querySelector('#automationSwitch [data-edit-mode="goal"]') as HTMLButtonElement).click(); await settle();
  expect(live.controlCalls).toEqual([]);
  expect((w.document.getElementById('chatAutomation') as HTMLSelectElement).value).toBe('off');
  expect(objective.hidden).toBe(false);
  expect(w.document.activeElement).toBe(objective);
  expect(w.document.querySelector('label[for="sessionObjective"]')!.textContent).toBe('Goal');
  objective.value = 'Ship the dashboard'; objective.dispatchEvent(new w.Event('input'));
  w.document.getElementById('saveSessionObjective')!.click(); await settle();
  expect(api.setSessionObjective).toHaveBeenCalledWith(summary([]).id, 'Ship the dashboard', 'goal');
  expect(live.controlCalls).toEqual([]);
  expect((w.document.getElementById('composerSettings') as HTMLDetailsElement).open).toBe(false);
});

it('disables empty task actions and confirms saving without the old helper sentence', async () => {
  const { w } = await boot([], false);
  const save = w.document.getElementById('saveSessionObjective') as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  const plan = w.document.getElementById('createPlan') as HTMLButtonElement;
  plan.click();
  expect(w.document.activeElement?.id).toBe('chatInput');
  expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).placeholder).toContain('plan');
  expect(w.document.getElementById('chatSend')!.title).toBe('Click to generate plan');
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).toBe('Generate plan');
  expect(plan.getAttribute('aria-pressed')).toBe('true');
  plan.click();
  expect(plan.getAttribute('aria-pressed')).toBe('false');
  expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).placeholder).toBe('Ask anything…');
  expect(w.document.getElementById('chatSend')!.title).toBe('');
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Implement and verify'; objective.dispatchEvent(new w.Event('input'));
  expect(save.disabled).toBe(false); save.click(); await settle();
  expect(save.textContent).toContain('Saved'); expect(save.disabled).toBe(true);
  expect(w.document.getElementById('sessionControlStatus')!.textContent).toBe('');
  objective.value += ' everything'; objective.dispatchEvent(new w.Event('input'));
  expect(save.disabled).toBe(false); expect(save.textContent).not.toContain('Saved');
});


it('omits the selected worker identity but retains a different sender', async () => {
  const events: SessionEvent[] = [
    { seq: 1, time: T0, source: 'extension', kind: 'assistant_message', agent: 'worker-2', message: text('Own reply'), final: true },
    { seq: 2, time: T0 + 1, source: 'extension', kind: 'assistant_message', agent: 'worker-3', message: text('Other reply'), final: true }
  ];
  const { w } = await boot(events, true, [], [], { origin: { kind: 'worker', agentId: 'worker-2', fromSessionId: 'parent', task: 'Audit' } });
  const labels = [...w.document.querySelectorAll('.ev-body > .chip')].map(el => el.textContent);
  expect(labels).toEqual(['worker-3']);
  expect(w.document.querySelector('.timeline')?.textContent ?? w.document.body.textContent).toContain('Own reply');
});

it('renders one legacy interrupted-response card across reloads and updates it after completion', async () => {
  const error: SessionEvent = { seq: 2, time: T0 + 2, source: 'extension', kind: 'chat_error', turnId: 'original', recoverable: true, message: text('Connection interrupted') };
  const { w, append } = await boot([
    { seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'question', message: text('Build') },
    error, { ...error, seq: 3, turnId: undefined }, { ...error, seq: 4, turnId: 'replacement' },
    { seq: 5, time: T0 + 5, source: 'app', kind: 'progress', turnId: 'replacement', progressId: 'browser-repair:test', message: text('Reloaded chat') }
  ]);
  expect(w.document.querySelectorAll('.chat-error-notice')).toHaveLength(1);
  expect(w.document.querySelector('.chat-error-notice')!.textContent).toContain('Reloaded chat');
  expect(w.document.querySelector('.chat-error-notice')!.classList.contains('is-resolved')).toBe(false);
  await append([{ seq: 6, time: T0 + 6, source: 'extension', kind: 'assistant_message', final: true, messageId: 'answer', message: text('Done') }]);
  expect(w.document.querySelectorAll('.chat-error-notice')).toHaveLength(1);
  expect(w.document.querySelector('.chat-error-notice')!.textContent).toContain('later completed');
  expect(w.document.querySelector('.chat-error-notice')!.classList.contains('is-resolved')).toBe(true);
  expect(w.document.querySelector('.chat-error-notice strong')!.textContent).toBe('Recovered after interruption');
  await append([{ seq: 7, time: T0 + 7, source: 'app', kind: 'turn_start', turnId: 'replacement' }]);
  expect(w.document.querySelector('.chat-error-notice')!.classList.contains('is-resolved')).toBe(false);
  expect(w.document.querySelector('.chat-error-notice')!.textContent).toContain('Work continued');
});

it('explicitly queues an image injection before the first MCP call without choosing browser delivery', async () => {
  const app = await boot([]);
  const api = (app.w as any).api;
  api.getSessionControls = async () => ({ ok: true, data: { sessionId: summary([]).id,
    activeTurnId: 'plain-turn', canInject: false, canSendDirectly: true, queueAtFinish: false } });
  await app.append([]);
  const image = { id: '11111111-2222-4333-8444-555555555555', name: 'image.png', mimeType: 'image/png', size: 42 };
  api.chooseFiles = async () => ({ ok: true, data: [image] });
  app.w.document.getElementById('attachImages')!.click(); await settle();
  const action = app.w.document.querySelector('[data-delivery="tool"]') as HTMLButtonElement;
  expect(action.hidden).toBe(false); action.click();
  (app.w.document.getElementById('chatInput') as HTMLTextAreaElement).value = 'Describe this image';
  app.w.document.getElementById('composer')!.dispatchEvent(new app.w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(app.live.sent).toHaveLength(1);
  expect(app.live.sent[0]).toMatchObject({ mode: 'auto', delivery: 'tool', text: 'Describe this image', attachments: [image] });
});

it('docks recent app repair progress without hiding authored lookalikes', async () => {
  const events: SessionEvent[] = [
    { seq: 1, time: Date.now(), source: 'app', kind: 'progress', progressId: 'browser-repair:test', message: text('Restored the browser connection') },
    { seq: 2, time: Date.now(), source: 'extension', kind: 'assistant_message', message: text('Reopened chat to recover a missing browser tab.'), final: true }
  ];
  const { w } = await boot(events);
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(false);
  expect(w.document.getElementById('recoveryStatus')!.textContent).toContain('Restored the browser connection');
  expect(w.document.querySelectorAll('.ev-progress')).toHaveLength(0);
  expect(w.document.querySelector('.ev-assistant_message')!.textContent).toContain('Reopened chat');
  w.document.getElementById('newChat')!.click();
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(true);
});

it('translates the historical approval deferral in the timeline and recovery notice', async () => {
  const { w } = await boot([{ seq: 1, time: Date.now(), source: 'app', kind: 'progress',
    progressId: 'browser-repair:approval-deferred',
    message: text('Reload was deferred because ChatGPT showed a tool approval card.') }], true, [], [], { developerMode: true });
  const { setLanguage } = await import('../src/renderer/i18n.js');
  try {
    setLanguage('es');
    const translated = 'Se pospuso la recarga porque ChatGPT mostró una tarjeta de aprobación de herramientas.';
    expect(w.document.querySelector('.ev-progress')!.textContent).toContain(translated);
    expect(w.document.getElementById('recoveryStatus')!.textContent).toContain(translated);
    expect(w.document.querySelector('.approval-wait')).toBeNull();
  } finally { setLanguage('en'); }
});

it('keeps historical repair details in developer mode without reviving a status', async () => {
  const { w } = await boot([{ seq: 1, time: T0, source: 'app', kind: 'progress', progressId: 'browser-repair:old', message: text('Historical repair') }], true, [], [], { developerMode: true });
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(true);
  expect(w.document.querySelector('.ev-progress')!.textContent).toContain('Historical repair');
});

it('keeps accepted pending-send Stop while the durable queue refresh is still in flight', async () => {
  const { w } = await boot([], false);
  const api = (w as any).api;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const send = w.document.getElementById('chatSend') as HTMLButtonElement;
  const form = w.document.getElementById('composer')!;
  const listings: Array<(value: any) => void> = [];
  api.listInputs = () => new Promise(resolve => listings.push(resolve));
  api.sendInput = async (value: InputArgs) => ({ ok: true, data: { ...value, state: 'queued', owner: null, createdAt: Date.now(), conversationId: null } });
  input.value = 'First request';
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  expect(send.dataset.action).toBe('stop');
  await settle();
  expect(send.dataset.action).toBe('stop');
  listings[0]!({ ok: true, data: [] });
  await settle();
  expect(send.dataset.action).toBe('stop');
});

it('dismisses only the displayed recovery revision and reveals a changed status or new incident', async () => {
  const time = Date.now();
  const repair: SessionEvent = { seq: 1, time, source: 'app', kind: 'progress', progressId: 'browser-repair:dismiss', message: text('Reloaded chat to recover an unresponsive open turn.') };
  const { w, append, live } = await boot([repair], true, [], [], { developerMode: true });
  const status = w.document.getElementById('recoveryStatus')!;
  const dismiss = () => (status.querySelector('[aria-label="Dismiss recovery notice"]') as HTMLButtonElement).click();
  expect(status.hidden).toBe(false); dismiss(); expect(status.hidden).toBe(true);
  expect(live.events).toEqual([repair]);
  expect(w.document.querySelector('.ev-progress')?.textContent).toContain('Reloaded chat');
  await append([]); expect(status.hidden).toBe(true);
  await append([{ ...repair, seq: 2, message: text('The browser connection is restored.') }]);
  expect(status.hidden).toBe(false); expect(status.textContent).toContain('connection is restored');
  dismiss(); await append([]); expect(status.hidden).toBe(true);
  await append([{ ...repair, seq: 3, progressId: 'browser-repair:new' }]);
  expect(status.hidden).toBe(false);
  expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).disabled).toBe(false);
});
