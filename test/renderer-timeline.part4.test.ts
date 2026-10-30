import { expect, it, vi } from 'vitest';
import { PLAYFUL_WORDS, T0, TOKEN, boot, dom, positionOf, projectTimeline, settle, settleHistoryFrame, summary, text, toolCall, waitFor, type InputArgs, type InputEntry, type SessionEvent } from './renderer-timeline.harness.js';

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


it('blocks an empty stage, deletes it explicitly, and hides the whole dock in settings', async () => {
  const { w, live } = await boot([], false);
  const api = (w as any).api;
  (await api.getState()).data.config.ui.finishTool = true;
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Write poem', 'Verify lines'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Rain poem'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  const stage = w.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit stage 1"]')!;
  stage.value = ''; stage.dispatchEvent(new w.Event('input'));
  expect(stage.getAttribute('aria-invalid')).toBe('true');
  expect((w.document.getElementById('chatSend') as HTMLButtonElement).disabled).toBe(true);
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle(); expect(live.sent).toHaveLength(0);
  w.document.querySelector<HTMLButtonElement>('[aria-label="Delete stage 1"]')!.click();
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(1);
  expect((w.document.getElementById('chatSend') as HTMLButtonElement).disabled).toBe(false);
  const chat = await import('../src/renderer/chat.js');
  chat.openChatView('settings');
  expect(w.document.getElementById('composerDock')!.hidden).toBe(true);
  chat.openChatView('timeline');
  expect(w.document.getElementById('composerDock')!.hidden).toBe(false);
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(1);
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle(); expect(live.sent[0]).toMatchObject({ text: 'Verify lines', stages: [] });
});

it('cancels pending planning without replacing the draft with a late result', async () => {
  const { w, live, progress } = await boot([], false);
  const api = (w as any).api;
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  (await api.getState()).data.config.ui.finishTool = true;
  let finish!: (value: unknown) => void;
  api.draftTaskPlan = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Keep this draft';
  const plan = w.document.getElementById('createPlan') as HTMLButtonElement;
  plan.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  const requestId = api.draftTaskPlan.mock.calls[0][2];
  expect(plan.getAttribute('aria-pressed')).toBe('true');
  plan.click();
  expect(api.cancelTaskRequest).toHaveBeenCalledWith(requestId);
  progress({ requestId, phase: 'generating', text: 'Stale cancelled plan' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toContain('Stale cancelled plan');
  finish({ ok: true, data: ['First', 'Second'] }); await settle();
  expect(input.value).toBe('Keep this draft');
  expect(plan.getAttribute('aria-pressed')).toBe('false');
  expect(w.document.getElementById('taskPlanPreview')!.hidden).toBe(true);
  expect(live.sent).toHaveLength(0);
});

// 2.1.41 bug hunt: a ready plan had already taken the request out of the composer, so Cancel plan
// (whose tooltip promises to keep the draft) or deleting its last stage lost the request outright.
it('gives the request back to the composer when a ready plan is cancelled or its last stage deleted', async () => {
  const { w, live } = await boot([], false);
  const api = (w as any).api;
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Write it', 'Check it'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const plan = w.document.getElementById('createPlan') as HTMLButtonElement;
  const prepare = async (text: string) => {
    input.value = text; input.dispatchEvent(new w.Event('input'));
    plan.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
    expect(input.value).toBe('');
    expect(w.document.querySelectorAll('#taskPlanPreview .plan-stage')).toHaveLength(2);
  };
  await prepare('Write a poem about a lighthouse');
  plan.click(); await settle();
  expect(plan.getAttribute('aria-pressed')).toBe('false');
  expect(input.value).toBe('Write a poem about a lighthouse');

  input.value = ''; input.dispatchEvent(new w.Event('input'));
  await prepare('Write a song about the sea');
  for (let i = 0; i < 2; i++) (w.document.querySelector('#taskPlanPreview .plan-stage [aria-label^="Delete stage"]') as HTMLButtonElement).click();
  await settle();
  expect(plan.getAttribute('aria-pressed')).toBe('false');
  expect(input.value).toBe('Write a song about the sea');

  // Something typed since stays; the request does not overwrite it.
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  await prepare('Write a limerick');
  input.value = 'A newer thought'; input.dispatchEvent(new w.Event('input'));
  plan.click(); await settle();
  expect(input.value).toBe('A newer thought');
  expect(live.sent).toHaveLength(0);
});

it('keeps completed stages after clearing or replacing the composer until explicitly deleted', async () => {
  const { w, live } = await boot([], false);
  const api = (w as any).api;
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Build foundation', 'Verify it'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Build the whole task'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  for (const replacement of ['', 'Unrelated next message', '']) {
    input.value = replacement; input.dispatchEvent(new w.Event('input'));
    expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(2);
    expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Verify it');
  }
  expect(live.sent).toHaveLength(0);
  w.document.querySelector<HTMLButtonElement>('[aria-label="Delete stage 1"]')!.click();
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(1);
  w.document.querySelector<HTMLButtonElement>('[aria-label="Delete stage 1"]')!.click();
  expect(w.document.getElementById('taskPlanPreview')!.hidden).toBe(true);
});

it('queues every generated stage in an existing session without Send and preserves them after clearing the composer', async () => {
  const { w, live } = await boot([]);
  const api = (w as any).api;
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Build foundation', 'Verify it'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Build the whole task'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ sessionId: summary([]).id, text: 'Build foundation', stages: ['Verify it'], mode: 'finish', model: null, reasoningEffort: null, authoredSource: 'objective' });
  expect(input.value).toBe('');
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(2);
  expect(w.document.querySelectorAll('[aria-label="Remove queued task"]')).toHaveLength(2);
  expect(w.document.getElementById('taskPlanPreview')!.hidden).toBe(true);
  api.cancelInput = vi.fn(async (id: string) => { live.inputs = live.inputs.filter(row => row.id !== id); return { ok: true, data: true }; });
  w.document.querySelector<HTMLButtonElement>('[aria-label="Remove queued task"]')!.click(); await settle();
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(1);
  expect(w.document.getElementById('finishQueue')!.textContent).toContain('Verify it');
  expect(live.sent).toHaveLength(1);
});

// #1428: in a chat with nothing running, the plan used to be queued "at Session finish" right
// away, and Session finish only comes at the end of a turn. Nothing started until the person
// sent some other message.
it('shows the plan in an idle chat and starts it with Enter, like in a new chat', async () => {
  const { w, live } = await boot([]);
  const api = (w as any).api;
  api.getSessionControls = (id: string) => Promise.resolve({ ok: true, data: { sessionId: id, conversationId: 'chat-a', automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null } });
  // Selected again, so the chat's state is read with nothing running.
  w.document.getElementById('newChat')!.click(); await settle();
  (w.document.querySelector(`[data-id="${summary([]).id}"]`) as HTMLButtonElement).click(); await settle();
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Build foundation', 'Verify it'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Build the whole task'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  // Written out for review, not queued behind a turn that will not come.
  expect(live.sent).toHaveLength(0);
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(2);
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).toBe('Start full plan');
  expect(w.document.querySelector('.plan-stage-heading')!.getAttribute('title')).not.toMatch(/Session finish/);
  input.focus();
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ sessionId: summary([]).id, text: 'Build foundation', stages: ['Verify it'], objective: 'Build the whole task', authoredSource: 'objective', mode: 'auto' });
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(0);
});

it('retries a materialized finish checkpoint without recreating its already independent siblings', async () => {
  const { w, live, append } = await boot([]);
  live.inputs = [{ id: 'failed-first-checkpoint', sessionId: summary([]).id, text: 'Retry just this checkpoint', stages: ['Deleted sibling'],
    stagesApplied: true, mode: 'finish', dueAt: 0, model: null, reasoningEffort: null, state: 'failed', owner: null,
    createdAt: 0, conversationId: 'chat-b', error: 'Provider rejected opted-in after-turn delivery' }];
  await append([]);
  w.document.querySelector<HTMLButtonElement>('[aria-label="Retry delivery"]')!.click(); await settle();
  expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).value).toBe('Retry just this checkpoint');
  expect(live.sent).toHaveLength(0);
  expect(w.document.getElementById('finishQueue')!.hidden).toBe(true);
});

it('retains a rejected queue admission independently of composer edits and retries as finish only', async () => {
  const { w, live } = await boot([]);
  const api = (w as any).api, send = api.sendInput;
  let reject!: (value: unknown) => void;
  api.sendInput = vi.fn(() => new Promise(resolve => { reject = resolve; }));
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['First checkpoint', 'Last checkpoint'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Plan the remaining checks';
  w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  reject({ ok: false, error: 'Queue full' }); await settle();
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(2);
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).toBe('Queue plan at Session finish');
  api.sendInput = send;
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ mode: 'finish', text: 'First checkpoint', stages: ['Last checkpoint'] });
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(2);
  expect(input.value).toBe('');
});

it.each([false, true])('clears the planner prompt and starts a new-chat plan with Enter from the empty composer (pro=%s)', async pro => {
  const { w, live } = await boot([], false, [], [], { pro });
  const effort = w.document.getElementById('composerReasoning') as HTMLSelectElement;
  effort.value = pro ? 'pro' : 'high'; effort.dispatchEvent(new w.Event('change')); await settle();
  (w as any).api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Build foundation', 'Verify it'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Original objective';
  w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  expect(input.value).toBe('');
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true }));
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, cancelable: true }));
  await settle(); expect(live.sent).toHaveLength(0);
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', cancelable: true })); await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ objective: 'Original objective', text: 'Build foundation', stages: ['Verify it'], reasoningEffort: pro ? 'pro' : 'high' });
  // While it is delivered, the message shows what the person wrote, as it will once recorded.
  await settle();
  expect([...w.document.querySelectorAll('.pending-message-text')].map(node => node.textContent)).toEqual(['Original objective']);
});

it('does not erase a new composer draft while completed-plan queue admission is pending', async () => {
  const { w } = await boot([]);
  const api = (w as any).api, send = api.sendInput;
  let admit!: () => Promise<void>;
  api.sendInput = vi.fn((args: InputArgs) => new Promise(resolve => { admit = async () => resolve(await send(args)); }));
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['First checkpoint', 'Last checkpoint'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Planner request';
  w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  expect(input.value).toBe('');
  input.value = 'My next correction'; input.dispatchEvent(new w.Event('input'));
  await admit(); await settle();
  expect(input.value).toBe('My next correction');
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(2);
});

it('clearing the complete planner task cancels generation and restores Create plan', async () => {
  const { w, live } = await boot([], false);
  const api = (w as any).api;
  (await api.getState()).data.config.ui.finishTool = true;
  let finish!: (value: unknown) => void;
  api.draftTaskPlan = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Write a poem'; w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  expect(api.cancelTaskRequest).toHaveBeenCalled();
  expect(w.document.getElementById('createPlan')!.getAttribute('aria-pressed')).toBe('false');
  expect(w.document.getElementById('createPlan')!.textContent).toBe('Plan');
  expect(w.document.getElementById('createPlan')!.getAttribute('aria-label')).toBe('Create plan');
  finish({ ok: true, data: ['Old stage', 'Old check'] }); await settle();
  expect(live.sent).toHaveLength(0);
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(0);
});

it('routes an armed empty-composer plan through the planner and paints only its live progress', async () => {
  const { w, live, progress } = await boot([], false);
  const api = (w as any).api;
  (await api.getState()).data.config.ui.finishTool = true;
  let finish!: (value: unknown) => void;
  api.draftTaskPlan = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  w.document.getElementById('createPlan')!.click();
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Create an SVG cat';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(0);
  expect(api.draftTaskPlan.mock.calls[0][0]).toBe('Create an SVG cat');
  const requestId = api.draftTaskPlan.mock.calls[0][2];
  progress({ requestId: 'another-request', phase: 'generating', text: 'Wrong work' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toContain('Wrong work');
  progress({ requestId, phase: 'generating', text: 'Design the SVG paths' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Design the SVG paths');
  progress({ requestId, phase: 'retrying', text: '', attempt: 2, retryAt: Date.now() + 30000, error: 'rate_limited' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Provider busy · retry 2');
  expect(w.document.getElementById('createPlan')!.getAttribute('aria-busy')).toBe('true');
  finish({ ok: true, data: ['Write SVG paths', 'Validate the SVG'] }); await settle();
  expect(live.sent).toHaveLength(0);
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ text: 'Write SVG paths', stages: ['Validate the SVG'] });
});

it('does not turn an empty or repeated form submission into a Stop request', async () => {
  const { w, live } = await boot([]);
  const api = (w as any).api;
  const stop = vi.fn(async () => ({ ok: true, data: {} }));
  api.stopSessionTurn = stop;
  const form = w.document.getElementById('composer')!;
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(stop).not.toHaveBeenCalled();
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'A single correction'; input.dispatchEvent(new w.Event('input'));
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(live.sent.map(row => row.text)).toEqual(['A single correction']);
  expect(stop).not.toHaveBeenCalled();
});

it('keeps actual-turn Stop through two authored sends and stops only the captured active turn', async () => {
  const { w, live } = await boot([]);
  const api = (w as any).api;
  const stop = vi.fn(async () => ({ ok: true, data: {} }));
  api.stopSessionTurn = stop;
  const cancel = vi.fn(async () => ({ ok: true, data: true }));
  api.cancelInput = cancel;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const send = w.document.getElementById('chatSend') as HTMLButtonElement;
  const form = w.document.getElementById('composer')!;
  for (const text of ['First new direction', 'Second new direction']) {
    expect(send.dataset.action).toBe('stop');
    input.value = text; input.dispatchEvent(new w.Event('input'));
    expect(send.dataset.action).toBe('send');
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    expect(send.dataset.action).toBe('stop');
    await settle();
    expect(send.dataset.action).toBe('stop');
  }
  expect(live.sent.map(row => row.text)).toEqual(['First new direction', 'Second new direction']);
  expect(live.sent.every(row => row.sessionId === '2026-09-02-test0001' && row.mode === 'auto')).toBe(true);
  // A queued follow-up does not replace the real active turn as Stop's authority.
  send.click();
  await settle();
  expect(stop).toHaveBeenCalledWith('2026-09-02-test0001', 'held-turn');
  expect(cancel).not.toHaveBeenCalled();
  expect(input.value).toBe('');
});

it('does not retarget an awaiting Stop after leaving and reselecting the same chat', async () => {
  const { w } = await boot([]);
  const api = (w as any).api;
  const baseControls = api.getSessionControls;
  const original = async (id: string) => ({ ok: true, data: { ...(await baseControls(id)).data,
    plan: { updatedAt: 2, plan: [{ step: 'Current plan', status: 'in_progress', details: 'Current selection' }] } } });
  const stop = vi.fn(async () => ({ ok: true, data: {} }));
  api.stopSessionTurn = stop;
  let resolve!: (value: any) => void;
  api.getSessionControls = () => new Promise(done => { resolve = done; });
  w.document.getElementById('chatSend')!.click();
  api.getSessionControls = original;
  w.document.getElementById('newChat')!.click();
  (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click();
  await settle();
  expect(w.document.getElementById('agentPlan')!.textContent).toContain('Current plan');
  resolve({ ok: true, data: { ...(await original('2026-09-02-test0001')).data,
    plan: { updatedAt: 1, plan: [{ step: 'Stale plan', status: 'pending' }] } } });
  await settle();
  expect(stop).not.toHaveBeenCalled();
  expect(w.document.getElementById('chatSend')!.dataset.action).toBe('stop');
  expect(w.document.getElementById('agentPlan')!.textContent).toContain('Current plan');
  expect(w.document.getElementById('agentPlan')!.textContent).not.toContain('Stale plan');
});

it('streams a new Goal opening, queues it once, and displays authoritative delivery failure', async () => {
  const { w, live, progress, append } = await boot([], false);
  let finish!: (value: any) => void;
  const opening = vi.fn((_text: string, _mode: string, _requestId: string) => new Promise(resolve => { finish = resolve; }));
  (w as any).api.draftGoalOpening = opening;
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Implement and verify'; objective.dispatchEvent(new w.Event('input'));
  (w.document.getElementById('saveSessionObjective') as HTMLButtonElement).click();
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.textContent).toContain('Preparing the opening message');
  expect(row.getAttribute('aria-busy')).toBe('true');
  const requestId = opening.mock.calls[0]![2];
  progress({ requestId: 'unrelated-request', phase: 'generating', text: 'Wrong Goal' });
  expect(row.textContent).not.toContain('Wrong Goal');
  progress({ requestId, phase: 'retrying', text: '', error: 'rate_limited', attempt: 2, retryAt: Date.now() + 30000 });
  expect(row.textContent).toContain('Provider busy · retry 2');
  expect(row.getAttribute('aria-busy')).toBe('true');
  progress({ requestId, phase: 'generating', text: 'Inspect the existing code first' });
  expect(row.textContent).toContain('Inspect the existing code first');
  expect(live.sent).toEqual([]);
  finish({ ok: true, data: { reply: 'Inspect and implement the task', model: 'fixture' } });
  await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ text: 'Inspect and implement the task', objective: 'Implement and verify', automation: 'goal', authoredSource: 'objective' });
  expect(row.textContent).toContain('Opening message queued');
  live.inputs = live.inputs.map(input => ({ ...input, state: 'failed', error: 'Model could not be selected' }));
  await append([]);
  expect(row.textContent).toContain('Model could not be selected');
  expect(row.getAttribute('aria-busy')).toBe('false');
});

it('preserves an Off goal and never sends its late generated opening after Off and On', async () => {
  const { w, live, progress } = await boot([], false);
  const cancel = vi.fn(async () => ({ ok: true, data: true }));
  (w as any).api.cancelTaskRequest = cancel;
  let finish!: (value: any) => void;
  let requestId = '';
  (w as any).api.draftGoalOpening = (_text: string, _mode: string, id: string) => { requestId = id; return new Promise(resolve => { finish = resolve; }); };
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Keep this objective'; objective.dispatchEvent(new w.Event('input'));
  w.document.getElementById('saveSessionObjective')!.click();
  for (const mode of ['off', 'goal']) (w.document.querySelector(`#automationSwitch [data-mode="${mode}"]`) as HTMLButtonElement).click();
  expect(cancel).toHaveBeenCalledWith(requestId);
  progress({ requestId, phase: 'generating', text: 'Late provider text' });
  finish({ ok: true, data: { reply: 'Must not send', model: 'fixture' } });
  await settle();
  expect(live.sent).toEqual([]);
  expect(objective.value).toBe('Keep this objective');
  expect(w.document.getElementById('goalLifecycle')!.hidden).toBe(true);
  expect(w.document.getElementById('goalLifecycle')!.textContent).not.toContain('Late provider text');
});

it.each(['navigate', 'objective edit', 'mode change', 'automation change'] as const)('cancels native Goal generation on %s and ignores stale progress', async (action) => {
  const { w, live, progress } = await boot([], false);
  const api = (w as any).api;
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  let finish!: (value: any) => void;
  api.draftGoalOpening = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Original task'; objective.dispatchEvent(new w.Event('input'));
  w.document.getElementById('saveSessionObjective')!.click();
  const requestId = api.draftGoalOpening.mock.calls[0][2];
  if (action === 'navigate') {
    (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click();
    await settle();
  } else if (action === 'objective edit') {
    objective.value = 'Replacement task'; objective.dispatchEvent(new w.Event('input'));
  } else if (action === 'mode change') {
    const mode = w.document.getElementById('sessionObjectiveMode') as HTMLSelectElement;
    mode.value = 'loop'; mode.dispatchEvent(new w.Event('change'));
  } else {
    (w.document.querySelector('#automationSwitch [data-mode="loop"]') as HTMLButtonElement).click();
  }
  expect(api.cancelTaskRequest).toHaveBeenCalledWith(requestId);
  progress({ requestId, phase: 'generating', text: 'Obsolete provider progress' });
  expect(w.document.getElementById('goalLifecycle')!.textContent).not.toContain('Obsolete provider progress');
  finish({ ok: true, data: { reply: 'Obsolete opening', model: 'fixture' } });
  await settle();
  expect(live.sent).toHaveLength(0);
});

it('shows Loop settling, its real waiting deadline, and generated text in the same row', async () => {
  // The clock stands still, so a slow run cannot tick the countdown from 2:05 to 2:04 (2.1.47 round).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 28, 12, 0));
  try {
    const { w, append } = await boot([]);
    const api = (w as any).api;
    const controls = { automation: 'loop', objective: 'Continue the task', blocked: '', job: null,
      goalWait: { reason: 'quiet', until: Date.now() + 125_000 }, goalDraft: null as unknown };
    api.getSessionControls = async () => ({ ok: true, data: controls });
    await append([]);
    const row = w.document.getElementById('goalLifecycle')!;
    expect(row.hidden).toBe(false);
    expect(row.textContent).toContain('Loop · Waiting for tool inactivity');
    expect(row.querySelector('[role="timer"]')?.textContent).toContain('2:05');
    expect(row.getAttribute('aria-busy')).toBe('true');
    controls.goalDraft = { stage: 'answering', model: 'fixture', text: 'Continue with the remaining checks', error: null };
    await append([]);
    expect(w.document.getElementById('goalLifecycle')).toBe(row);
    expect(row.textContent).toContain('Generating a continuation');
    expect(row.textContent).toContain('Continue with the remaining checks');
    expect(row.querySelector('[role="timer"]')).toBeNull();
    controls.automation = 'off'; await append([]);
    expect(row.hidden).toBe(true);
    expect(row.textContent).toBe('');
  } finally { vi.useRealTimers(); }
});

it('names the wait for this chat’s own sub-agents without inventing a countdown', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  // The wait ends when the last worker stops, which is not a time this page can predict, so
  // the row says what it is waiting for and shows no timer at all.
  const controls = { automation: 'loop', objective: 'Continue the task', blocked: '', job: null,
    goalWait: { reason: 'workers' }, goalDraft: null as unknown };
  api.getSessionControls = async () => ({ ok: true, data: controls });
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.hidden).toBe(false);
  expect(row.textContent).toContain('Loop · Waiting for this chat’s sub-agents');
  expect(row.querySelector('[role="timer"]')).toBeNull();
  expect(row.getAttribute('aria-busy')).toBe('true');
  api.getSessionControls = async () => ({ ok: true, data: { ...controls, goalWait: null } });
  await append([]);
  expect(row.hidden).toBe(true);
});

it('names the wait for the Goal step reviewer (#1832)', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  api.getSessionControls = async () => ({ ok: true, data: { automation: 'goal', objective: 'Ship it', blocked: '', job: null,
    goalWait: { reason: 'reviewer', until: Date.now() + 300_000 }, goalDraft: null as unknown } });
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.hidden).toBe(false);
  expect(row.textContent).toContain('Goal · Waiting for the reviewer');
  expect(row.getAttribute('aria-busy')).toBe('true');
  // At the deadline Goal goes on without the review, so the countdown says that, not "Check in".
  expect(row.querySelector('[role="timer"]')?.textContent).toMatch(/^Continues without the review in [45]:\d\d$/);
  // The next step's draft waits for the review before asking the helper: it says so, not "Preparing".
  api.getSessionControls = async () => ({ ok: true, data: { automation: 'goal', objective: 'Ship it', blocked: '', job: null,
    goalWait: { reason: 'reviewer', until: Date.now() + 300_000 }, goalDraft: { stage: 'sending', model: 'fixture', text: '', error: null } } });
  await append([]);
  expect(row.textContent).toContain('Goal · Waiting for the reviewer');
  expect(row.textContent).not.toContain('Preparing a continuation');
});

it('says a Goal waits for its closed chat, without a spinner or a countdown', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  // The person closed the chat's tab before the Goal decided; nothing settles until it opens again.
  api.getSessionControls = async () => ({ ok: true, data: { automation: 'goal', objective: 'Ship the release', blocked: '', job: null,
    goalWait: { reason: 'closed' }, goalDraft: null } });
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.hidden).toBe(false);
  expect(row.textContent).toContain('Goal · Paused until this chat is open in the browser');
  expect(row.textContent).not.toContain('Answer settling');
  expect(row.getAttribute('aria-busy')).toBe('false');
  expect(row.querySelector('.session-status.is-working')).toBeNull();
  expect(row.querySelector('[role="timer"]')).toBeNull();
  // The row offers the way on: opening the chat, as its sidebar row does.
  const opened: string[] = [];
  api.openSessionChat = async (id: string) => { opened.push(id); return { ok: true, data: true }; };
  const open = row.querySelector<HTMLButtonElement>('button.dock-action')!;
  expect(open.getAttribute('aria-label')).toBe('Open this chat in your browser');
  open.click();
  await waitFor(() => expect(opened).toHaveLength(1));
  // Any other wait has no such button.
  api.getSessionControls = async () => ({ ok: true, data: { automation: 'goal', objective: 'Ship the release', blocked: '', job: null,
    goalWait: { reason: 'settling' }, goalDraft: null } });
  await append([]);
  expect(row.textContent).toContain('Answer settling');
  expect(row.querySelector('button.dock-action')).toBeNull();
});

it('follows the accepted New Chat receipt while preserving a typed follow-up', async () => {
  const { w, live, append } = await boot([], false);
  const composer = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  composer.value = 'Opening message';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(1);
  composer.value = 'Follow-up while delivery is pending';
  composer.dispatchEvent(new w.Event('input'));
  live.inputs = live.inputs.map(row => ({ ...row, state: 'sent', deliveredSessionId: summary([]).id }));
  await append([]);
  expect(w.document.querySelector('#sessionList [data-id].is-sel')).not.toBeNull();
  expect(composer.value).toBe('Follow-up while delivery is pending');
});

it('shows Pro Loop delivery before sending and freezes changes made while the opening is being accepted', async () => {
  const { w, live } = await boot([], false, [], [], { pro: true });
  (await (w as any).api.getState()).data.config.ui.finishTool = true;
  const row = w.document.getElementById('loopDeliveryRow')!;
  const effort = w.document.getElementById('composerReasoning') as HTMLSelectElement;
  const delivery = w.document.getElementById('loopDelivery') as HTMLSelectElement;
  const choose = (value: string) => { effort.value = value; effort.dispatchEvent(new w.Event('change')); };
  w.document.querySelector<HTMLButtonElement>('#automationSwitch [data-mode="loop"]')!.click();
  expect(row.hidden).toBe(true);
  choose('pro'); expect(row.hidden).toBe(false);
  expect(delivery.value).toBe('finish');
  // The choice names when Loop continues, and its title says what that means.
  expect(row.firstChild!.textContent).toBe('When to continue');
  expect([...delivery.options].map(option => option.textContent)).toEqual(['Session Finish only', 'Also after the turn']);
  expect(delivery.title).toBe('Only inside the Session Finish tool result; never start a new turn');
  delivery.value = 'after-turn'; delivery.dispatchEvent(new w.Event('change'));
  expect(delivery.title).toBe('At Session Finish, or as a new message after verified turn completion');
  choose('high'); expect(row.hidden).toBe(true);
  choose('pro'); expect(row.hidden).toBe(false);
  expect(delivery.value).toBe('after-turn');
  const api = (w as any).api;
  const originalSend = api.sendInput;
  let accept!: () => void;
  api.sendInput = vi.fn((input: InputArgs) => new Promise(resolve => { accept = () => resolve(originalSend(input)); }));
  api.setInputAutomation = vi.fn(async () => ({ ok: true, data: true }));
  (w.document.getElementById('chatInput') as HTMLTextAreaElement).value = 'First Pro Loop message';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(api.sendInput.mock.calls[0][0]).toMatchObject({ sessionId: null, automation: 'loop', loopAfterTurn: true });
  delivery.value = 'finish'; delivery.dispatchEvent(new w.Event('change'));
  accept(); await settle();
  expect(api.setInputAutomation).toHaveBeenLastCalledWith(live.sent[0]!.id, 'loop', false);
  w.document.querySelector<HTMLButtonElement>('#automationSwitch [data-mode="goal"]')!.click();
  expect(row.hidden).toBe(true);
  w.document.getElementById('newChat')!.click();
  expect(delivery.value).toBe('finish');
});

it.each(['goal', 'loop'] as const)('keeps Astra %s selected when changing delivery and hides finish choices when finish is disabled', async mode => {
  const { w, append } = await boot([], true, [], [], { astra: true });
  const api = (w as any).api;
  const state = (await api.getState()).data;
  state.config.ui.finishTool = true;
  const getSession = api.getSession;
  api.getSession = async (...args: unknown[]) => {
    const result = await getSession(...args);
    result.data.summary.selectedModel = { conversationId: 'chat-b', model: 'gpt-6-pro', reasoningEffort: 'pro', observedAt: Date.now() };
    return result;
  };
  const model = w.document.getElementById('composerModel') as HTMLSelectElement;
  model.value = 'gpt-6-pro'; model.dispatchEvent(new w.Event('change'));
  const controls = { sessionId: summary([]).id, conversationId: 'chat-b', automation: mode, loopAfterTurn: false, blocked: '' };
  api.getSessionControls = async () => ({ ok: true, data: controls });
  api.setSessionAutomation = vi.fn(async (_id: string, next: string, afterTurn: boolean) => {
    controls.automation = next as typeof mode; controls.loopAfterTurn = afterTurn;
    return { ok: true, data: controls };
  });
  await append([]);
  // Re-select after the session's recorded model projection has settled.
  model.value = 'gpt-6-pro'; model.dispatchEvent(new w.Event('change'));
  const row = w.document.getElementById('loopDeliveryRow')!;
  const delivery = w.document.getElementById('loopDelivery') as HTMLSelectElement;
  expect(row.hidden).toBe(false);
  delivery.value = 'after-turn'; delivery.dispatchEvent(new w.Event('change'));
  await settle();
  expect(api.setSessionAutomation).toHaveBeenLastCalledWith(summary([]).id, mode, true);
  expect((w.document.getElementById('chatAutomation') as HTMLSelectElement).value).toBe(mode);
  state.config.ui.finishTool = false;
  await append([]);
  expect(row.hidden).toBe(true);
  expect(delivery.value).toBe('after-turn');
  state.config.ui.finishTool = true;
  model.value = 'gpt-6-pro'; model.dispatchEvent(new w.Event('change'));
  expect(row.hidden).toBe(false);
  expect(delivery.value).toBe('after-turn');
});

it('applies Off to the exact accepted New Chat opening while preserving an unrelated composer draft', async () => {
  const { w, live, append } = await boot([], false);
  const api = (w as any).api;
  api.draftGoalOpening = vi.fn(async () => ({ ok: true, data: { reply: 'Say hello once', model: 'fixture' } }));
  const controls = api.getSessionControls;
  api.getSessionControls = async (id: string) => { const result = await controls(id); result.data.objective = 'Greeting goal'; return result; };
  api.setInputAutomation = vi.fn(async (id: string, mode: 'off' | 'goal' | 'loop') => {
    live.inputs = live.inputs.map(row => row.id === id ? { ...row, automation: mode } : row);
    return { ok: true, data: true };
  });
  const composer = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  composer.value = 'Keep my separate draft';
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Greeting goal'; objective.dispatchEvent(new w.Event('input'));
  w.document.getElementById('saveSessionObjective')!.click(); await settle();
  expect(live.sent).toHaveLength(1);
  const id = live.sent[0]!.id;
  (w.document.querySelector('#automationSwitch [data-mode="off"]') as HTMLButtonElement).click(); await settle();
  expect(api.setInputAutomation).toHaveBeenCalledWith(id, 'off');
  live.inputs = live.inputs.map(row => ({ ...row, state: 'sent', deliveredSessionId: summary([]).id }));
  await append([]);
  expect(composer.value).toBe('Keep my separate draft');
  expect(objective.value).toBe('Greeting goal');
  expect(live.sent).toHaveLength(1);
});

it('cancels pending plan generation when its own draft changes', async () => {
  const { w, live, progress } = await boot([], false);
  const api = (w as any).api;
  (await api.getState()).data.config.ui.finishTool = true;
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  let finish!: (value: any) => void;
  api.draftTaskPlan = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Original plan';
  w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  const requestId = api.draftTaskPlan.mock.calls[0][2];
  input.value = 'Replacement plan'; input.dispatchEvent(new w.Event('input'));
  expect(api.cancelTaskRequest).toHaveBeenCalledWith(requestId);
  progress({ requestId, phase: 'generating', text: 'Old plan text' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toContain('Old plan text');
  finish({ ok: true, data: ['Old first stage', 'Old second stage'] }); await settle();
  expect(live.sent).toHaveLength(0);
});

it('preserves composer drafts across chat and settings navigation without forcing a fixed height', async () => {
  const first = summary([]), second = { ...first, id: 'second-chat', title: 'Second chat' };
  const { w } = await boot([], true, [], [], { sessions: [first, second] });
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Long draft\n'.repeat(60); input.dispatchEvent(new w.Event('input'));
  const draft = input.value;
  expect(input.style.height).toBe('');
  (w.document.querySelector('#sessionList [data-id="second-chat"]') as HTMLElement).click(); await settle();
  expect(input.value).toBe('');
  expect(input.style.height).toBe('');
  (w.document.querySelector(`#sessionList [data-id="${first.id}"]`) as HTMLElement).click(); await settle();
  expect(input.value).toBe(draft);
  expect(input.style.height).toBe('');
  const chat = await import('../src/renderer/chat.js');
  chat.openChatView('settings');
  (w.document.querySelector('#sessionList [data-id="second-chat"]') as HTMLElement).click(); await settle();
  (w.document.querySelector(`#sessionList [data-id="${first.id}"]`) as HTMLElement).click(); await settle();
  chat.openChatView('timeline');
  expect(input.value).toBe(draft);
  expect(input.style.height).toBe('');
});

it('marks chats that hold an unsent draft, and gives drafts back after a restart', async () => {
  const first = summary([]), second = { ...first, id: 'second-chat', title: 'Second chat' };
  const sessions = [first, second];
  const { w } = await boot([], false, [], [], { sessions });
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const row = (id: string) => w.document.querySelector<HTMLElement>(`#sessionList .sess[data-id="${id}"]`)!;
  const type = (value: string) => { input.value = value; input.dispatchEvent(new w.Event('input')); };
  type('A new chat idea');
  row(first.id).querySelector<HTMLElement>('[data-session-select]')!.click(); await settle();
  type('Unsent reply');
  // The open chat shows its draft in the composer, so its row needs no mark.
  expect(row(first.id).querySelector('.sess-draft-mark')).toBeNull();
  row(second.id).querySelector<HTMLElement>('[data-session-select]')!.click(); await settle();
  expect(row(first.id).querySelector('.sess-draft-mark')).not.toBeNull();
  expect(row(first.id).title).toContain('Draft');
  expect(row(first.id).querySelector('[data-session-select] .sess-draft-mark')!.getAttribute('aria-label')).toBe('Draft');
  expect(row(second.id).querySelector('.sess-draft-mark')).toBeNull();

  w.dispatchEvent(new w.Event('pagehide'));
  const saved = w.localStorage.getItem('chat-on-steroids.composer-drafts')!;
  dom!.window.close(); vi.resetModules();
  const restarted = await boot([], false, [], [], { sessions, storage: { 'chat-on-steroids.composer-drafts': saved } });
  const after = restarted.w.document;
  const again = after.getElementById('chatInput') as HTMLTextAreaElement;
  expect(again.value).toBe('A new chat idea');
  expect(after.querySelector(`#sessionList .sess[data-id="${first.id}"] .sess-draft-mark`)).not.toBeNull();
  after.querySelector<HTMLElement>(`#sessionList .sess[data-id="${first.id}"] [data-session-select]`)!.click(); await settle();
  expect(again.value).toBe('Unsent reply');
  expect(after.querySelector(`#sessionList .sess[data-id="${first.id}"] .sess-draft-mark`)).toBeNull();
});

it('retains an existing running chat planner across navigation and accepts its result only in that draft', async () => {
  const first = summary([]), second = { ...first, id: 'second-chat', title: 'Second chat' };
  const { w, live, progress } = await boot([], true, [], [], { sessions: [first, second] });
  const api = (w as any).api;
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  let finish!: (value: any) => void;
  api.draftTaskPlan = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Plan for this running chat'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  const requestId = api.draftTaskPlan.mock.calls[0][2];
  (w.document.querySelector('#sessionList [data-id="second-chat"]') as HTMLElement).click(); await settle();
  input.value = 'Unrelated draft'; input.dispatchEvent(new w.Event('input'));
  expect(api.cancelTaskRequest).not.toHaveBeenCalled();
  progress({ requestId, phase: 'generating', text: 'Original chat progress' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toContain('Original chat progress');
  (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click(); await settle();
  expect(input.value).toBe('Plan for this running chat');
  expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Original chat progress');
  expect(w.document.getElementById('createPlan')!.getAttribute('aria-busy')).toBe('true');
  (w.document.querySelector('#sessionList [data-id="second-chat"]') as HTMLElement).click(); await settle();
  finish({ ok: true, data: ['Original first stage', 'Original checkpoint'] }); await settle();
  expect(input.value).toBe('Unrelated draft');
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(0);
  (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click(); await settle();
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(2);
  expect(input.value).toBe('');
  expect(w.document.getElementById('taskPlanPreview')!.hidden).toBe(true);
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ sessionId: summary([]).id, mode: 'finish', text: 'Original first stage', stages: ['Original checkpoint'] });
});

it('keeps two planner owners independent and ignores a cancelled result after returning to its chat', async () => {
  const first = summary([]), second = { ...first, id: 'second-chat', title: 'Second chat' };
  const { w, live } = await boot([], true, [], [], { sessions: [first, second] });
  const api = (w as any).api;
  const pending = new Map<string, (value: any) => void>();
  api.draftTaskPlan = vi.fn((text: string) => new Promise(resolve => { pending.set(text, resolve); }));
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const generate = () => { w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); };
  const select = async (id: string) => { (w.document.querySelector(`#sessionList [data-id="${id}"]`) as HTMLElement).click(); await settle(); };
  input.value = 'Plan A'; generate(); await settle();
  const requestA = api.draftTaskPlan.mock.calls[0][2];
  await select(second.id);
  input.value = 'Plan B'; generate(); await settle();
  pending.get('Plan A')!({ ok: true, data: ['A first', 'A check'] }); await settle();
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(0);
  expect(w.document.getElementById('createPlan')!.getAttribute('aria-busy')).toBe('true');
  await select(first.id);
  expect(w.document.getElementById('finishQueue')!.textContent).toContain('A first');
  await select(second.id);
  const requestB = api.draftTaskPlan.mock.calls[1][2];
  w.document.getElementById('createPlan')!.click(); // Explicitly cancel B; A and navigation did not cancel it.
  expect(api.cancelTaskRequest.mock.calls).toEqual([[requestB]]);
  expect(api.cancelTaskRequest).not.toHaveBeenCalledWith(requestA);
  input.value = 'B replacement'; generate(); await settle();
  pending.get('Plan B')!({ ok: true, data: ['Stale B result'] }); await settle();
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toContain('Stale B');
  pending.get('B replacement')!({ ok: false, error: 'Planner unavailable' }); await settle();
  await select(first.id); await select(second.id);
  expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Planner unavailable');
  expect(input.value).toBe('B replacement');
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ sessionId: first.id, text: 'A first', mode: 'finish' });
});

it('renders existing-chat Goal draft stages from main controls without starting another request', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  const original = api.getSessionControls;
  let draft = { stage: 'answering', model: 'fixture', text: 'Actual continuation text', error: null as string | null };
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, automation: 'goal', goalDraft: draft } });
  const opening = vi.fn(); api.draftGoalOpening = opening;
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.textContent).toContain('Actual continuation text');
  expect(row.getAttribute('aria-busy')).toBe('true');
  draft = { ...draft, stage: 'ready' }; await append([]);
  expect(row.textContent).toContain('awaiting ChatGPT delivery');
  draft = { ...draft, stage: 'failed', error: 'no_api_key' }; await append([]);
  expect(row.textContent).toContain('No API key is configured for the continuation provider.');
  expect(row.textContent).not.toContain('no_api_key');
  expect(row.getAttribute('aria-busy')).toBe('false');
  expect(opening).not.toHaveBeenCalled();
});

it('says the goal was reached instead of still pursuing it, and only once', async () => {
  // Found on Windows (2026-10-04): the helper decided the goal was met and sent nothing, yet the
  // row kept saying "Pursuing goal", so the run looked as if it were still working.
  const { w, append } = await boot([]);
  const api = (w as any).api;
  const original = api.getSessionControls;
  let draft: unknown = { stage: 'no-reply', model: 'fixture', text: '', error: null };
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, automation: 'goal',
    objective: 'Write one poem about tides', goalDraft: draft } });
  await append([]);
  const goalRow = w.document.getElementById('activeGoalRow')!;
  expect(goalRow.textContent).toContain('Goal reached · Write one poem about tides');
  expect(goalRow.textContent).not.toContain('Pursuing goal');
  expect(goalRow.querySelector('.ico')!.className).toContain('ph-check');
  // Pause and Edit stay: the objective can be continued or changed.
  expect(goalRow.querySelectorAll('.dock-action')).toHaveLength(2);
  expect(w.document.getElementById('goalLifecycle')!.hidden).toBe(true);
  // A newer turn replaces the outcome; the run is pursuing again.
  draft = null; await append([]);
  expect(goalRow.textContent).toContain('Pursuing goal · Write one poem about tides');
  expect(goalRow.querySelector('.ico')!.className).toContain('ph-activity');
});

it('shows the immediate recovery deadline before a draft exists and clears it on fresh work', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  let goalWait: object | null = { reason: 'silence', until: Date.now() + 120_000 };
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data,
    automation: 'loop', goalWait, goalDraft: null } });
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.hidden).toBe(false);
  expect(row.textContent).toContain('Loop · Waiting before recovery reload');
  expect(row.querySelector('[role="timer"]')).not.toBeNull();
  goalWait = null;
  await append([]);
  expect(row.hidden).toBe(true);
});

it.each([
  { reason: 'silence', kind: 'silence' },
  { reason: 'listening', kind: 'post-reload' },
  { reason: 'native-busy', kind: 'native-busy' },
  { reason: 'quiet', kind: 'post-reload' }
] as const)('shows the shared $reason deadline once while keeping independent Loop waits', async ({ reason, kind }) => {
  const { w, append } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  const deadline = Date.now() + 60_000;
  const goalWait = { reason, until: deadline };
  const recovery = [{ kind: kind as string, deadline, visibleAt: 0 }];
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data,
    automation: 'loop', objective: 'Keep working', goalWait, recovery, goalDraft: null } });
  await append([]);
  const lifecycle = w.document.getElementById('goalLifecycle')!;
  expect(lifecycle.hidden).toBe(true);
  expect(lifecycle.querySelector('[role="timer"]')).toBeNull();
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(false);
  expect(w.document.getElementById('activeGoalRow')!.hidden).toBe(false);
  expect(w.document.querySelectorAll('#composerDock [role="timer"]')).toHaveLength(1);

  // A different deadline is independent, even when both owners happen to be waiting.
  goalWait.until += 15_000;
  await append([]);
  expect(lifecycle.hidden).toBe(false);
  expect(w.document.querySelectorAll('#composerDock [role="timer"]')).toHaveLength(2);

  // A hidden recovery row must not swallow the only visible indication of a wait.
  goalWait.until = deadline; recovery[0]!.visibleAt = deadline - 15_000;
  await append([]);
  expect(lifecycle.hidden).toBe(false);
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(true);

  // Attribution and pickup have their own actions, even at the same timestamp.
  recovery[0]!.visibleAt = 0; recovery[0]!.kind = 'pickup';
  await append([]);
  expect(lifecycle.hidden).toBe(false);
  expect(w.document.querySelectorAll('#composerDock [role="timer"]')).toHaveLength(2);
});

it.each([false, true])('does not redisplay the old reload receipt after Continue starts the next turn (developer mode: %s)', async developerMode => {
  const reloadedAt = Date.now() - 60_000;
  const repair: SessionEvent = { seq: 1, time: reloadedAt, source: 'app', kind: 'progress',
    progressId: 'browser-repair:fixture', turnId: 'silent-turn',
    message: text('Reloaded chat to recover an unresponsive open turn.') };
  const { w, append, live } = await boot([repair], true, [], [], { developerMode });
  const host = w.document.getElementById('recoveryStatus')!;
  expect(host.hidden).toBe(false);
  await append([{ seq: 2, time: Date.now(), source: 'app', kind: 'turn_start', turnId: 'silent-turn' }]);
  expect(host.hidden).toBe(false); // Reopening the same source is not a new question.
  await append([
    { seq: 3, time: Date.now(), source: 'extension', kind: 'user_message', messageId: 'continue-message', message: text('Continue the work.') },
    { seq: 4, time: Date.now(), source: 'extension', kind: 'turn_start', turnId: 'continued-turn' }
  ]);
  expect(host.hidden).toBe(true);
  expect(live.events).toContainEqual(repair);
  if (developerMode) expect(w.document.getElementById('timeline')!.textContent).toContain(repair.message.text);
  await append([{ ...repair, seq: 5, time: Date.now(), turnId: 'continued-turn', progressId: 'browser-repair:new-turn' }]);
  expect(host.hidden).toBe(false);
});

it('reuses the Goal animation for a session-finish draft while ordinary automation is off', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  let finishGoalDraft: object | null = { stage: 'answering', model: 'fixture', text: 'Next useful action', error: null };
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, automation: 'off', finishGoalDraft } });
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.hidden).toBe(false);
  expect(row.textContent).toContain('Next useful action');
  expect(row.getAttribute('aria-busy')).toBe('true');
  finishGoalDraft = null; await append([]);
  expect(row.hidden).toBe(true);
  expect(row.getAttribute('aria-busy')).toBe('false');
});

it('shows the active finish animation after an earlier ordinary Goal save failed', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  let finishGoalDraft: object | null = null;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, automation: 'goal', finishGoalDraft } });
  api.setSessionObjective = vi.fn(async () => ({ ok: false, error: 'Save failed' }));
  await append([]);
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Verify remaining work'; objective.dispatchEvent(new w.Event('input'));
  w.document.getElementById('saveSessionObjective')!.click(); await settle();
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.textContent).toContain('Task could not be saved');
  finishGoalDraft = { stage: 'answering', model: 'fixture', text: 'Check the active task', error: null };
  await append([]);
  expect(row.textContent).toContain('Check the active task');
  expect(row.textContent).not.toContain('Task could not be saved');
  expect(row.getAttribute('aria-busy')).toBe('true');
  expect(row.querySelector('.session-status.is-working')).not.toBeNull();
});

it('offers Generate Goal only at an empty finish wait and preserves the manual draft', async () => {
  const { w, append, live } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  let waiting = false;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, finishWaiting: waiting } });
  const generate = vi.fn(async () => ({ ok: true, data: 'Goal queued' })); api.generateFinishGoal = generate;
  const button = w.document.getElementById('generateFinishGoal') as HTMLButtonElement;
  await append([]); expect(button.hidden).toBe(true);
  waiting = true; await append([]); expect(button.hidden).toBe(false);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'My own follow-up'; input.dispatchEvent(new w.Event('input', { bubbles: true }));
  expect(input.disabled).toBe(false);
  button.click(); await settle();
  expect(generate).toHaveBeenCalledWith(summary(live.events).id, 'held-turn');
  expect(input.value).toBe('My own follow-up');
  live.inputs.push({ id: 'pending', sessionId: summary(live.events).id, state: 'queued', mode: 'finish', text: 'Prior task', dueAt: Date.now(), createdAt: Date.now() } as InputEntry);
  await append([]); expect(button.hidden).toBe(true);
  button.click(); await settle(); expect(generate).toHaveBeenCalledTimes(1);
});

it('offers a per-task post-turn opt-in only for Astra', async () => {
  const { w, live, append } = await boot([]);
  const current = summary([]);
  live.inputs.push({ id: 'choice-task', sessionId: current.id, text: 'Next task', mode: 'finish', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  expect(w.document.querySelector('.queue-delivery')).toBeNull();
  current.selectedModel = { conversationId: 'chat-b', model: 'gpt-6-pro', reasoningEffort: 'pro', observedAt: T0 };
  (w as any).api.listSessions = async () => ({ ok: true, data: { sessions: [current], activeId: current.id, pressure: [] } });
  (w as any).api.getSession = async () => ({ ok: true, data: { summary: current, events: [], total: 0, nextFrom: 0 } });
  const edit = vi.fn(async () => ({ ok: true, data: true }));
  (w as any).api.editQueuedInput = edit;
  await append([]);
  const toggle = w.document.querySelector<HTMLButtonElement>('.queue-delivery');
  expect(toggle?.getAttribute('aria-pressed')).toBe('false');
  toggle!.click();
  await settle();
  expect(edit).toHaveBeenCalledWith('choice-task', 'Next task', true);
});

it('opens every selected chat at the bottom and preserves manual reading during live updates', async () => {
  const rows = Array.from({ length: 160 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `opening-${i}`, message: text(`Opening item ${i + 1}`) }));
  const first = summary(rows), second = { ...summary(rows), id: '2026-09-02-test0002', title: 'Other chat' };
  const { w, append } = await boot(rows, false, [], [], { sessions: [first, second] });
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 },
    scrollHeight: { get: () => timeline.querySelectorAll('[data-timeline-key]').length * 100 } });
  w.document.getElementById('timelineContent')!.getBoundingClientRect = () => ({ height: pane.scrollHeight } as DOMRect);
  const select = async (id: string) => {
    (w.document.querySelector(`#sessionList [data-id="${id}"]`) as HTMLElement).click();
    await settle();
    expect(pane.scrollTop).toBe(pane.scrollHeight); // Chromium clamps to the actual bottom.
  };
  await select(first.id);
  // The reader's own scrolling: a wheel, then the position it lands on.
  const readTo = (top: number) => {
    pane.dispatchEvent(new w.WheelEvent('wheel'));
    pane.scrollTop = top;
    pane.dispatchEvent(new w.Event('scroll'));
  };
  // A global notification from another chat still refreshes this idle selection.
  // A deliberate small scroll away from its bottom must remain a reading position.
  readTo(pane.scrollHeight - pane.clientHeight - 20);
  const nearTail = pane.scrollTop;
  for (let index = 0; index < 3; index++) {
    await append([]);
    expect(pane.scrollTop).toBe(nearTail);
  }
  for (let i = 0; i < 3; i++) {
    readTo(700);
    await append([]);
    expect(pane.scrollTop).toBe(700);
    await select(second.id);
    readTo(0);
    await select(first.id);
  }

  // A late opening response must neither replace the current chat nor drag its reader down.
  const api = (w as any).api, original = api.getSession;
  const pending: Array<() => void> = [];
  api.getSession = async (id: string, options: unknown) => {
    await new Promise<void>(resolve => pending.push(resolve));
    return original(id, options);
  };
  await append([]); // Old A refresh is still in flight when A -> B -> A begins.
  (w.document.querySelector(`#sessionList [data-id="${second.id}"]`) as HTMLElement).click();
  (w.document.querySelector(`#sessionList [data-id="${first.id}"]`) as HTMLElement).click();
  expect(pending).toHaveLength(3);
  pending[2]!(); await settle();
  expect(pane.scrollTop).toBe(pane.scrollHeight);
  pane.scrollTop = 850;
  pending[1]!(); pending[0]!(); await settle();
  expect(pane.scrollTop).toBe(850);
  expect(w.document.getElementById('chatTitle')!.textContent).toBe(first.title);
});

it.each(['empty', 'failed'])('keeps a fitting chat live after an %s older-page read', async outcome => {
  const { w, append } = await boot([{ seq: 12, time: T0, source: 'extension', kind: 'user_message',
    messageId: 'short', message: text('Short chat') }]);
  const api = (w as any).api, original = api.getSession;
  const read = vi.fn((id: string, options: any) => options?.before && outcome === 'failed'
    ? Promise.resolve({ ok: false, error: 'Read failed' }) : original(id, options));
  api.getSession = read;
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 800 }, scrollHeight: { value: 800 } });
  pane.scrollTop = 0;
  pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 })); await settle();
  expect(read).toHaveBeenCalledWith(expect.any(String), { before: 12, limit: 30 });
  expect(pane.scrollTop).toBe(0);
  expect(timeline.querySelector('.timeline-window-note')).toBeNull();
  expect(w.document.getElementById('timelineContent')!.style.getPropertyValue('--timeline-scroll-reserve')).toBe('');
  await append([{ seq: 13, time: T0 + 1, source: 'extension', kind: 'assistant_message',
    messageId: 'fresh', message: text('Still receiving live output'), final: true }]);
  expect(timeline.textContent).toContain('Still receiving live output');
  expect(read).toHaveBeenLastCalledWith(expect.any(String), { from: 13, limit: 30 });
});

it('loads bounded earlier pages on deliberate upward scrolling without draining on render', async () => {
  const rows = Array.from({ length: 360 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `history-${i}`, message: text(`History item ${i + 1}`) }));
  const { w, append } = await boot(rows);
  const timeline = w.document.getElementById('timeline')!;
  const pane = w.document.getElementById('chatBody')!;
  expect(timeline.querySelector('[data-history="older"]')).toBeNull();
  pane.dispatchEvent(new w.Event('scroll')); await settle();
  expect(timeline.textContent).toContain('History item 360');
  expect(timeline.textContent).not.toContain('History item 121');
  Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 400 });
  Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 10000 });
  for (const row of timeline.querySelectorAll<HTMLElement>('[data-timeline-key]')) row.getBoundingClientRect = () => {
    const top = [...timeline.querySelectorAll('[data-timeline-key]')].indexOf(row) * 20 - pane.scrollTop;
    return { top, bottom: top + 20, height: 20, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) };
  };
  const up = async () => {
    pane.scrollTop = 0;
    pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 }));
    await settleHistoryFrame(w);
  };
  await up();
  expect(pane.scrollTop).toBe(600);
  expect(timeline.textContent).toContain('History item 301');
  expect(timeline.textContent).toContain('History item 360');
  await append([{ seq: 361, time: T0 + 361, source: 'extension', kind: 'user_message', messageId: 'newest', message: text('Newest live input') }]);
  expect(timeline.textContent).toContain('History item 301');
  expect(timeline.textContent).not.toContain('Newest live input');
  for (let page = 0; page < 12 && !timeline.textContent?.includes('History item 1'); page++) await up();
  expect(timeline.textContent).toContain('History item 1');
  expect(timeline.querySelectorAll('[data-timeline-key]').length).toBeLessThanOrEqual(160);
  expect(timeline.querySelector('[data-history="latest"]')).toBeNull();
});
it('scrolls forward through evicted history with wheel, keyboard and scrollbar, then resumes live deltas', async () => {
  const rows = Array.from({ length: 400 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `bidirectional-${i}`, message: text(`Bidirectional item ${i + 1}.`) }));
  const { w, live, append } = await boot(rows);
  const api = (w as any).api;
  const read = vi.fn(async (_id: string, options: { from?: number; before?: number; after?: number; limit: number }) => {
    const eligible = live.events.filter(e => (options.from === undefined || e.seq >= options.from) && (options.before === undefined || positionOf(e) < options.before) && (options.after === undefined || positionOf(e) > options.after));
    const page = options.from === undefined && options.after === undefined ? eligible.slice(-options.limit) : eligible.slice(0, options.limit);
    return { ok: true, data: { summary: summary(live.events), events: page, total: live.events.length,
      nextFrom: page.reduce((next, e) => Math.max(next, e.seq + 1), options.from ?? 0) } };
  });
  api.getSession = read;
  const timeline = w.document.getElementById('timeline')!;
  const pane = w.document.getElementById('chatBody')!;
  Object.defineProperties(pane, { clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, get: () => timeline.querySelectorAll('[data-timeline-key]').length * 20 } });
  // Model one layout snapshot per DOM revision. A selector scan inside every
  // rectangle read made this mock quadratic and exhausted Windows CI's timeout.
  let geometryRows: Map<Element, number> | null = null;
  const geometryChanges = new w.MutationObserver(() => { geometryRows = null; });
  geometryChanges.observe(timeline, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-timeline-key'] });
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    if (geometryChanges.takeRecords().length) geometryRows = null;
    geometryRows ??= new Map([...timeline.querySelectorAll('[data-timeline-key]')].map((row, index) => [row, index]));
    const index = geometryRows.get(this) ?? -1;
    const top = index < 0 ? 0 : index * 20 - pane.scrollTop;
    return { top, bottom: top + 20, height: 20 } as DOMRect;
  };
  for (let i = 0; i < 14 && !timeline.textContent?.includes('Bidirectional item 1.'); i++) {
    pane.scrollTop = 0;
    pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 }));
    await settleHistoryFrame(w);
  }
  expect(timeline.textContent).toContain('Bidirectional item 1.');
  expect(timeline.textContent).not.toContain('Bidirectional item 400.');
  const downward = async (kind: string) => {
    pane.scrollTop = pane.scrollHeight - pane.clientHeight;
    const anchor = [...timeline.querySelectorAll<HTMLElement>('[data-timeline-key]')].find(row => {
      const rect = row.getBoundingClientRect(); return rect.bottom > 0 && rect.top >= 0;
    })!;
    const before = anchor.getBoundingClientRect().top;
    if (kind === 'wheel') pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: 100 }));
    else if (kind === 'keyboard') pane.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'PageDown' }));
    else {
      pane.scrollTop -= 100;
      pane.dispatchEvent(new w.Event('pointerdown'));
      pane.scrollTop += 100; pane.dispatchEvent(new w.Event('scroll'));
      w.dispatchEvent(new w.Event('pointerup'));
    }
    await settleHistoryFrame(w);
    expect(anchor.isConnected).toBe(true);
    expect(anchor.getBoundingClientRect().top).toBe(before);
    expect(timeline.querySelectorAll('[data-timeline-key]').length).toBeLessThanOrEqual(160);
    const count = read.mock.calls.length;
    pane.dispatchEvent(new w.Event('scroll')); await settleHistoryFrame(w);
    expect(read).toHaveBeenCalledTimes(count);
  };
  for (let page = 0; page < 14 && !timeline.textContent?.includes('Bidirectional item 400.'); page++) {
    await downward(['wheel', 'keyboard', 'scrollbar'][page % 3]!);
  }
  expect(timeline.textContent).toContain('Bidirectional item 400.');
  expect(read.mock.calls.every(([, options]) => options.limit === 30)).toBe(true);
  await downward('wheel'); // Empty forward page proves we reached the current tail.
  await append([{ seq: 401, time: T0 + 401, source: 'extension', kind: 'user_message', messageId: 'live-again', message: text('Live again') }]);
  expect(timeline.textContent).toContain('Live again');
  geometryChanges.disconnect();
});

it('keeps a revised long answer reachable in both directions and never uses its revision as a history boundary', async () => {
  const rows = Array.from({ length: 360 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `origin-${i}`, message: text(`Origin row ${i + 1}.`) }));
  rows[99] = { seq: 1000, origin: 100, time: T0 + 99, source: 'extension', kind: 'assistant_message',
    messageId: 'long-reviewed-answer', message: text('Detailed ratings. '.repeat(1000)), final: true };
  const { w } = await boot(rows);
  const api = (w as any).api;
  const read = vi.fn(api.getSession);
  api.getSession = read;
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  // The renderer fills a requested edge across animation frames. A permanently
  // underfilled mock kept that demand alive, making the last read depend on timing.
  Object.defineProperties(pane, { clientHeight: { value: 400 },
    scrollHeight: { get: () => Math.max(400, timeline.querySelectorAll('[data-timeline-key]').length * 20) } });
  let geometryRows: Map<Element, number> | null = null;
  const geometryChanges = new w.MutationObserver(() => { geometryRows = null; });
  geometryChanges.observe(timeline, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-timeline-key'] });
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    if (geometryChanges.takeRecords().length) geometryRows = null;
    geometryRows ??= new Map([...timeline.querySelectorAll('[data-timeline-key]')].map((row, index) => [row, index]));
    const index = geometryRows.get(this) ?? -1;
    const top = index < 0 ? 0 : index * 20 - pane.scrollTop;
    return { top, bottom: top + 20, height: 20 } as DOMRect;
  };
  const page = async (deltaY: number) => {
    pane.scrollTop = deltaY < 0 ? 0 : pane.scrollHeight - pane.clientHeight;
    pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY }));
    await settleHistoryFrame(w);
  };
  for (let index = 0; index < 12 && !timeline.textContent?.includes('Detailed ratings.'); index++) await page(-100);
  expect(timeline.textContent).toContain('Detailed ratings.');
  expect(timeline.querySelectorAll('.ev-assistant_message')).toHaveLength(1);
  expect(read).toHaveBeenLastCalledWith(expect.any(String), { before: 121, limit: 30 });
  const newestBefore = Math.max(...[...timeline.querySelectorAll<HTMLElement>('.ev-user_message')]
    .map(row => Number(row.textContent?.match(/Origin row (\d+)\./)?.[1] ?? 0)));
  await page(100);
  expect(read).toHaveBeenLastCalledWith(expect.any(String), { after: newestBefore, limit: 30 });
  expect(timeline.textContent).toContain(`Origin row ${newestBefore + 30}.`);
  await page(-100);
  expect(timeline.textContent).toContain('Detailed ratings.');
  expect(timeline.querySelectorAll('.ev-assistant_message')).toHaveLength(1);
  geometryChanges.disconnect();
});

it('keeps reloaded interim messages above their tool groups through live results and repaint', async () => {
  const working = '11111111-1111-4111-8111-111111111111';
  const exchange = '22222222-2222-4222-8222-222222222222';
  const parent = '33333333-3333-4333-8333-333333333333';
  const turns = { working: { origin: 1, time: T0 } };
  const rows: SessionEvent[] = [
    { seq: 1, time: T0, kind: 'turn_start', source: 'extension', turnId: 'working' },
    { seq: 2, time: T0 + 2000, kind: 'assistant_message', source: 'extension', turnId: 'working',
      messageId: `assistant:${parent}:${working}:${exchange}`, message: text('FIRST UPDATE'), final: false },
    ...[3, 4].map(seq => ({ ...toolCall(seq, `before-${seq}`), turnId: 'working' })),
    { seq: 7, origin: 5, time: T0 + 5000, kind: 'assistant_message', source: 'extension',
      messageId: `assistant:${exchange}:${working}:${exchange}`, message: text('SECOND UPDATE'), final: false },
    { ...toolCall(6, 'after-6'), turnId: 'working' },
    { ...toolCall(8, 'after-8'), turnId: 'working' }
  ];
  const { w, append } = await boot(projectTimeline(rows, turns));
  const timeline = w.document.getElementById('timeline')!;
  const reading = () => [...timeline.children].filter(row => row.matches('.ev-assistant_message, .tool-group'));
  expect(reading().map(row => row.classList.contains('tool-group') ? 'TOOLS' : row.textContent))
    .toEqual([expect.stringContaining('FIRST UPDATE'), 'TOOLS', expect.stringContaining('SECOND UPDATE'), 'TOOLS']);
  const group = reading()[3] as HTMLDetailsElement;
  group.open = true;
  group.dispatchEvent(new w.Event('toggle'));
  await append(projectTimeline([{ ...toolCall(9, 'after-9'), turnId: 'working' }], turns, {}, rows));
  expect(reading()[3]).toBe(group);
  expect(group.open).toBe(true);
  expect(group.querySelectorAll('.ev-tool_call')).toHaveLength(3);
  await append([]);
  expect(reading()[2]?.textContent).toContain('SECOND UPDATE');
  expect(reading()[3]).toBe(group);
  expect(timeline.querySelectorAll('.ev-assistant_message')).toHaveLength(2);
});

it('keeps long surrounding prose while materializing large tool results only on expansion', async () => {
  const call = toolCall(2, 'large-output');
  if (call.kind !== 'tool_call') throw new Error('Expected fixture tool');
  call.call.result = text('Recorded output. '.repeat(150000));
  const { w, append } = await boot([
    { seq: 1, time: T0, kind: 'assistant_message', source: 'extension', messageId: 'before-large', message: text('Prose before the large tool'), final: false },
    call,
    { seq: 3, time: T0 + 3000, kind: 'assistant_message', source: 'extension', messageId: 'after-large', message: text('Prose after the large tool'), final: true }
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const disclosure = timeline.querySelector<HTMLDetailsElement>('details.tool')!;
  expect(disclosure.querySelector('.raw')).toBeNull();
  expect(timeline.textContent).toContain('Prose before the large tool');
  expect(timeline.textContent).toContain('Prose after the large tool');
  disclosure.open = true; disclosure.dispatchEvent(new w.Event('toggle')); await settle();
  expect(disclosure.querySelector('.raw')?.textContent).toContain('Recorded output.');
  await append([]);
  expect(timeline.querySelector('details.tool')).toBe(disclosure);
  expect(disclosure.open).toBe(true);
  expect(timeline.textContent).toContain('Prose before the large tool');
});

it('retains the visible collapsed group beyond the normal resident target and still admits newer data', async () => {
  const rows = Array.from({ length: 400 }, (_, i) => toolCall(i + 1, `dense-${i}`));
  const { w, live, append } = await boot(rows);
  const api = (w as any).api;
  api.getSession = async (_id: string, options: { from?: number; before?: number; after?: number; limit: number }) => {
    const eligible = live.events.filter(e => (options.from === undefined || e.seq >= options.from) && (options.before === undefined || positionOf(e) < options.before) && (options.after === undefined || positionOf(e) > options.after));
    const page = options.from === undefined && options.after === undefined ? eligible.slice(-options.limit) : eligible.slice(0, options.limit);
    return { ok: true, data: { summary: summary(live.events), events: page, total: live.events.length,
      nextFrom: page.reduce((next, e) => Math.max(next, e.seq + 1), options.from ?? 0) } };
  };
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 }, scrollHeight: { value: 400 } });
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    return { top: 0, bottom: this.classList.contains('tool-group') ? 30 : 0,
      height: this.classList.contains('tool-group') ? 30 : 0 } as DOMRect;
  };
  const group = timeline.querySelector('.tool-group');
  // One deliberate movement keeps filling the edge through collapsed batches.
  // Await the actual read result, including its animation-frame yields.
  pane.scrollTop = 0; pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 }));
  // 2.7 s here; the macOS x64 release runner stopped at 300–390 of 400 rows after 5 s (2026-10-15).
  await waitFor(() => expect(timeline.querySelectorAll('.ev-tool_call')).toHaveLength(rows.length), { timeout: 20_000 });
  expect(timeline.querySelector('.tool-group')).toBe(group);
  expect(timeline.querySelectorAll('.raw')).toHaveLength(0);
  for (let i = 0; i < 14; i++) {
    pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: 100 })); await settle();
  }
  await append([{ seq: 401, time: T0 + 401_000, source: 'extension', kind: 'user_message',
    messageId: 'dense-live', message: text('New data at the resident bound') }]);
  expect(timeline.textContent).toContain('New data at the resident bound');
  expect(timeline.querySelector('.tool-group')).toBe(group);
  expect(timeline.querySelectorAll('.ev').length).toBeLessThanOrEqual(rows.length + 1);
});

it.each(['older', 'newer'])('does not apply a %s-page response or scroll after switching to a new chat', async direction => {
  const rows = Array.from({ length: 200 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `prior-${i}`, message: text(`Prior row ${i}`) }));
  const { w } = await boot(rows);
  const api = (w as any).api;
  const pane = w.document.getElementById('chatBody')!;
  if (direction === 'newer') {
    pane.scrollTop = 0; pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 })); await settle();
  }
  const original = api.getSession;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  api.getSession = async (id: string, options: any) => { if (options?.before || options?.after !== undefined) await pending; return original(id, options); };
  pane.scrollTop = 0; pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: direction === 'older' ? -100 : 100 }));
  await settle();
  (w.document.getElementById('newChat') as HTMLElement).click(); await settle();
  pane.scrollTop = 73;
  release(); await settle();
  expect(w.document.getElementById('timeline')!.textContent).not.toContain('Prior row');
  expect(pane.scrollTop).toBe(73);
});

it('clears a delivered check when later model activity arrives without a timer', async () => {
  const message: SessionEvent = { seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'input:receipt', inputId: 'receipt', inputDelivery: 'confirmed', message: text('Continue') };
  const app = await boot([message]);
  const receipt = app.w.document.querySelector('.input-receipt') as HTMLElement;
  expect(receipt.hidden).toBe(false);
  await app.append([toolCall(2, 'next-tool')]);
  expect(app.w.document.querySelector('.input-receipt')).toBe(receipt);
  expect(receipt.hidden).toBe(true);
});


// 2026-10-15, the user's Mac: three fresh-turn continues that failed ("the browser did not pick up
// this message within 60 seconds") stayed at the end of the chat as its newest messages, even after
// the work moved on. A failed automatic continue belongs to its time, like a cancelled one.
it('keeps a failed fresh-turn continue at its creation time, not at the end of the chat', async () => {
  const app = await boot([
    { seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'before-rotation', message: text('Original work') },
    { seq: 2, time: T0 + 2000, source: 'extension', kind: 'user_message', messageId: 'after-rotation', message: text('Later continuation') }
  ]);
  const { w, live } = app;
  live.inputs.push({ id: 'failed-rotation', sessionId: summary([]).id, conversationId: 'chat-b', text: 'Continue the task from where you are.',
    mode: 'auto', dueAt: T0 + 1000, createdAt: T0 + 1000, state: 'failed', owner: null, model: null, reasoningEffort: null, purpose: 'rotation',
    error: 'Not sent: the browser did not pick up this message within 60 seconds.' });
  await app.append([]);
  const timeline = w.document.getElementById('timeline')!;
  expect(timeline.querySelector('[data-input-id="failed-rotation"]')).not.toBeNull();
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Continue the task from where you are.');
  expect(timeline.textContent!.indexOf('Continue the task from where you are.')).toBeLessThan(timeline.textContent!.indexOf('Later continuation'));
});

it('keeps a cancelled automatic draft at its creation time as later messages arrive', async () => {
  const app = await boot([
    { seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'before-draft', message: text('Original work') },
    { seq: 2, time: T0 + 2000, source: 'extension', kind: 'user_message', messageId: 'after-draft', message: text('Later continuation') }
  ]);
  const { w, live } = app;
  live.inputs.push({ id: 'retired-auto', sessionId: summary([]).id, conversationId: 'chat-b', text: 'Unused automatic instruction',
    mode: 'auto', dueAt: T0 + 1000, createdAt: T0 + 1000, state: 'cancelled', owner: null, model: null, reasoningEffort: null,
    finishOwner: { turnId: 'old-turn', periodic: false },
    error: 'Automatic follow-up cancelled because its active turn or setting changed.' });
  await app.append([]);
  const timeline = w.document.getElementById('timeline')!;
  const retired = timeline.querySelector<HTMLElement>('[data-input-id="retired-auto"]')!;
  expect(retired).not.toBeNull();
  expect(retired.querySelector('time')!.textContent).toBe(new Date(T0 + 1000).toLocaleString('en'));
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Unused automatic instruction');
  const before = () => timeline.textContent!.indexOf('Unused automatic instruction') < timeline.textContent!.indexOf('Later continuation');
  expect(before()).toBe(true);
  await app.append([{ seq: 3, time: T0 + 3000, source: 'extension', kind: 'assistant_message', messageId: 'new-progress', message: text('New work continues'), final: false }]);
  expect(timeline.querySelector('[data-input-id="retired-auto"]')).toBe(retired);
  expect(before()).toBe(true);
  expect(live.sent).toHaveLength(0);
  retired.querySelector<HTMLButtonElement>('[title="Dismiss delivery notice"]')!.click();
  await app.append([]);
  expect(timeline.textContent).not.toContain('Unused automatic instruction');
  expect(live.sent).toHaveLength(0);
});

it('keeps the latest recovery verdict in view until the chat works again', async () => {
  // 2026-09-26: a stopped prime was explained only by timeline notes that scrolled away.
  const verdict = 'Could not restart this chat automatically: the browser chat was closed. Send a message here to continue it.';
  const app = await boot([
    { seq: 1, time: T0 + 1000, source: 'extension', kind: 'turn_start', turnId: 'stalled' },
    { seq: 2, time: T0 + 2000, source: 'extension', kind: 'turn_end', turnId: 'stalled', outcome: 'stalled' },
    { seq: 3, time: T0 + 3000, source: 'app', kind: 'note', message: text(verdict) }
  ] as SessionEvent[]);
  const host = app.w.document.getElementById('recoveryStatus')!;
  expect(host.hidden).toBe(false);
  expect(host.textContent).toContain('Could not restart this chat automatically');
  await app.append([{ seq: 4, time: T0 + 4000, source: 'extension', kind: 'turn_start', turnId: 'resumed' } as SessionEvent]);
  expect(host.hidden).toBe(true);
});

it('does not show a handoff note as a recovery verdict', async () => {
  const app = await boot([{ seq: 1, time: T0 + 1000, source: 'app', kind: 'note', continuation: TOKEN, message: text('Compact & Resume abandoned') }] as SessionEvent[]);
  expect(app.w.document.getElementById('recoveryStatus')!.hidden).toBe(true);
});

it('keeps the plain Working label unless playful status words are turned on', async () => {
  const { w } = await boot([{ seq: 1, time: T0, source: 'extension', kind: 'turn_start', turnId: 'held-turn' }]);
  expect(w.document.getElementById('chatState')!.textContent).toMatch(/^Working for /);
});

it('uses a playful work word when it is turned on in Settings', async () => {
  const { w } = await boot([{ seq: 1, time: T0, source: 'extension', kind: 'turn_start', turnId: 'held-turn' }], true, [], [], { playfulStatus: true });
  expect(w.document.getElementById('chatState')!.textContent).toMatch(PLAYFUL_WORDS);
});

it('offers copy and Markdown or HTML export under the answer of a completed turn only', async () => {
  const ask: SessionEvent = { kind: 'user_message', seq: 1, origin: 1, time: T0, source: 'extension', turnId: 'done-turn', messageId: 'ask', message: text('Write hello.txt') };
  const reply: SessionEvent = { kind: 'assistant_message', seq: 2, time: T0 + 1_000, source: 'extension', turnId: 'done-turn', messageId: 'reply', message: text('Created **hello.txt**.'), final: true, state: 'final' };
  const { w, append } = await boot([ask, reply]);
  const api = (w as any).api;
  api.exportMarkdown = vi.fn(async () => ({ ok: true, data: { done: 'copied' } }));
  // Still open: the answer may yet change, so it offers nothing.
  expect(w.document.querySelector('.answer-actions')).toBeNull();

  await append([{ seq: 3, time: T0 + 2_000, source: 'extension', kind: 'turn_end', turnId: 'done-turn', outcome: 'completed' }]);
  const actions = w.document.querySelector('.ev-assistant_message .said .answer-actions');
  expect(actions).not.toBeNull();
  expect(w.document.querySelectorAll('.answer-actions')).toHaveLength(1);

  (actions!.querySelector('button.answer-action') as HTMLButtonElement).click(); await settle();
  expect(api.exportMarkdown).toHaveBeenCalledWith({ id: summary([]).id, scope: 'answer', turnId: 'done-turn', target: 'clipboard' });
  expect(actions!.querySelector('button.answer-action')!.classList.contains('is-done')).toBe(true);

  api.exportMarkdown = vi.fn(async () => ({ ok: true, data: { done: 'saved', name: 'chat.md' } }));
  const choices = [...actions!.querySelectorAll<HTMLButtonElement>('.answer-export-choice')];
  expect(choices.map(choice => choice.textContent)).toEqual(['This answer', 'Whole session', 'Whole session as HTML']);
  // Choosing closes the menu and takes the choice off the screen; focus goes back to the Export button, not the page.
  actions!.querySelector<HTMLDetailsElement>('details.answer-export')!.open = true;
  choices[1]!.focus();
  choices[1]!.click(); await settle();
  expect(actions!.querySelector<HTMLDetailsElement>('details.answer-export')!.open).toBe(false);
  expect(w.document.activeElement).toBe(actions!.querySelector('details.answer-export > summary'));
  expect(api.exportMarkdown).toHaveBeenCalledWith({ id: summary([]).id, scope: 'session', turnId: undefined, target: 'file' });
  // A web page is always previewed first: the choice opens Share's dialog and saves nothing by itself.
  const calls = api.exportMarkdown.mock.calls.length;
  api.sharePage = vi.fn(async () => ({ ok: true, data: { done: 'preview', preview: '00000000-0000-4000-8000-000000000000', html: '<html><head></head></html>', hidden: 0 } }));
  choices[2]!.click(); await settle();
  expect(w.document.querySelector<HTMLDialogElement>('#sharePageDialog')!.open).toBe(true);
  expect(api.sharePage).toHaveBeenCalledWith({ id: summary([]).id, target: 'preview', hide: true, lang: 'en' });
  expect(api.exportMarkdown.mock.calls.length).toBe(calls);
});

it('does not offer copy or export after an interrupted turn', async () => {
  const reply: SessionEvent = { kind: 'assistant_message', seq: 1, time: T0, source: 'extension', turnId: 'cut-turn', messageId: 'cut', message: text('Half an answer'), final: true, state: 'final' };
  const { w } = await boot([reply, { seq: 2, time: T0 + 1_000, source: 'extension', kind: 'turn_end', turnId: 'cut-turn', outcome: 'interrupted' }]);
  expect(w.document.querySelector('.answer-actions')).toBeNull();
});

it('opens each turn with how long it has worked, live while running and still once ended', async () => {
  const start: SessionEvent = { seq: 1, time: T0, source: 'extension', kind: 'turn_start', turnId: 'long-turn' };
  const ask: SessionEvent = { kind: 'user_message', seq: 2, origin: 2, time: T0 + 100, source: 'extension', turnId: 'long-turn', messageId: 'q', message: text('Check the sites') };
  const note: SessionEvent = { kind: 'assistant_message', seq: 3, time: T0 + 2_000, source: 'extension', turnId: 'long-turn', messageId: 'c', message: text('Checking both.'), final: true, state: 'final' };
  const reply: SessionEvent = { kind: 'assistant_message', seq: 4, time: T0 + 70_000, source: 'extension', turnId: 'long-turn', messageId: 'r', message: text('Both sites return 200 OK.'), final: true, state: 'final' };
  const { w, append } = await boot([start, ask, note, reply]);
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({ ok: true,
    data: { sessionId: id, automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null } });
  await append([{ seq: 5, time: T0 + 72_000, source: 'extension', kind: 'turn_end', turnId: 'long-turn', outcome: 'completed' }]);
  const lines = [...w.document.querySelectorAll<HTMLElement>('#timeline .turn-worked')];
  expect(lines.map(line => line.textContent)).toEqual(['Worked for 1m 11s']);
  // At the top of the turn: after your message, before its first reply.
  expect(lines[0]!.previousElementSibling?.matches('.ev-user_message')).toBe(true);
  expect(lines[0]!.nextElementSibling?.textContent).toContain('Checking both.');
  // The header no longer repeats it.
  expect(w.document.getElementById('chatState')!.classList.contains('is-mirrored')).toBe(true);
});

it('keeps a still worked line on earlier turns while the latest turn has its own', async () => {
  const turn = (id: string, at: number, seq: number): SessionEvent[] => [
    { seq, time: at, source: 'extension', kind: 'turn_start', turnId: id },
    { kind: 'user_message', seq: seq + 1, origin: seq + 1, time: at + 10, source: 'extension', turnId: id, messageId: `q-${id}`, message: text(`Ask ${id}`) },
    { kind: 'assistant_message', seq: seq + 2, time: at + 5_000, source: 'extension', turnId: id, messageId: `r-${id}`, message: text(`Answer ${id}`), final: true, state: 'final' },
    { seq: seq + 3, time: at + 9_000, source: 'extension', kind: 'turn_end', turnId: id, outcome: 'completed' }
  ];
  const { w, append } = await boot([...turn('first', T0, 1), ...turn('second', T0 + 60_000, 5)]);
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({ ok: true,
    data: { sessionId: id, automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null } });
  await append([]);
  const lines = [...w.document.querySelectorAll<HTMLElement>('#timeline .turn-worked')];
  expect(lines.map(line => line.textContent)).toEqual(['Worked for 8s', 'Worked for 8s']);
  expect(lines.map(line => line.nextElementSibling?.textContent ?? '')).toEqual([expect.stringContaining('Answer first'), expect.stringContaining('Answer second')]);
});

it('shows the running turn working at its top while it works', async () => {
  const running: SessionEvent[] = [
    { seq: 1, time: Date.now() - 12_000, source: 'extension', kind: 'turn_start', turnId: 'held-turn' },
    { kind: 'user_message', seq: 2, origin: 2, time: Date.now() - 11_900, source: 'extension', turnId: 'held-turn', messageId: 'q-live', message: text('Build it') },
    { kind: 'assistant_message', seq: 3, time: Date.now() - 9_000, source: 'extension', turnId: 'held-turn', messageId: 'c-live', message: text('Starting the build.'), final: true, state: 'final' }
  ];
  const { w } = await boot(running);
  const line = w.document.querySelector<HTMLElement>('#timeline .turn-status')!;
  expect(line.textContent).toMatch(/^Working for /);
  expect(line.classList.contains('is-working')).toBe(true);
  expect(line.previousElementSibling?.matches('.ev-user_message')).toBe(true);
});

it('ends the running turn with a row saying what it is doing now', async () => {
  const asked = Date.now() - 12_000;
  const { w, append } = await boot([
    { seq: 1, time: asked - 100, source: 'extension', kind: 'turn_start', turnId: 'held-turn' },
    { kind: 'user_message', seq: 2, origin: 2, time: asked, source: 'extension', turnId: 'held-turn', messageId: 'q-now', message: text('Run the tests') }
  ]);
  const now = () => w.document.querySelector<HTMLElement>('#timeline .turn-now')!;
  // The Working line keeps only its clock; the step is the last row of the turn's work.
  expect(w.document.querySelector('#timeline .turn-status')!.textContent).toMatch(/^Working for \d+s$/);
  expect(now().parentElement!.lastElementChild).toBe(now());
  const shown = () => now().hidden ? null : [now().querySelector('.turn-now-text')!.textContent, now().querySelector('.turn-now-time')!.textContent];
  // Nothing visible has happened since the message.
  expect(shown()).toEqual(['Thinking', '']);
  // A call of this app runs for this chat: it is named, with its own clock once it lasts.
  const asks: string[][] = [];
  (w as any).api.runningTools = (ids: string[]) => {
    asks.push(ids);
    return Promise.resolve({ ok: true, data: [{ title: 'Running npm test', kind: 'run', since: Date.now() - 5_000 }] });
  };
  await append([]); await append([]);
  expect(asks.at(-1)).toEqual(['chat-b', 'chat-a']);
  expect(shown()).toEqual(['Running npm test', '5s']);
  // No call of ours: ChatGPT's own step, while it is still going on.
  (w as any).api.runningTools = () => Promise.resolve({ ok: true, data: [] });
  await append([{ seq: 3, time: Date.now(), source: 'extension', kind: 'page_tool', messageId: 'thought-1', label: 'Searching the web' }]);
  await append([]);
  expect(shown()?.[0]).toBe('Searching the web');
  // It follows the work: a new step lands above it, and it stays the last row.
  expect(now().previousElementSibling?.textContent).toContain('Searching the web');
  expect(now().parentElement!.lastElementChild).toBe(now());
  // Prose speaks for itself while it is being written, once its first block shows…
  await append([{ kind: 'assistant_message', seq: 4, time: Date.now(), source: 'extension', messageId: 'a-now', message: text('Two tests'), final: false, state: 'streaming' }]);
  expect(shown()).toEqual(['Thinking', '']);
  await append([{ kind: 'assistant_message', seq: 5, time: Date.now(), source: 'extension', messageId: 'a-now', message: text('Two tests fail.\n\nThe'), final: false, state: 'streaming' }]);
  // …and once nothing of it is held back.
  expect(shown()).toEqual(['Thinking', '']);
  await append([{ kind: 'assistant_message', seq: 6, time: Date.now(), source: 'extension', messageId: 'a-now', message: text('Two tests fail.\n\nThe rest pass.\n\n'), final: false, state: 'streaming' }]);
  expect(shown()).toBeNull();
  // …and once it stops changing the turn is still working: an interim paragraph stays "streaming".
  await new Promise(resolve => setTimeout(resolve, 2_600));
  await append([]);
  expect(shown()?.[0]).toBe('Thinking');
});

it('shows a new chat\'s first sentences in the timeline and keeps the live row for what happens now (#942)', async () => {
  const asked = Date.now() - 12_000;
  const { w, append } = await boot([
    { seq: 1, time: asked - 100, source: 'extension', kind: 'turn_start', turnId: 'held-turn' },
    { kind: 'user_message', seq: 2, origin: 2, time: asked, source: 'extension', turnId: 'held-turn', messageId: 'q-first', message: text('Run three commands') }
  ]);
  const now = () => w.document.querySelector<HTMLElement>('#timeline .turn-now')!;
  const shown = () => now().hidden ? null : now().querySelector('.turn-now-text')!.textContent;
  const asks: string[][] = [];
  // ChatGPT shows the sentence long before it publishes a message for it; the turn's outline holds it.
  (w as any).api.turnTraces = (_id: string, ids: string[]) => {
    asks.push(ids);
    return Promise.resolve({ ok: true, data: { 'held-turn': [{ kind: 'say', text: 'First command printed one; now running the second.', done: true },
      ...(status ? [{ kind: 'now', text: status }] : [])] } });
  };
  let status = '';
  await append([]); await append([]);
  expect(asks.at(-1)).toEqual(['held-turn']);
  const sentence = w.document.querySelector<HTMLElement>('#timeline .ev.is-interim')!;
  expect(sentence.textContent).toContain('First command printed one; now running the second.');
  // The sentence is the turn's own words, before the row that says what it does right now.
  expect(sentence.compareDocumentPosition(now()) & w.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(shown()).toBe('Thinking');
  // ChatGPT's own phrase for what the turn is doing takes Thinking's place, with Thinking's sign.
  status = 'Comparando três estruturas de projeto';
  await append([]); await append([]);
  expect(shown()).toBe('Comparando três estruturas de projeto');
  expect(now().classList.contains('is-thinking')).toBe(true);
  // A call of this app running meanwhile keeps ChatGPT's words and lends them its icon.
  (w as any).api.runningTools = () => Promise.resolve({ ok: true, data: [{ title: 'Running echo one', kind: 'run', since: Date.now() }] });
  await append([]); await append([]);
  expect(shown()).toBe('Comparando três estruturas de projeto');
  expect(now().classList.contains('is-thinking')).toBe(false);
  status = '';
  (w as any).api.runningTools = () => Promise.resolve({ ok: true, data: [{ title: 'Running echo two', kind: 'run', since: Date.now() }] });
  await append([]); await append([]);
  expect(shown()).toBe('Running echo two');
  expect(w.document.querySelectorAll('#timeline .ev.is-interim')).toHaveLength(1);
});
