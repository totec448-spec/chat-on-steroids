import { describe, expect, it, vi } from 'vitest';
import { BOOKMARK_EXCERPT_MAX, JSDOM, T0, boot, closeDom, menuItem, settle, summary, text, toolCall, waitFor, type SessionEvent } from './renderer-timeline.harness.js';

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


describe('the finished-reply announcement', () => {
  const ask = (seq: number, turnId: string): SessionEvent =>
    ({ kind: 'user_message', seq, time: T0 + seq * 1000, source: 'extension', turnId, messageId: `q-${seq}`, message: text('Check the build') }) as SessionEvent;
  const start = (seq: number, turnId: string): SessionEvent => ({ seq, time: T0 + seq * 1000, source: 'extension', kind: 'turn_start', turnId });
  const end = (seq: number, turnId: string, outcome: 'completed' | 'stopped' = 'completed'): SessionEvent =>
    ({ seq, time: T0 + seq * 1000, source: 'extension', kind: 'turn_end', turnId, outcome }) as SessionEvent;
  const region = (w: JSDOM['window']) => w.document.getElementById('turnAnnounce')!;

  it('reads out once that a reply finished in the open chat, when it is turned on', async () => {
    const { w, append } = await boot([ask(1, 't1'), start(2, 't1')], true, [], [], { announceTurns: true });
    expect(region(w).getAttribute('role')).toBe('status');
    expect(region(w).getAttribute('aria-live')).toBe('polite');
    expect(region(w).classList.contains('sr-only')).toBe(true);
    expect(region(w).textContent).toBe('');
    await append([end(3, 't1')]);
    expect(region(w).textContent).toBe('Reply finished');
    // The next turn empties it first, so the same words are read again when that one ends.
    await append([ask(4, 't2'), start(5, 't2')]);
    expect(region(w).textContent).toBe('');
    await append([end(6, 't2')]);
    expect(region(w).textContent).toBe('Reply finished');
  });

  it('reads out a reply that finished in the same read as the next turn started, even right after the last one', async () => {
    const { w, append } = await boot([ask(1, 't1'), start(2, 't1')], true, [], [], { announceTurns: true });
    const said: string[] = [];
    new w.MutationObserver(() => said.push(region(w).textContent ?? '')).observe(region(w), { childList: true, characterData: true, subtree: true });
    // A Goal or Loop continue can start the next turn within one coalesced read.
    await append([end(3, 't1'), start(4, 't2')]);
    expect(region(w).textContent).toBe('Reply finished');
    // The region still holds those words: it is emptied first, so the second reply is read too.
    said.length = 0;
    await append([end(5, 't2'), start(6, 't3')]);
    await settle(200);
    expect(region(w).textContent).toBe('Reply finished');
    expect(said).toEqual(['', 'Reply finished']);
  });

  it('drops a delayed repeat once the next question has emptied the region', async () => {
    const { w, append } = await boot([ask(1, 't1'), start(2, 't1')], true, [], [], { announceTurns: true });
    await append([end(3, 't1')]);
    expect(region(w).textContent).toBe('Reply finished');
    // Hold the 100 ms repeat so the next read lands before it.
    const held: Array<() => void> = [], setTimer = w.setTimeout.bind(w);
    vi.spyOn(w, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) =>
      ms === 100 ? (held.push(fn), 0) : setTimer(fn, ms, ...rest)) as typeof w.setTimeout);
    await append([ask(4, 't2'), start(5, 't2'), end(6, 't2')]);
    expect(region(w).textContent).toBe('');
    await append([ask(7, 't3'), start(8, 't3')]);
    for (const fn of held.splice(0)) fn();
    expect(region(w).textContent).toBe('');
  });

  it('drops a delayed repeat once a later reply has been read out at once', async () => {
    const { w, append } = await boot([ask(1, 't1'), start(2, 't1')], true, [], [], { announceTurns: true });
    await append([end(3, 't1')]);
    const held: Array<() => void> = [], setTimer = w.setTimeout.bind(w);
    vi.spyOn(w, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) =>
      ms === 100 ? (held.push(fn), 0) : setTimer(fn, ms, ...rest)) as typeof w.setTimeout);
    // A Loop continue: the region still says the words, so this read waits for its repeat.
    await append([start(4, 't2'), end(5, 't2'), start(6, 't3')]);
    expect(held).toHaveLength(1);
    // The next reply finishes before that repeat, and the empty region takes the words at once.
    await append([end(7, 't3')]);
    expect(region(w).textContent).toBe('Reply finished');
    const said: string[] = [];
    new w.MutationObserver(() => said.push(region(w).textContent ?? '')).observe(region(w), { childList: true, characterData: true, subtree: true });
    for (const fn of held.splice(0)) fn();
    await settle();
    expect(said).toEqual([]);
  });

  // The announcement's own timers (the 100 ms refill and the gap between replies) are held and
  // run by hand, in order, so nothing here waits on the clock.
  const holdTimers = (w: JSDOM['window']) => {
    const held: Array<() => void> = [], setTimer = w.setTimeout.bind(w);
    vi.spyOn(w, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) =>
      ms === 100 || ms === 1000 ? (held.push(fn), 0) : setTimer(fn, ms, ...rest)) as typeof w.setTimeout);
    return held;
  };
  const watch = (w: JSDOM['window']) => {
    const said: string[] = [];
    new w.MutationObserver(() => said.push(region(w).textContent ?? '')).observe(region(w), { childList: true, characterData: true, subtree: true });
    return said;
  };

  it('reads out every reply that finished in one read, one after another', async () => {
    const { w, append } = await boot([ask(1, 't1'), start(2, 't1')], true, [], [], { announceTurns: true });
    const held = holdTimers(w), said = watch(w);
    await append([end(3, 't1'), start(4, 't2'), end(5, 't2'), start(6, 't3'), end(7, 't3')]);
    // The first is read at once; the others wait their turn.
    expect(region(w).textContent).toBe('Reply finished');
    expect(held).toHaveLength(1);
    held.shift()!(); // the gap, then the region is emptied for the second
    await settle();
    expect(region(w).textContent).toBe('');
    held.shift()!(); // refilled in a later task
    await settle();
    expect(region(w).textContent).toBe('Reply finished');
    held.shift()!();
    await settle();
    held.shift()!();
    await settle();
    expect(held).toHaveLength(0);
    expect(said).toEqual(['Reply finished', '', 'Reply finished', '', 'Reply finished']);
  });

  it('empties and refills for each reply when the region already held the words', async () => {
    const { w, append } = await boot([ask(1, 't1'), start(2, 't1')], true, [], [], { announceTurns: true });
    await append([end(3, 't1')]);
    const held = holdTimers(w), said = watch(w);
    await append([start(4, 't2'), end(5, 't2'), start(6, 't3'), end(7, 't3')]);
    while (held.length > 0) { held.shift()!(); await settle(); }
    expect(said).toEqual(['', 'Reply finished', '', 'Reply finished']);
  });

  it('drops the replies still waiting when the open chat changes', async () => {
    const first = summary([]), second = { ...summary([]), id: '2026-09-02-test0002', title: 'Other session' };
    const { w, append } = await boot([ask(1, 't1'), start(2, 't1')], true, [], [], { announceTurns: true, sessions: [first, second] });
    const held = holdTimers(w);
    await append([end(3, 't1'), start(4, 't2'), end(5, 't2'), start(6, 't3'), end(7, 't3')]);
    expect(region(w).textContent).toBe('Reply finished');
    expect(held).toHaveLength(1);
    (w.document.querySelector(`#sessionList [data-id="${second.id}"]`) as HTMLElement).click();
    await settle();
    expect(region(w).textContent).toBe('');
    const said = watch(w);
    while (held.length > 0) { held.shift()!(); await settle(); }
    expect(region(w).textContent).toBe('');
    expect(said).toEqual([]);
  });

  it.each([
    ['when it is off', false, end(3, 't1')],
    ['for a stopped reply', true, end(3, 't1', 'stopped')]
  ] as const)('stays quiet %s', async (_, announceTurns, last) => {
    const { w, append } = await boot([ask(1, 't1'), start(2, 't1')], true, [], [], { announceTurns });
    await append([last]);
    expect(region(w).textContent).toBe('');
  });

  it('stays quiet for a chat whose reply had finished before it was opened', async () => {
    const { w } = await boot([ask(1, 't1'), start(2, 't1'), end(3, 't1')], true, [], [], { announceTurns: true });
    expect(region(w).textContent).toBe('');
  });
});

describe('bookmarked answers', () => {
  const chat = '6ad337fe-47a4-83ed-a21f-c2e24d5829a4';
  const replyId = '2b06482d-0dc6-4847-bf7a-2e1a0f671e89';
  const ask: SessionEvent = { kind: 'user_message', seq: 1, origin: 1, time: T0, source: 'extension', turnId: 'done-turn', messageId: 'ask', message: text('Plan the release') };
  const reply: SessionEvent = { kind: 'assistant_message', seq: 2, time: T0 + 1_000, source: 'extension', turnId: 'done-turn', messageId: replyId, message: text('**Tag first**, then build.\n\nMore detail.'), final: true, state: 'final' };
  const end: SessionEvent = { seq: 3, time: T0 + 2_000, source: 'extension', kind: 'turn_end', turnId: 'done-turn', outcome: 'completed' };
  const mark = { messageId: replyId, excerpt: 'Tag first, then build.', messageTime: T0 + 1_000, at: T0 + 5_000 };

  it('bookmarks an answer, lists it in the header and jumps back to it', async () => {
    const { w } = await boot([ask, reply, end], true, [], [], { summary: { conversationId: chat } });
    const api = (w as any).api;
    api.setBookmark = vi.fn(async (_id: string, _messageId: string, _excerpt: string, _time: number, on: boolean) => ({ ok: true, data: on ? [mark] : [] }));
    api.locateMessage = vi.fn(async () => ({ ok: true, data: { seq: 2, kind: 'assistant_message', messageId: replyId, position: 2 } }));
    const header = w.document.getElementById('chatBookmarks') as HTMLButtonElement;
    const toggle = w.document.querySelector<HTMLButtonElement>('.answer-actions .answer-bookmark')!;
    expect(header.hidden).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Bookmark answer');

    toggle.click(); await settle();
    expect(api.setBookmark).toHaveBeenCalledWith(summary([]).id, replyId, 'Tag first, then build.', T0 + 1_000, true);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Remove bookmark');
    expect(header.hidden).toBe(false);
    expect(header.textContent!.trim()).toBe('1');
    expect(header.getAttribute('aria-label')).toBe('1 bookmark in this chat');

    header.click(); await settle();
    expect(header.getAttribute('aria-expanded')).toBe('true');
    const item = w.document.querySelector<HTMLButtonElement>('[data-row-action="bookmark"]')!;
    expect(item.textContent).toContain('Tag first, then build.');
    expect(item.closest('.row-menu')!.classList.contains('is-wide')).toBe(true);
    expect(item.querySelector('.row-menu-hint')!.textContent).not.toBe('');
    item.click(); await settle();
    expect(api.locateMessage).toHaveBeenCalledWith(summary([]).id, replyId);
    expect(header.getAttribute('aria-expanded')).toBe('false');

    toggle.click(); await settle();
    expect(api.setBookmark).toHaveBeenLastCalledWith(summary([]).id, replyId, 'Tag first, then build.', T0 + 1_000, false);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(header.hidden).toBe(true);
  });

  it('bookmarks an answer whose first paragraph is very long, with a short excerpt', async () => {
    const long: SessionEvent = { ...reply, message: text(`${'word '.repeat(1_200)}end.`) };
    const { w } = await boot([ask, long, end], true, [], [], { summary: { conversationId: chat } });
    const api = (w as any).api;
    api.setBookmark = vi.fn(async (_id: string, _messageId: string, _excerpt: string, _time: number, on: boolean) => ({ ok: true, data: on ? [mark] : [] }));
    w.document.querySelector<HTMLButtonElement>('.answer-actions .answer-bookmark')!.click(); await settle();
    const excerpt = api.setBookmark.mock.calls[0]![2] as string;
    expect(excerpt.length).toBeLessThanOrEqual(BOOKMARK_EXCERPT_MAX);
    expect(excerpt.startsWith('word word')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('removes a bookmark whose answer is no longer in the chat when it is opened, never on a failed read', async () => {
    // The answer's own button is gone with it, so the list is the only place left to remove it from.
    const gone = { messageId: '7c1e0f9a-1d2b-4c3d-8e4f-5a6b7c8d9e0f', excerpt: 'An answer that is gone', messageTime: T0 + 500, at: T0 + 6_000 };
    const { w } = await boot([ask, reply, end], true, [], [], { summary: { conversationId: chat } });
    const api = (w as any).api;
    api.listBookmarks = vi.fn(async () => ({ ok: true, data: [gone] }));
    api.setBookmark = vi.fn(async () => ({ ok: true, data: [] }));
    api.locateMessage = vi.fn(async () => ({ ok: false, error: 'The chat history could not be read' }));
    w.document.getElementById('newChat')!.click(); await settle();
    w.document.querySelector<HTMLElement>(`.sess[data-id="${summary([]).id}"]`)!.click(); await settle();
    const header = w.document.getElementById('chatBookmarks') as HTMLButtonElement;
    const open = async () => { header.click(); await settle(); w.document.querySelector<HTMLButtonElement>('[data-row-action="bookmark"]')!.click(); await settle(); };
    // A history that could not be read says so and keeps the bookmark.
    await open();
    expect(api.setBookmark).not.toHaveBeenCalled();
    expect(header.hidden).toBe(false);
    // The answer is not in the recorded chat: its bookmark goes, and the person is told why.
    api.locateMessage = vi.fn(async () => ({ ok: true, data: null }));
    await open();
    expect(api.setBookmark).toHaveBeenCalledWith(summary([]).id, gone.messageId, gone.excerpt, gone.messageTime, false);
    expect(header.hidden).toBe(true);
    expect(w.document.querySelector('.toast')!.textContent).toBe('This answer is no longer in the chat, so its bookmark was removed.');
    // The hidden header button gives its focus to the message box rather than to nothing.
    expect(w.document.activeElement).toBe(w.document.getElementById('chatInput'));
  });

  it('keeps a stale bookmark when removing it fails, and says nothing in another chat opened meanwhile', async () => {
    const gone = { messageId: '7c1e0f9a-1d2b-4c3d-8e4f-5a6b7c8d9e0f', excerpt: 'An answer that is gone', messageTime: T0 + 500, at: T0 + 6_000 };
    const { w } = await boot([ask, reply, end], true, [], [], { summary: { conversationId: chat } });
    const api = (w as any).api;
    api.listBookmarks = vi.fn(async () => ({ ok: true, data: [gone] }));
    api.locateMessage = vi.fn(async () => ({ ok: true, data: null }));
    w.document.getElementById('newChat')!.click(); await settle();
    w.document.querySelector<HTMLElement>(`.sess[data-id="${summary([]).id}"]`)!.click(); await settle();
    const header = w.document.getElementById('chatBookmarks') as HTMLButtonElement;
    const open = async () => { header.click(); await settle(); w.document.querySelector<HTMLButtonElement>('[data-row-action="bookmark"]')!.click(); await settle(); };
    // A removal that throws still ends with a message, and the bookmark stays listed.
    api.setBookmark = vi.fn(async () => { throw new Error('disk gone'); });
    await open();
    expect(header.hidden).toBe(false);
    expect(w.document.querySelector('.toast')!.textContent).toBe('This answer is no longer in the chat.');
    w.document.querySelector('.toast')!.remove();
    // The person opens a new chat while the removal is still on its way: no message there.
    let finish!: (value: unknown) => void;
    api.setBookmark = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    await open();
    w.document.getElementById('newChat')!.click(); await settle();
    finish({ ok: true, data: [] }); await settle();
    expect(w.document.querySelector('.toast')).toBeNull();
  });

  it('shows a chat\'s saved bookmarks when it is opened', async () => {
    const { w } = await boot([ask, reply, end], true, [], [], { summary: { conversationId: chat } });
    const api = (w as any).api;
    api.listBookmarks = vi.fn(async () => ({ ok: true, data: [mark] }));
    // Open another view and come back: the chat loads its marks again.
    w.document.getElementById('newChat')!.click(); await settle();
    w.document.querySelector<HTMLElement>(`.sess[data-id="${summary([]).id}"]`)!.click(); await settle();
    expect(api.listBookmarks).toHaveBeenCalledWith(summary([]).id);
    expect((w.document.getElementById('chatBookmarks') as HTMLButtonElement).hidden).toBe(false);
    expect(w.document.querySelector('.answer-actions .answer-bookmark')!.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('recorded DIL cards inside a Markdown answer', () => {
  const source = [
    'Introduction remains ordinary Markdown.', '',
    '**Sample archive verification** (Passed)', '',
    'Documents indexed', '', '# 1,234', '',
    'Collections checked', '', '# 28', '',
    'Records verified', '', '# 45,678', '',
    'Index witnesses', '', '# 11', '', '---', '',
    'Integrity and consistency checks passed', '',
    'Original examples were not modified', '',
    'The explanation after the card stays in the reply.'
  ].join('\n');
  const metric = (label: string, value: string): string =>
    `<div data-d-component="grid-item"><p data-d-component="text" data-d-size="xs">${label}</p>` +
    `<h1 data-d-component="title" data-d-size="xl">${value}</h1></div>`;
  const card = '<div data-d-component="card" onclick="alert(1)" style="background: hotpink">' +
    '<div data-d-component="row" data-d-justify="between"><p data-d-component="text">' +
    '<span data-d-component="text" data-d-default-strong="">Sample archive verification</span></p>' +
    '<div data-d-component="badge" data-color="success">Passed</div></div>' +
    '<div data-d-component="grid" style="grid-template-columns: repeat(2,1fr)">' +
    metric('Documents indexed', '1,234') + metric('Collections checked', '28') +
    metric('Records verified', '45,678') + metric('Index witnesses', '11') +
    '</div><div data-d-component="divider"></div>' +
    '<div data-d-component="row"><svg data-d-component="icon" style="color: var(--color-text-success)"><path d="M0 0"/></svg>' +
    '<p data-d-component="text">Integrity and consistency checks passed</p></div>' +
    '<div data-d-component="row"><svg data-d-component="icon" style="color: var(--color-text-success)"></svg>' +
    '<p data-d-component="text">Original examples were not modified</p></div></div>';
  const captured = (markup = card): string =>
    `<div><p>Introduction remains ordinary Markdown.</p>${markup}` +
    '<p>The explanation after the card stays in the reply.</p></div>';
  const answer = (body: string, markup = captured()): SessionEvent => ({
    seq: 1, origin: 1, time: T0, source: 'extension', kind: 'assistant_message', messageId: 'dil-card',
    message: text(body), renderedHtml: text(markup), state: 'final', final: true
  });

  it('restores the compact grid, success badge and static icons without replacing surrounding prose', async () => {
    const { w } = await boot([answer(source)]);
    const message = w.document.querySelector('.ev-assistant_message .msg.rich')!;
    const panel = message.querySelector('.markdown-dil-card')!;
    expect(panel).not.toBeNull();
    expect(panel.querySelectorAll('.markdown-dil-grid-item')).toHaveLength(4);
    expect([...panel.querySelectorAll('.markdown-dil-title')].map(node => node.textContent)).toEqual(['1,234', '28', '45,678', '11']);
    expect(panel.querySelector('.markdown-dil-badge.markdown-dil-success')?.textContent).toBe('Passed');
    expect(panel.querySelectorAll('.markdown-dil-success-icon')).toHaveLength(2);
    expect(message.firstElementChild?.textContent).toBe('Introduction remains ordinary Markdown.');
    expect(message.lastElementChild?.textContent).toBe('The explanation after the card stays in the reply.');
    expect([...message.querySelectorAll('h1')]).toHaveLength(4);
    expect(message.querySelector('[onclick], [style], svg, script')).toBeNull();
  });

  it('rejects an out-of-date card whose metric no longer matches the canonical answer', async () => {
    const changed = source.replace('45,678', '45,679');
    const { w } = await boot([answer(changed)]);
    const message = w.document.querySelector('.ev-assistant_message .msg.rich')!;
    expect(message.querySelector('.markdown-dil-card')).toBeNull();
    expect(message.textContent).toContain('45,679');
    expect(message.textContent).not.toContain('45,678');
  });

  it.each([
    { recorded: '+12%', current: '-12%' },
    { recorded: '45,678', current: '45.678' },
    { recorded: '45,678', current: '-45,678' },
    { recorded: '12%', current: '12' },
    { recorded: '$100', current: '€100' }
  ])('refuses a recorded metric $recorded when the current reply says $current', async ({ recorded, current }) => {
    const { w } = await boot([answer(source.replace('45,678', current), captured(card.replace('45,678', recorded)))]);
    const root = w.document.querySelector('.ev-assistant_message .msg.rich')!;
    expect(root.querySelector('.markdown-dil-card')).toBeNull();
    expect(root.textContent).toContain(current);
  });

  it.each([
    { recorded: '✅ Tests', current: '❌ Tests' },
    { recorded: '🟢 Online', current: '🔴 Online' },
    { recorded: '⚠️ Warning', current: '✅ Warning' },
    { recorded: '✓ Checks', current: '✗ Checks' },
    { recorded: '↑ 12%', current: '↓ 12%' },
    { recorded: '< 5 ms', current: '> 5 ms' },
    { recorded: '≤ 5 ms', current: '≥ 5 ms' },
    { recorded: '± 3', current: '~ 3' }
  ])('refuses a stale recorded card when only the status or comparison symbol changed ($recorded to $current)', async ({ recorded, current }) => {
    const { w } = await boot([answer(source.replace('45,678', current), captured(card.replace('45,678', recorded)))]);
    const root = w.document.querySelector('.ev-assistant_message .msg.rich')!;
    expect(root.querySelector('.markdown-dil-card')).toBeNull();
    expect(root.textContent).toContain(current);
  });

  it('restores a recorded card whose status emoji still matches the current answer', async () => {
    const updated = '✅ Tests';
    const { w } = await boot([answer(source.replace('45,678', updated), captured(card.replace('45,678', updated)))]);
    expect(w.document.querySelector('.ev-assistant_message .msg.rich .markdown-dil-card')).not.toBeNull();
  });

  it('keeps a recorded card with the app-replaced decorative down-arrow icon', async () => {
    const withArrow = card.replace(
      '<svg data-d-component="icon" style="color: var(--color-text-success)"></svg>',
      '<svg data-d-component="icon"><path d="M12.707 18.707L1 1"/></svg>'
    );
    const { w } = await boot([answer(source, captured(withArrow))]);
    const panel = w.document.querySelector('.ev-assistant_message .msg.rich .markdown-dil-card');
    expect(panel).not.toBeNull();
    expect(panel!.querySelectorAll('.markdown-dil-down-icon')).toHaveLength(1);
  });

  it('does not restore captured cards that contain active controls or links', async () => {
    const { w } = await boot([answer(source, captured(card.replace('</div></div>', '<button>Click</button></div></div>')))]);
    const message = w.document.querySelector('.ev-assistant_message .msg.rich')!;
    expect(message.querySelector('.markdown-dil-card')).toBeNull();
    expect(message.querySelector('button')).toBeNull();
    expect(message.textContent).toContain('Documents indexed');
  });

  it('does not reveal hidden captured text when sanitized layout would remove its visibility attributes', async () => {
    const hidden = card.replace('<div data-d-component="divider"></div>',
      '<div data-d-component="divider" aria-hidden="true">Unrecorded hidden text</div>');
    const { w } = await boot([answer(source, captured(hidden))]);
    const message = w.document.querySelector('.ev-assistant_message .msg.rich')!;
    expect(message.querySelector('.markdown-dil-card')).toBeNull();
    expect(message.textContent).not.toContain('Unrecorded hidden text');
  });

  it('does not guess which identical canonical span to replace', async () => {
    const cardSource = source.split('Introduction remains ordinary Markdown.\n\n')[1]!
      .split('\n\nThe explanation after the card stays in the reply.')[0]!;
    const { w } = await boot([answer(`${cardSource}\n\n${cardSource}`)]);
    expect(w.document.querySelector('.markdown-dil-card')).toBeNull();
  });

  it.each(['missing', 'truncated'] as const)('keeps the canonical Markdown when a recorded layout is %s', async kind => {
    const capture = kind === 'missing' ? undefined : { ...text(captured()), truncated: true };
    const event = { ...answer(source), renderedHtml: capture };
    const { w } = await boot([event]);
    const root = w.document.querySelector('.ev-assistant_message .msg.rich')!;
    expect(root.querySelector('.markdown-dil-card')).toBeNull();
    expect(root.textContent).toContain('Introduction remains ordinary Markdown.');
    expect(root.textContent).toContain('Documents indexed');
    expect(root.textContent).toContain('The explanation after the card stays in the reply.');
  });
});

describe('charts, diagrams and illustrated Markdown from recorded DIL', () => {
  const observation = (body: string, html = '<p>Unrelated provider drawing.</p>'): SessionEvent => ({
    seq: 1, origin: 1, time: T0, source: 'extension', kind: 'assistant_message', messageId: 'rich-layout',
    message: text(body), renderedHtml: text(html), state: 'final', final: true
  });
  const message = (w: { document: Document }): Element => w.document.querySelector('.ev-assistant_message .msg.rich')!;

  it('renders bounded chart data from the canonical widget rather than trusting a captured plot', async () => {
    const directive = `\uE200genui\uE202${JSON.stringify({ charts_widget_v2: { content: {
      chartType: 'bar', xKey: 'group', series: [{ dataKey: 'value', label: 'Sample values', valueSuffix: '%' }],
      data: [{ group: 'A', value: 4 }, { group: 'B', value: 9 }, { group: 'C', value: 15 }],
      meta: { footer: 'Illustrative values only' }
    } } })}\uE201`;
    const { w } = await boot([observation(`Intro.\n\n${directive}\n\nAfter the chart.`)]);
    const root = message(w);
    expect(root.querySelector('.markdown-dil-chart')).not.toBeNull();
    expect([...root.querySelectorAll('.markdown-dil-chart-x')].map(item => item.textContent)).toEqual(['A', 'B', 'C']);
    expect([...root.querySelectorAll<HTMLElement>('.markdown-dil-chart-bar')].map(item => item.style.height)).toEqual(['26.666666666666668%', '60%', '100%']);
    expect(root.querySelector('.markdown-dil-chart')?.getAttribute('aria-label')).toContain('C 15%');
    expect(root.querySelectorAll('.markdown-dil-chart-column')).toHaveLength(3);
    expect(root.lastElementChild?.textContent).toBe('After the chart.');
  });

  it('restores chart placeholders whose zero-based index has three digits', async () => {
    const directive = `\uE200genui\uE202${JSON.stringify({ charts_widget_v2: { content: {
      chartType: 'bar', xKey: 'group', series: [{ dataKey: 'value' }], data: [{ group: 'Example', value: 3 }]
    } } })}\uE201`;
    const { w } = await boot([observation(Array.from({ length: 101 }, (_, i) => `Chart ${i + 1}.\n\n${directive}`).join('\n\n'))]);
    const root = message(w);
    expect(root.querySelectorAll('.markdown-dil-chart')).toHaveLength(101);
    expect(root.textContent).not.toContain('\uE030100\uE031');
  });

  it.each([
    { opening: '```json', closing: '```' },
    { opening: '~~~~example', closing: '~~~~' }
  ])('keeps a chart example literal inside $opening but draws one outside the fence', async ({ opening, closing }) => {
    const widget = `\uE200genui\uE202${JSON.stringify({ charts_widget_v2: { content: {
      chartType: 'bar', xKey: 'group', series: [{ dataKey: 'value' }], data: [{ group: 'Example', value: 3 }]
    } } })}\uE201`;
    const { w } = await boot([observation(`Example code:\n\n${opening}\n${widget}\n${closing}\n\n${widget}\n\nAfter.`)]);
    const root = message(w);
    expect(root.querySelector('pre code')?.textContent).toContain(widget);
    expect(root.querySelector('pre code')?.textContent).not.toContain('\uE030');
    expect(root.querySelectorAll('.markdown-dil-chart')).toHaveLength(1);
    expect(root.lastElementChild?.textContent).toBe('After.');
  });

  it('keeps a chart example literal in an unclosed Markdown fence', async () => {
    const widget = `\uE200genui\uE202${JSON.stringify({ charts_widget_v2: { content: {
      chartType: 'bar', xKey: 'group', series: [{ dataKey: 'value' }], data: [{ group: 'Example', value: 3 }]
    } } })}\uE201`;
    const { w } = await boot([observation(`Example:\n\n\`\`\`json\n${widget}`)]);
    const root = message(w);
    expect(root.querySelector('pre code')?.textContent).toContain(widget);
    expect(root.querySelector('.markdown-dil-chart')).toBeNull();
  });

  it.each(['- ```', '> ```'])('does not close a top-level chart code fence at %s', async misleadingCloser => {
    const widget = `\uE200genui\uE202${JSON.stringify({ charts_widget_v2: { content: {
      chartType: 'bar', xKey: 'group', series: [{ dataKey: 'value' }], data: [{ group: 'Example', value: 3 }]
    } } })}\uE201`;
    const { w } = await boot([observation('Example:\n\n```json\n' + misleadingCloser + '\n' + widget + '\n```\n\n' + widget + '\n\nAfter.')]);
    const root = message(w);
    expect(root.querySelector('pre code')?.textContent).toContain(widget);
    expect(root.querySelectorAll('.markdown-dil-chart')).toHaveLength(1);
    expect(root.lastElementChild?.textContent).toBe('After.');
  });

  it.each([
    { name: 'content line', markdown: (widget: string) => 'Example:\n\n```json\n    ```\n' + widget + '\n```\n\n' + widget },
    { name: 'indented opener', markdown: (widget: string) => 'Example:\n\n    ```\n\n' + widget }
  ])('respects Marked top-level fence indentation for $name', async ({ markdown, name }) => {
    const widget = `\uE200genui\uE202${JSON.stringify({ charts_widget_v2: { content: {
      chartType: 'bar', xKey: 'group', series: [{ dataKey: 'value' }], data: [{ group: 'Example', value: 3 }]
    } } })}\uE201`;
    const { w } = await boot([observation(markdown(widget))]);
    const root = message(w);
    if (name === 'content line') {
      expect(root.querySelector('pre code')?.textContent).toContain(widget);
      expect(root.querySelectorAll('.markdown-dil-chart')).toHaveLength(1);
    } else {
      expect(root.querySelectorAll('.markdown-dil-chart')).toHaveLength(1);
      expect(root.textContent).not.toContain('\uE030');
    }
  });

  it.each([
    { spaces: '    ', charts: 2 },
    { spaces: '      ', charts: 1 }
  ])('distinguishes list-continuation charts from nested indented code at $spaces spaces', async ({ spaces, charts }) => {
    const widget = `\uE200genui\uE202${JSON.stringify({ charts_widget_v2: { content: {
      chartType: 'bar', xKey: 'group', series: [{ dataKey: 'value' }], data: [{ group: 'Example', value: 3 }]
    } } })}\uE201`;
    const { w } = await boot([observation('- Revenue\n\n' + spaces + widget + '\n\n' + widget)]);
    const root = message(w);
    expect(root.querySelectorAll('.markdown-dil-chart')).toHaveLength(charts);
    if (charts === 1) expect(root.querySelector('li pre code')?.textContent).toContain(widget);
    expect(root.textContent).not.toContain('\uE030');
  });

  it('protects four-space code after a top-level fence ends a list', async () => {
    const widget = `\uE200genui\uE202${JSON.stringify({ charts_widget_v2: { content: {
      chartType: 'bar', xKey: 'group', series: [{ dataKey: 'value' }], data: [{ group: 'Example', value: 3 }]
    } } })}\uE201`;
    const { w } = await boot([observation('- List item\n\n```txt\nStandalone example\n```\n    ' + widget + '\n\n' + widget)]);
    const root = message(w);
    expect([...root.querySelectorAll('pre code')].map(node => node.textContent).join('\n')).toContain(widget);
    expect(root.querySelectorAll('.markdown-dil-chart')).toHaveLength(1);
    expect(root.textContent).not.toContain('\uE030');
  });

  it('does not hide a valid chart between unrelated backticks in separate paragraphs', async () => {
    const widget = `\uE200genui\uE202${JSON.stringify({ charts_widget_v2: { content: {
      chartType: 'bar', xKey: 'group', series: [{ dataKey: 'value' }], data: [{ group: 'Example', value: 3 }]
    } } })}\uE201`;
    const { w } = await boot([observation('Unmatched ` before.\n\n' + widget + '\n\nUnmatched ` after.')]);
    const root = message(w);
    expect(root.querySelectorAll('.markdown-dil-chart')).toHaveLength(1);
    expect(root.textContent).toContain('Unmatched');
  });

  it.each([
    { name: 'four spaces', indent: '    ' },
    { name: 'a tab', indent: '\t' }
  ])('keeps a chart directive literal inside code indented by $name', async ({ indent }) => {
    const widget = `\uE200genui\uE202${JSON.stringify({ charts_widget_v2: { content: {
      chartType: 'bar', xKey: 'group', series: [{ dataKey: 'value' }], data: [{ group: 'Example', value: 3 }]
    } } })}\uE201`;
    const { w } = await boot([observation(`Example:\n\n${indent}${widget}\n\n${widget}\n\nAfter.`)]);
    const root = message(w);
    expect(root.querySelector('pre code')?.textContent).toContain(widget);
    expect(root.querySelectorAll('.markdown-dil-chart')).toHaveLength(1);
    expect(root.lastElementChild?.textContent).toBe('After.');
  });

  it.each(['    ', '\t'])('keeps %s indented chart code immediately after a closed fence', async indent => {
    const widget = `\uE200genui\uE202${JSON.stringify({ charts_widget_v2: { content: {
      chartType: 'bar', xKey: 'group', series: [{ dataKey: 'value' }], data: [{ group: 'Example', value: 3 }]
    } } })}\uE201`;
    const { w } = await boot([observation('```txt\nExisting example\n```\n' + indent + widget + '\n\n' + widget + '\n\nAfter.')]);
    const root = message(w);
    expect([...root.querySelectorAll('pre code')].map(node => node.textContent).join('\n')).toContain(widget);
    expect(root.querySelectorAll('.markdown-dil-chart')).toHaveLength(1);
    expect(root.lastElementChild?.textContent).toBe('After.');
  });

  it.each([
    { name: 'blockquote fence', example: (widget: string) => `> \`\`\`json\n> ${widget}\n> \`\`\``, code: 'blockquote pre code' },
    { name: 'list-item fence', example: (widget: string) => `- \`\`\`json\n  ${widget}\n  \`\`\``, code: 'li pre code' },
    { name: 'inline backticks', example: (widget: string) => `Example: \`${widget}\``, code: 'p code' },
    { name: 'double inline backticks', example: (widget: string) => `Example: \`\`${widget}\`\``, code: 'p code' }
  ])('keeps a chart example literal in $name and renders the following chart', async ({ example, code }) => {
    const widget = `\uE200genui\uE202${JSON.stringify({ charts_widget_v2: { content: {
      chartType: 'bar', xKey: 'group', series: [{ dataKey: 'value' }], data: [{ group: 'Example', value: 3 }]
    } } })}\uE201`;
    const { w } = await boot([observation(`Example code:\n\n${example(widget)}\n\n${widget}\n\nAfter.`)]);
    const root = message(w);
    expect(root.querySelector(code)?.textContent).toContain(widget);
    expect(root.querySelectorAll('.markdown-dil-chart')).toHaveLength(1);
    expect(root.lastElementChild?.textContent).toBe('After.');
  });

  it('formats chart values, axis guides, tooltips and accessibility text in the chosen app language', async () => {
    const widget = `\uE200genui\uE202${JSON.stringify({ charts_widget_v2: { content: {
      chartType: 'bar', xKey: 'group', series: [{ dataKey: 'value', label: 'Vergleich' }],
      data: [{ group: 'Erste', value: 45678 }, { group: 'Zweite', value: 7.5 }], yAxisMax: 45678
    } } })}\uE201`;
    await boot([observation('Initial message.')]);
    const { setLanguage } = await import('../src/renderer/i18n.js');
    const { renderedMarkdown } = await import('../src/renderer/chat.js');
    setLanguage('de');
    try {
      const figure = renderedMarkdown(widget).querySelector('.markdown-dil-chart')!;
      expect(figure.getAttribute('aria-label')).toBe('Vergleich: Erste 45.678, Zweite 7,5');
      expect([...figure.querySelectorAll('.markdown-dil-chart-guide span')].map(node => node.textContent))
        .toEqual(['45.678', '22.839', '0']);
      expect([...figure.querySelectorAll<HTMLElement>('.markdown-dil-chart-bar')].map(bar => bar.title))
        .toEqual(['Erste: 45.678', 'Zweite: 7,5']);
    } finally { setLanguage('en'); }
  });

  it.each([
    { label: 'negative', data: [{ group: 'A', value: -1 }] },
    { label: 'non-numeric', data: [{ group: 'A', value: 'many' }] },
    { label: 'non-finite', data: [{ group: 'A', value: Number.POSITIVE_INFINITY }] },
    { label: 'oversized', data: [{ group: 'A', value: 1e13 }] },
    { label: 'invalid minimum', data: [{ group: 'A', value: 1 }], yAxisMin: -2 },
    { label: 'invalid maximum', data: [{ group: 'A', value: 5 }], yAxisMax: 4 },
    { label: 'non-numeric maximum', data: [{ group: 'A', value: 5 }], yAxisMax: '100' }
  ])('rejects $label chart values without changing the canonical surrounding text', async content => {
    const widget = `\uE200genui\uE202${JSON.stringify({ charts_widget_v2: { content: {
      chartType: 'bar', xKey: 'group', series: [{ dataKey: 'value' }], ...content
    } } })}\uE201`;
    const { w } = await boot([observation(`Before.\n\n${widget}\n\nAfter.`)]);
    const root = message(w);
    expect(root.querySelector('.markdown-dil-chart')).toBeNull();
    expect(root.textContent).toContain('Before.');
    expect(root.textContent).toContain('After.');
  });

  it('ignores malformed chart payloads without crashing the timeline', async () => {
    const widget = `\uE200genui\uE202${JSON.stringify({ charts_widget_v2: { content: {
      chartType: 'bar', xKey: 'group', series: [null], data: [{ group: 'A', value: 1 }]
    } } })}\uE201`;
    const { w } = await boot([observation(`Start.\n\n${widget}\n\nEnd.`)]);
    const root = message(w);
    expect(root.querySelector('.markdown-dil-chart')).toBeNull();
    expect(root.textContent).toContain('Start.');
    expect(root.textContent).toContain('End.');
  });

  it('uses the original chart data as its accessible label without adding English text', async () => {
    const widget = `\uE200genui\uE202${JSON.stringify({ charts_widget_v2: { content: {
      chartType: 'bar', xKey: 'group', series: [{ dataKey: 'value' }],
      data: [{ group: 'Échantillon A', value: 2 }, { group: 'Échantillon B', value: 5 }]
    } } })}\uE201`;
    const { w } = await boot([observation(`Before.\n\n${widget}\n\nAfter.`)]);
    expect(message(w).querySelector('.markdown-dil-chart')?.getAttribute('aria-label'))
      .toBe('Échantillon A 2, Échantillon B 5');
  });

  it('retains full 36-character chart labels and long guide values for tooltips and accessibility', async () => {
    const label = 'Fictional group with a long label 12';
    expect(label).toHaveLength(36);
    const widget = `\uE200genui\uE202${JSON.stringify({ charts_widget_v2: { content: {
      chartType: 'bar', xKey: 'group', series: [{ dataKey: 'value', label: 'Example chart' }],
      data: [{ group: label, value: 4 }, { group: 'Other', value: 12 }], yAxisMax: 1e12
    } } })}\uE201`;
    const { w } = await boot([observation(`A fictional chart.\n\n${widget}`)]);
    const figure = message(w).querySelector('.markdown-dil-chart')!;
    expect(figure.getAttribute('aria-label')).toContain(`${label} 4`);
    const first = figure.querySelector<HTMLElement>('.markdown-dil-chart-x')!;
    expect(first.textContent).toBe(label);
    expect(first.title).toBe(label);
    const guide = figure.querySelector<HTMLElement>('.markdown-dil-chart-guide span')!;
    expect(guide.textContent).toBe('1T');
    expect(guide.title).toBe('1,000,000,000,000');
    expect(guide.getAttribute('aria-label')).toBe('1,000,000,000,000');
    expect([...figure.querySelectorAll('.markdown-dil-chart-guide span')].map(node => node.textContent))
      .toEqual(['1T', '500B', '0']);
    expect([...figure.querySelectorAll('.markdown-dil-chart-guide span')].every(node => !node.textContent?.includes('…')))
      .toBe(true);
    const lines = [...figure.querySelectorAll('.markdown-dil-chart-bars > .markdown-dil-chart-gridline')];
    expect(lines.map(node => node.classList.item(1))).toEqual([
      'markdown-dil-chart-gridline-top',
      'markdown-dil-chart-gridline-middle',
      'markdown-dil-chart-gridline-baseline'
    ]);
    expect(lines.map(node => node.getAttribute('aria-hidden'))).toEqual(['true', 'true', 'true']);
  });

  it('uses compact y-axis guides in German without losing the exact localized tooltip or aria value', async () => {
    const widget = `\uE200genui\uE202${JSON.stringify({ charts_widget_v2: { content: {
      chartType: 'bar', xKey: 'group', series: [{ dataKey: 'value', label: 'Beispiel' }],
      data: [{ group: 'Erste', value: 1e12 }, { group: 'Zweite', value: 5e11 }], yAxisMax: 1e12
    } } })}\uE201`;
    await boot([observation('Initial message.')]);
    const { setLanguage } = await import('../src/renderer/i18n.js');
    const { renderedMarkdown } = await import('../src/renderer/chat.js');
    setLanguage('de');
    try {
      const figure = renderedMarkdown(widget).querySelector('.markdown-dil-chart')!;
      const guides = [...figure.querySelectorAll<HTMLElement>('.markdown-dil-chart-guide span')];
      expect(guides.map(label => label.textContent)).toEqual(['1 Bio.', '500 Mrd.', '0']);
      expect(guides.map(label => label.title)).toEqual(['1.000.000.000.000', '500.000.000.000', '0']);
      expect(guides.map(label => label.getAttribute('aria-label')))
        .toEqual(['1.000.000.000.000', '500.000.000.000', '0']);
      expect(figure.getAttribute('aria-label')).toContain('Erste 1.000.000.000.000');
      expect(guides.every(label => !label.textContent?.includes('…'))).toBe(true);
    } finally { setLanguage('en'); }
  });

  it('recovers the side-by-side table workflow only when its entire text matches', async () => {
    const body = [
      'Before.', '', '**Genetics**', '', 'Variants', '', '| ID | SNP |', '| --- | --- |', '| P1 | 0 |', '| P2 | 1 |', '',
      '**Microbiome**', '', 'Species', '', '| ID | Bacteria |', '| --- | --- |', '| P1 | 4% |', '| P2 | 9% |', '',
      'Match by ID', '', '**Association test**', '', 'Test each SNP.', '', 'After.'
    ].join('\n');
    const table = (title: string, subtitle: string, last: string, a: string, b: string) =>
      `<div data-d-component="grid-item"><p><strong>${title}</strong></p><p>${subtitle}</p>` +
      `<table><tr><th>ID</th><th>${last}</th></tr><tr><td>P1</td><td>${a}</td></tr><tr><td>P2</td><td>${b}</td></tr></table></div>`;
    const workflow = `<div data-d-component="box" data-d-has-border=""><div data-d-component="grid">` +
      table('Genetics', 'Variants', 'SNP', '0', '1') + table('Microbiome', 'Species', 'Bacteria', '4%', '9%') +
      `</div><p>Match by ID</p><div data-d-component="box" data-d-has-border=""><p><strong>Association test</strong></p>` +
      `<p>Test each SNP.</p></div></div>`;
    const { w } = await boot([observation(body, `<p>Before.</p>${workflow}<p>After.</p>`)]);
    const root = message(w);
    expect(root.querySelector('.markdown-dil-panel .markdown-dil-grid')).not.toBeNull();
    expect(root.querySelectorAll('.markdown-dil-panel .markdown-dil-grid-item')).toHaveLength(2);
    expect(root.querySelector('.markdown-dil-panel .markdown-dil-bordered')).not.toBeNull();
    expect(root.firstElementChild?.textContent).toBe('Before.');
    expect(root.lastElementChild?.textContent).toBe('After.');
  });

  it('rebuilds an ordered two-step panel without turning step numbers into oversized headings', async () => {
    const body = '1\n\n**Step one**\n\nStart here.\n\n2\n\n**Step two**\n\nFinish here.';
    const step = (number: number, heading: string, text: string) => `<div data-d-component="row"><div data-d-component="box">` +
      `<h2 data-d-component="title">${number}</h2></div><div data-d-component="box"><p><strong>${heading}</strong></p><p>${text}</p></div></div>`;
    const { w } = await boot([observation(body, `<div data-d-component="box">${step(1, 'Step one', 'Start here.')}${step(2, 'Step two', 'Finish here.')}</div>`)]);
    expect(message(w).querySelectorAll('.markdown-dil-steps > .markdown-dil-row')).toHaveLength(2);
  });

  it('restores a local vector figure after excluding all external SVG capabilities', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100" height="50"><line x1="0" y1="0" x2="100" y2="50" stroke="currentColor"/><circle cx="60" cy="25" r="4" fill="blue"/></svg>';
    const captured = (image: string): string => `<div data-d-component="box" data-d-has-border=""><p>Illustrative plot</p>` +
      `<img data-d-component="svg" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(image)}">` +
      `<p>Schematic only.</p></div>`;
    const body = 'Illustrative plot\n\nSchematic only.';
    const { w } = await boot([observation(body, captured(svg))]);
    const restored = message(w).querySelector<HTMLImageElement>('.markdown-dil-panel img.markdown-dil-svg');
    expect(restored?.src).toContain('data:image/svg+xml;charset=utf-8,');
    expect(decodeURIComponent(restored!.src)).toContain('<circle');
    const poisoned = svg.replace('</svg>', '<script>alert(1)</script></svg>');
    closeDom(); vi.resetModules();
    const { w: other } = await boot([observation(body, captured(poisoned))]);
    expect(message(other).querySelector('.markdown-dil-panel')).toBeNull();
    expect(message(other).querySelector('script, img')).toBeNull();
  });

  it.each(['text', 'tspan'])('refuses a recorded SVG containing %s labels that cannot be revision-matched', async tag => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><g><${tag}>Old value 12</${tag}></g></svg>`;
    const captured = `<div data-d-component="box" data-d-has-border=""><p>Illustrative plot</p>` +
      `<img data-d-component="svg" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}">` +
      `<p>Schematic only.</p></div>`;
    const { w } = await boot([observation('Illustrative plot\n\nSchematic only.', captured)]);
    const root = message(w);
    expect(root.querySelector('.markdown-dil-panel, .markdown-dil-svg')).toBeNull();
    expect(root.textContent).toContain('Illustrative plot');
    expect(root.textContent).not.toContain('Old value 12');
  });

  it('allows only static first-party search illustrations, not arbitrary recorded image requests', async () => {
    const html = (url: string): string => `<div data-d-component="row"><div data-d-component="box">` +
      `<div data-d-component="image"><img src="${url}" alt=""></div></div>` +
      `<div data-d-component="box"><p><strong>Example item</strong></p><p>Short explanation.</p></div></div>`;
    const body = '**Example item**\n\nShort explanation.';
    const { w } = await boot([observation(body, html('https://images.openai.com/static-rsc-4/Example01234'))]);
    expect(message(w).querySelector('.markdown-dil-photo-row img.markdown-dil-photo')).not.toBeNull();
    closeDom(); vi.resetModules();
    const { w: other } = await boot([observation(body, html('https://untrusted.invalid/track'))]);
    expect(message(other).querySelector('.markdown-dil-photo-row')).toBeNull();
  });

  it('keeps the canonical answer readable if a recorded illustration cannot load', async () => {
    const captured = '<div data-d-component="row"><div data-d-component="box">' +
      '<div data-d-component="image"><img src="https://images.openai.com/static-rsc-4/Example01234"></div></div>' +
      '<div data-d-component="box"><p><strong>Example item</strong></p><p>Short explanation.</p></div></div>';
    const { w } = await boot([observation('**Example item**\n\nShort explanation.', captured)]);
    const row = message(w).querySelector('.markdown-dil-photo-row')!;
    const image = row.querySelector<HTMLImageElement>('img.markdown-dil-photo')!;
    expect(image.referrerPolicy).toBe('no-referrer');
    image.dispatchEvent(new w.Event('error'));
    expect(row.querySelector('.markdown-dil-photo, .markdown-dil-box:first-child:empty')).toBeNull();
    expect(row.textContent).toContain('Example item');
    expect(row.textContent).toContain('Short explanation.');
  });
});

describe('a formula in an answer', () => {
  const answer = (seq: number, body: string): SessionEvent => ({
    seq, origin: 1, time: T0, source: 'extension', kind: 'assistant_message', messageId: 'math-answer', message: text(body),
    state: 'streaming', final: false });
  const rightClick = (w: any, target: Element) => {
    const event = new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it('copies its LaTeX source and its MathML from a right click, also on a block a later revision adds', async () => {
    const tex = String.raw`x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}`;
    const first = ['Solve:', '', String.raw`\[`, tex, String.raw`\]`, '', String.raw`with \(a\neq 0\).`, '', 'More'].join('\n');
    const { w, append } = await boot([answer(1, first)]);
    const writeClipboard = vi.fn(async () => ({ ok: true, data: true }));
    (w as any).api.writeClipboard = writeClipboard;
    const display = w.document.querySelector('.ev-assistant_message .math-display')!;
    // Anywhere in the drawing, not only on its outer box.
    expect(rightClick(w, display.querySelector('.katex-html .mord')!)).toBe(true);
    expect([...w.document.querySelectorAll<HTMLElement>('.row-menu .row-menu-item')].map(item => item.textContent)).toEqual(['Copy LaTeX', 'Copy MathML']);
    menuItem(w, 'copy-latex').click();
    await waitFor(() => expect(writeClipboard).toHaveBeenLastCalledWith(tex));
    expect(w.document.querySelector('.row-menu')).toBeNull();

    rightClick(w, w.document.querySelector('.ev-assistant_message .math-inline')!);
    menuItem(w, 'copy-mathml').click();
    await waitFor(() => expect(writeClipboard).toHaveBeenCalledTimes(2));
    const mathml = String((writeClipboard.mock.calls as unknown as string[][])[1]![0]);
    expect(mathml).toMatch(/^<math xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML">/);
    expect(mathml).toContain(String.raw`<annotation encoding="application/x-tex">a\neq 0</annotation>`);

    await append([answer(2, [first, '', String.raw`\[`, String.raw`e^{i\pi}+1=0`, String.raw`\]`, '', 'End'].join('\n'))]);
    rightClick(w, w.document.querySelectorAll('.ev-assistant_message .math-display')[1]!);
    menuItem(w, 'copy-latex').click();
    await waitFor(() => expect(writeClipboard).toHaveBeenLastCalledWith(String.raw`e^{i\pi}+1=0`));
  });

  it('leaves a right click on prose, or on LaTeX it could not draw, without a formula menu', async () => {
    const { w } = await boot([answer(1, String.raw`Plain words and \(\frac{1}{\) as written.`)]);
    const paragraph = w.document.querySelector('.ev-assistant_message .msg.rich p')!;
    expect(rightClick(w, paragraph)).toBe(false);
    expect(rightClick(w, paragraph.querySelector('.math-inline.is-source')!)).toBe(false);
    expect(w.document.querySelector('.row-menu')).toBeNull();
  });
});

// #1827 (Haz's review): one collapsed "Changed files" summary under a finished answer that edited files.
it("sums up what a finished answer changed, collapsed, counting only real changes, with each file's net diff and Open in Review", async () => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Repo', path: '/repo', createdAt: 1 };
  const { w, append } = await boot([], true, [], [project]);
  const api = (w as any).api;
  const changes = [
    // Recorded as the tools saw them: under the approved root's virtual name.
    { path: '/repo/src/app.ts', state: 'edited', added: 30, removed: 5, approximate: false, diff: 'kept', edits: 3 },
    { path: '/repo/src/new-page.ts', state: 'created', added: 12, removed: 0, approximate: false, diff: 'kept', edits: 1 },
    { path: '/repo/old/helper.ts', state: 'unchanged', added: 0, removed: 0, approximate: false, diff: 'kept', edits: 2 },
    { path: '/repo/big.json', state: 'edited', added: 400, removed: 2, approximate: true, diff: 'too-large', edits: 1 }
  ];
  api.turnChanges = vi.fn(async () => ({ ok: true, data: { changes, total: 4 } }));
  api.turnFileDiff = vi.fn(async () => ({ ok: true, data: { before: 'a\n', after: 'a\nb\n' } }));
  const edit = (seq: number, path: string, kind: 'edit' | 'create', agent?: string): SessionEvent => {
    const call = toolCall(seq, `edit-${seq}`) as Extract<SessionEvent, { kind: 'tool_call' }>;
    return { ...call, turnId: 't-edit', ...(agent ? { agent } : {}), call: { ...call.call, tool: 'apply_patch', summary: { kind, tone: 'good', title: `Edited ${path}` },
      changes: [{ path, added: 1, removed: 0, approximate: false, reviewAssetId: `asset-${seq}` }] } } as SessionEvent;
  };
  const answer = (seq: number): SessionEvent => ({ seq, time: T0 + seq * 1000, source: 'extension', kind: 'assistant_message', turnId: 't-edit',
    messageId: 'answer-edit', message: text('Done: three files.'), final: true, state: 'final' } as SessionEvent);
  await append([
    { seq: 10, time: T0 + 10_000, source: 'extension', kind: 'turn_start', turnId: 't-edit' } as SessionEvent,
    edit(11, 'src/app.ts', 'edit'), edit(12, 'src/new-page.ts', 'create'), answer(13)
  ]);
  // Still running: no card yet, so it never changes under the reader.
  expect(w.document.querySelector('.turn-changes')).toBeNull();
  await append([{ seq: 14, time: T0 + 14_000, source: 'extension', kind: 'turn_end', turnId: 't-edit', outcome: 'completed' } as SessionEvent]);
  await append([]);
  const card = w.document.querySelector<HTMLDetailsElement>('.turn-changes')!;
  expect(card).not.toBeNull();
  expect(api.turnChanges).toHaveBeenCalledWith(expect.any(String), 't-edit', 10);
  // Collapsed, even for a few files; the headline counts net changes only, and says the rest.
  expect(card.open).toBe(false);
  expect(card.querySelector('summary')!.textContent).toBe('Changed 3 files · +442 −7 (approx.) · 1 put back');
  card.open = true; card.dispatchEvent(new w.Event('toggle'));
  const rows = [...card.querySelectorAll<HTMLDetailsElement>('.turn-change')];
  // Each file named the way its tool row names it, without the root's virtual name; the full path in the tooltip.
  expect(rows.map(row => row.querySelector('summary')!.textContent)).toEqual([
    'src/app.ts+30 −5edited', 'src/new-page.ts+12created', 'old/helper.tsno net change', 'big.json+400 −2 (approx.)edited'
  ]);
  expect(rows[0]!.querySelector('summary')!.title).toBe('/repo/src/app.ts');
  // Two approved roots with the same file: the shortened names would be equal, so both keep their root (CodeRabbit).
  const { turnChangeLabels } = await import('../src/renderer/turn-changes.js');
  expect(turnChangeLabels(['/repo-a/src/app.ts', '/repo-b/src/app.ts', '/repo-a/README.md', 'notes.md']))
    .toEqual(['/repo-a/src/app.ts', '/repo-b/src/app.ts', 'README.md', 'notes.md']);
  // A file's net diff loads when its row opens; one the recording did not keep says so.
  rows[0]!.open = true; rows[0]!.dispatchEvent(new w.Event('toggle'));
  await settle();
  expect(api.turnFileDiff).toHaveBeenCalledWith(expect.any(String), 't-edit', 10, '/repo/src/app.ts');
  rows[3]!.open = true; rows[3]!.dispatchEvent(new w.Event('toggle'));
  await settle();
  expect(rows[3]!.textContent).toContain('Diff unavailable: this edit was too large to keep');
  expect(api.turnFileDiff).toHaveBeenCalledTimes(1);
  expect(card.querySelector('.turn-changes-review')!.textContent).toBe('Open in Review');
});

// CodeRabbit on #1836: a long turn's early edits can be outside the loaded page; a turn can gain an edit
// after its card loaded; a turn can start again after it ended.
it('asks for the card of an answer whose turn start is not loaded, and shows none when it edited nothing', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  api.turnChanges = vi.fn(async () => ({ ok: true, data: { changes: [{ path: 'early.ts', state: 'edited', added: 2, removed: 1, approximate: false, diff: 'kept', edits: 1 }], total: 1 } }));
  await append([
    { seq: 501, time: T0 + 501_000, source: 'extension', kind: 'assistant_message', turnId: 't-long', messageId: 'a-long', message: text('All done.'), final: true, state: 'final' } as SessionEvent,
    { seq: 502, time: T0 + 502_000, source: 'extension', kind: 'turn_end', turnId: 't-long', outcome: 'completed' } as SessionEvent
  ]);
  await append([]);
  expect(api.turnChanges).toHaveBeenCalledWith(expect.any(String), 't-long', 0);
  expect(w.document.querySelector('.turn-changes')?.textContent).toContain('Changed 1 file');
});

it('reads a reopened turn from its first start when only the reopening is loaded (CodeRabbit)', async () => {
  // The first turn_start and its edits left the loaded page; the app-authored reopening (with \`detail\`) is still there.
  const { w, append } = await boot([]);
  const api = (w as any).api;
  api.turnChanges = vi.fn(async () => ({ ok: true, data: { changes: [{ path: 'early.ts', state: 'edited', added: 2, removed: 1, approximate: false, diff: 'kept', edits: 1 }], total: 1 } }));
  await append([
    { seq: 700, time: T0 + 700_000, source: 'app', kind: 'turn_start', turnId: 't-reopened', detail: 'a tool call proved the turn was still running' } as SessionEvent,
    { seq: 701, time: T0 + 701_000, source: 'extension', kind: 'assistant_message', turnId: 't-reopened', messageId: 'a-reopened', message: text('All done.'), final: true, state: 'final' } as SessionEvent,
    { seq: 702, time: T0 + 702_000, source: 'extension', kind: 'turn_end', turnId: 't-reopened', outcome: 'completed' } as SessionEvent
  ]);
  await append([]);
  // Not from 700: that would leave out every edit made before the reopening.
  expect(api.turnChanges).toHaveBeenCalledWith(expect.any(String), 't-reopened', 0);
  expect(w.document.querySelector('.turn-changes')?.textContent).toContain('Changed 1 file');
});

it('refreshes the card when its finished turn gains another edit, and hides it while the turn runs again', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  let files = 1;
  api.turnChanges = vi.fn(async () => ({ ok: true, data: { changes: Array.from({ length: files }, (_, i) => ({ path: `f${i}.ts`, state: 'edited', added: 1, removed: 0, approximate: false, diff: 'kept', edits: 1 })), total: files } }));
  const edit = (seq: number, path: string): SessionEvent => {
    const call = toolCall(seq, `edit-late-${seq}`) as Extract<SessionEvent, { kind: 'tool_call' }>;
    return { ...call, turnId: 't-late', call: { ...call.call, tool: 'apply_patch', summary: { kind: 'edit', tone: 'good', title: `Edited ${path}` },
      changes: [{ path, added: 1, removed: 0, approximate: false, reviewAssetId: `asset-${seq}` }] } } as SessionEvent;
  };
  await append([
    { seq: 600, time: T0 + 600_000, source: 'extension', kind: 'turn_start', turnId: 't-late' } as SessionEvent,
    edit(601, 'f0.ts'),
    { seq: 602, time: T0 + 602_000, source: 'extension', kind: 'assistant_message', turnId: 't-late', messageId: 'a-late', message: text('Done.'), final: true, state: 'final' } as SessionEvent,
    { seq: 603, time: T0 + 603_000, source: 'extension', kind: 'turn_end', turnId: 't-late', outcome: 'completed' } as SessionEvent
  ]);
  await append([]);
  expect(w.document.querySelector('.turn-changes')?.textContent).toContain('Changed 1 file');
  files = 2;
  await append([edit(604, 'f1.ts')]);
  await append([]);
  expect(w.document.querySelector('.turn-changes')?.textContent).toContain('Changed 2 files');
  // The same turn starts again: its card waits until it is over again.
  await append([{ seq: 605, time: T0 + 605_000, source: 'extension', kind: 'turn_start', turnId: 't-late' } as SessionEvent]);
  await append([]);
  expect(w.document.querySelector('.turn-changes')).toBeNull();
});

it('shows no Changed files card for a turn whose only edits were a worker\'s, or that edited nothing', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  api.turnChanges = vi.fn(async () => ({ ok: true, data: { changes: [], total: 0 } }));
  const worker = toolCall(21, 'worker-edit') as Extract<SessionEvent, { kind: 'tool_call' }>;
  await append([
    { seq: 20, time: T0 + 20_000, source: 'extension', kind: 'turn_start', turnId: 't-w' } as SessionEvent,
    { ...worker, turnId: 't-w', agent: 'worker-1', call: { ...worker.call, tool: 'apply_patch', summary: { kind: 'edit', tone: 'good', title: 'Edited a.ts' },
      changes: [{ path: 'a.ts', added: 1, removed: 0, approximate: false }] } } as SessionEvent,
    { ...toolCall(22, 'read-only'), turnId: 't-w' } as SessionEvent,
    { seq: 23, time: T0 + 23_000, source: 'extension', kind: 'assistant_message', turnId: 't-w', messageId: 'a-w', message: text('Read it.'), final: true, state: 'final' } as SessionEvent,
    { seq: 24, time: T0 + 24_000, source: 'extension', kind: 'turn_end', turnId: 't-w', outcome: 'completed' } as SessionEvent
  ]);
  await append([]);
  expect(w.document.querySelector('.turn-changes')).toBeNull();
  expect(api.turnChanges).not.toHaveBeenCalled();
});

it('jumps between your own messages with Alt+↑ / Alt+↓, marked like a search result, and leaves the message box alone (#1884)', async () => {
  const at = Date.now() - 60_000;
  const { w } = await boot([
    { kind: 'user_message', seq: 11, origin: 11, time: at, source: 'extension', messageId: 'q-1', message: text('First question') },
    { kind: 'assistant_message', seq: 12, time: at + 1, source: 'extension', messageId: 'a-1', message: text('First answer'), final: true, state: 'final' } as SessionEvent,
    { kind: 'user_message', seq: 13, origin: 13, time: at + 2, source: 'extension', messageId: 'q-2', message: text('Second question') },
    { kind: 'assistant_message', seq: 14, time: at + 3, source: 'extension', messageId: 'a-2', message: text('Second answer'), final: true, state: 'final' } as SessionEvent,
    { kind: 'user_message', seq: 15, origin: 15, time: at + 4, source: 'extension', messageId: 'q-3', message: text('Third question') }
  ]);
  const doc = w.document;
  doc.querySelector<HTMLElement>('.app')!.dataset.screen = 'chat';
  const own = [...doc.querySelectorAll<HTMLElement>('#timeline [data-timeline-key]')].filter(row => row.querySelector('.said.is-user'));
  expect(own.map(row => row.textContent?.match(/(First|Second|Third) question/)?.[1])).toEqual(['First', 'Second', 'Third']);
  // The view starts at the third question; the first two are above it.
  const tops = [-800, -200, 0];
  own.forEach((row, index) => { row.getBoundingClientRect = () => ({ top: tops[index]!, bottom: tops[index]! + 40, left: 0, right: 600, width: 600, height: 40, x: 0, y: tops[index]!, toJSON: () => ({}) }) as DOMRect; });
  doc.getElementById('chatBody')!.getBoundingClientRect = () => ({ top: 0, bottom: 700, left: 0, right: 800, width: 800, height: 700, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  const scrolled: string[] = [];
  own.forEach(row => { row.scrollIntoView = () => { scrolled.push(row.textContent!.match(/(First|Second|Third)/)![1]!); }; });
  const press = (key: string, target: Element = doc.body) => target.dispatchEvent(new w.KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true }));
  // Attachment names come before the text in the box; only the message is read (CodeRabbit).
  const attachments = doc.createElement('div'); attachments.className = 'message-attachments';
  attachments.textContent = 'quarterly-report-final-version.pdf '.repeat(20);
  own[1]!.querySelector('.said.is-user')!.insertBefore(attachments, own[1]!.querySelector('.user-message-text'));
  press('ArrowUp');
  expect(scrolled).toEqual(['Second']);
  expect(own[1]!.classList.contains('is-search-hit')).toBe(true);
  // A screen reader hears which message it went to; the focus did not move (CodeRabbit).
  expect(doc.getElementById('recallAnnounce')!.textContent).toBe('Second question');
  expect(doc.activeElement).toBe(doc.body);
  press('ArrowDown');
  expect(scrolled).toEqual(['Second']);
  // In the message box the keys stay the box's own, and in the sidebar they move a chat or project.
  press('ArrowUp', doc.getElementById('chatInput')!);
  press('ArrowUp', doc.querySelector('.sidebar') ?? doc.body);
  expect(scrolled).toEqual(['Second']);
  // Other modifiers are not this shortcut.
  doc.body.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, shiftKey: true, bubbles: true }));
  expect(scrolled).toEqual(['Second']);
  // With the chat's settings (or another view of the pane) shown, the keys don't act on the hidden chat.
  const content = doc.getElementById('timelineContent')!;
  content.hidden = true;
  const hidden = new w.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true });
  doc.body.dispatchEvent(hidden);
  expect(hidden.defaultPrevented).toBe(false);
  expect(scrolled).toEqual(['Second']);
  content.hidden = false;
  // No earlier message on the loaded page, with the pane already at its top: the page before it is
  // asked for, as reading up would, although no scroll event happens (CodeRabbit).
  const api = (w as any).api, original = api.getSession;
  const read = vi.fn((id: string, options: unknown) => original(id, options));
  api.getSession = read;
  own.forEach(row => { row.getBoundingClientRect = () => ({ top: 100, bottom: 140, left: 0, right: 600, width: 600, height: 40, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect; });
  const pane = doc.getElementById('chatBody')!;
  Object.defineProperties(pane, { clientHeight: { value: 700 }, scrollHeight: { value: 700 } });
  pane.scrollTop = 0;
  // All three are in view now: the jump goes on from Second to First (CodeRabbit), and only then
  // is there none earlier.
  press('ArrowUp', doc.getElementById('chatTitle') ?? doc.body);
  expect(scrolled).toEqual(['Second', 'First']);
  expect(read).not.toHaveBeenCalled();
  press('ArrowUp', doc.getElementById('chatTitle') ?? doc.body);
  await settle();
  expect(read).toHaveBeenCalledWith(expect.any(String), { before: 11, limit: 30 });
});
