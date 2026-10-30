import { describe, expect, it, vi } from 'vitest';
import { Lexer, T0, TOKEN, boot, colorChoice, compaction, menuItem, olderProjectFixture, prependUserPrompt, projectMenu, settle, settleHistoryFrame, summary, text, toolCall, waitFor, type LocalProject, type SessionEvent, type SessionSummary } from './renderer-timeline.harness.js';

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


it('uses the same separate image row for pending and recorded native attachments', async () => {
  const app = await boot([]);
  const attachment = { id: 'a'.repeat(32), name: 'meme.png', mimeType: 'image/png', size: 42, preview: 'data:image/webp;base64,YQ==' };
  app.live.inputs.push({ id: 'image-input', sessionId: summary([]).id, text: 'whats that', attachments: [attachment],
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null, state: 'browser', owner: null, createdAt: T0, conversationId: 'chat-b' });
  await app.append([]);
  const pending = app.w.document.querySelector('.pending-message')!;
  expect(pending.querySelector('.message-attachments')?.nextElementSibling?.className).toBe('pending-message-text');
  expect(pending.querySelector('.composer-image')).toBeNull();
  await app.append([{ seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'native-image',
    inputId: 'image-input', message: text('whats that'), attachments: [attachment] }]);
  const recorded = app.w.document.querySelector('.said.is-user')!;
  expect(recorded.querySelector('.message-attachments')?.nextElementSibling?.classList.contains('user-message-text')).toBe(true);
  expect(recorded.querySelector('.message-attachments > img')?.getAttribute('alt')).toBe('meme.png');
  expect(recorded.querySelector('.composer-image')).toBeNull();
});

it('keeps all ten injected image previews when the outbox message gains its canonical history row', async () => {
  const { w, live, append } = await boot([]);
  const images = Array.from({ length: 10 }, (_, index) => ({ name: `reference-${index}.webp`, dataUrl: 'data:image/webp;base64,YQ==' }));
  live.inputs.push({ id: 'ten-images', sessionId: summary([]).id, text: 'Ten references', images, mode: 'auto', dueAt: 0,
    state: 'tool', owner: 'request', createdAt: 0, conversationId: 'chat-b', model: null, reasoningEffort: null });
  await append([]);
  expect(w.document.querySelectorAll('#inputQueue [data-input-id="ten-images"] img')).toHaveLength(10);
  await append([{ seq: 1, source: 'app', time: T0, kind: 'user_message', inputId: 'ten-images', messageId: 'input:ten-images', message: text('Ten references') }]);
  expect(w.document.querySelectorAll('#timeline .user-image-slot img')).toHaveLength(10);
  expect(w.document.querySelector('#inputQueue [data-input-id="ten-images"]')).toBeNull();
});

it('explains a legacy missing image recording without asserting a provider receipt', async () => {
  const app = await boot([]);
  const event = toolCall(1, 'missing-image') as Extract<SessionEvent, { kind: 'tool_call' }>;
  event.call.tool = 'view_image';
  event.call.result = text('');
  await app.append([event]);
  const tool = app.w.document.querySelector('details.tool') as HTMLDetailsElement;
  tool.open = true; tool.dispatchEvent(new app.w.Event('toggle'));
  await settle();
  expect(tool.textContent).toContain('No image preview was retained in this recording.');
  expect(tool.textContent).not.toContain('received');
});

it('loads recorded tool images on expansion and hides truncated binary envelopes', async () => {
  const app = await boot([]);
  const { w } = app;
  const event = toolCall(1, 'plugin-image') as Extract<SessionEvent, { kind: 'tool_call' }>;
  event.call.tool = 'get_viewport_screenshot';
  event.call.result = { text: '{"content":[{"type":"image","data":"AAAA', truncated: true, chars: 140000, assetId: 'aaaaaaaa.txt' };
  event.call.assets = [{ id: 'abcdefab.png', mimeType: 'image/png', bytes: 99000 }];
  const getImage = vi.fn(async () => ({ ok: true, data: 'data:image/png;base64,YQ==' }));
  (w as any).api.getSessionImage = getImage;
  await app.append([event]);
  const tool = w.document.querySelector('details.tool') as HTMLDetailsElement;
  expect(getImage).not.toHaveBeenCalled();
  expect(tool.textContent).not.toContain('AAAA');
  expect(tool.textContent).not.toContain('aaaaaaaa.txt');
  tool.open = true; tool.dispatchEvent(new w.Event('toggle'));
  await settle();
  expect(tool.textContent).toContain('aaaaaaaa.txt');
  expect(tool.textContent).not.toContain('AAAA');
  expect(getImage).toHaveBeenCalledWith(summary([]).id, 'abcdefab.png');
  expect(tool.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,YQ==');
});

it("shows a project's older chats when it is expanded, asking for that project's pages only", async () => {
  const f = await olderProjectFixture(); f.heading().click(); await settle();
  expect(f.w.document.querySelector('.project-group [data-id="older-parent"]')).not.toBeNull();
  // A page of workers alone shows no chat, so the next page of the project follows.
  expect(f.projectCalls()).toEqual([
    { projectId: f.project.id, limit: 60 },
    { projectId: f.project.id, limit: 60, cursor: { updatedAt: f.worker.updatedAt, id: f.worker.id } }
  ]);
  // The rest of the history is not paged for it, no chat is selected, and the project stays open.
  expect(f.list.mock.calls.every(([options]) => !!options?.projectId)).toBe(true);
  expect(f.w.document.querySelector('[data-id="oldest-unfiled"]')).toBeNull();
  expect(f.w.document.querySelector('.sess.is-sel')).toBeNull();
  expect((f.w.document.querySelector('.project-group') as HTMLDetailsElement).open).toBe(true);
});

it("keeps a project's older chats through the sidebar's next refresh", async () => {
  const f = await olderProjectFixture(); f.heading().click(); await settle();
  await f.append([]); await settle();
  expect(f.w.document.querySelector('.project-group [data-id="older-parent"]')).not.toBeNull();
  // Asked once: the refresh and another expand do not read the project again.
  f.heading().click(); f.heading().click(); await settle();
  expect(f.projectCalls()).toHaveLength(2);
});

it('stops reading a project when it is collapsed while a page is on its way', async () => {
  const f = await olderProjectFixture();
  let resolve!: (value: any) => void;
  f.list.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  f.heading().click(); await settle();
  expect(f.projectCalls()).toHaveLength(1);
  f.heading().click();
  resolve({ ok: true, data: { sessions: f.own[0], total: 4, nextCursor: { updatedAt: f.worker.updatedAt, id: f.worker.id }, activeId: null, pressure: [], blocked: [] } });
  await settle();
  expect(f.projectCalls()).toHaveLength(1);
  expect((f.w.document.querySelector('.project-group') as HTMLDetailsElement).open).toBe(false);
  // Expanding again continues where it stopped.
  f.heading().click(); await settle();
  expect(f.projectCalls()).toHaveLength(2);
  expect(f.w.document.querySelector('.project-group [data-id="older-parent"]')).not.toBeNull();
});

it('does not loop when a project page cannot be read, and tries again on the next expand', async () => {
  const f = await olderProjectFixture();
  f.list.mockResolvedValueOnce({ ok: false, error: 'Fixture read failure' } as any);
  f.heading().click(); await settle();
  expect(f.projectCalls()).toHaveLength(1);
  expect(f.w.document.querySelector('.project-group [data-id="older-parent"]')).toBeNull();
  f.heading().click(); f.heading().click(); await settle();
  expect(f.w.document.querySelector('.project-group [data-id="older-parent"]')).not.toBeNull();
});

it('asks an empty project once', async () => {
  const f = await olderProjectFixture([[]]);
  f.heading().click(); await settle();
  f.heading().click(); f.heading().click(); await settle();
  expect(f.projectCalls()).toEqual([{ projectId: f.project.id, limit: 60 }]);
  expect(f.w.document.querySelectorAll('.project-group .sess')).toHaveLength(0);
});

it('continues with the project\'s older pages from "Show more"', async () => {
  const task = (index: number): SessionSummary => ({ ...summary([]), id: `project-task-${index}`, conversationId: `chat-${index}`, title: `Task ${index}`,
    projectId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', updatedAt: T0 + 100 - index });
  const f = await olderProjectFixture([[0, 1, 2, 3, 4].map(task), [5, 6].map(task)]);
  f.heading().click(); await settle();
  const shown = () => [...f.w.document.querySelectorAll<HTMLElement>('.project-group .sess')].map(row => row.dataset.id);
  expect(shown()).toHaveLength(5);
  // Everything loaded is on screen, and the project has more: the button reads on from there.
  const more = f.w.document.querySelector('.project-show-more') as HTMLElement;
  expect(more).not.toBeNull();
  more.click(); await settle();
  expect(f.projectCalls()).toHaveLength(2);
  expect(shown()).toEqual([0, 1, 2, 3, 4, 5, 6].map(index => `project-task-${index}`));
  expect(f.w.document.querySelector('.project-show-more')).toBeNull();
});

it('pages project tasks as complete parent/worker groups and keeps the selected task visible after reordering', async () => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Paged', path: '/paged', createdAt: 1 };
  const tasks = Array.from({ length: 8 }, (_, index) => ({ ...summary([]), id: `project-task-${index}`, conversationId: `chat-${index}`, title: `Task ${index}`, projectId: project.id }));
  const worker = { ...summary([]), id: 'project-worker', conversationId: 'worker-chat', projectId: project.id,
    origin: { kind: 'worker' as const, fromSessionId: tasks[0]!.id, agentId: 'worker-1', task: 'Inspect' } };
  const entries = [...tasks, worker];
  const { w, append } = await boot([], true, [], [project], { sessions: entries });
  const section = () => w.document.querySelector('.project-group')!;
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(5);
  (section().querySelector('.worker-toggle') as HTMLButtonElement).click();
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(5);
  expect(section().querySelector('.worker-group [data-id="project-worker"]')).not.toBeNull();
  // A refresh can move the selected older task below the default five. Keep its complete
  // group visible without expanding every other old task or splitting off its child.
  entries.splice(0, entries.length, ...tasks.slice(1), tasks[0]!, worker);
  await append([]);
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(6);
  expect(section().querySelector('[data-id="project-task-0"]')).not.toBeNull();
  expect(section().querySelector('.worker-group [data-id="project-worker"]')).not.toBeNull();
  (section().querySelector('.project-show-more') as HTMLButtonElement).click();
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(8);
  expect(section().querySelector('.project-show-more')).toBeNull();
  await append([]);
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(8);
});
it('does not allocate hidden project chat rows on each activity refresh', async () => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Busy project', path: '/project', createdAt: 1 };
  const tasks = Array.from({ length: 240 }, (_, index): SessionSummary => ({
    ...summary([]), id: `task-${index}`, conversationId: `chat-${index}`,
    title: `Task ${index}`, projectId: project.id
  }));
  const { w, append } = await boot([], false, [], [project], { sessions: tasks });
  expect(w.document.querySelectorAll('.project-group .sess')).toHaveLength(5);

  // Count even detached nodes: simply inspecting the live sidebar misses the hundreds of
  // rows allocated and discarded before the five visible project tasks are appended.
  const created: Element[] = [];
  const create = w.document.createElement.bind(w.document);
  const spy = vi.spyOn(w.document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) => {
    const node = create(tag, options);
    created.push(node);
    return node;
  }) as typeof w.document.createElement);
  try { await append([]); }
  finally { spy.mockRestore(); }

  const sessionRows = created.filter(node => node.classList.contains('sess'));
  expect(w.document.querySelectorAll('.project-group .sess')).toHaveLength(5);
  expect(sessionRows).toHaveLength(5);
});
it('groups many projects without scanning the whole session list for each project', async () => {
  let projectIdReads = 0;
  const ids = Array.from({ length: 24 }, (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`);
  const projects: LocalProject[] = ids.map((id, index) => {
    const project = { id, name: `Project ${index}`, path: `/project-${index}`, createdAt: 1 };
    Object.defineProperty(project, 'id', { enumerable: true, get: () => { projectIdReads++; return id; } });
    return project;
  });
  const tasks = Array.from({ length: 240 }, (_, index): SessionSummary => ({
    ...summary([]), id: `session-${index}`, conversationId: `chat-${index}`,
    projectId: ids[index % ids.length]!
  }));
  const { w, append } = await boot([], false, [], projects, { sessions: tasks });
  expect(w.document.querySelectorAll('.project-group')).toHaveLength(24);
  projectIdReads = 0;
  await append([]);
  // One lookup table per paint is fine; P complete scans of N rows followed by
  // projects.find() for every comparison multiplies CPU work while the UI is busy.
  expect(projectIdReads).toBeLessThan(tasks.length * 12);
});
it('shows five project chats initially and reveals eight more per click', async () => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Paged', path: '/paged', createdAt: 1 };
  const tasks = Array.from({ length: 22 }, (_, index) => ({ ...summary([]), id: `page-task-${index}`, conversationId: `chat-${index}`, projectId: project.id }));
  const { w, append } = await boot([], false, [], [project], { sessions: tasks });
  const section = () => w.document.querySelector('.project-group')!;
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(5);
  for (const count of [13, 21, 22]) {
    (section().querySelector('.project-show-more') as HTMLButtonElement).click();
    expect(section().querySelectorAll(':scope > .sess')).toHaveLength(count);
  }
  expect(section().querySelector('.project-show-more')).toBeNull();
  await append([]);
  expect(section().querySelectorAll(':scope > .sess')).toHaveLength(22);
});

it('shows original user text while retaining transport instructions outside the visible bubble', async () => {
  const { w } = await boot([{ seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'native-one', inputId: 'one', authoredText: 'hello', message: text('hello\n\nTransport-only control instruction') }]);
  expect(w.document.querySelector('.said.is-user .msg')?.textContent).toBe('hello');
  expect(w.document.body.textContent).toContain('hello');
});
it.each(['', '\n', '\n\n'])('hides complete worker instructions without an app receipt, including native prefix %j', async prefix => {
  const sent = prefix + prependUserPrompt('Visible authored message', 'Invisible complete guidance');
  const { w } = await boot([{ seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'echo', message: text(sent) }]);
  expect(w.document.querySelector('.said.is-user .msg')?.textContent).toBe('Visible authored message');
  expect(w.document.body.textContent).not.toContain('Invisible complete guidance');
});

it('imports one physical file drop from the composer, timeline, or sidebar exactly once and caps attachments', async () => {
  const { w } = await boot([], false);
  const api = (w as any).api;
  const image = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'dropped.md', size: 12, mimeType: 'text/markdown' };
  api.dropFiles = vi.fn(async () => ({ ok: true, data: [image] }));
  const drop = (target: Element, count: number) => {
    const event = new w.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: Array.from({ length: count }, () => new w.File(['image'], 'image.png', { type: 'image/png' })) } });
    target.dispatchEvent(event);
    return event;
  };
  expect(drop(w.document.getElementById('timeline')!, 1).defaultPrevented).toBe(true);
  await settle();
  expect(api.dropFiles).toHaveBeenCalledTimes(1);
  expect(drop(w.document.getElementById('composer')!, 1).defaultPrevented).toBe(true);
  await settle();
  expect(api.dropFiles).toHaveBeenCalledTimes(2);
  expect(drop(w.document.getElementById('sessionList')!, 1).defaultPrevented).toBe(true);
  await settle();
  expect(api.dropFiles).toHaveBeenCalledTimes(3);
  expect(w.document.querySelectorAll('#composerImages .attachment-card')).toHaveLength(3);
  expect(w.document.getElementById('composerImages')!.textContent).toContain('dropped.md');
  drop(w.document.getElementById('composer')!, 18);
  await settle();
  expect(api.dropFiles).toHaveBeenCalledTimes(3);
  expect(w.document.querySelectorAll('#composerImages .attachment-card')).toHaveLength(3);
});

it('leaves file drops on the Folders card to its explicit folder-import owner', async () => {
  const { w } = await boot([], false);
  const api = (w as any).api;
  api.dropFiles = vi.fn(async () => ({ ok: true, data: [] }));
  api.addRootPath = vi.fn(async () => ({ ok: true, data: null }));
  const folder = new w.File(['folder'], 'folder-entry', { type: '' });
  const event = new w.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [folder] } });
  w.document.getElementById('foldersCard')!.dispatchEvent(event);
  await settle();
  expect(api.addRootPath).toHaveBeenCalledExactlyOnceWith(folder);
  expect(api.dropFiles).not.toHaveBeenCalled();
});

it('keeps ordinary draft edits and parallel imports in the same draft lifetime', async () => {
  const { w } = await boot([], false);
  const api = (w as any).api;
  const finishes: Array<(value: unknown) => void> = [];
  api.dropFiles = vi.fn(() => new Promise(resolve => finishes.push(resolve)));
  const paste = (name: string) => {
    const event = new w.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [new w.File(['image'], name, { type: 'image/png' })] } });
    w.document.getElementById('chatInput')!.dispatchEvent(event);
  };
  paste('first.png');
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'An ordinary edit while importing'; input.dispatchEvent(new w.Event('input', { bubbles: true }));
  paste('second.png');
  await waitFor(() => expect(api.dropFiles).toHaveBeenCalledTimes(2));
  finishes[1]!({ ok: true, data: [{ id: '11111111-2222-4333-8444-555555555555', name: 'second.png', size: 4, mimeType: 'image/png' }] });
  finishes[0]!({ ok: true, data: [{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'first.png', size: 4, mimeType: 'image/png' }] });
  await settle();
  expect(w.document.querySelectorAll('#composerImages .attachment-card')).toHaveLength(2);
  expect(w.document.getElementById('composerImages')!.textContent).toContain('first.png');
  expect(w.document.getElementById('composerImages')!.textContent).toContain('second.png');
  expect(input.value).toBe('An ordinary edit while importing');
  expect(w.document.querySelector('.toast')?.textContent ?? '').not.toContain('draft changed');
  (w.document.querySelector(`[data-id="${summary([]).id}"]`) as HTMLButtonElement).click();
  await settle();
  expect(w.document.querySelectorAll('#composerImages .attachment-card')).toHaveLength(0);
  w.document.getElementById('newChat')!.click(); await settle();
  expect(input.value).toBe('An ordinary edit while importing');
  expect(w.document.querySelectorAll('#composerImages .attachment-card')).toHaveLength(2);
});

it.each(['new-same-key', 'a-b-a', 'opening-adopt-new', 'same-session-send-next', 'same-session-failed-send', 'plan-replaces', 'retry-replaces'])('rejects a late attachment import after the draft owner changed (%s)', async mode => {
  const a = { ...summary([]), id: 'draft-a', conversationId: 'chat-a' };
  const b = { ...summary([]), id: 'draft-b', conversationId: 'chat-b' };
  const options = mode === 'a-b-a' ? { sessions: [a, b] }
    : mode.startsWith('same-session') || mode.endsWith('replaces') ? { sessions: [a] }
    : mode === 'opening-adopt-new' ? { reserveOpenings: true } : {};
  const app = await boot([], false, [], [], options);
  const { w } = app;
  if (mode === 'a-b-a' || mode.startsWith('same-session') || mode.endsWith('replaces'))
    (w.document.querySelector('[data-id="draft-a"]') as HTMLButtonElement).click();
  if (mode === 'retry-replaces') {
    app.live.inputs.push({ id: 'failed-retry', sessionId: a.id, text: 'Restored failed message',
      mode: 'auto', dueAt: 0, model: null, reasoningEffort: null, state: 'failed', owner: null,
      createdAt: T0, conversationId: a.conversationId, error: 'Delivery failed' });
    await app.append([]);
  }
  let finish!: () => void;
  const attachment = { id: 'cccccccc-dddd-4eee-8fff-000000000000', name: 'late.png', size: 4, mimeType: 'image/png', preview: 'data:image/webp;base64,AAAA' };
  (w as any).api.dropFiles = vi.fn(() => new Promise(resolve => { finish = () => resolve({ ok: true, data: [attachment] }); }));
  const paste = new w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [new w.File(['image'], 'late.png', { type: 'image/png' })] } });
  w.document.getElementById('chatInput')!.dispatchEvent(paste);
  await waitFor(() => expect((w as any).api.dropFiles).toHaveBeenCalledTimes(1));

  if (mode === 'new-same-key') {
    w.document.getElementById('newChat')!.click();
  } else if (mode === 'a-b-a') {
    (w.document.querySelector('[data-id="draft-b"]') as HTMLButtonElement).click();
    (w.document.querySelector('[data-id="draft-a"]') as HTMLButtonElement).click();
  } else if (mode === 'opening-adopt-new') {
    const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
    input.value = 'Adopt this opening';
    w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => expect(w.document.querySelector('.sess.is-sel')).not.toBeNull());
    w.document.getElementById('newChat')!.click();
  } else if (mode.startsWith('same-session')) {
    const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
    if (mode === 'same-session-failed-send')
      (w as any).api.sendInput = vi.fn(async () => ({ ok: false, error: 'test rejected send' }));
    input.value = 'Submitted draft';
    w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    if (mode === 'same-session-send-next') await waitFor(() => expect(app.live.sent).toHaveLength(1));
    else await waitFor(() => expect((w as any).api.sendInput).toHaveBeenCalledTimes(1));
    await settle();
    input.value = 'Next draft'; input.dispatchEvent(new w.Event('input', { bubbles: true }));
  } else if (mode === 'plan-replaces') {
    (w as any).api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Stage one', 'Stage two'] }));
    const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
    input.value = 'Turn this into a plan';
    w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await waitFor(() => expect(input.value).toBe(''));
  } else {
    (w.document.querySelector('.delivery-retry') as HTMLButtonElement).click();
    expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).value).toBe('Restored failed message');
  }
  finish(); await settle();
  expect(w.document.querySelector('#composerImages .attachment-card')).toBeNull();
  expect(w.document.querySelector('.toast')?.textContent).toContain('draft changed');
});

it.each([false, true])('removes a project group in one click, keeps its chats and draft, and rejects an older refresh (selectedSkill=%s)', async selectedSkill => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Removed', path: '/removed', createdAt: 1 };
  const other = { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', name: 'Other', path: '/other', createdAt: 2 };
  const parent = { ...summary([]), projectId: project.id };
  const child = { ...summary([]), id: 'child-session', conversationId: 'child-chat', projectId: project.id,
    origin: { kind: 'worker' as const, fromSessionId: parent.id, agentId: 'worker-1', task: 'Keep working' } };
  const { w, live } = await boot([], false, [], [project, other], { sessions: [parent, child] });
  const api = (w as any).api;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  (w.document.querySelector('.worker-toggle') as HTMLButtonElement).click();
  (w.document.querySelector(`.project-heading > [data-new-project="${project.id}"]`) as HTMLButtonElement).click();
  input.value = 'Keep my draft';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  if (selectedSkill) {
    api.skillLibrary = () => Promise.resolve({ ok: true, data: { skills: [
      { id: 'review', name: 'Review', description: '', path: '/skills/review/SKILL.md', scope: 'managed', source: 'managed', managed: true, allowImplicitInvocation: true }
    ], roots: [], errors: [], includeInstructions: true } });
    input.value = '/re\n' + input.value; input.setSelectionRange(3, 3); input.dispatchEvent(new w.Event('input', { bubbles: true })); await settle();
    w.document.querySelector<HTMLButtonElement>('.skill-choice[data-skill-id="review"]')!.click();
  }
  let finishList!: (value: unknown) => void;
  api.listSessions = () => new Promise(resolve => { finishList = resolve; });
  (w.document.getElementById('chatRefresh') as HTMLButtonElement).click();
  await settle();
  api.removeProject = vi.fn(async () => ({ ok: true, data: { ...project, ungrouped: true } }));
  projectMenu(w, project.id); menuItem(w, 'remove').click();
  await settle();
  expect(api.removeProject).toHaveBeenCalledExactlyOnceWith(project.id);
  expect(w.document.querySelector(`[data-project-id="${project.id}"]`)).toBeNull();
  expect(w.document.querySelector(`[data-project-id="${other.id}"]`)).not.toBeNull();
  expect(w.document.querySelector(`#chatList > [data-id="${parent.id}"]`)).not.toBeNull();
  expect(w.document.querySelector('#chatList > .worker-group [data-id="child-session"]')).not.toBeNull();
  expect(w.document.querySelector(`#projectList [data-id="${parent.id}"]`)).toBeNull();
  expect(input.value).toBe('Keep my draft');
  expect(input.placeholder).toBe('Ask anything…');
  finishList({ ok: true, data: { sessions: [parent, child], activeId: null, pressure: [], blocked: [] } });
  await settle();
  expect(w.document.querySelector(`[data-project-id="${project.id}"]`)).toBeNull();
  (w.document.getElementById('chatSend') as HTMLButtonElement).click();
  await settle();
  expect(live.sent[0]).toMatchObject({ sessionId: null, projectId: null, text: selectedSkill ? '/review\nKeep my draft' : 'Keep my draft' });
});

it('keeps the project visible when its removal fails, and lets the removal be tried again', async () => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Keep', path: '/keep', createdAt: 1 };
  const { w } = await boot([], false, [], [project]);
  (w as any).api.removeProject = vi.fn(async () => ({ ok: false, error: 'Could not save' }));
  projectMenu(w, project.id); menuItem(w, 'remove').click();
  await settle();
  expect(w.document.querySelector('.project-group')).not.toBeNull();
  projectMenu(w, project.id);
  expect(menuItem(w, 'remove').disabled).toBe(false);
  menuItem(w, 'remove').click(); await settle();
  expect((w as any).api.removeProject).toHaveBeenCalledTimes(2);
});

it('offers a new chat beside a project\'s menu, and its color as a submenu and removal inside it', async () => {
  // Linked to its ChatGPT Project: a project without one also offers choosing it (#1756, tested on its own).
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Workspace', path: 'C:\\workspace\\primary', createdAt: 1,
    chatgpt: { state: 'linked' as const, id: `g-p-${'d'.repeat(32)}`, updatedAt: 1 } };
  const { w } = await boot([], false, [], [project]);
  const group = w.document.querySelector<HTMLElement>(`.project-group[data-project-id="${project.id}"]`)!;
  // Two buttons on the row: the primary new chat, then one "⋯"; a right click opens the same menu.
  expect([...group.querySelector('.project-heading')!.querySelectorAll('button')].map(b => b.className)).toEqual(['btn row-menu-button project-new', 'btn row-menu-button project-menu']);
  const button = projectMenu(w, project.id);
  expect(button.getAttribute('aria-expanded')).toBe('true');
  const menu = w.document.querySelector<HTMLElement>('.row-menu')!;
  expect(menu.getAttribute('role')).toBe('menu');
  expect([...menu.querySelectorAll<HTMLElement>('.row-menu-item')].map(item => item.dataset.rowAction)).toEqual(['group-new', 'chatgpt-change', 'chatgpt-unlink', 'color', 'secrets-shield', 'remove']);
  expect(menuItem(w, 'remove').classList.contains('is-danger')).toBe(true);
  expect(w.document.activeElement).toBe(menuItem(w, 'group-new'));
  // Keyboard: Down and Up move, Right opens the color submenu on the current choice, Left comes back.
  menu.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(w.document.activeElement).toBe(menuItem(w, 'chatgpt-change'));
  menu.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(w.document.activeElement).toBe(menuItem(w, 'chatgpt-unlink'));
  menu.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(w.document.activeElement).toBe(menuItem(w, 'color'));
  menu.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(w.document.activeElement).toBe(menuItem(w, 'secrets-shield'));
  menu.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(w.document.activeElement).toBe(menuItem(w, 'remove'));
  menu.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  menu.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  expect(w.document.activeElement).toBe(menuItem(w, 'color'));
  menu.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(w.document.querySelectorAll('.row-menu').length).toBe(2);
  expect(w.document.activeElement).toBe(menuItem(w, 'color-none'));
  expect(menuItem(w, 'color-none').getAttribute('aria-checked')).toBe('true');
  w.document.querySelectorAll<HTMLElement>('.row-menu')[1]!.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  expect(w.document.querySelectorAll('.row-menu').length).toBe(1);
  expect(w.document.activeElement).toBe(menuItem(w, 'color'));
  // Escape closes it and gives focus back to the row's button.
  menu.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(w.document.querySelector('.row-menu')).toBeNull();
  expect(w.document.activeElement).toBe(button);
  expect(button.getAttribute('aria-expanded')).toBe('false');
  // A right click on the row opens the same menu; a click elsewhere closes it.
  group.querySelector('.project-heading')!.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
  expect(menuItem(w, 'color')).not.toBeNull();
  w.document.body.dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
  expect(w.document.querySelector('.row-menu')).toBeNull();
  // New chat in this project: the row's own button, no longer a menu item.
  expect(projectMenu(w, project.id) && menuItem(w, 'new-chat')).toBeNull();
  w.document.body.dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
  (w.document.querySelector(`.project-heading > [data-new-project="${project.id}"]`) as HTMLButtonElement).click(); await settle();
  expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).placeholder).toBe('Message in Workspace…');
});

it('picks and clears project color without changing project membership', async () => {
  const project = {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Workspace', path: 'C:\\workspace\\primary', createdAt: 1
  };
  const { w } = await boot([], false, [], [project]);
  const api = (w as any).api;
  api.setProjectColor = vi.fn(async (_id: string, color: string | null) => ({ ok: true, data: { ...project, ...(color ? { color } : {}) } }));
  colorChoice(w, project.id, 'blue').click(); await settle();
  expect(api.setProjectColor).toHaveBeenNthCalledWith(1, project.id, 'blue');
  let refreshed = w.document.querySelector<HTMLElement>(`.project-group[data-project-id="${project.id}"]`)!;
  expect(refreshed.dataset.projectColor).toBe('blue');
  expect(colorChoice(w, project.id, 'blue').getAttribute('aria-checked')).toBe('true');
  menuItem(w, 'color-none').click(); await settle();
  expect(api.setProjectColor).toHaveBeenNthCalledWith(2, project.id, null);
  refreshed = w.document.querySelector<HTMLElement>(`.project-group[data-project-id="${project.id}"]`)!;
  expect(refreshed.dataset.projectColor).toBeUndefined();
  // Choosing the color it already has saves nothing.
  colorChoice(w, project.id, 'none').click(); await settle();
  expect(api.setProjectColor).toHaveBeenCalledTimes(2);
});

it('turns the secrets shield off and on for one project from its menu (#1797)', async () => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Workspace', path: '/workspace', createdAt: 1 };
  const { w } = await boot([], false, [], [project]);
  const api = (w as any).api;
  api.setProjectSecretsShieldOff = vi.fn(async (_id: string, off: boolean) => ({ ok: true, data: { ...project, ...(off ? { secretsShieldOff: true } : {}) } }));
  projectMenu(w, project.id);
  let item = menuItem(w, 'secrets-shield');
  // An on/off switch, on by default.
  expect(item.getAttribute('role')).toBe('menuitemcheckbox');
  expect(item.getAttribute('aria-checked')).toBe('true');
  expect(item.title).toBe("Keys and tokens in this project's tool results are hidden from ChatGPT");
  item.click(); await settle();
  expect(api.setProjectSecretsShieldOff).toHaveBeenNthCalledWith(1, project.id, true);
  projectMenu(w, project.id);
  item = menuItem(w, 'secrets-shield');
  expect(item.getAttribute('aria-checked')).toBe('false');
  expect(item.title).toBe("This project's tools send keys and tokens to ChatGPT as they are");
  item.click(); await settle();
  expect(api.setProjectSecretsShieldOff).toHaveBeenNthCalledWith(2, project.id, false);
  projectMenu(w, project.id);
  expect(menuItem(w, 'secrets-shield').getAttribute('aria-checked')).toBe('true');
  w.document.body.dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
  // Off in Settings for every project: the switch shows off and waits there.
  (await api.getState()).data.config.ui.secretsShield = false;
  projectMenu(w, project.id);
  item = menuItem(w, 'secrets-shield');
  expect(item.getAttribute('aria-checked')).toBe('false');
  expect(item.disabled).toBe(true);
  expect(item.title).toBe('Off for every project in Settings');
});

it.each([[false, true], [true, true], [true, false]])('preserves the keyboard color-save focus owner (focus moved: %s, focusin: %s)', async (moved, propagates) => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Workspace', path: 'C:\\workspace\\primary', createdAt: 1 };
  const { w } = await boot([], false, [], [project]);
  let finish!: (value: unknown) => void;
  (w as any).api.setProjectColor = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  colorChoice(w, project.id, 'blue').click();
  const other = w.document.createElement('button'); other.textContent = 'Other control'; w.document.body.append(other);
  if (moved) {
    // An inactive Electron document can update activeElement without delivering focusin.
    // Suppress that notification only; the real DOM still owns the current focused element.
    if (!propagates) w.document.addEventListener('focusin', event => event.stopImmediatePropagation(), { capture: true, once: true });
    other.focus();
  }
  finish({ ok: true, data: { ...project, color: 'blue' } }); await settle();
  const button = w.document.querySelector<HTMLButtonElement>('.project-menu')!;
  expect(w.document.querySelector<HTMLElement>('.project-group')!.dataset.projectColor).toBe('blue');
  expect(w.document.activeElement === (moved ? other : button)).toBe(true);
});

it.each([false, true])('a rejected color-save keeps the color and the current focus owner (focus moved: %s)', async moved => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Workspace', path: '/workspace', createdAt: 1 };
  const { w } = await boot([], false, [], [project]);
  let finish!: (value: unknown) => void;
  (w as any).api.setProjectColor = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  colorChoice(w, project.id, 'blue').click();
  // While the save is pending, its choices wait for the answer.
  expect(colorChoice(w, project.id, 'teal').disabled).toBe(true);
  menuItem(w, 'color').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  w.document.querySelector<HTMLElement>('.row-menu')?.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const button = w.document.querySelector<HTMLButtonElement>('.project-menu')!;
  const other = w.document.getElementById('chatInput')!;
  if (moved) other.focus();
  finish({ ok: false, error: 'Synthetic save refusal' }); await settle();
  expect(w.document.querySelector<HTMLElement>('.project-group')!.dataset.projectColor).toBeUndefined();
  expect(w.document.activeElement === (moved ? other : button)).toBe(true);
  expect(colorChoice(w, project.id, 'blue').disabled).toBe(false);
});

it.each([false, true])('does not restore an old color-save focus after selecting another chat and returning (rejected: %s)', async rejected => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Workspace', path: 'C:\\workspace\\primary', createdAt: 1 };
  const a = { ...summary([]), id: 'color-chat-a', projectId: project.id };
  const b = { ...summary([]), id: 'color-chat-b', projectId: project.id };
  const { w } = await boot([], true, [], [project], { sessions: [a, b] });
  let finish!: (value: unknown) => void;
  (w as any).api.setProjectColor = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  colorChoice(w, project.id, 'blue').click();
  // A real click on a chat row moves focus to it; jsdom's click() does not, so do both.
  const choose = (id: string): void => { const row = w.document.querySelector<HTMLElement>(`[data-id="${id}"] [data-session-select]`)!; row.focus(); row.click(); };
  choose('color-chat-b'); await settle();
  choose('color-chat-a'); await settle();
  finish(rejected ? { ok: false, error: 'Synthetic save refusal' } : { ok: true, data: { ...project, color: 'blue' } }); await settle();
  expect(w.document.querySelector<HTMLElement>('.project-group')!.dataset.projectColor).toBe(rejected ? undefined : 'blue');
  // The old save does not pull focus back to the project's menu button.
  expect(w.document.activeElement?.closest('.project-heading')).toBeNull();
});

it('names project colors in the interface language and keeps focus on the menu button after a pick', async () => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Workspace', path: '/workspace', createdAt: 1 };
  const { w } = await boot([], false, [], [project]);
  const api = (w as any).api;
  api.setProjectColor = vi.fn(async (_id: string, color: string | null) => ({ ok: true, data: { ...project, ...(color ? { color } : {}) } }));
  const group = (): HTMLElement => w.document.querySelector<HTMLElement>(`.project-group[data-project-id="${project.id}"]`)!;
  // Each choice is the color itself, in words a screen reader can say, never the internal value.
  const { setLanguage } = await import('../src/renderer/i18n.js');
  expect(colorChoice(w, project.id, 'blue').textContent).toBe('Blue');
  setLanguage('de');
  expect(menuItem(w, 'color-blue').textContent).toBe('Blau');
  expect(menuItem(w, 'color').textContent).toBe('Farbe');
  setLanguage('en');

  // Picking repaints the sidebar. Focus must come back to the new menu button, not fall to the page.
  menuItem(w, 'color-teal').click(); await settle();
  expect(api.setProjectColor).toHaveBeenCalledWith(project.id, 'teal');
  expect(group().dataset.projectColor).toBe('teal');
  expect(w.document.activeElement).toBe(group().querySelector<HTMLButtonElement>('.project-menu'));
});

it('Share a folder creates a sidebar project and keeps it when an older list refresh finishes', async () => {
  const { w, live } = await boot([], false);
  const api = (w as any).api;
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Shared', path: '/shared', createdAt: 1 };
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  let finishList!: (value: unknown) => void;
  api.listSessions = () => new Promise(resolve => { finishList = resolve; });
  (w.document.getElementById('chatRefresh') as HTMLButtonElement).click();
  await settle();
  api.addProject = vi.fn(async () => ({ ok: true, data: project }));
  api.addRoot = vi.fn();
  (w.document.getElementById('composerFolder') as HTMLButtonElement).click();
  await settle();
  expect(api.addProject).toHaveBeenCalledTimes(1);
  expect(api.addRoot).not.toHaveBeenCalled();
  expect(w.document.querySelector<HTMLDetailsElement>(`[data-project-id="${project.id}"]`)?.open).toBe(true);
  finishList({ ok: true, data: { sessions: [], activeId: null, pressure: [], blocked: [] } });
  await settle();
  expect(w.document.querySelector(`[data-project-id="${project.id}"]`)).not.toBeNull();
  expect(input.placeholder).toContain('Shared');
  input.value = 'Work in this folder';
  (w.document.getElementById('chatSend') as HTMLButtonElement).click();
  await settle();
  expect(live.sent[0]).toMatchObject({ sessionId: null, projectId: project.id, text: 'Work in this folder' });
});

// #1469: the sidebar's + offers a folder on this computer or one on a server.
it('offers a local folder and a server folder from the sidebar +, and marks a server project', async () => {
  const { w } = await boot([], false);
  const api = (w as any).api;
  const doc = w.document;
  const local = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1', name: 'Local', path: '/local', createdAt: 1 };
  const remote = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2', name: 'app', path: 'me@devbox:/srv/app', createdAt: 2, remote: { host: 'me@devbox', path: '/srv/app' } };
  api.addProject = vi.fn(async () => ({ ok: true, data: local }));
  api.addRemoteProject = vi.fn(async () => ({ ok: true, data: remote }));
  const item = (action: string) => doc.querySelector<HTMLButtonElement>(`[data-row-action="${action}"]`);
  (doc.getElementById('addProject') as HTMLButtonElement).click();
  await settle();
  expect(item('add-local-project')?.textContent).toContain('Folder on this computer');
  item('add-local-project')!.click();
  await settle();
  expect(api.addProject).toHaveBeenCalledTimes(1);
  expect(doc.querySelector(`[data-project-id="${local.id}"] .project-badge`)).toBeNull();
  (doc.getElementById('addProject') as HTMLButtonElement).click();
  await settle();
  item('add-ssh-project')!.click();
  await settle();
  expect((doc.getElementById('sshProjectDialog') as HTMLDialogElement).open).toBe(true);
  (doc.getElementById('sshProjectAddress') as HTMLInputElement).value = 'me@devbox';
  (doc.getElementById('sshProjectFolder') as HTMLInputElement).value = '/srv/app';
  doc.getElementById('sshProjectForm')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(api.addRemoteProject).toHaveBeenCalledWith('me@devbox', '/srv/app');
  const badge = doc.querySelector(`[data-project-id="${remote.id}"] .project-badge`);
  expect(badge?.textContent).toBe('SSH');
  expect(badge?.getAttribute('title')).toBe('me@devbox');
});

// #1756: with ChatGPT Projects to choose from, a new project's own is picked right after adding it.
describe('choosing a ChatGPT Project for a project', () => {
  const existing = `g-p-${'a'.repeat(32)}`, taken = `g-p-${'b'.repeat(32)}`;
  const local = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3', name: 'Local', path: '/local', createdAt: 3 };
  async function adding(choices: unknown[]) {
    const { w } = await boot([], false);
    const api = (w as any).api;
    api.chatgptProjectChoices = vi.fn(async () => ({ ok: true, data: choices }));
    api.addProject = vi.fn(async () => ({ ok: true, data: local }));
    api.linkChatgptProject = vi.fn(async (id: string, chatgptId: string) => ({ ok: true, data: { ...local, id, chatgpt: { state: 'linked', id: chatgptId, updatedAt: 4 } } }));
    api.createChatgptProject = vi.fn(async (id: string) => ({ ok: true, data: { ...local, id, chatgpt: { state: 'requested', requestId: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee', updatedAt: 4 } } }));
    (w.document.getElementById('addProject') as HTMLButtonElement).click();
    await settle();
    w.document.querySelector<HTMLButtonElement>('[data-row-action="add-local-project"]')!.click();
    await settle(); await settle();
    const options = () => [...w.document.querySelectorAll<HTMLButtonElement>('.chatgpt-project-picker [role="option"]')];
    return { w, api, options };
  }
  const listed = [{ id: existing, name: 'Existing', linkedTo: null }, { id: taken, name: 'Taken', linkedTo: { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee9', name: 'Other' } }];

  it('links the new project to a Project the account already has', async () => {
    const { w, api, options } = await adding(listed);
    expect(api.addProject).toHaveBeenCalledWith({ chatgpt: 'later' });
    expect(options().map(option => option.textContent)).toEqual(['New ChatGPT Project “Local”', 'Existing', 'TakenLinked to Other']);
    expect(options()[2]!.disabled).toBe(true);
    expect(options().map(option => option.title)).toEqual(['New ChatGPT Project “Local”', 'Existing', 'Taken\nLinked to Other']);
    options()[1]!.click();
    await settle();
    expect(api.linkChatgptProject).toHaveBeenCalledWith(local.id, existing);
    expect(api.createChatgptProject).not.toHaveBeenCalled();
    expect(w.document.querySelector('.chatgpt-project-picker')).toBeNull();
  });

  it('creates nothing when the choice is closed, and says it can be made later from the menu', async () => {
    const { w, api } = await adding(listed);
    expect(w.document.querySelector('.chatgpt-project-picker')!.textContent).toContain('Or choose later from the ⋯ menu.');
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(api.createChatgptProject).not.toHaveBeenCalled();
    expect(api.linkChatgptProject).not.toHaveBeenCalled();
  });

  it('adds as before when ChatGPT listed nothing to choose', async () => {
    const { w, api } = await adding([listed[1]]);
    expect(api.addProject).toHaveBeenCalledWith();
    expect(w.document.querySelector('.chatgpt-project-picker')).toBeNull();
    expect(api.createChatgptProject).not.toHaveBeenCalled();
  });

  it('offers the choice from the menu of a project without one, and closing it there changes nothing', async () => {
    const { w } = await boot([], false, [], [local]);
    const api = (w as any).api;
    api.chatgptProjectChoices = vi.fn(async () => ({ ok: true, data: listed }));
    api.createChatgptProject = vi.fn();
    const menuButton = w.document.querySelector<HTMLButtonElement>(`[data-row-menu="project:${local.id}"]`)!;
    menuButton.click();
    w.document.querySelector<HTMLButtonElement>('.row-menu [data-row-action="chatgpt-link"]')!.click();
    await settle();
    // A project with no ChatGPT Project can also start a new one from here.
    expect([...w.document.querySelectorAll('.chatgpt-project-picker [role="option"]')].map(option => option.textContent))
      .toEqual(['New ChatGPT Project “Local”', 'Existing', 'TakenLinked to Other']);
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(w.document.querySelector('.chatgpt-project-picker')).toBeNull();
    expect(api.createChatgptProject).not.toHaveBeenCalled();
  });

  it('unlinks a linked project from its menu, and says the ChatGPT Project stays in ChatGPT', async () => {
    const linked = { ...local, chatgpt: { state: 'linked' as const, id: existing, updatedAt: 4 } };
    const { w } = await boot([], false, [], [linked]);
    const api = (w as any).api;
    api.unlinkChatgptProject = vi.fn(async () => ({ ok: true, data: local }));
    const menuButton = w.document.querySelector<HTMLButtonElement>(`[data-row-menu="project:${local.id}"]`)!;
    menuButton.click();
    expect(w.document.querySelector('.row-menu [data-row-action="chatgpt-link"]')).toBeNull();
    w.document.querySelector<HTMLButtonElement>('.row-menu [data-row-action="chatgpt-unlink"]')!.click();
    await settle();
    expect(api.unlinkChatgptProject).toHaveBeenCalledWith(local.id);
    expect(w.document.body.textContent).toContain('Unlinked. The ChatGPT Project stays in ChatGPT.');
    // Unlinked, the menu offers choosing one again instead of changing or unlinking.
    menuButton.click();
    expect(w.document.querySelector('.row-menu [data-row-action="chatgpt-unlink"]')).toBeNull();
    expect(w.document.querySelector('.row-menu [data-row-action="chatgpt-link"]')).not.toBeNull();
  });
});

it('sends a new chat at once with Automatic when no model list is readable and none was asked for (#864)', async () => {
  // ChatGPT Go and Free show no model picker, so Send used to wait two minutes for a list that never came.
  const { w, live } = await boot([], false, [], [], { noModels: true });
  const discover = vi.fn(async () => ({ ok: true, data: { state: 'unavailable', requestedAt: 1, observedAt: null, models: [] } }));
  (w as any).api.requestChatModels = discover;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  expect(w.document.getElementById('composerModelLabel')!.textContent).toBe('Automatic');
  input.value = 'Hello from a Go account';
  (w.document.getElementById('chatSend') as HTMLButtonElement).click();
  await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ text: 'Hello from a Go account', model: null, reasoningEffort: null });
  expect(discover).not.toHaveBeenCalled();
});

it('preserves the draft and refuses send while model discovery cannot confirm the default model', async () => {
  // The default is an exact request: without a list it is never replaced by Automatic (#864).
  const { w, live } = await boot([], false, [], [], { defaultChatModel: 'gpt-6' });
  const discover = vi.fn(async () => ({ ok: true, data: { state: 'unavailable', requestedAt: 1, observedAt: null, models: [] } }));
  (w as any).api.requestChatModels = discover;
  (w.document.getElementById('refreshComposerModels') as HTMLButtonElement).click();
  await settle();
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Keep this until a real model is selected';
  (w.document.getElementById('chatSend') as HTMLButtonElement).click();
  await settle();
  expect(input.value).toBe('Keep this until a real model is selected');
  expect(live.sent).toHaveLength(0);
  expect(discover).toHaveBeenCalledTimes(2); // Manual Reload, then automatic discovery on Send.
  expect(w.document.body.textContent).toContain('Model discovery could not confirm your selection');
  expect(w.document.querySelector('.pending-message')).toBeNull();
});

it('cancelling Share a folder preserves the selected composer and creates no sidebar group', async () => {
  const { w } = await boot([], false);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Keep this draft';
  (w as any).api.addProject = vi.fn(async () => ({ ok: true, data: null }));
  (w.document.getElementById('composerFolder') as HTMLButtonElement).click();
  await settle();
  expect(input.value).toBe('Keep this draft');
  expect(w.document.querySelector('.project-group')).toBeNull();
});

it('groups project chats and restores each project composer with its selected identity', async () => {
  const projects = [{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Alpha', path: '/alpha', createdAt: 1 }, { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', name: 'Beta', path: '/beta', createdAt: 2 }];
  const { w, live, append } = await boot([], false, [], projects);
  const groups = w.document.querySelectorAll<HTMLDetailsElement>('.project-group');
  expect(groups).toHaveLength(2);
  expect([...groups].map(group => group.open)).toEqual([false, false]);
  expect(groups[0]!.querySelector('[data-id]')?.getAttribute('data-id')).toBe(summary([]).id);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const choose = (id: string) => { (w.document.querySelector(`.project-heading > [data-new-project="${id}"]`) as HTMLButtonElement).click(); };
  choose(projects[0]!.id); expect(w.document.querySelector<HTMLDetailsElement>(`[data-project-id="${projects[0]!.id}"]`)!.open).toBe(true); input.value = 'Alpha draft';
  choose(projects[1]!.id); expect(w.document.querySelector<HTMLDetailsElement>(`[data-project-id="${projects[1]!.id}"]`)!.open).toBe(true); expect(input.value).toBe(''); input.value = 'Beta draft';
  (w.document.getElementById('newChat') as HTMLButtonElement).click();
  expect(input.value).toBe(''); input.value = 'Unfiled draft';
  choose(projects[0]!.id); expect(input.value).toBe('Alpha draft'); input.value = 'Alpha request';
  (w.document.getElementById('chatSend') as HTMLButtonElement).click();
  await settle();
  expect(live.sent[0]).toMatchObject({ sessionId: null, projectId: projects[0]!.id, text: 'Alpha request' });
  choose(projects[1]!.id); expect(input.value).toBe('Beta draft');
  const beta = w.document.querySelector<HTMLDetailsElement>(`[data-project-id="${projects[1]!.id}"]`)!;
  beta.querySelector('summary')!.click(); await append([]);
  expect(w.document.querySelector<HTMLDetailsElement>(`[data-project-id="${projects[1]!.id}"]`)!.open).toBe(false);
});

it('reorders whole project groups without changing chat selection, ownership or disclosure across refresh', async () => {
  const projects: LocalProject[] = [
    { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Alpha', path: '/alpha', createdAt: 1 },
    { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', name: 'Beta', path: '/beta', createdAt: 2 }
  ];
  const chats = projects.map((project, index) => ({ ...summary([]), id: `chat-${index}`, conversationId: `conversation-${index}`, projectId: project.id }));
  const { w, append, live } = await boot([], false, [], projects, { sessions: chats });
  const list = w.document.getElementById('sessionList')!;
  list.setPointerCapture = vi.fn(); list.hasPointerCapture = () => false;
  const groups = () => [...w.document.querySelectorAll<HTMLDetailsElement>('.project-group')];
  const ids = () => groups().map(group => group.dataset.projectId);
  const geometry = () => groups().forEach((group, index) => {
    group.getClientRects = () => [{ top: index * 100, height: 80 }] as unknown as DOMRectList;
    group.getBoundingClientRect = () => ({ top: index * 100, height: 80 }) as DOMRect;
  });
  const pointer = (target: Element | Window, type: string, y: number) => target.dispatchEvent(new w.MouseEvent(type, {
    bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: y
  }));
  groups()[0]!.querySelector('summary')!.click();
  expect(groups()[0]!.open).toBe(true);
  expect(groups().every(group => !group.hasAttribute('data-id'))).toBe(true);
  geometry();
  pointer(groups()[1]!.querySelector('summary')!, 'pointerdown', 110);
  pointer(list, 'pointermove', -20); pointer(w as unknown as Window, 'pointerup', -20);
  expect(ids()).toEqual([projects[1]!.id, projects[0]!.id]);
  expect(groups()[1]!.open).toBe(true);
  for (const chat of chats) expect(w.document.querySelector(`[data-project-id="${chat.projectId}"] [data-id="${chat.id}"]`)).not.toBeNull();
  expect(w.document.querySelector('.sess.is-sel')).toBeNull();
  await append([]);
  expect(ids()).toEqual([projects[1]!.id, projects[0]!.id]);
  geometry();
  const beta = groups()[0]!.querySelector<HTMLElement>('summary')!;
  beta.focus(); beta.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
  expect(ids()).toEqual(projects.map(project => project.id));
  expect(w.document.activeElement).toBe(groups()[1]!.querySelector('summary'));
  const saved = w.localStorage.getItem('chat-on-steroids.sidebar-order');
  pointer(groups()[0]!.querySelector('.project-menu')!, 'pointerdown', 10);
  pointer(list, 'pointermove', 500); pointer(w as unknown as Window, 'pointerup', 500);
  expect(w.localStorage.getItem('chat-on-steroids.sidebar-order')).toBe(saved);
  expect(live.sent).toEqual([]);
});

it('keeps working state per chat and marks only completed background chats as unseen until opened', async () => {
  const startedAt = Date.now();
  const chats: SessionSummary[] = [
    { ...summary([]), id: 'chat-a', title: 'Alpha', conversationId: 'conversation-a', chatIds: ['conversation-a'], updatedAt: startedAt,
      lastToolCallAt: startedAt, activityExpiresAt: startedAt + 60_000 },
    { ...summary([]), id: 'chat-b', title: 'Beta', conversationId: 'conversation-b', chatIds: ['conversation-b'], updatedAt: startedAt - 1,
      lastToolCallAt: startedAt, activityExpiresAt: startedAt + 60_000 }
  ];
  const { w } = await boot([], false, [], [], { sessions: chats });
  const row = (id: string) => w.document.querySelector<HTMLElement>(`.sess[data-id="${id}"]`)!;
  const refresh = async () => { (w.document.getElementById('chatRefresh') as HTMLButtonElement).click(); await settle(); };
  let observedAt = Date.now();
  const nextAt = () => ++observedAt;

  row('chat-a').click();
  expect(row('chat-a').querySelector('.session-status.is-active')).not.toBeNull();
  expect(row('chat-b').querySelector('.session-status.is-active')).not.toBeNull();

  const backgroundCompletedAt = nextAt();
  Object.assign(chats[1]!, {
    activityExpiresAt: null,
    lastAssistantFinalAt: backgroundCompletedAt,
    lastTurnEndAt: backgroundCompletedAt,
    lastTurnOutcome: 'completed',
    updatedAt: backgroundCompletedAt
  });
  await refresh();
  expect(row('chat-a').querySelector('.session-status.is-active')).not.toBeNull();
  expect(row('chat-b').querySelector('.session-status.is-unseen')?.getAttribute('aria-label')).toBe('New response');

  row('chat-b').click();
  expect(row('chat-b').querySelector('.session-status.is-unseen')).not.toBeNull();
  await settle();
  expect(row('chat-b').querySelector('.session-status.is-unseen')).toBeNull();
  expect(w.localStorage.getItem('chat-on-steroids.sidebar-completion-seen')).toContain('chat-b');

  const selectedWorkingAt = nextAt();
  Object.assign(chats[1]!, { lastToolCallAt: selectedWorkingAt, activityExpiresAt: selectedWorkingAt + 60_000, updatedAt: selectedWorkingAt });
  await refresh();
  expect(row('chat-b').querySelector('.session-status.is-active')).not.toBeNull();
  const selectedCompletedAt = nextAt();
  Object.assign(chats[1]!, {
    activityExpiresAt: null,
    lastAssistantFinalAt: selectedCompletedAt,
    lastTurnEndAt: selectedCompletedAt,
    lastTurnOutcome: 'completed',
    updatedAt: selectedCompletedAt
  });
  await refresh();
  expect(row('chat-b').querySelector('.session-status.is-unseen')).toBeNull();

  const alphaCompletedAt = nextAt();
  Object.assign(chats[0]!, {
    activityExpiresAt: null,
    lastAssistantFinalAt: alphaCompletedAt,
    lastTurnEndAt: alphaCompletedAt,
    lastTurnOutcome: 'completed',
    updatedAt: alphaCompletedAt
  });
  await refresh();
  expect(row('chat-a').querySelector('.session-status.is-unseen')).not.toBeNull();
  expect(row('chat-b').querySelector('.session-status.is-unseen')).toBeNull();
});

it("marks every New response seen from the header, or one project's from its menu, and leaves a working chat working", async () => {
  // Linked to a ChatGPT Project, so its menu holds no "Choose a ChatGPT Project…" (#1756).
  const project: LocalProject = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Workspace', path: '/workspace', createdAt: 1,
    chatgpt: { state: 'linked', id: `g-p-${'a'.repeat(32)}`, updatedAt: 1 } };
  const startedAt = Date.now();
  const chat = (id: string, projectId?: string): SessionSummary => ({ ...summary([]), id, title: id, conversationId: `conversation-${id}`, chatIds: [`conversation-${id}`],
    projectId, updatedAt: startedAt, lastToolCallAt: startedAt, activityExpiresAt: startedAt + 60_000 });
  const chats = [chat('p1', project.id), chat('p2', project.id), chat('p3', project.id), chat('u1')];
  const { w } = await boot([], false, [], [project], { sessions: chats });
  const row = (id: string) => w.document.querySelector<HTMLElement>(`.sess[data-id="${id}"]`)!;
  const unseen = () => chats.map(entry => entry.id).filter(id => row(id).querySelector('.session-status.is-unseen'));
  const header = () => w.document.getElementById('markAllSeen') as HTMLButtonElement;
  const actions = () => [...w.document.querySelectorAll<HTMLElement>('.row-menu .row-menu-item')].map(item => item.dataset.rowAction);
  const refresh = async () => { (w.document.getElementById('chatRefresh') as HTMLButtonElement).click(); await settle(); };
  expect(header().hidden).toBe(true);
  projectMenu(w, project.id);
  expect(actions()).toEqual(['group-new', 'chatgpt-change', 'chatgpt-unlink', 'color', 'secrets-shield', 'remove']);
  w.document.querySelector<HTMLElement>('.row-menu')!.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  // p1, p2 and u1 finish in the background; p3 is still running.
  let at = Date.now();
  for (const entry of [chats[0]!, chats[1]!, chats[3]!]) {
    const done = ++at;
    Object.assign(entry, { activityExpiresAt: null, lastAssistantFinalAt: done, lastTurnEndAt: done, lastTurnOutcome: 'completed', updatedAt: done });
  }
  await refresh();
  expect(unseen()).toEqual(['p1', 'p2', 'u1']);
  expect(header().hidden).toBe(false);

  projectMenu(w, project.id);
  expect(actions()).toEqual(['group-new', 'chatgpt-change', 'chatgpt-unlink', 'mark-seen', 'color', 'secrets-shield', 'remove']);
  menuItem(w, 'mark-seen').click();
  await settle();
  expect(unseen()).toEqual(['u1']);
  expect(row('p3').querySelector('.session-status.is-active')).not.toBeNull();
  projectMenu(w, project.id);
  expect(actions()).toEqual(['group-new', 'chatgpt-change', 'chatgpt-unlink', 'color', 'secrets-shield', 'remove']);
  w.document.querySelector<HTMLElement>('.row-menu')!.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  header().focus();
  header().click();
  await settle();
  expect(unseen()).toEqual([]);
  expect(header().hidden).toBe(true);
  expect(w.document.activeElement?.id).toBe('searchChatsButton');
  expect(row('p3').querySelector('.session-status.is-active')).not.toBeNull();
  const saved = w.localStorage.getItem('chat-on-steroids.sidebar-completion-seen')!;
  for (const id of ['p1', 'p2', 'u1']) expect(saved).toContain(`"${id}"`);
  expect(saved).not.toContain('"p3"');
});

it.each(['projects', 'inbox'] as const)("hands the keyboard on to search when the last New response is read while the header button has focus (%s layout)", async layout => {
  const startedAt = Date.now();
  const chats: SessionSummary[] = [{ ...summary([]), id: 'chat-a', title: 'Alpha', conversationId: 'conversation-a', chatIds: ['conversation-a'],
    updatedAt: startedAt, lastToolCallAt: startedAt, activityExpiresAt: startedAt + 60_000 }];
  const { w } = await boot([], false, [], [], { sessions: chats, inbox: layout === 'inbox' });
  const header = () => w.document.getElementById('markAllSeen') as HTMLButtonElement;
  const row = () => w.document.querySelector<HTMLElement>('.sess[data-id="chat-a"]')!;
  const search = () => layout === 'inbox' ? w.document.querySelector<HTMLElement>('[data-inbox-control="search"]')! : w.document.getElementById('searchChatsButton')!;
  // The chat finishes in the background.
  const done = Date.now() + 1;
  Object.assign(chats[0]!, { activityExpiresAt: null, lastAssistantFinalAt: done, lastTurnEndAt: done, lastTurnOutcome: 'completed', updatedAt: done });
  (w.document.getElementById('chatRefresh') as HTMLButtonElement).click();
  await waitFor(() => expect(header().hidden).toBe(false), { timeout: 5000 });
  header().focus();
  expect(w.document.activeElement).toBe(header());

  // Opening the chat acknowledges it only when its detail read comes back, not on the click.
  let reply: (value: unknown) => void = () => {};
  (w as any).api.getSession = vi.fn(() => new Promise(resolve => { reply = resolve; }));
  row().querySelector<HTMLElement>('[data-session-select]')!.click();
  await waitFor(() => expect((w as any).api.getSession).toHaveBeenCalled(), { timeout: 5000 });
  expect(header().hidden).toBe(false);
  reply({ ok: true, data: { summary: chats[0], events: [], total: 0, nextFrom: 0 } });
  await waitFor(() => expect(header().hidden).toBe(true), { timeout: 5000 });
  expect(w.document.activeElement).toBe(search());
});

it('keeps the sidebar working spinner on one continuous phase across activity repaints', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
  try {
    const chats: SessionSummary[] = [{
      ...summary([]), id: 'chat-a', title: 'Alpha', conversationId: 'conversation-a', chatIds: ['conversation-a'],
      updatedAt: 10_000, lastToolCallAt: 10_000, activityExpiresAt: 70_000
    }];
    const { w } = await boot([], false, [], [], { sessions: chats });
    const spinner = () => w.document.querySelector<HTMLElement>('.sess[data-id="chat-a"] .session-status.is-active')!;
    expect(spinner().style.animationDelay).toBe('-100ms');

    clock.mockReturnValue(10_450);
    chats[0]!.lastToolCallAt = 10_450;
    chats[0]!.updatedAt = 10_450;
    (w.document.getElementById('chatRefresh') as HTMLButtonElement).click();
    await settle();
    // The row node was rebuilt, but the spinner resumes the wall-clock phase instead of 0deg.
    expect(spinner().style.animationDelay).toBe('-550ms');
  } finally {
    clock.mockRestore();
  }
});

it('keeps unseen completions unread through failed and stale A-to-B-to-A detail loads', async () => {
  const chats: SessionSummary[] = [
    { ...summary([]), id: 'chat-a', title: 'Alpha', conversationId: 'conversation-a', chatIds: ['conversation-a'] },
    { ...summary([]), id: 'chat-b', title: 'Beta', conversationId: 'conversation-b', chatIds: ['conversation-b'] }
  ];
  const { w } = await boot([], false, [], [], { sessions: chats });
  const row = (id: string) => w.document.querySelector<HTMLElement>(`.sess[data-id="${id}"]`)!;
  let observedAt = Date.now();
  for (const chat of chats) {
    const completedAt = ++observedAt;
    Object.assign(chat, {
      activeTurnId: null,
      activityExpiresAt: null,
      lastAssistantFinalAt: completedAt,
      lastTurnEndAt: completedAt,
      lastTurnOutcome: 'completed',
      updatedAt: completedAt
    });
  }
  (w.document.getElementById('chatRefresh') as HTMLButtonElement).click();
  await settle();
  expect(row('chat-a').querySelector('.session-status.is-unseen')).not.toBeNull();
  expect(row('chat-b').querySelector('.session-status.is-unseen')).not.toBeNull();

  type Reply = (value: unknown) => void;
  const pending: Array<{ id: string; reply: Reply }> = [];
  const api = (w as any).api;
  api.getSession = vi.fn((id: string) => new Promise(resolve => pending.push({ id, reply: resolve })));
  const detail = (sum: SessionSummary) => ({ ok: true, data: { summary: sum, events: [], total: 0, nextFrom: 0 } });

  // A failed current read is not a review receipt.
  row('chat-b').click();
  await waitFor(() => expect(pending.map(entry => entry.id)).toEqual(['chat-b']));
  expect(row('chat-b').querySelector('.session-status.is-unseen')).not.toBeNull();
  pending[0]!.reply({ ok: false, error: 'B detail unavailable' });
  await settle();
  expect(row('chat-b').querySelector('.session-status.is-unseen')).not.toBeNull();

  // Returning to A creates a new selection/load generation. Neither the old A response nor
  // the intervening B response may acknowledge work just because the selected id later matches.
  row('chat-a').click();
  await waitFor(() => expect(pending.map(entry => entry.id)).toEqual(['chat-b', 'chat-a']));
  row('chat-b').click();
  await waitFor(() => expect(pending.map(entry => entry.id)).toEqual(['chat-b', 'chat-a', 'chat-b']));
  row('chat-a').click();
  await waitFor(() => expect(pending.map(entry => entry.id)).toEqual(['chat-b', 'chat-a', 'chat-b', 'chat-a']));

  pending[1]!.reply(detail(chats[0]!));
  pending[2]!.reply(detail(chats[1]!));
  await settle();
  expect(row('chat-a').querySelector('.session-status.is-unseen')).not.toBeNull();
  expect(row('chat-b').querySelector('.session-status.is-unseen')).not.toBeNull();

  pending[3]!.reply(detail(chats[0]!));
  await settle();
  expect(row('chat-a').querySelector('.session-status.is-unseen')).toBeNull();
  expect(row('chat-b').querySelector('.session-status.is-unseen')).not.toBeNull();
});

it('folds a whole Compact & Resume into one row that says the new chat opened', async () => {
  const { w } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'session_start', conversationId: 'chat-a', title: 'Loop under test' },
    toolCall(2, 'call-1'),
    ...compaction(3),
    toolCall(9, 'call-2')
  ]);
  const timeline = w.document.getElementById('timeline')!;

  const cards = timeline.querySelectorAll('details.compaction');
  expect(cards).toHaveLength(1);
  const card = cards[0]!;
  expect(card.className).toContain('tone-good');
  expect(card.querySelector('summary')!.textContent).toMatch(/^Compact & Resume:New chat opened at .* \(44 characters\)$/);
  expect(card.querySelectorAll('summary .step')).toHaveLength(0);

  // The rows the card replaces are gone from the list; nothing else is.
  expect(timeline.querySelector('.ev-handoff')).toBeNull();
  expect(timeline.textContent).not.toContain('[[CLF-');
  expect(timeline.querySelectorAll('.ev-turn_start, .ev-turn_end')).toHaveLength(0);
  expect(timeline.querySelectorAll('.ev-tool_call')).toHaveLength(2);
  // The card sits where the compaction happened, between the two calls.
  const order = [...timeline.children].map((row) => row.className);
  expect(order).toEqual(['ev ev-tool_call', 'ev ev-compaction', 'ev ev-tool_call']);

  // Everything is still there for whoever unfolds the card.
  card.toggleAttribute('open', true);
  expect(card.textContent).toContain('Brief request');
  expect(card.textContent).toContain('keep the loop running');
  expect(card.textContent).toContain('Handoff saved');
  expect(card.textContent).toContain('Bootstrap sent into the new chat');
});

it('folds a Compact & Resume whose marker ChatGPT escaped as Markdown', async () => {
  // Same fold, same assertions, but the two prompts are recorded the way the composer has
  // written them since 2026-09-16. Every reader of the shared marker regex reads text that
  // came back out of the page, so they all stopped matching at once: this card was not built
  // at all, and the raw marker was left on screen in the rows it should have replaced.
  const { w } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'session_start', conversationId: 'chat-a', title: 'Loop under test' },
    toolCall(2, 'call-1'),
    ...compaction(3, true),
    toolCall(9, 'call-2')
  ]);
  const timeline = w.document.getElementById('timeline')!;

  const cards = timeline.querySelectorAll('details.compaction');
  expect(cards).toHaveLength(1);
  expect(cards[0]!.querySelector('summary')!.textContent).toMatch(/^Compact & Resume:New chat opened at .* \(44 characters\)$/);
  // Stripped in the form it was recorded in, so no half-removed marker survives either.
  expect(timeline.textContent).not.toContain('[[CLF-');
  expect(timeline.textContent).not.toContain('CLF-RESUME');
  expect([...timeline.children].map((row) => row.className)).toEqual(['ev ev-tool_call', 'ev ev-compaction', 'ev ev-tool_call']);

  cards[0]!.toggleAttribute('open', true);
  expect(cards[0]!.textContent).toContain('Brief request');
  expect(cards[0]!.textContent).toContain('keep the loop running');
});

it('retires a pending Skills picker when sending replaces its draft', async () => {
  const { w, live } = await boot([], false);
  let resolve!: (value: unknown) => void;
  (w as any).api.skillLibrary = () => new Promise(done => { resolve = done; });
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = '/'; input.setSelectionRange(1, 1); input.dispatchEvent(new w.Event('input', { bubbles: true }));
  expect((w.document.getElementById('skillPicker') as HTMLElement).hidden).toBe(false);
  input.value = 'Complete my task'; input.dispatchEvent(new w.Event('input', { bubbles: true }));
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(live.sent[0]?.text).toBe('Complete my task');
  expect((w.document.getElementById('skillPicker') as HTMLElement).hidden).toBe(true);
  input.value = 'Next task';
  resolve({ ok: true, data: { skills: [{ id: 'old', name: 'Old', description: '', path: '/skills/old/SKILL.md', scope: 'managed', managed: true, source: 'managed', allowImplicitInvocation: true }], roots: [], errors: [], includeInstructions: true } });
  await settle();
  expect(input.value).toBe('Next task');
  expect((w.document.getElementById('skillPicker') as HTMLElement).hidden).toBe(true);
});

it('uses slash Skills completion and delivers the selected directive once with the unchanged task', async () => {
  const { w, live } = await boot([], false);
  (w as any).api.skillLibrary = vi.fn(async () => ({ ok: true, data: { skills: [
    { id: 'review', name: 'Review code', description: 'Inspect before editing', path: '/skills/review/SKILL.md', managed: true, source: 'managed', scope: 'managed', allowImplicitInvocation: true }
  ], roots: [], errors: [], includeInstructions: true } }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Do my entire task.\nKeep the second line.';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  input.value = '/re\n' + input.value; input.setSelectionRange(3, 3); input.dispatchEvent(new w.Event('input', { bubbles: true })); await settle();
  w.document.querySelector<HTMLButtonElement>('.skill-choice[data-skill-id="review"]')!.click();
  expect(input.value).toBe('Do my entire task.\nKeep the second line.');
  expect(w.document.querySelectorAll('.composer-selected-skill')).toHaveLength(1);
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]!.text).toBe('/review\nDo my entire task.\nKeep the second line.');
  expect(w.document.querySelectorAll('.composer-selected-skill')).toHaveLength(0);
});

it('keeps Projects and Chats separate while preserving disclosure state through activity refresh', async () => {
  const project: LocalProject = { id: '33333333-3333-4333-8333-333333333333', name: 'Workspace', path: '/workspace', createdAt: T0 };
  const linked = { ...summary([]), id: 'linked-chat', projectId: project.id };
  const standalone = { ...summary([]), id: 'standalone-chat', projectId: undefined };
  const app = await boot([], false, [], [project], { sessions: [linked, standalone] });
  expect(app.w.document.querySelector('#projectList [data-id="linked-chat"]')).not.toBeNull();
  expect(app.w.document.querySelector('#chatList [data-id="standalone-chat"]')).not.toBeNull();
  expect(app.w.document.querySelector('#chatList [data-id="linked-chat"]')).toBeNull();
  const projects = app.w.document.getElementById('projectsSection') as HTMLDetailsElement;
  projects.open = false; await app.append([]);
  expect(app.w.document.getElementById('projectsSection')).toBe(projects);
  expect(projects.open).toBe(false);
});

it('reviews only an exact recorded edit without expanding its tool row or querying Git', async () => {
  const project: LocalProject = { id: '33333333-3333-4333-8333-333333333333', name: 'Workspace', path: '/workspace', createdAt: T0 };
  const edit = toolCall(2, 'edit-one');
  if (edit.kind !== 'tool_call') throw new Error('Expected a tool call');
  edit.call.tool = 'apply_patch';
  edit.call.summary = { kind: 'edit', title: 'Edited src/main.ts', metric: '+1 −1', tone: 'good' };
  edit.call.changes = [{ path: '/repo/src/main.ts', added: 1, removed: 1, approximate: false, reviewAssetId: 'deadbeef.txt' }];
  const app = await boot([edit], true, [], [project]);
  const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });
  const reviewCall = vi.fn(() => ok({ callId: edit.call.callId, changeIndex: 0, path: 'src/main.ts', added: 1, removed: 1,
    baseText: 'before', currentText: 'after' }));
  app.w.api.getToolEditReview = reviewCall;
  const row = app.w.document.querySelector<HTMLDetailsElement>('details.tool')!;
  const review = row.querySelector<HTMLButtonElement>('.tool-open-diff')!;
  expect(review.getAttribute('aria-label')).toBe('Review this edit');
  review.click(); await settle();
  expect(row.open).toBe(false);
  expect(reviewCall).toHaveBeenCalledWith(expect.any(String), edit.call.callId, 0);
  expect(app.w.document.querySelector<HTMLElement>('.review-panel .file-changes-view')?.hidden).toBe(false);
  expect(app.w.document.querySelector('.review-panel .file-preview-meta')?.textContent).toContain('This edit');
});

it('says why an edit has no diff and how many files a partial review covers (#563)', async () => {
  const project: LocalProject = { id: '44444444-4444-4444-8444-444444444444', name: 'Workspace', path: '/workspace', createdAt: T0 };
  const missing = toolCall(2, 'edit-too-large');
  const partial = toolCall(3, 'edit-partial');
  if (missing.kind !== 'tool_call' || partial.kind !== 'tool_call') throw new Error('Expected tool calls');
  for (const edit of [missing, partial]) {
    edit.call.tool = 'apply_patch';
    edit.call.summary = { kind: 'edit', title: 'Edited files', metric: '+2 −2', tone: 'good' };
  }
  missing.call.changes = [{ path: '/repo/big.json', added: 1, removed: 1, approximate: false, reviewUnavailable: 'too-large' }];
  partial.call.changes = [
    { path: '/repo/src/a.ts', added: 1, removed: 1, approximate: false, reviewAssetId: 'deadbeef.txt' },
    { path: '/repo/src/b.ts', added: 1, removed: 1, approximate: false, reviewUnavailable: 'not-kept' }
  ];
  const app = await boot([missing, partial], true, [], [project]);
  const [first, second] = [...app.w.document.querySelectorAll<HTMLDetailsElement>('details.tool')];
  const unavailable = first!.querySelector<HTMLButtonElement>('.tool-open-diff')!;
  expect(unavailable.classList.contains('is-unavailable')).toBe(true);
  expect(unavailable.getAttribute('aria-disabled')).toBe('true');
  expect(unavailable.getAttribute('aria-label')).toBe('Diff unavailable: this edit was too large to keep');
  unavailable.click(); await settle();
  expect(first!.open).toBe(false);
  expect(second!.querySelector('.tool-open-diff')?.getAttribute('aria-label')).toBe('Review this edit (1 of 2 files)');
});

it('does not offer a project diff shortcut in an unfiled chat', async () => {
  const edit = toolCall(2, 'edit-unfiled');
  if (edit.kind !== 'tool_call') throw new Error('Expected a tool call');
  edit.call.tool = 'apply_patch';
  edit.call.summary = { kind: 'edit', title: 'Edited src/main.ts', metric: '+1 −1', tone: 'good' };
  edit.call.changes = [{ path: '/repo/src/main.ts', added: 1, removed: 1, approximate: false, reviewAssetId: 'deadbeef.txt' }];
  const app = await boot([edit]);
  expect(app.w.document.querySelector('.tool-open-diff')).toBeNull();
});

it('starts in New Chat despite active history and selects only the exact acknowledged send', async () => {
  const app = await boot([], false);
  const { w, live } = app;
  expect(w.document.querySelector('#sessionList .is-sel')).toBeNull();
  await app.append([]);
  expect(w.document.querySelector('#sessionList .is-sel')).toBeNull();
  (w.document.getElementById('chatInput') as HTMLTextAreaElement).value = 'A new request';
  (w.document.getElementById('chatAutomation') as HTMLSelectElement).value = 'loop';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(live.sent[0]).toMatchObject({ sessionId: null, text: 'A new request', automation: 'loop', authoredSource: 'text' });
  live.inputs[0] = { ...live.inputs[0]!, state: 'sent', conversationId: 'chat-b', deliveredSessionId: summary([]).id };
  await app.append([]);
  expect(w.document.querySelector('#sessionList .is-sel')?.getAttribute('data-id')).toBe(summary([]).id);
});

it('selects an acknowledged New Chat while recording notifications keep arriving', async () => {
  const app = await boot([], false);
  const { w, live } = app;
  (w.document.getElementById('chatInput') as HTMLTextAreaElement).value = 'Streaming request';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  live.inputs[0] = { ...live.inputs[0]!, state: 'sent', conversationId: 'chat-b', deliveredSessionId: summary([]).id };
  const timer = setInterval(app.notifySession, 30);
  try {
    await waitFor(() => expect(w.document.querySelector('#sessionList .is-sel')?.getAttribute('data-id')).toBe(summary([]).id), { timeout: 2000 });
  } finally { clearInterval(timer); }
});

it.each(['composer', 'bubble'])('clears New Chat drafts and removes a delivery cancelled with %s', async (control) => {
  const app = await boot([], false, [], [], { reserveOpenings: true });
  const { w, live } = app;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Old attempt';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  const owner = live.inputs[0]!.sessionId!;
  expect(w.document.querySelector('#sessionList .is-sel')?.getAttribute('data-id')).toBe(owner);
  expect(w.document.getElementById('inputQueue')!.textContent).toContain('Old attempt');
  live.inputs[0] = { ...live.inputs[0]!, state: 'browser' };
  input.value = 'Discard this draft';
  w.document.getElementById('newChat')!.click();
  await app.append([]);
  expect(input.value).toBe('');
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Old attempt');
  expect(live.inputs[0]!.state).toBe('browser'); // Preserve ambiguous receipts; never retry them.
  (w.document.querySelector(`#sessionList [data-id="${owner}"]`) as HTMLButtonElement).click();
  await settle();
  expect(w.document.getElementById('inputQueue')!.textContent).toContain('Old attempt');
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  const cancel = vi.fn(async (id: string) => { live.inputs = live.inputs.map(row => row.id === id ? { ...row, state: 'cancelled' as const, error: 'Not sent: this delivery was cancelled before Send was authorized.' } : row); return { ok: true, data: true }; });
  (w as any).api.cancelInput = cancel;
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).toBe('Cancel delivery');
  if (control === 'composer') w.document.getElementById('chatSend')!.click();
  else (w.document.querySelector('#inputQueue [title="Cancel delivery"]') as HTMLButtonElement).click();
  await settle();
  expect(cancel).toHaveBeenCalledWith(live.inputs[0]!.id);
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Old attempt');
  w.document.getElementById('newChat')!.click();
  input.value = 'Fresh attempt';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(w.document.getElementById('inputQueue')!.textContent).toContain('Fresh attempt');
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Old attempt');
});

it.each([false, true])('dismisses retired delivery errors in selected-chat=%s without resending', async selected => {
  const app = await boot([], selected, [], [], { reserveOpenings: true });
  const { w, live } = app;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const submit = () => w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  input.value = 'Expired request'; submit(); await settle();
  const owner = live.inputs[0]!.sessionId!;
  live.inputs[0] = { ...live.inputs[0]!, state: 'cancelled', error: 'Delivery confirmation timed out. The message may already have reached ChatGPT.' };
  if (!selected) {
    w.document.getElementById('newChat')!.click();
    await app.append([]);
    expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Expired request');
    (w.document.querySelector(`#sessionList [data-id="${owner}"]`) as HTMLButtonElement).click();
  }
  await app.append([]);
  const queue = w.document.getElementById('inputQueue')!;
  expect(queue.textContent).toContain('Expired request');
  expect(queue.textContent).toContain('may already have reached ChatGPT');
  const retry = queue.querySelector<HTMLButtonElement>('[aria-label="Retry delivery"]')!;
  expect(retry.classList.contains('delivery-retry')).toBe(true);
  expect(retry.textContent).toBe('');
  expect(retry.querySelector('.ico.ph-arrow-clockwise')).not.toBeNull();
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).not.toBe('Cancel delivery');
  (queue.querySelector('[title="Dismiss delivery notice"]') as HTMLButtonElement).click();
  await app.append([]);
  expect(queue.textContent).not.toContain('Expired request');
  w.document.getElementById('newChat')!.click();
  input.value = 'Fresh request'; submit(); await settle();
  expect(live.sent.at(-1)).toMatchObject({ text: 'Fresh request' });
  expect(queue.textContent).not.toContain('Expired request');
});

it('does not steal a newer New Chat draft when an older queued send is acknowledged', async () => {
  const app = await boot([], false);
  const { w, live } = app;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'First request';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  w.document.getElementById('newChat')!.click();
  input.value = 'Newer unsent draft';
  live.inputs[0] = { ...live.inputs[0]!, state: 'sent', conversationId: 'chat-b', deliveredSessionId: summary([]).id };
  await app.append([]);
  expect(w.document.querySelector('#sessionList .is-sel')).toBeNull();
  expect(input.value).toBe('Newer unsent draft');
  w.document.getElementById('newChat')!.click();
  input.value = '';
  await app.append([]);
  expect(w.document.querySelector('#sessionList .is-sel')).toBeNull();
});

it.each(['stopped', 'failed'] as const)('shows the exact summary turn %s instead of writing, then updates the same card on recovery', async outcome => {
  const [request, start, brief, end, handoff, resume] = compaction(2);
  const app = await boot([request!, start!, { ...brief!, final: false, state: 'streaming' } as SessionEvent]);
  const card = app.w.document.querySelector<HTMLDetailsElement>('details.compaction')!;
  const state = () => card.querySelector('summary .state')!.textContent;
  expect(state()).toBe('ChatGPT is writing the summary…');
  await app.append([{ ...end!, outcome, detail: outcome === 'failed' ? 'Provider request limit' : undefined } as SessionEvent]);
  expect(state()).toBe(outcome === 'stopped' ? 'Summary generation stopped' : 'Summary generation failed — Provider request limit');
  expect(card.className).toContain('tone-bad');
  await app.append([{ ...handoff!, seq: 9, time: T0 + 9000 }]);
  expect(state()).toContain('Summary saved');
  expect(card.className).toContain('tone-wait');
  await app.append([{ ...resume!, seq: 10, time: T0 + 10000 }]);
  expect(app.w.document.querySelector('details.compaction')).toBe(card);
  expect(state()).toContain('New chat opened');
  expect(card.className).toContain('tone-good');
});

it('keeps a stopped empty summary truthful without adopting another turn or its completed outcome', async () => {
  const [request, start, , end] = compaction(2);
  const app = await boot([request!, start!, { ...end!, outcome: 'stopped' } as SessionEvent]);
  await app.append([
    { seq: 10, time: T0 + 10000, source: 'extension', kind: 'turn_start', turnId: 'other' },
    { seq: 11, time: T0 + 11000, source: 'extension', kind: 'turn_end', turnId: 'other', outcome: 'completed' }
  ]);
  expect(app.w.document.querySelector('details.compaction summary .state')!.textContent).toBe('Summary generation stopped');
});

it('a committed resume supersedes an older abandonment on the same compaction', async () => {
  const [request, start, , end, , resume] = compaction(2);
  const app = await boot([request!, start!, { ...end!, outcome: 'failed' } as SessionEvent,
    { seq: 8, time: T0 + 8000, source: 'app', kind: 'note', continuation: TOKEN, message: text('Compact & Resume abandoned — earlier failure') }]);
  await app.append([{ ...resume!, seq: 9, time: T0 + 9000 }]);
  expect(app.w.document.querySelector('details.compaction summary .state')!.textContent).toContain('New chat opened');
});

it('does not infer compaction failure from a later tool call while the handoff is being saved', async () => {
  const [request, start, brief, end] = compaction(2);
  const { w, append } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'session_start', conversationId: 'chat-a', title: 'Loop under test' },
    request!,
    start!,
    brief!,
    end!
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const state = () => timeline.querySelector('details.compaction summary .state')!.textContent;
  // Still the newest thing recorded: the summary is written, the app is saving it.
  expect(state()).toBe('Summary written — saving the handoff…');
  expect(timeline.querySelector('details.compaction')!.className).toContain('tone-wait');

  // A late call does not settle the continuation transaction.
  await append([toolCall(9, 'call-late')]);
  expect(state()).toBe('Summary written — saving the handoff…');
  expect(timeline.querySelector('details.compaction')!.className).toContain('tone-wait');
});

it('keeps one live compaction across refused source calls and unrelated old-turn commentary', async () => {
  const [request, start, brief, end, handoff, resume] = compaction(2);
  const app = await boot([request!, start!]);
  const card = app.w.document.querySelector<HTMLDetailsElement>('details.compaction')!;
  const state = () => card.querySelector('summary .state')!.textContent;
  const late = toolCall(4, 'late-source-call') as Extract<SessionEvent, { kind: 'tool_call' }>;
  late.call.outcome = 'tool_rejected';
  late.call.result = text('COMPACTION_IN_PROGRESS: no local tool was run.');
  await app.append([late, { seq: 5, time: T0 + 5000, source: 'extension', kind: 'assistant_message',
    messageId: 'old-commentary', turnId: 'old-turn', final: false, message: text('Still reading the old task.') }]);
  expect(state()).toBe('Summary requested — waiting for ChatGPT…');
  expect(card.className).toContain('tone-wait');
  expect(card.textContent).not.toContain('Still reading the old task.');
  expect(app.w.document.querySelector('.ev-assistant_message')!.textContent).toContain('Still reading the old task.');
  await app.append([{ ...brief!, seq: 6, time: T0 + 6000 }, { ...end!, seq: 7, time: T0 + 7000 }]);
  expect(state()).toBe('Summary written — saving the handoff…');
  expect(card.textContent).toContain('Goal: keep the loop running.');
  await app.append([{ ...handoff!, seq: 8, time: T0 + 8000 }, toolCall(9, 'late-recording')]);
  expect(state()).toContain('opening the new chat');
  await app.append([{ ...resume!, seq: 10, time: T0 + 10000 }]);
  expect(app.w.document.querySelector('details.compaction')).toBe(card);
  expect(app.w.document.querySelectorAll('details.compaction')).toHaveLength(1);
  expect(card.className).toContain('tone-good');
});

/**
 * The shape the live recorder actually writes. The brief request is typed by the app, so its
 * row carries no local turn id; the turn ChatGPT answers it in opens right after it. Folding by
 * the request's own turn id left the start, the brief, the end and the handoff loose under an
 * empty card — twenty rows for one compaction.
 */
it('folds the answer turn into the card when the request row has no turn id', async () => {
  const [request, start, brief, end, handoff, resume] = compaction(2) as [
    SessionEvent, SessionEvent, SessionEvent, SessionEvent, SessionEvent, SessionEvent
  ];
  delete (request as { turnId?: string }).turnId;
  const { w } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'session_start', conversationId: 'chat-a', title: 'Loop under test' },
    request,
    start,
    brief,
    end,
    handoff,
    { seq: 8, time: T0 + 8000, source: 'extension', kind: 'turn_start', turnId: 'turn-next' },
    resume
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const order = [...timeline.children].map((row) => row.className);
  expect(order).toEqual(['ev ev-compaction']);
  expect(timeline.querySelector('details.compaction')!.className).toContain('tone-good');
});

it('says why a compaction died when the app abandoned it', async () => {
  const [request, start, brief, end] = compaction(2);
  const { w } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'session_start', conversationId: 'chat-a', title: 'Loop under test' },
    request!,
    start!,
    brief!,
    end!,
    {
      seq: 7,
      time: T0 + 7000,
      source: 'app',
      kind: 'note',
      continuation: TOKEN,
      message: text('Compact & Resume abandoned — the handover never landed and was given up on')
    },
    toolCall(8, 'call-after')
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const card = timeline.querySelector('details.compaction')!;
  expect(card.className).toContain('tone-bad');
  expect(card.querySelector('summary .state')!.textContent).toBe('Failed — the handover never landed and was given up on');
  // The note is the card's, not a loose row of its own.
  expect(timeline.querySelectorAll('.ev-note')).toHaveLength(0);
  card.toggleAttribute('open', true);
  expect(card.textContent).toContain('abandoned');
});

it('offers to open a new chat with the summary an abandoned compaction already saved (#1215)', async () => {
  const [request, start, brief, end, handoff] = compaction(2);
  const abandoned = { seq: 9, time: T0 + 9000, source: 'app', kind: 'note', continuation: TOKEN,
    message: text('Compact & Resume abandoned — the new chat could not be opened') } as SessionEvent;
  const { w, live } = await boot([request!, start!, brief!, end!, handoff!, abandoned]);
  const card = w.document.querySelector<HTMLDetailsElement>('details.compaction')!;
  expect(card.className).toContain('tone-bad');
  const reuse = card.querySelector<HTMLButtonElement>('.compaction-reuse')!;
  expect(reuse.textContent).toBe('Open a new chat with this summary');
  reuse.click();
  await waitFor(() => expect(live.controlCalls).toContainEqual(
    expect.objectContaining({ action: `resume:${(handoff as Extract<SessionEvent, { kind: 'handoff' }>).handoffId}` })));
});

it('offers no summary reuse when the abandoned run never saved a summary', async () => {
  const [request, start, brief, end] = compaction(2);
  const abandoned = { seq: 9, time: T0 + 9000, source: 'app', kind: 'note', continuation: TOKEN,
    message: text('Compact & Resume abandoned — the summary was not written') } as SessionEvent;
  const { w } = await boot([request!, start!, brief!, end!, abandoned]);
  expect(w.document.querySelector('details.compaction')).not.toBeNull();
  expect(w.document.querySelector('.compaction-reuse')).toBeNull();
});

it('takes the summary reuse off an abandoned run once a later Compact & Resume started (#1215)', async () => {
  const [request, start, brief, end, handoff] = compaction(2);
  const abandoned = { seq: 9, time: T0 + 9000, source: 'app', kind: 'note', continuation: TOKEN,
    message: text('Compact & Resume abandoned — cancelled') } as SessionEvent;
  const later = { seq: 10, time: T0 + 10000, source: 'extension', kind: 'user_message', messageId: 'm-later-bootstrap',
    message: text('[[CLF-RESUME:tok_fedcba9876543210]] Continue from this brief: keep the loop running.') } as SessionEvent;
  const { w } = await boot([request!, start!, brief!, end!, handoff!, abandoned, later]);
  expect(w.document.querySelectorAll('details.compaction')).toHaveLength(2);
  expect(w.document.querySelector('.compaction-reuse')).toBeNull();
});

it('puts a reopened run\'s saved summary in its own row (#1215)', async () => {
  const [request, start, brief, end, handoff] = compaction(2);
  const abandoned = { seq: 9, time: T0 + 9000, source: 'app', kind: 'note', continuation: TOKEN,
    message: text('Compact & Resume abandoned — cancelled') } as SessionEvent;
  const again = { seq: 10, time: T0 + 10000, source: 'app', kind: 'handoff', handoffId: 'h-2', chars: 26_333,
    reason: 'compact and resume', continuation: 'tok_fedcba9876543210' } as SessionEvent;
  const bootstrap = { seq: 11, time: T0 + 11000, source: 'extension', kind: 'user_message', messageId: 'm-again',
    message: text('[[CLF-RESUME:tok_fedcba9876543210]] Continue from this brief: keep the loop running.') } as SessionEvent;
  const { w } = await boot([request!, start!, brief!, end!, handoff!, abandoned, again, bootstrap]);
  const timeline = w.document.getElementById('timeline')!;
  expect([...timeline.children].map((row) => row.className)).toEqual(['ev ev-compaction', 'ev ev-compaction']);
  const rows = [...timeline.querySelectorAll('details.compaction')];
  expect(rows[1]!.querySelector('summary .state')!.textContent).toContain('26k characters');
});

it('offers no summary reuse once the new chat opened', async () => {
  const [request, start, brief, end, handoff, resume] = compaction(2);
  const { w } = await boot([request!, start!, brief!, end!, handoff!, resume!]);
  expect(w.document.querySelector('details.compaction')).not.toBeNull();
  expect(w.document.querySelector('.compaction-reuse')).toBeNull();
});

it('retains the open compaction disclosure and brief request while the summary streams and completes', async () => {
  const [request, start, original, , handoff, resume] = compaction(2);
  const brief = { ...original, origin: original!.seq, state: 'streaming', final: false } as Extract<SessionEvent, { kind: 'assistant_message' }>;
  const { w, append } = await boot([request!, start!, brief]);
  const card = w.document.querySelector<HTMLDetailsElement>('details.compaction')!;
  card.open = true;
  card.dispatchEvent(new w.Event('toggle'));
  const requestText = card.querySelector('.pre')!;
  const head = card.querySelector('summary')!;
  head.focus();
  for (let i = 0; i < 3; i++) {
    await append([{ ...brief, seq: 20 + i, message: text('# Brief\n\n' + 'More summary text. '.repeat(i + 2)), final: i === 2, state: i === 2 ? 'final' : 'streaming' }]);
    expect(w.document.querySelector('details.compaction')).toBe(card);
    expect(card.open).toBe(true);
    expect(card.querySelector('.pre')).toBe(requestText);
    expect(w.document.activeElement).toBe(head);
    expect(card.querySelector('.rich')!.textContent).toContain('More summary text.');
  }
  expect(card.querySelector('summary .state')!.textContent).toBe('Summary written — saving the handoff…');
  await append([{ ...handoff!, seq: 23 }, { ...resume!, seq: 24 }]);
  expect(w.document.querySelector('details.compaction')).toBe(card);
  expect(card.className).toContain('tone-good');
  card.open = false;
  card.dispatchEvent(new w.Event('toggle'));
  await append([toolCall(25, 'after-resume')]);
  expect(card.open).toBe(false);
});

it('keeps a streaming message anchor and its following tool group across canonical revisions', async () => {
  const message: Extract<SessionEvent, { kind: 'assistant_message' }> = { seq: 1, origin: 1, time: T0, source: 'extension',
    kind: 'assistant_message', messageId: 'live-message', message: text('Working'), state: 'streaming', final: false };
  const { w, append } = await boot([message, toolCall(2, 'live-tool'), toolCall(3, 'next-tool')]);
  const timeline = w.document.getElementById('timeline')!;
  const anchor = timeline.querySelector<HTMLElement>('.ev-assistant_message')!.dataset.timelineKey;
  const group = timeline.querySelector<HTMLDetailsElement>('.tool-group')!;
  group.open = true;
  group.dispatchEvent(new w.Event('toggle'));
  await append([{ ...message, seq: 4, message: text('Working on the next step') }]);
  expect(timeline.querySelector<HTMLElement>('.ev-assistant_message')!.dataset.timelineKey).toBe(anchor);
  expect(timeline.querySelector('.tool-group')).toBe(group);
  expect(group.open).toBe(true);
});

describe('an answer while ChatGPT writes it', () => {
  const answer = (seq: number, body: string, more: Partial<Extract<SessionEvent, { kind: 'assistant_message' }>> = {}): SessionEvent => ({
    seq, origin: 1, time: T0, source: 'extension', kind: 'assistant_message', messageId: 'live-answer', message: text(body),
    state: 'streaming', final: false, ...more });
  const blocks = (w: { document: Document }) => [...w.document.querySelectorAll<HTMLElement>('.ev-assistant_message .msg.rich > *')];
  const fading = (w: { document: Document }) => blocks(w).filter(block => block.classList.contains('is-entering')).map(block => block.textContent?.trim());

  it('keeps finished paragraphs of a streaming answer as the same nodes while it grows', async () => {
    const { w, append } = await boot([answer(1, 'Alpha one.')]);
    const row = w.document.querySelector('.ev-assistant_message');
    const [first] = blocks(w);
    const selection = w.getSelection()!;
    selection.setBaseAndExtent(first!.firstChild!, 0, first!.firstChild!, 5);
    await append([answer(2, 'Alpha one.\n\nBeta two.')]);
    expect(w.document.querySelector('.ev-assistant_message')).toBe(row);
    expect(blocks(w)[0]).toBe(first);
    expect(blocks(w).map(block => block.textContent)).toEqual(['Alpha one.', 'Beta two.']);
    expect(selection.anchorNode).toBe(first!.firstChild);
    expect(selection.toString()).toBe('Alpha');
  });

  it('fades in only the blocks a revision adds, not the one that grew', async () => {
    const { w, append } = await boot([answer(1, 'Alpha.\n\nBeta')]);
    await append([answer(2, 'Alpha.\n\nBeta grew.\n\nGamma.\n\n- Delta')]);
    expect(fading(w)).toEqual(['Gamma.', 'Delta']);
  });

  it('keeps a block that faded in as the same node on the next revision', async () => {
    const { w, append } = await boot([answer(1, 'Alpha.')]);
    await append([answer(2, 'Alpha.\n\nBeta.')]);
    const beta = blocks(w)[1]!;
    expect(beta.classList.contains('is-entering')).toBe(true);
    // The ended fade leaves the block's class attribute behind, empty.
    beta.dispatchEvent(new w.Event('animationend'));
    await append([answer(3, 'Alpha.\n\nBeta.\n\nGamma.')]);
    expect(blocks(w)[1]).toBe(beta);
    expect(fading(w)).toEqual(['Gamma.']);
  });

  it('keeps the blocks a reader used: an opened source card and a copied code block', async () => {
    const body = 'Alpha. :chatgpt-content-reference{index="1"}\n\n```\nnpm test\n```';
    const references = [{ index: 1, sources: [{ title: 'A report', url: 'https://news.example.com/report', source: 'Example News' }] }];
    const { w, append } = await boot([answer(1, body, { references })]);
    (w as any).api.writeClipboard = vi.fn(async () => ({ ok: true, data: true }));
    const [alpha, code] = blocks(w);
    alpha!.querySelector('.citation')!.dispatchEvent(new w.FocusEvent('focusin'));
    expect(alpha!.querySelector<HTMLElement>('.citation-card')!.hidden).toBe(false);
    code!.querySelector<HTMLButtonElement>('.tool-copy')!.click();
    await waitFor(() => expect(code!.querySelector('.tool-copy')!.textContent).toBe('Copied'));
    await append([answer(2, `${body}\n\nBeta.`, { references })]);
    expect(blocks(w)[0]).toBe(alpha);
    expect(blocks(w)[1]).toBe(code);
    expect(fading(w)).toEqual(['Beta.']);
  });

  it('opens a chat with a streaming answer without fading its blocks', async () => {
    const { w } = await boot([answer(1, 'Alpha.\n\nBeta.')]);
    expect(blocks(w)).toHaveLength(2);
    expect(fading(w)).toEqual([]);
  });

  it('replaces an answer from the first block a revision changes', async () => {
    const { w, append } = await boot([answer(1, 'Alpha.\n\nBeta')]);
    const [alpha] = blocks(w);
    // The next line turns the paragraph above it into a heading.
    await append([answer(2, 'Alpha.\n\nBeta\n---\n\nGamma.')]);
    expect(blocks(w)[0]).toBe(alpha);
    expect(blocks(w).map(block => block.tagName)).toEqual(['P', 'H2', 'P']);
    expect(fading(w)).toEqual(['Gamma.']);
  });

  it('keeps an answer\'s blocks when it completes and gains its actions', async () => {
    const ask: SessionEvent = { kind: 'user_message', seq: 1, origin: 1, time: T0, source: 'extension', turnId: 'done-turn', messageId: 'ask', message: text('Say hello') };
    const { w, append } = await boot([ask, answer(2, 'Alpha.', { origin: 2, turnId: 'done-turn' })]);
    const row = w.document.querySelector('.ev-assistant_message')!;
    const [alpha] = blocks(w);
    expect(row.querySelector('.said > b')!.textContent).toBe('ChatGPT (partial)');
    await append([answer(3, 'Alpha.\n\nBeta.', { origin: 2, turnId: 'done-turn', state: 'final', final: true })]);
    await append([{ seq: 4, time: T0 + 2_000, source: 'extension', kind: 'turn_end', turnId: 'done-turn', outcome: 'completed' }]);
    expect(w.document.querySelector('.ev-assistant_message')).toBe(row);
    expect(blocks(w)[0]).toBe(alpha);
    expect(row.querySelector('.said > b')!.textContent).toBe('ChatGPT');
    expect(row.querySelectorAll('.said > .answer-actions')).toHaveLength(1);
  });

  it('adds no fade under reduced motion', async () => {
    const { w, append } = await boot([answer(1, 'Alpha.')]);
    expect(blocks(w)).toHaveLength(1);
    Object.defineProperty(w, 'matchMedia', { configurable: true,
      value: (query: string) => ({ matches: query.includes('reduce'), addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
    const [alpha] = blocks(w);
    await append([answer(2, 'Alpha.\n\nBeta.')]);
    expect(blocks(w)[0]).toBe(alpha);
    expect(fading(w)).toEqual([]);
  });

  it('replaces a code block unfaded while it gains lines', async () => {
    const { w, append } = await boot([answer(1, 'Alpha.\n\n```\nline 1')]);
    const [alpha, code] = blocks(w);
    await append([answer(2, 'Alpha.\n\n```\nline 1\nline 2')]);
    expect(blocks(w)[0]).toBe(alpha);
    expect(blocks(w)[1]).not.toBe(code);
    expect(blocks(w)[1]!.querySelector('pre')!.textContent).toBe('line 1\nline 2\n');
    expect(fading(w)).toEqual([]);
  });

  it('swaps the whole row when a revision is too long to draw rich', async () => {
    const { w, append } = await boot([answer(1, 'Alpha.')]);
    const row = w.document.querySelector('.ev-assistant_message');
    await append([answer(2, `Alpha. ${'Long. '.repeat(50_000)}`)]);
    const rows = w.document.querySelectorAll('.ev-assistant_message');
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toBe(row);
    expect(rows[0]!.querySelector('.said > .msg')!.classList.contains('rich')).toBe(false);
    expect(rows[0]!.textContent).toContain('Alpha. Long.');
  });

  describe('while its turn works', () => {
    const start: SessionEvent = { seq: 1, time: T0, source: 'extension', kind: 'turn_start', turnId: 'live-turn' };
    const written = (seq: number, body: string, more: Partial<Extract<SessionEvent, { kind: 'assistant_message' }>> = {}) =>
      answer(seq, body, { origin: 2, turnId: 'live-turn', ...more });
    const shown = (w: { document: Document }) => blocks(w).map(block => block.textContent?.trim());

    it('holds back the paragraph ChatGPT is still writing', async () => {
      const { w, append } = await boot([start, written(2, 'Alpha.\n\nBe')]);
      expect(shown(w)).toEqual(['Alpha.']);
      const [alpha] = blocks(w);
      await append([written(3, 'Alpha.\n\nBeta.\n\nGa')]);
      expect(shown(w)).toEqual(['Alpha.', 'Beta.']);
      expect(blocks(w)[0]).toBe(alpha);
      expect(fading(w)).toEqual(['Beta.']);
    });

    it('opens a chat mid-answer with the tail held back and nothing fading', async () => {
      const { w } = await boot([start, written(2, 'Alpha.\n\nBeta.\n\nGa')]);
      expect(shown(w)).toEqual(['Alpha.', 'Beta.']);
      expect(fading(w)).toEqual([]);
    });

    it('fades in the first paragraph of an answer as it appears', async () => {
      const { w, append } = await boot([start, written(2, 'Alp')]);
      expect(w.document.querySelector<HTMLElement>('.ev-assistant_message')!.hidden).toBe(true);
      await append([written(3, 'Alpha.\n\nBe')]);
      expect(w.document.querySelector<HTMLElement>('.ev-assistant_message')!.hidden).toBe(false);
      expect(fading(w)).toEqual(['Alpha.']);
    });

    it('never cuts inside an open code fence', async () => {
      const { w, append } = await boot([start, written(2, 'Alpha.\n\n~~~~\none\n\n~~~\ntwo\n')]);
      expect(shown(w)).toEqual(['Alpha.']);
      await append([written(3, 'Alpha.\n\n~~~~\none\n\n~~~\ntwo\n~~~~\nAf')]);
      expect(blocks(w)[1]!.querySelector('pre')!.textContent).toBe('one\n\n~~~\ntwo\n');
    });

    it('shows the whole answer once it is final, keeping the blocks it showed', async () => {
      const { w, append } = await boot([start, written(2, 'Alpha.\n\nBe')]);
      const [alpha] = blocks(w);
      await append([written(3, 'Alpha.\n\nBeta.', { state: 'final', final: true })]);
      expect(shown(w)).toEqual(['Alpha.', 'Beta.']);
      expect(blocks(w)[0]).toBe(alpha);
      expect(fading(w)).toEqual(['Beta.']);
    });

    it('shows the rest when the turn ends on a message that stays streaming', async () => {
      const { w, append } = await boot([start, written(2, 'Alpha.\n\nBe')]);
      expect(shown(w)).toEqual(['Alpha.']);
      await append([{ seq: 3, time: T0 + 3_000, source: 'extension', kind: 'turn_end', turnId: 'live-turn', outcome: 'stopped' }]);
      expect(shown(w)).toEqual(['Alpha.', 'Be']);
    });

    it('shows the rest once something follows the message in its turn', async () => {
      const { w, append } = await boot([start, written(2, 'Alpha.\n\nBe')]);
      expect(shown(w)).toEqual(['Alpha.']);
      await append([{ ...toolCall(3, 'after'), turnId: 'live-turn' }]);
      expect(shown(w)).toEqual(['Alpha.', 'Be']);
    });

    it('keeps the live row while it holds back a block ChatGPT is still writing', async () => {
      const ask: SessionEvent = { kind: 'user_message', seq: 2, origin: 2, time: T0, source: 'extension', turnId: 'live-turn', messageId: 'ask-live', message: text('Write it') };
      const { w, append } = await boot([start, ask, written(3, 'Alpha.\n\n```ts\nconst a = 1;')]);
      const live = () => {
        const row = w.document.querySelector<HTMLElement>('#timeline .turn-now');
        return row && !row.hidden ? row.querySelector('.turn-now-text')!.textContent : null;
      };
      expect(shown(w)).toEqual(['Alpha.']);
      expect(live()).toBe('Thinking');
      await append([written(4, 'Alpha.\n\n```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;')]);
      expect(shown(w)).toEqual(['Alpha.']);
      expect(live()).toBe('Thinking');
      // Everything written so far shows: the prose speaks for itself.
      await append([written(5, 'Alpha.\n\n```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```\n\n')]);
      expect(blocks(w)).toHaveLength(2);
      expect(live()).toBeNull();
    });

    it('draws nothing again for a chunk that finishes no block', async () => {
      const { w, append } = await boot([start, written(2, 'Alpha.\n\nBe', { renderedHtml: text('<p>Alpha.</p><p>Be</p>') })]);
      const row = w.document.querySelector('.ev-assistant_message');
      const lex = vi.spyOn(Lexer, 'lex');
      // A revision advances the seq and the page's capture grows, but what shows is the same.
      await append([written(3, 'Alpha.\n\nBeta is', { renderedHtml: text('<p>Alpha.</p><p>Beta is</p>') })]);
      expect(lex).not.toHaveBeenCalled();
      expect(w.document.querySelector('.ev-assistant_message')).toBe(row);
      // The store can move a revision's time to when the page authored it; the held row keeps its clock.
      const clock = row!.querySelector('time')!.textContent;
      await append([written(4, 'Alpha.\n\nBeta is mo', { time: T0 + 1_500 })]);
      expect(lex).not.toHaveBeenCalled();
      await append([written(5, 'Alpha.\n\nBeta is done.\n\nGa')]);
      expect(lex).toHaveBeenCalled();
      expect(shown(w)).toEqual(['Alpha.', 'Beta is done.']);
      lex.mockClear();
      await append([written(6, 'Alpha.\n\nBeta is done.\n\nGamma.', { state: 'final', final: true, time: T0 + 120_000 })]);
      expect(lex).toHaveBeenCalled();
      expect(shown(w)).toEqual(['Alpha.', 'Beta is done.', 'Gamma.']);
      // The final event is not held: it draws its own time.
      expect(w.document.querySelector('.ev-assistant_message time')!.textContent).not.toBe(clock);
      lex.mockRestore();
    });

    /** Opens the chat with its controls held back until `release`, answered with `change` applied. */
    const openBeforeControls = async (change: Record<string, unknown> = {}) => {
      const { w, append } = await boot([start, written(2, 'Alpha.\n\nBe')], false);
      const api = (w as any).api, original = api.getSessionControls, pending: Array<() => void> = [];
      api.getSessionControls = (id: string) => new Promise(resolve => pending.push(async () => {
        const answer = await original(id);
        resolve({ ...answer, data: { ...answer.data, ...change } });
      }));
      (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click();
      await settle();
      return { w, append, release: async () => { for (const reply of pending.splice(0)) reply(); await settle(); } };
    };

    it('holds the tail back from the first paint, before the chat\'s controls arrive', async () => {
      const { w, release } = await openBeforeControls();
      expect(blocks(w)).toHaveLength(1);
      expect(shown(w)).toEqual(['Alpha.']);
      await release();
      expect(shown(w)).toEqual(['Alpha.']);
    });

    it('shows the message whole once the controls say its open turn is not working', async () => {
      const { w, release } = await openBeforeControls({ activeTurnId: null });
      expect(shown(w)).toEqual(['Alpha.']);
      await release();
      expect(shown(w)).toEqual(['Alpha.', 'Be']);
    });

    it('keeps holding the tail when this app files a status row after the message', async () => {
      const { w, append } = await boot([start, written(2, 'Alpha.\n\nBe')]);
      await append([
        { seq: 3, time: T0 + 1_000, source: 'app', kind: 'progress', progressId: 'finish-notice:x', message: text('Preparing finish notice') },
        { seq: 4, time: T0 + 1_100, source: 'app', kind: 'note', message: text('Recovered the page') },
        { seq: 5, time: T0 + 1_200, source: 'app', kind: 'progress', turnId: 'live-turn', progressId: 'browser-repair:y', message: text('Repairing') }
      ]);
      expect(shown(w)).toEqual(['Alpha.']);
      await append([written(6, 'Alpha.\n\nBeta.\n\nGa')]);
      expect(shown(w)).toEqual(['Alpha.', 'Beta.']);
    });

    it('shows the rest when an error for the chat follows the message, with or without its turn', async () => {
      const { w, append } = await boot([start, written(2, 'Alpha.\n\nBe')]);
      await append([{ seq: 3, time: T0 + 1_000, source: 'extension', kind: 'chat_error', message: text('Something went wrong') }]);
      expect(shown(w)).toEqual(['Alpha.', 'Be']);
    });

    it('shows the rest when ChatGPT\'s own commentary follows the message', async () => {
      const { w, append } = await boot([start, written(2, 'Alpha.\n\nBe')]);
      await append([{ seq: 3, time: T0 + 1_000, source: 'extension', kind: 'progress', message: text('Checking the docs') }]);
      expect(shown(w)).toEqual(['Alpha.', 'Be']);
    });

    it('draws a revision that rewrites a shown block to the same length', async () => {
      const { w, append } = await boot([start, written(2, 'Alpha.\n\nBe')]);
      expect(shown(w)).toEqual(['Alpha.']);
      await append([written(3, 'Omega.\n\nBe')]);
      expect(shown(w)).toEqual(['Omega.']);
    });

    it('draws a source a revision adds to a block already shown', async () => {
      const body = 'Alpha. :chatgpt-content-reference{index="1"}\n\nBe';
      const { w, append } = await boot([start, written(2, body)]);
      expect(blocks(w)[0]!.querySelector('.citation')).toBeNull();
      const references = [{ index: 1, sources: [{ title: 'A report', url: 'https://news.example.com/report', source: 'Example News' }] }];
      await append([written(3, body, { references })]);
      expect(blocks(w)[0]!.querySelector('.citation-pill')?.getAttribute('href')).toBe('https://news.example.com/report');
      expect(shown(w)).toHaveLength(1);
    });

    it('shows a list once it ends, so it does not turn loose on screen', async () => {
      const { w, append } = await boot([start, written(2, 'Alpha.\n\n- one\n- two\n\n- thr')]);
      expect(shown(w)).toEqual(['Alpha.']);
      await append([written(3, 'Alpha.\n\n- one\n- two\n\n- three\n\nAfter.\n\nNe')]);
      expect(blocks(w).map(block => block.tagName)).toEqual(['P', 'UL', 'P']);
      const list = blocks(w)[1]!;
      expect(list.querySelectorAll('li > p')).toHaveLength(3);
      expect(fading(w)).toEqual([list.textContent?.trim(), 'After.']);
      await append([written(4, 'Alpha.\n\n- one\n- two\n\n- three\n\nAfter.\n\nNext.\n\n')]);
      expect(blocks(w)[1]).toBe(list);
    });
  });

  it('draws a final answer opened with the chat again when it is revised', async () => {
    const { w, append } = await boot([answer(1, 'Alpha.\n\nBeta.', { state: 'final', final: true })]);
    await append([answer(2, 'Alpha.\n\nBeta, revised.', { state: 'final', final: true })]);
    expect(blocks(w).map(block => block.textContent)).toEqual(['Alpha.', 'Beta, revised.']);
  });

  it('pages an earlier answer in without fading it', async () => {
    const asks = Array.from({ length: 30 }, (_, i): SessionEvent => ({ seq: i + 2, time: T0 + i + 2, source: 'extension',
      kind: 'user_message', messageId: `ask-${i}`, message: text(`Ask ${i}`) }));
    const { w } = await boot([answer(1, 'Earlier alpha.\n\nEarlier beta.', { messageId: 'earlier', state: 'final', final: true }), ...asks]);
    expect(blocks(w)).toEqual([]);
    const pane = w.document.getElementById('chatBody')!;
    Object.defineProperties(pane, { clientHeight: { value: 800 }, scrollHeight: { value: 800 } });
    pane.scrollTop = 0;
    pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 }));
    await settleHistoryFrame(w);
    expect(blocks(w).map(block => block.textContent)).toEqual(['Earlier alpha.', 'Earlier beta.']);
    expect(fading(w)).toEqual([]);
  });

  it('fades nothing when a revision shortens an answer', async () => {
    const { w, append } = await boot([answer(1, 'Alpha.\n\nBeta.\n\nGamma.')]);
    const [alpha] = blocks(w);
    await append([answer(2, 'Alpha.\n\nBeta')]);
    expect(blocks(w)[0]).toBe(alpha);
    expect(blocks(w).map(block => block.textContent)).toEqual(['Alpha.', 'Beta']);
    expect(fading(w)).toEqual([]);
  });
});
