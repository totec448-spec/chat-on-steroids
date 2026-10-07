import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
interface DomApi {
  insertPrompt(text: string, mode?: boolean | 'append', failure?: (reason: string) => void): boolean;
  enterProject(entry: { id: string; sourceConversationId: string }, current?: () => boolean,
    failure?: (reason: string) => void): Promise<boolean>;
  composer(): HTMLElement | null;
  composerActions(): { host: HTMLElement; before: HTMLElement | null } | null;
  generating(): boolean;
  sendButton(): HTMLButtonElement | null;
  temporaryChatReady(): boolean;
  confirmTemporaryChatIntroduction(): void;
  errors(): Array<{ text: string; recoverable: boolean; blocking?: boolean }>;
  captureComposerDraft(text: string, current?: () => boolean): { current(): boolean; clear(): Promise<boolean>; withdraw(): boolean; dispose(): void; attachments(nodes: Element[]): void };
  visibleModelSelection(): { model: string; reasoningEffort?: string } | null;
  hasComposerAttachments(): boolean;
  stopGeneration(current: () => boolean): boolean;
  inspectModelSettings(current?: () => boolean, failure?: (reason: string) => void): Promise<Array<{id: string; label: string; efforts: string[]}> | null>;
  send(options?: { acceptanceTimeoutMs?: number; stillCurrent?: () => boolean; beforeSend?: () => Promise<boolean>;
    mention?: { path: string; name: string } | null; explain?: (why: string) => void }): Promise<boolean>;
  selectModelSettings(model: string | null, effort: string | null, current?: () => boolean): Promise<boolean>;
  uploadImages(images: Array<{ name: string; dataUrl: string }>, current?: () => boolean, draft?: ReturnType<DomApi['captureComposerDraft']>, files?: File[]): Promise<boolean>;
  messages(): Array<{ id: string; role: 'user' | 'assistant'; text: string; turnId: string | null }>;
  turns(): Array<{ id: string | null; role: string; node: HTMLElement; nodes: HTMLElement[] }>;
  toolBlocks(turn: ReturnType<DomApi['turns']>[number]): HTMLElement[];
  hideActivity(turn: ReturnType<DomApi['turns']>[number], covered: HTMLElement[]): void;
}
let dom: JSDOM;
let document: Document;
let api: DomApi;
let box: HTMLElement;
let button: HTMLButtonElement;
beforeEach(() => {
  vi.useFakeTimers();
  dom = new JSDOM('<form><div id="prompt-textarea" contenteditable="true">Exact app prompt</div><div data-testid="composer-trailing-actions"><button type="button" aria-haspopup="menu">Medium</button><button type="button" data-testid="send-button">Send</button></div></form>', { url: 'https://chatgpt.com/', runScripts: 'outside-only', pretendToBeVisual: true });
  document = dom.window.document;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{ width: 10, height: 10 }]; } });
  dom.window.eval(source);
  api = (dom.window as unknown as { CLF_DOM: DomApi }).CLF_DOM;
  box = document.getElementById('prompt-textarea')!;
  button = document.querySelector('[data-testid="send-button"]')!;
});
afterEach(() => { dom.window.close(); vi.useRealTimers(); });
function user(text: string) {
  const section = document.createElement('section');
  section.setAttribute('data-testid', 'conversation-turn-1');
  section.setAttribute('data-turn', 'user');
  section.setAttribute('data-turn-id', 'turn-one');
  const message = document.createElement('div');
  message.setAttribute('data-message-id', 'message-one');
  message.setAttribute('data-message-author-role', 'user');
  message.textContent = text;
  section.append(message); document.body.append(section);
}

it('reads the September search-unit renderer without legacy message attributes', () => {
  const turn = document.createElement('div');
  turn.setAttribute('data-turn-key', 'search-turn');
  const userUnit = document.createElement('div');
  userUnit.setAttribute('data-chatgpt-search-unit-key', 'search-turn:0:user');
  userUnit.setAttribute('data-chatgpt-search-message-ids', 'search-user');
  const userText = document.createElement('div');
  userText.className = 'whitespace-pre-wrap';
  userText.textContent = 'Search unit question';
  userUnit.append(userText);
  const assistantUnit = document.createElement('div');
  assistantUnit.setAttribute('data-chatgpt-search-unit-key', 'search-turn:2:assistant');
  assistantUnit.setAttribute('data-chatgpt-selection-message-id', 'search-assistant');
  const prose = document.createElement('div');
  prose.setAttribute('data-markdown-text-style', 'assistant-message');
  prose.textContent = 'Search unit answer';
  assistantUnit.append(prose);
  turn.append(userUnit, assistantUnit);
  document.body.append(turn);

  expect(api.messages()).toEqual([
    expect.objectContaining({ id: 'search-user', role: 'user', text: 'Search unit question', turnId: 'search-turn' }),
    expect.objectContaining({ id: 'search-assistant', role: 'assistant', text: 'Search unit answer', turnId: 'search-turn' })
  ]);
});

describe('one native HTML edit for prepared text', () => {
  beforeEach(() => {
    document.execCommand = (command, _ui, value) => {
      const selection = document.getSelection();
      if (command !== 'insertHTML' || document.activeElement !== box || !selection?.rangeCount) return false;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const template = document.createElement('template');
      template.innerHTML = value || '';
      range.insertNode(template.content);
      return true;
    };
  });
  it('hands a 96000-character multiline frame to the editor once without native per-line editing', () => {
    const value = ('Literal <abc> & "quoted" instructions.\n\n').repeat(2600).slice(0, 96000);
    const nativeEdit = vi.spyOn(document, 'execCommand');
    const events = vi.spyOn(document, 'dispatchEvent');
    const pasted = vi.fn(); box.addEventListener('paste', pasted);
    expect(api.insertPrompt(value, true)).toBe(true);
    expect(nativeEdit).toHaveBeenCalledOnce();
    expect(nativeEdit).toHaveBeenCalledWith('insertHTML', false, expect.any(String));
    expect(events).not.toHaveBeenCalled();
    expect(pasted).not.toHaveBeenCalled();
    expect(box.querySelectorAll('p')).toHaveLength(0);
    expect(box.querySelector('abc')).toBeNull();
    expect(box.innerHTML.replaceAll('<br>', '\n')).toContain('&lt;abc&gt;');
    expect(box.textContent!.replace(/\s/g, '')).toBe(value.replace(/\s/g, ''));
  });
  it('preserves an existing draft when native editing refuses it without falling back', () => {
    const nativeEdit = vi.fn(() => false); document.execCommand = nativeEdit;
    expect(api.insertPrompt('replacement', true)).toBe(false);
    expect(box.textContent).toBe('Exact app prompt');
    expect(nativeEdit).toHaveBeenCalledOnce();
  });
  it.each(['replace', 'append', 'empty'] as const)('uses the browser range for one %s edit even when a cold custom paste handler drops text', mode => {
    const original = mode === 'empty' ? '' : 'Original draft';
    box.textContent = original;
    const pasted = vi.fn((event: Event) => event.preventDefault());
    box.addEventListener('paste', pasted);
    const nativeEdit = vi.spyOn(document, 'execCommand');
    expect(api.insertPrompt('Replacement', mode === 'append' ? 'append' : true)).toBe(true);
    expect(nativeEdit).toHaveBeenCalledOnce();
    expect(pasted).not.toHaveBeenCalled();
    expect(box.textContent).toBe(mode === 'append' ? original + 'Replacement' : 'Replacement');
  });
  it('does not edit a host replaced while it takes focus', () => {
    const nativeEdit = vi.spyOn(document, 'execCommand');
    box.focus = () => box.replaceWith(box.cloneNode(true));
    expect(api.insertPrompt('Replacement', true)).toBe(false);
    expect(nativeEdit).not.toHaveBeenCalled();
    expect(document.getElementById('prompt-textarea')!.textContent).toBe('Exact app prompt');
  });
  it.each(['refused', 'modified', 'replaced', 'exception'])('reports only bounded predicate metadata for %s insertion', kind => {
    const secret = 'PRIVATE authored prompt';
    document.execCommand = () => {
      if (kind === 'refused') return false;
      if (kind === 'modified') box.textContent = 'Other text';
      if (kind === 'replaced') box.replaceWith(box.cloneNode(true));
      if (kind === 'exception') throw new Error(secret);
      return true;
    };
    const failure = vi.fn();
    expect(api.insertPrompt(secret, true, failure)).toBe(false);
    expect(failure).toHaveBeenCalledOnce();
    const reason = failure.mock.calls[0]![0];
    expect(reason).toBe({ refused: 'native_edit_rejected', modified: 'text_mismatch', replaced: 'editor_replaced', exception: 'insertion_exception' }[kind]);
    expect(reason).not.toContain(secret);
    expect(reason).not.toContain('Other text');
  });
  it('restores an originally empty draft through one native inline edit', () => {
    const nativeEdit = vi.spyOn(document, 'execCommand');
    expect(api.insertPrompt('', true)).toBe(true);
    expect(box.textContent).toBe('');
    expect(nativeEdit).toHaveBeenCalledOnce();
    expect(nativeEdit).toHaveBeenCalledWith('insertHTML', false, '<br>');
  });
  it('refuses another draft before native editing', () => {
    const nativeEdit = vi.spyOn(document, 'execCommand');
    expect(api.insertPrompt('replacement')).toBe(false);
    expect(nativeEdit).not.toHaveBeenCalled();
  });
  it('retains the exact editor lease through paragraph normalization but rejects changed content and remounts', () => {
    box.textContent = 'First line\nSecond line';
    const draft = api.captureComposerDraft(box.textContent);
    box.innerHTML = '<p>First line</p><p>Second line</p>';
    expect(draft.current()).toBe(true);
    box.lastElementChild!.textContent = 'Different line';
    expect(draft.current()).toBe(false);
    box.innerHTML = '<p>First line</p><p>Second line</p>';
    box.replaceWith(box.cloneNode(true));
    expect(draft.current()).toBe(false);
    draft.dispose();
  });
});

describe('a workspace page kept mounted behind the current one', () => {
  // Measured 2026-10-01: a tab opened on /c/<id> and moved into its Project keeps the first page
  // mounted under display:none, editor and header included. Two editors meant no composer at all,
  // so the tab could neither send nor enter its Project.
  function keptPage(shown = false) {
    const kept = document.createElement('div');
    kept.setAttribute('data-app-shell-page-surface', 'true');
    if (!shown) kept.style.display = 'none';
    kept.innerHTML = '<form><div id="prompt-textarea" contenteditable="true">Old page</div><button type="button" data-testid="send-button">Send</button></form>';
    document.body.prepend(kept);
    return kept;
  }
  it('takes the rendered editor and its own Send', async () => {
    keptPage();
    expect(api.composer()).toBe(box);
    let clicked = false;
    button.addEventListener('click', () => { clicked = true; user('Exact app prompt'); box.replaceChildren(); });
    expect(await api.send()).toBe(true);
    expect(clicked).toBe(true);
  });
  it.each([
    ['display', 'none'],
    ['visibility', 'hidden']
  ] as const)('ignores a model-transition editor hidden only by computed %s', (property, value) => {
    const stale = document.createElement('div');
    stale.style[property] = value;
    stale.innerHTML = '<form><div id="prompt-textarea" contenteditable="true">Old transition editor</div></form>';
    document.body.prepend(stale);
    expect(api.composer()).toBe(box);
  });
  it("reads only this page's turns, not those of an earlier page kept undisplayed", () => {
    // After a Project resume the tab keeps the source chat hidden; its turns are another chat's.
    const kept = keptPage();
    const old = document.createElement('section');
    old.setAttribute('data-testid', 'conversation-turn-1'); old.setAttribute('data-turn', 'user'); old.setAttribute('data-turn-id', 'old-turn');
    const oldMessage = document.createElement('div');
    oldMessage.setAttribute('data-message-id', 'old-message'); oldMessage.setAttribute('data-message-author-role', 'user');
    oldMessage.textContent = 'Source chat question'; old.append(oldMessage); kept.append(old);
    user('Resumed chat question');
    expect(api.messages().map(message => message.text)).toEqual(['Resumed chat question']);
  });
  it('still refuses two displayed editors', () => {
    keptPage(true);
    expect(api.composer()).toBeNull();
  });
});

describe('native Project entry readiness', () => {
  const entry = { id: 'g-p-11111111222233334444555555555555', sourceConversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
  const projectUrl = `https://chatgpt.com/g/${entry.id}-example/project`;
  function sourceLink(markup = `<a href="${projectUrl}"><span data-testid="project-folder-icon"></span>Project</a>`) {
    dom.reconfigure({ url: `https://chatgpt.com/c/${entry.sourceConversationId}` });
    const header = document.createElement('header');
    header.innerHTML = markup;
    document.body.prepend(header);
    return header.querySelector('a')!;
  }

  it('waits for the mounted source editor before spending its one native click', async () => {
    const link = sourceLink();
    box.textContent = '';
    box.remove();
    const clicks = vi.fn((event: Event) => event.preventDefault());
    link.addEventListener('click', clicks);
    const entered = api.enterProject(entry);
    // The native header can mount before its source chat. A premature click can be
    // swallowed while the provider is hydrating, leaving the one-click attempt spent.
    await Promise.resolve();
    expect(clicks).not.toHaveBeenCalled();
    link.addEventListener('click', () => {
      dom.reconfigure({ url: projectUrl });
      box.replaceWith(box.cloneNode(true));
    });
    document.querySelector('form')!.prepend(box);
    expect(await entered).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the October 2026 header link', `<a href="/g/${entry.id}/project" data-discover="true"><span><span><svg></svg></span><span>Homelab</span></span></a>`]
  ])('enters through %s, which no longer carries the folder icon test id', async (_shape, markup) => {
    // Measured 2026-10-01: every Compact & resume from a Project chat failed with "could not
    // open the source Project" because the header link lost data-testid="project-folder-icon".
    const link = sourceLink(markup);
    box.textContent = '';
    link.addEventListener('click', event => { event.preventDefault(); dom.reconfigure({ url: projectUrl }); box.replaceWith(box.cloneNode(true)); });
    expect(await api.enterProject(entry)).toBe(true);
  });

  it('enters through the current Project chrome link when it is no longer inside header or banner', async () => {
    // Measured 2026-10-04: the native Project-home link is still exact and same-origin, but
    // ChatGPT moved it out of both <header> and [role="banner"]. Restricting discovery to those
    // two old shells leaves zero candidates and Compact & resume fails before Send.
    dom.reconfigure({ url: `https://chatgpt.com/c/${entry.sourceConversationId}` });
    const chrome = document.createElement('div');
    chrome.innerHTML = `<a href="/g/${entry.id}/project" data-discover="true"><span>Homelab</span></a>`;
    document.body.prepend(chrome);
    const link = chrome.querySelector('a')!;
    box.textContent = '';
    const clicks = vi.fn((event: Event) => {
      event.preventDefault();
      dom.reconfigure({ url: projectUrl });
      box.replaceWith(box.cloneNode(true));
    });
    link.addEventListener('click', clicks);
    const entered = api.enterProject(entry);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await entered).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('never uses an exact Project-home link rendered only inside a conversation turn', async () => {
    dom.reconfigure({ url: `https://chatgpt.com/c/${entry.sourceConversationId}` });
    user('Earlier turn');
    const turn = document.querySelector('section[data-testid^="conversation-turn"]')!;
    const transcriptLink = document.createElement('a');
    transcriptLink.href = `/g/${entry.id}/project`;
    transcriptLink.textContent = 'Project link quoted in chat';
    turn.querySelector('[data-message-author-role="user"]')!.append(transcriptLink);
    const transcriptClicks = vi.fn((event: Event) => event.preventDefault());
    transcriptLink.addEventListener('click', transcriptClicks);
    const entered = api.enterProject(entry);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transcriptClicks).not.toHaveBeenCalled();
    expect(await entered).toBe(false);
  });

  it('accepts the Project home when ChatGPT keeps the same editor element', async () => {
    // Measured 2026-10-01: from a Project chat, the header link leads to the Project home in
    // the same editor element. Waiting for a new editor failed every Compact & resume there.
    const link = sourceLink(`<a href="/g/${entry.id}/project"><span>Homelab</span></a>`);
    box.textContent = '';
    user('Earlier turn');
    const turn = document.querySelector('section[data-testid^="conversation-turn"]')!;
    const kept = box;
    link.addEventListener('click', event => {
      event.preventDefault();
      dom.reconfigure({ url: `https://chatgpt.com/g/${entry.id}/project` });
      dom.window.setTimeout(() => turn.remove(), 300);
    });
    const entered = api.enterProject(entry);
    await vi.advanceTimersByTimeAsync(200);
    // Still the source's turns on screen: not entered yet.
    let settled = false; void entered.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(await entered).toBe(true);
    expect(document.getElementById('prompt-textarea')).toBe(kept);
  });

  it('enters while turns of an earlier page stay mounted but undisplayed', async () => {
    // Measured 2026-10-01: the app's tab keeps its redirect steps as hidden pages, turns included.
    const link = sourceLink(`<a href="/g/${entry.id}/project"><span>Homelab</span></a>`);
    box.textContent = '';
    user('Earlier turn');
    const turn = document.querySelector('section[data-testid^="conversation-turn"]')!;
    link.addEventListener('click', event => {
      event.preventDefault();
      dom.reconfigure({ url: `https://chatgpt.com/g/${entry.id}/project` });
      const kept = document.createElement('div');
      kept.setAttribute('data-app-shell-page-surface', 'true'); kept.style.display = 'none';
      turn.replaceWith(kept); kept.append(turn);
    });
    expect(await api.enterProject(entry)).toBe(true);
    expect(turn.isConnected).toBe(true);
  });

  it('ignores the header of an earlier page ChatGPT keeps undisplayed', async () => {
    // Measured 2026-10-01: a replacement tab's header held the Project link twice, one on a kept,
    // undisplayed page. Counting both refused the only real link and the resume failed.
    const link = sourceLink(`<div data-app-shell-page-surface="true" style="display:none"><a href="/g/${entry.id}/project"><span>Homelab</span></a></div><a href="/g/${entry.id}/project"><span>Homelab</span></a>`);
    const shown = document.querySelectorAll('header a')[1]!;
    box.textContent = '';
    const clicks = vi.fn((event: Event) => { event.preventDefault(); dom.reconfigure({ url: `https://chatgpt.com/g/${entry.id}/project` }); });
    shown.addEventListener('click', clicks);
    expect(await api.enterProject(entry)).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
    void link;
  });

  it('refuses two header links to the same Project instead of guessing', async () => {
    const link = sourceLink(`<a href="/g/${entry.id}/project"><span>A</span></a><a href="/g/${entry.id}/project"><span>B</span></a>`);
    box.textContent = '';
    const clicks = vi.fn((event: Event) => event.preventDefault());
    document.querySelectorAll('header a').forEach(node => node.addEventListener('click', clicks));
    const failure = vi.fn();
    const entered = api.enterProject(entry, undefined, failure);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await entered).toBe(false);
    expect(failure).toHaveBeenCalledWith('source-ready-timeout:last=candidate-count-2');
    expect(clicks).not.toHaveBeenCalled();
    void link;
  });

  it('gives the native transition its own deadline after source loading', async () => {
    const link = sourceLink();
    box.textContent = '';
    box.remove();
    let clicks = 0;
    link.addEventListener('click', event => {
      event.preventDefault(); clicks++;
      dom.window.setTimeout(() => {
        dom.reconfigure({ url: projectUrl });
        box.replaceWith(box.cloneNode(true));
      }, 2_000);
    });
    const entered = api.enterProject(entry);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(clicks).toBe(0);
    document.querySelector('form')!.prepend(box);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await entered).toBe(true);
    expect(clicks).toBe(1);
  });

  it('lets a large source chat take longer than the transition deadline to load (#212)', async () => {
    // The published reproduction: a source ready at 13 s failed against the old shared 12 s.
    const link = sourceLink();
    box.textContent = '';
    box.remove();
    let clicks = 0;
    link.addEventListener('click', event => {
      event.preventDefault(); clicks++;
      dom.window.setTimeout(() => { dom.reconfigure({ url: projectUrl }); box.replaceWith(box.cloneNode(true)); }, 2_000);
    });
    const entered = api.enterProject(entry);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(clicks).toBe(0);
    document.querySelector('form')!.prepend(box);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await entered).toBe(true);
    expect(clicks).toBe(1);
  });

  it('still gives up on a native transition that does not arrive within its own deadline', async () => {
    const link = sourceLink();
    let clicks = 0;
    link.addEventListener('click', event => { event.preventDefault(); clicks++; });
    box.textContent = '';
    const failure = vi.fn();
    const entered = api.enterProject(entry, undefined, failure);
    await vi.advanceTimersByTimeAsync(12_500);
    expect(clicks).toBe(1);
    expect(await entered).toBe(false);
    expect(failure).toHaveBeenCalledWith('transition-timeout:last=source-route');
  });

  it('reports a Project route whose editor never becomes ready after the one click', async () => {
    const link = sourceLink();
    box.textContent = '';
    link.addEventListener('click', event => {
      event.preventDefault();
      dom.reconfigure({ url: projectUrl });
      box.remove();
    });
    const failure = vi.fn();
    const entered = api.enterProject(entry, undefined, failure);
    await vi.advanceTimersByTimeAsync(12_500);
    expect(await entered).toBe(false);
    expect(failure).toHaveBeenCalledWith('transition-timeout:last=composer-not-ready');
  });

  it('reports visible source turns as the last observation when the Project transition times out', async () => {
    const link = sourceLink();
    box.textContent = '';
    user('Earlier turn');
    link.addEventListener('click', event => {
      event.preventDefault();
      dom.reconfigure({ url: projectUrl });
    });
    const failure = vi.fn();
    const entered = api.enterProject(entry, undefined, failure);
    await vi.advanceTimersByTimeAsync(12_500);
    expect(await entered).toBe(false);
    expect(failure).toHaveBeenCalledWith('transition-timeout:last=source-turns-remain');
  });

  it.each([
    ['missing', 'source-ready-timeout:last=source-not-ready'],
    ['draft', 'source-ready-timeout:last=source-not-ready'],
    ['cancelled', 'current-lost'],
    ['foreign-route', 'wrong-route-before-click']
  ])('never clicks an unready or retired source: %s', async (reason, expectedFailure) => {
    const link = sourceLink();
    box.textContent = reason === 'draft' ? 'Keep my draft' : '';
    box.remove();
    let current = true;
    const clicks = vi.fn((event: Event) => event.preventDefault());
    link.addEventListener('click', clicks);
    const failure = vi.fn();
    const entered = api.enterProject(entry, () => current, failure);
    if (reason === 'cancelled') current = false;
    if (reason === 'foreign-route') dom.reconfigure({ url: 'https://chatgpt.com/c/bbbbbbbb-1111-4222-8333-444444444444' });
    if (reason !== 'missing') document.querySelector('form')!.prepend(box);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await entered).toBe(false);
    expect(failure).toHaveBeenCalledWith(expectedFailure);
    expect(clicks).not.toHaveBeenCalled();
    if (reason === 'draft') expect(box.textContent).toBe('Keep my draft');
  });
});

describe('one native Send and bounded acceptance observation', () => {
  it.each([false, true])('retires only the unchanged accepted composer text (new draft: %s)', async edited => {
    document.execCommand = command => { if (command === 'delete') box.replaceChildren(); return true; };
    button.addEventListener('click', () => {
      dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
      user('Exact app prompt');
      if (edited) box.textContent = 'My next unsent draft';
    });
    expect(await api.send()).toBe(true);
    expect(box.textContent).toBe(edited ? 'My next unsent draft' : '');
  });
  it('recognizes the live Stop answering composer-submit control without treating Start Voice as Stop', () => {
    button.dataset.testid = 'composer-submit-button'; button.setAttribute('aria-label', 'Stop answering');
    const clicked = vi.fn(); button.addEventListener('click', clicked);
    expect(api.stopGeneration(() => true)).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);
    button.setAttribute('aria-label', 'Start Voice');
    expect(api.stopGeneration(() => true)).toBe(false);
  });
  it.each(['Remove file:', 'Remove file 1:'])('recognizes %s attachment-only drafts before helper cleanup', (label) => {
    box.textContent = '';
    expect(api.hasComposerAttachments()).toBe(false);
    const tile = document.createElement('button'); tile.setAttribute('aria-label', `${label} user.webp`);
    document.querySelector('form')!.append(tile);
    expect(api.hasComposerAttachments()).toBe(true);
    tile.remove();
    const upload = document.createElement('span'); upload.setAttribute('data-inline-file-uploading', '');
    document.querySelector('form')!.append(upload);
    expect(api.hasComposerAttachments()).toBe(true);
  });
  it('stops only a visible enabled native control while exact ownership remains current', () => {
    button.dataset.testid = 'stop-button';
    const clicks = vi.fn(); button.addEventListener('click', clicks);
    expect(api.stopGeneration(() => false)).toBe(false);
    button.disabled = true;
    expect(api.stopGeneration(() => true)).toBe(false);
    button.disabled = false; button.hidden = true;
    expect(api.stopGeneration(() => true)).toBe(false);
    button.hidden = false;
    let checks = 0;
    expect(api.stopGeneration(() => ++checks === 1)).toBe(false);
    expect(clicks).not.toHaveBeenCalled();
    expect(api.stopGeneration(() => true)).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
  });
  it('accepts a composer clear after the old 3-second deadline without sending twice', async () => {
    const clicks = vi.fn(() => dom.window.setTimeout(() => { box.textContent = ''; }, 3200));
    button.addEventListener('click', clicks);
    const result = api.send();
    let settled = false; void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(3100);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('times out once after 30 seconds and never clicks a Send that stays disabled', async () => {
    const clicks = vi.fn(); button.addEventListener('click', clicks);
    const result = api.send({ acceptanceTimeoutMs: Infinity });
    await vi.advanceTimersByTimeAsync(30000);
    expect(await result).toBe(false);
    expect(clicks).toHaveBeenCalledTimes(1);
    button.disabled = true;
    const disabled = api.send();
    await vi.advanceTimersByTimeAsync(30000);
    expect(await disabled).toBe(false);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('allows fresh conversation assignment only with a new exact user message', async () => {
    button.addEventListener('click', () => {
      dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
      user('Exact app prompt');
    });
    expect(await api.send()).toBe(true);
  });

  it('does not accept navigation to an unrelated conversation with an empty composer', async () => {
    button.addEventListener('click', () => {
      dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
      box.textContent = ''; user('An unrelated user message');
    });
    const result = api.send({ acceptanceTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(false);
  });

  it('fails closed when target ownership is revoked before late acceptance', async () => {
    let current = true;
    const clicks = vi.fn(); button.addEventListener('click', clicks);
    const result = api.send({ stillCurrent: () => current });
    current = false; box.textContent = '';
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(false);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('does not retarget an existing conversation even when the new page contains matching text', async () => {
    dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    button.addEventListener('click', () => {
      dom.reconfigure({ url: 'https://chatgpt.com/c/bbbbbbbb-cccc-dddd-eeee-ffffffffffff' });
      user('Exact app prompt');
    });
    expect(await api.send()).toBe(false);
  });

  it('does not confuse missing word boundaries with exact submitted text', async () => {
    box.textContent = 'a b';
    button.addEventListener('click', () => user('ab'));
    const result = api.send({ acceptanceTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(false);
  });

  it('preserves adjacent rich-editor paragraphs when matching the submitted message', async () => {
    box.innerHTML = '<p>first line</p><p>second line</p>';
    button.addEventListener('click', () => user('first line\nsecond line'));
    expect(await api.send()).toBe(true);
  });

  it('does not mistake a remounted historical message for the newly submitted prompt', async () => {
    user('Exact app prompt');
    button.addEventListener('click', () => {
      document.querySelector('section')!.remove();
      user('Exact app prompt');
    });
    const result = api.send({ acceptanceTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(false);
  });
});

describe('Core app mention on app-owned sends (#861)', () => {
  const mention = { path: 'app://asdk_app_TESTCORE123', name: 'Chat On Steroids Core' };
  beforeEach(() => {
    // The editor turns the pasted mention element into its own non-editable token.
    document.execCommand = (command, _ui, value) => {
      const selection = document.getSelection();
      if (command === 'delete') { box.replaceChildren(); return true; }
      if (command !== 'insertHTML' || document.activeElement !== box || !selection?.rangeCount) return false;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const template = document.createElement('template');
      template.innerHTML = value || '';
      template.content.querySelectorAll('[app-mention-path]').forEach(token => token.setAttribute('contenteditable', 'false'));
      range.insertNode(template.content);
      return true;
    };
  });
  // The mention waits at least one task for the editor before Send.
  async function sendMention(options: Parameters<DomApi['send']>[0] = {}) {
    const result = api.send({ mention, ...options });
    await vi.advanceTimersByTimeAsync(10);
    return result;
  }
  // ChatGPT's editor drops the inserted element on a microtask and draws its own token one
  // task later; only that token is part of what Send submits.
  function redrawingEditor(draw = true) {
    const state = { drawn: null as Element | null };
    document.execCommand = (command, _ui, value) => {
      if (command === 'delete') { box.replaceChildren(); return true; }
      if (command !== 'insertHTML' || document.activeElement !== box) return false;
      const template = document.createElement('template'); template.innerHTML = value || '';
      const inserted = template.content.querySelector('[app-mention-path]')!;
      box.append(template.content);
      queueMicrotask(() => {
        const copy = inserted.cloneNode(true) as Element;
        inserted.remove();
        if (draw) setTimeout(() => { copy.setAttribute('contenteditable', 'false'); box.append(copy); state.drawn = copy; }, 0);
      });
      return true;
    };
    return state;
  }
  function mentionedUser(text: string) {
    user('');
    const row = document.querySelector('[data-message-author-role="user"]')!;
    const body = document.createElement('div'); body.className = 'whitespace-pre-wrap';
    const chip = document.createElement('span'); chip.setAttribute('data-prompt-link-href', mention.path);
    chip.setAttribute('data-prompt-link-label', '$chat-on-steroids-core'); chip.textContent = mention.name;
    body.append(text + ' ', chip); row.append(body);
  }
  it('adds the token at the end right before Send and recognizes the rendered message without it', async () => {
    let atClick = '';
    button.addEventListener('click', () => {
      atClick = box.innerHTML;
      dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
      mentionedUser('Exact app prompt');
      box.replaceChildren();
    });
    expect(await sendMention()).toBe(true);
    const clicked = document.createElement('div'); clicked.innerHTML = atClick;
    const token = clicked.querySelector('[app-mention-path]')!;
    expect(token.getAttribute('app-mention-path')).toBe(mention.path);
    expect(token.getAttribute('data-prompt-link-label')).toBe('$chat-on-steroids-core');
    expect(clicked.textContent!.trim().startsWith('Exact app prompt')).toBe(true);
    expect(api.messages().find(message => message.role === 'user')?.text).toBe('Exact app prompt');
  });
  it('removes its own token again when Send is not accepted', async () => {
    const result = api.send({ mention, acceptanceTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1100);
    expect(await result).toBe(false);
    expect(box.querySelector('[app-mention-path]')).toBeNull();
    expect(box.textContent!.trim()).toBe('Exact app prompt');
  });
  it('sends unchanged when the editor does not turn the mention into a token', async () => {
    document.execCommand = (command, _ui, value) => {
      if (command === 'undo') { box.textContent = 'Exact app prompt'; return true; }
      if (command !== 'insertHTML') return false;
      // An editor without the mention node keeps only the element's text.
      const parsed = document.createElement('template'); parsed.innerHTML = String(value);
      box.append(document.createTextNode(parsed.content.textContent || ''));
      return true;
    };
    let atClick = '';
    button.addEventListener('click', () => { atClick = box.textContent || ''; user('Exact app prompt'); box.replaceChildren(); });
    expect(await sendMention()).toBe(true);
    expect(atClick.trim()).toBe('Exact app prompt');
  });
  it('adds the mention even when rendered text and raw text of the prompt differ', async () => {
    // A hidden editor node counts in textContent but not in innerText. Comparing the two
    // aborted an approved Send; the mention is now checked against the box itself.
    const hidden = document.createElement('span'); hidden.textContent = '\u200b'; hidden.hidden = true; box.append(hidden);
    Object.defineProperty(box, 'innerText', { configurable: true, get: () => 'Exact app prompt' });
    let tokenAtClick = false;
    button.addEventListener('click', () => {
      tokenAtClick = !!box.querySelector('[app-mention-path]');
      dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
      mentionedUser('Exact app prompt'); box.replaceChildren();
    });
    expect(await sendMention()).toBe(true);
    expect(tokenAtClick).toBe(true);
  });
  it('sends unchanged when adding the mention throws', async () => {
    document.execCommand = () => { throw new Error('editor refused'); };
    button.addEventListener('click', () => { user('Exact app prompt'); box.replaceChildren(); });
    expect(await sendMention()).toBe(true);
  });
  it('clicks Send only after the editor has drawn its own token', async () => {
    const editor = redrawingEditor();
    let submittedWithMention = false;
    button.addEventListener('click', () => {
      submittedWithMention = !!editor.drawn?.isConnected;
      dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
      mentionedUser('Exact app prompt'); box.replaceChildren();
    });
    expect(await sendMention()).toBe(true);
    expect(submittedWithMention).toBe(true);
  });
  it('sends unchanged when the editor drops the token without drawing its own', async () => {
    redrawingEditor(false);
    let atClick: string | null = null;
    button.addEventListener('click', () => { atClick = box.innerHTML; user('Exact app prompt'); box.replaceChildren(); });
    const result = api.send({ mention });
    await vi.advanceTimersByTimeAsync(1000);
    expect(atClick).toBeNull();
    await vi.advanceTimersByTimeAsync(600);
    expect(await result).toBe(true);
    expect(atClick!.trim()).toBe('Exact app prompt');
  });
  it("removes the editor's own token when Send is not accepted", async () => {
    const editor = redrawingEditor();
    const result = api.send({ mention, acceptanceTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1100);
    expect(await result).toBe(false);
    expect(editor.drawn).not.toBeNull();
    expect(box.querySelector('[app-mention-path]')).toBeNull();
    expect(box.textContent!.trim()).toBe('Exact app prompt');
  });
  it('does not send when the prompt changed while the editor drew the token', async () => {
    redrawingEditor();
    let clicked = false;
    button.addEventListener('click', () => { clicked = true; });
    const reasons: string[] = [];
    const result = api.send({ mention, explain: why => reasons.push(why) });
    box.prepend(document.createTextNode('typed by the user '));
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toBe(false);
    expect(clicked).toBe(false);
    // Its own reason, apart from an edit before the mention step (#1086).
    expect(reasons).toEqual(['mention-changed']);
  });
  it('adds the mention only after the caller authorized the unchanged prompt', async () => {
    // Measured 2026-10-01: added at readiness, the token made the app's draft lease refuse
    // authorization, and every app prompt stayed typed in the composer.
    const editor = redrawingEditor();
    let tokenWhenAuthorizing = true;
    let submittedWithMention = false;
    button.addEventListener('click', () => {
      submittedWithMention = !!editor.drawn?.isConnected;
      dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
      mentionedUser('Exact app prompt'); box.replaceChildren();
    });
    const beforeSend = async () => { tokenWhenAuthorizing = !!box.querySelector('[app-mention-path]'); return true; };
    expect(await sendMention({ beforeSend })).toBe(true);
    expect(tokenWhenAuthorizing).toBe(false);
    expect(submittedWithMention).toBe(true);
  });
  it('clicks the Send control the editor drew again after the mention', async () => {
    redrawingEditor();
    let clicked = false;
    const redraw = new dom.window.MutationObserver(() => {
      if (!box.querySelector('[app-mention-path][contenteditable="false"]') || button.isConnected === false) return;
      redraw.disconnect();
      const fresh = button.cloneNode(true) as HTMLButtonElement;
      fresh.addEventListener('click', () => {
        clicked = true;
        dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
        mentionedUser('Exact app prompt'); box.replaceChildren();
      });
      button.replaceWith(fresh);
    });
    redraw.observe(box, { childList: true });
    expect(await sendMention({ beforeSend: async () => true })).toBe(true);
    expect(clicked).toBe(true);
  });
  it('sends exactly as before without a mention', async () => {
    const insert = vi.spyOn(document, 'execCommand');
    button.addEventListener('click', () => { user('Exact app prompt'); box.replaceChildren(); });
    expect(await api.send()).toBe(true);
    expect(insert).not.toHaveBeenCalledWith('insertHTML', expect.anything(), expect.anything());
  });
});

describe('why a Send ended without acceptance (#820)', () => {
  it.each<[string, () => void]>([
    ['page-busy', () => { const stop = document.createElement('button'); stop.setAttribute('data-testid', 'stop-button'); stop.textContent = 'Stop'; button.closest('div')!.append(stop); }],
    ['editor-missing', () => { box.remove(); }],
    ['draft-empty', () => { box.textContent = ''; }],
    ['chat-changed', () => undefined]
  ])('names %s at once', async (why, arrange) => {
    arrange();
    const said: string[] = [];
    expect(await api.send({ explain: reason => said.push(reason), stillCurrent: () => why !== 'chat-changed' })).toBe(false);
    expect(said).toEqual([why]);
  });
  it('names a refused authorization and a Send that never became ready', async () => {
    const refused: string[] = [];
    expect(await api.send({ explain: reason => refused.push(reason), beforeSend: async () => false })).toBe(false);
    expect(refused).toEqual(['not-authorized']);
    button.disabled = true;
    const late: string[] = [];
    const result = api.send({ explain: reason => late.push(reason), acceptanceTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1100);
    expect(await result).toBe(false);
    expect(late).toEqual(['send-not-ready']);
  });
  it('says nothing for an accepted Send', async () => {
    const said: string[] = [];
    button.addEventListener('click', () => { user('Exact app prompt'); box.replaceChildren(); });
    expect(await api.send({ explain: reason => said.push(reason) })).toBe(true);
    expect(said).toEqual([]);
  });
});

describe('composer-owned controls and Send readiness', () => {
  it.each(['allowed', 'revoked', 'replaced', 'deadline'])('authorizes only a ready Send and rechecks after authorization (%s)', async state => {
    button.disabled = true;
    let release!: (allowed: boolean) => void;
    const authorize = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
    const clicks = vi.fn(() => { box.textContent = ''; });
    button.addEventListener('click', clicks);
    const sending = api.send({ beforeSend: authorize, acceptanceTimeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(500);
    expect(authorize).not.toHaveBeenCalled();
    button.disabled = false;
    await vi.advanceTimersByTimeAsync(1);
    expect(authorize).toHaveBeenCalledTimes(1);
    button.setAttribute('aria-label', 'Send prompt');
    if (state === 'replaced') button.replaceWith(button.cloneNode(true));
    if (state === 'deadline') await vi.advanceTimersByTimeAsync(2000);
    release(state !== 'revoked');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await sending).toBe(state === 'allowed');
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(clicks).toHaveBeenCalledTimes(state === 'allowed' ? 1 : 0);
  });

  it.each(['disabled', 'aria-disabled', 'unmounted'])('waits for the same draft and its %s Send control without synthetic Enter', async state => {
    const trailing = button.parentElement!;
    if (state === 'disabled') button.disabled = true;
    if (state === 'aria-disabled') button.setAttribute('aria-disabled', 'true');
    if (state === 'unmounted') button.remove();
    const clicks = vi.fn(() => { box.textContent = ''; });
    const keys = vi.fn();
    button.addEventListener('click', clicks); box.addEventListener('keydown', keys);
    const result = api.send({ acceptanceTimeoutMs: 2000 });
    let settled = false; void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(900);
    expect(settled).toBe(false);
    expect(clicks).not.toHaveBeenCalled();
    expect(keys).not.toHaveBeenCalled();
    button.disabled = false; button.removeAttribute('aria-disabled'); trailing.append(button);
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(keys).not.toHaveBeenCalled();
  });

  it.each(['draft', 'editor', 'route', 'authority', 'other-generation'])('revokes a waiting Send when its %s changes', async reason => {
    button.remove();
    const keys = vi.fn(); box.addEventListener('keydown', keys);
    const clicks = vi.fn(); button.addEventListener('click', clicks);
    let current = true;
    const result = api.send({ acceptanceTimeoutMs: 2000, stillCurrent: () => current });
    await vi.advanceTimersByTimeAsync(50);
    if (reason === 'draft') box.textContent = 'A newer user draft';
    if (reason === 'editor') box.replaceWith(box.cloneNode(true));
    if (reason === 'route') dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    if (reason === 'authority') current = false;
    if (reason === 'other-generation') {
      const stop = document.createElement('button'); stop.dataset.testid = 'stop-button';
      document.querySelector('form')!.append(stop);
    }
    document.querySelector('form')!.append(button);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBe(false);
    expect(clicks).not.toHaveBeenCalled();
    expect(keys).not.toHaveBeenCalled();
  });

  it.each(['hidden', 'inert', 'transcript', 'other-form'])('does not let a %s Stop control block this composer', async place => {
    const stale = document.createElement('button'); stale.dataset.testid = 'stop-button';
    const host = document.createElement(place === 'other-form' ? 'form' : 'section');
    if (place === 'hidden') host.hidden = true;
    if (place === 'inert') host.setAttribute('inert', '');
    if (place === 'transcript') host.dataset.testid = 'conversation-turn-100';
    host.append(stale);
    if (place === 'hidden' || place === 'inert') document.querySelector('form')!.prepend(host);
    else document.body.prepend(host);
    expect(api.generating()).toBe(false);
    button.addEventListener('click', () => { box.textContent = ''; });
    expect(await api.send()).toBe(true);
  });

  it('uses only the visible Send in the current form and never a quoted or hidden control', async () => {
    const stale = button.cloneNode(true) as HTMLButtonElement;
    stale.hidden = true; button.parentElement!.prepend(stale);
    const quote = document.createElement('section'); quote.dataset.testid = 'conversation-turn-100';
    const quotedSend = button.cloneNode(true); quote.append(quotedSend); document.body.prepend(quote);
    const wrong = vi.fn(); stale.addEventListener('click', wrong); quotedSend.addEventListener('click', wrong);
    const clicks = vi.fn(() => { box.textContent = ''; }); button.addEventListener('click', clicks);
    expect(api.sendButton()).toBe(button);
    expect(await api.send()).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(wrong).not.toHaveBeenCalled();
  });

  it('does not guess between two visible Send controls while the composer is remounting', async () => {
    const duplicate = button.cloneNode(true) as HTMLButtonElement;
    button.parentElement!.append(duplicate);
    const wrong = vi.fn(); duplicate.addEventListener('click', wrong);
    const clicks = vi.fn(() => { box.textContent = ''; }); button.addEventListener('click', clicks);
    expect(api.sendButton()).toBeNull();
    const result = api.send({ acceptanceTimeoutMs: 2000 });
    expect(clicks).not.toHaveBeenCalled();
    duplicate.remove(); await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(wrong).not.toHaveBeenCalled();
  });
});

function upload() {
  const input = document.createElement('input');
  input.id = 'upload-photos'; input.type = 'file'; input.accept = 'image/*';
  Object.defineProperty(input, 'files', { writable: true, value: [] });
  document.querySelector('form')!.append(input);
  class Transfer {
    files: File[] = [];
    items = { add: (file: File) => { this.files.push(file); } };
  }
  Object.defineProperty(dom.window, 'DataTransfer', { value: Transfer });
  return input;
}
describe('native image readiness', () => {
  it.each(['wrong filename', 'multiple actions', 'outside attachments'])('rejects a shell attachment lookalike: %s', variant => {
    const holder = document.createElement('div'); holder.setAttribute('data-composer-attachments', '');
    holder.innerHTML = '<div role="button" aria-label="app.webp"><img alt="app.webp"><button aria-label="Remover app.webp"></button></div>';
    if (variant === 'wrong filename') holder.querySelector('img')!.alt = 'other.webp';
    if (variant === 'multiple actions') holder.firstElementChild!.append(document.createElement('button'));
    if (variant === 'outside attachments') holder.removeAttribute('data-composer-attachments');
    document.querySelector('form')!.append(holder);
    expect(api.hasComposerAttachments()).toBe(false);
  });
  it('recognizes the shell image tile by filename and its unique localized remove action', async () => {
    const input = upload(); input.id = '_r_image_';
    const draft = api.captureComposerDraft('Exact app prompt');
    document.execCommand = command => { if (command === 'delete') box.replaceChildren(); return true; };
    input.addEventListener('change', () => {
      const holder = document.createElement('div'); holder.setAttribute('data-composer-attachments', '');
      holder.innerHTML = '<div role="button" aria-label="app.webp"><img alt="app.webp"><button aria-label="Remover app.webp"></button></div>';
      holder.querySelector('button')!.addEventListener('click', () => holder.remove());
      document.querySelector('form')!.append(holder);
    });
    expect(await api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }], () => true, draft)).toBe(true);
    expect(api.hasComposerAttachments()).toBe(true);
    expect(await draft.clear()).toBe(true);
    expect(api.hasComposerAttachments()).toBe(false); draft.dispose();
  });
  it.each([false, true])('uses the current composer upload kind with dynamic ids (files=%s)', async files => {
    const input = upload(); input.id = '_r_photo_';
    if (files) { input.id = '_r_file_'; input.accept = ''; }
    const media = document.createElement('input'); media.type = 'file'; media.accept = 'image/*,video/*';
    input.after(media);
    const foreign = input.cloneNode() as HTMLInputElement; foreign.id = 'upload-photos';
    document.body.prepend(foreign);
    const wrong = vi.fn(); foreign.addEventListener('change', wrong); media.addEventListener('change', wrong);
    input.addEventListener('change', () => {
      const tile = document.createElement('button'); tile.setAttribute('aria-label', 'Remove file: app.webp');
      document.querySelector('form')!.append(tile);
    });
    const image = { name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' };
    const originals = files ? [new dom.window.File(['bytes'], image.name, { type: 'image/webp' })] : [];
    expect(await api.uploadImages(files ? [] : [image], () => true, undefined, originals)).toBe(true);
    expect(wrong).not.toHaveBeenCalled();
  });
  it.each(['duplicate', 'disabled', 'foreign'])('does not dispatch an upload with %s native ownership', async reason => {
    const input = upload(); const changed = vi.fn(); input.addEventListener('change', changed);
    if (reason === 'duplicate') input.after(input.cloneNode());
    if (reason === 'disabled') input.disabled = true;
    if (reason === 'foreign') document.body.append(input);
    expect(await api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }])).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });
  it.each(['rename', 'replacement', 'extra file', 'cancel'])('retains exact image upload nodes across %s while processing', async change => {
    const input = upload();
    const tile = document.createElement('button');
    tile.setAttribute('aria-label', 'Remove file 1: app.webp');
    let current = true;
    input.addEventListener('change', () => {
      document.querySelector('form')!.append(tile);
      button.setAttribute('aria-disabled', 'true');
    });
    const uploaded = api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }], () => current);
    await vi.advanceTimersByTimeAsync(0);
    if (change === 'rename') tile.setAttribute('aria-label', 'Remove file 1: app(1).webp');
    if (change === 'replacement') tile.replaceWith(tile.cloneNode(true));
    if (change === 'extra file') tile.after(tile.cloneNode(true));
    if (change === 'cancel') current = false;
    button.setAttribute('aria-disabled', 'false');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(await uploaded).toBe(change === 'rename');
  });
  it('waits for ARIA-only Send readiness after an attachment tile appears', async () => {
    const input = upload();
    input.addEventListener('change', () => {
      const tile = document.createElement('button');
      tile.setAttribute('aria-label', 'Remove file 1: app.webp');
      document.querySelector('form')!.append(tile);
      button.setAttribute('aria-disabled', 'true');
    });
    const uploaded = api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }]);
    let ready = false; void uploaded.then(value => { ready = value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(button.disabled).toBe(false);
    expect(ready).toBe(false);
    button.setAttribute('aria-disabled', 'false');
    await vi.advanceTimersByTimeAsync(0);
    expect(await uploaded).toBe(true);
  });
  it('uploads original Markdown bytes and recognizes localized native file actions without duplicate tiles', async () => {
    const input = upload(); input.id = 'upload-files'; input.accept = '';
    const draft = api.captureComposerDraft('Exact app prompt');
    document.execCommand = command => { if (command === 'delete') box.replaceChildren(); return true; };
    input.addEventListener('change', () => {
      const tile = document.createElement('div'); tile.setAttribute('role', 'group'); tile.setAttribute('aria-label', 'Notes.md');
      tile.innerHTML = '<div data-default-action="true"><button aria-label="Notes.md"></button></div><button aria-label="删除文件 1: Notes.md"></button>';
      tile.lastElementChild!.addEventListener('click', () => tile.remove());
      document.querySelector('form')!.append(tile);
    });
    const file = new dom.window.File(['# exact markdown'], 'Notes.md', { type: 'text/markdown' });
    expect(await api.uploadImages([], () => true, draft, [file])).toBe(true);
    expect(input.files?.[0]).toBe(file);
    expect(api.hasComposerAttachments()).toBe(true);
    expect(await draft.clear()).toBe(true);
    expect(api.hasComposerAttachments()).toBe(false); draft.dispose();
  });
  it('withdraws only the exact prepared app text and ready attachment nodes before Send', async () => {
    const input = upload();
    document.execCommand = command => { if (command === 'delete') box.replaceChildren(); return true; };
    const draft = api.captureComposerDraft('Exact app prompt');
    const tile = document.createElement('button'); tile.type = 'button'; tile.setAttribute('aria-label', 'Remove file 1: app.webp');
    tile.addEventListener('click', () => tile.remove());
    input.addEventListener('change', () => document.querySelector('form')!.append(tile));
    expect(await api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }], () => true, draft)).toBe(true);
    expect(await draft.clear()).toBe(true);
    expect(tile.isConnected).toBe(false); expect(box.textContent).toBe(''); draft.dispose();
  });
  it.each(['edited text', 'extra attachment', 'replacement attachment', 'navigation'])('preserves the entire draft after %s breaks exact ownership', async reason => {
    const input = upload();
    document.execCommand = command => { if (command === 'delete') box.replaceChildren(); return true; };
    let current = true;
    const draft = api.captureComposerDraft('Exact app prompt', () => current);
    const tile = document.createElement('button'); tile.type = 'button'; tile.setAttribute('aria-label', 'Remove file 1: app.webp');
    const removed = vi.fn(); tile.addEventListener('click', removed);
    input.addEventListener('change', () => document.querySelector('form')!.append(tile));
    expect(await api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }], () => current, draft)).toBe(true);
    if (reason === 'edited text') box.textContent += ' user change';
    if (reason === 'extra attachment') tile.after(tile.cloneNode(true));
    if (reason === 'replacement attachment') tile.replaceWith(tile.cloneNode(true));
    if (reason === 'navigation') current = false;
    expect(await draft.clear()).toBe(false);
    expect(removed).not.toHaveBeenCalled(); expect(box.textContent).not.toBe(''); draft.dispose();
  });
  it('withdraws exact app text across one remount after send authority is revoked', () => {
    document.execCommand = command => { if (command === 'delete') api.composer()?.replaceChildren(); return true; };
    let current = true;
    const draft = api.captureComposerDraft('Exact app prompt', () => current);
    current = false;
    const replacement = box.cloneNode(true) as HTMLElement;
    box.replaceWith(replacement);
    box = replacement;
    expect(draft.current()).toBe(false);
    expect(draft.withdraw()).toBe(true);
    expect(box.textContent).toBe('');
    draft.dispose();
  });
  it('does not withdraw a changed remounted draft after send authority is revoked', () => {
    document.execCommand = command => { if (command === 'delete') api.composer()?.replaceChildren(); return true; };
    let current = true;
    const draft = api.captureComposerDraft('Exact app prompt', () => current);
    current = false;
    const replacement = box.cloneNode(true) as HTMLElement;
    replacement.textContent = 'User-authored replacement';
    box.replaceWith(replacement);
    box = replacement;
    expect(draft.withdraw()).toBe(false);
    expect(box.textContent).toBe('User-authored replacement');
    draft.dispose();
  });
  it.each(['Remove file:', 'Remove file 1:'])('waits for matching %s attachment and upload completion before Send', async (label) => {
    const input = upload();
    const tile = document.createElement('button'); tile.type = 'button';
    tile.setAttribute('aria-label', `${label} example.webp`); tile.setAttribute('aria-busy', 'true');
    input.addEventListener('change', () => document.querySelector('form')!.append(tile));
    const result = api.uploadImages([{ name: 'example.webp', dataUrl: 'data:image/webp;base64,YQ==' }]);
    let settled = false; void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    tile.removeAttribute('aria-busy');
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(true);
  });

  it('rejects invalid attachments before changing the native file input', async () => {
    const input = upload(); const changed = vi.fn(); input.addEventListener('change', changed);
    expect(await api.uploadImages([{ name: 'bad.webp', dataUrl: 'data:image/png;base64,YQ==' }])).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });

  it('does not add app images to an existing attachment-only draft', async () => {
    const input = upload(); const changed = vi.fn(); input.addEventListener('change', changed);
    const tile = document.createElement('button'); tile.setAttribute('aria-label', 'Remove file: personal.webp');
    document.querySelector('form')!.append(tile);
    expect(await api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }])).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    expect(tile.isConnected).toBe(true);
  });

  it('refuses extra attachments added while the requested upload is completing', async () => {
    const input = upload();
    input.addEventListener('change', () => {
      for (const name of ['app.webp', 'personal.webp']) {
        const tile = document.createElement('button'); tile.setAttribute('aria-label', `Remove file: ${name}`);
        document.querySelector('form')!.append(tile);
      }
    });
    expect(await api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }])).toBe(false);
    expect(document.querySelectorAll('[aria-label^="Remove file:"]')).toHaveLength(2);
  });

  it('requires distinct new tiles with exact filenames rather than substring matches', async () => {
    const input = upload();
    const form = document.querySelector('form')!;
    const old = document.createElement('button'); old.setAttribute('aria-label', 'Other action'); form.append(old);
    const tile = document.createElement('button'); tile.setAttribute('aria-label', 'Remove file: data.webp');
    input.addEventListener('change', () => form.append(tile));
    const result = api.uploadImages(Array.from({ length: 2 }, () => ({ name: 'a.webp', dataUrl: 'data:image/webp;base64,YQ==' })));
    let settled = false; void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    tile.setAttribute('aria-label', 'Remove file: a.webp');
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    const second = document.createElement('button'); second.setAttribute('aria-label', 'Remove file: a.webp'); form.append(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(true);
  });
});


describe('transport-card scan cost', () => {
  it('skips hundreds of sidebar buttons without reading innerText and still finds the real card', () => {
    const sidebar = document.createElement('nav');
    const readSidebarText = vi.fn(function (this: HTMLElement) { return this.textContent; });
    Object.defineProperty(sidebar, 'innerText', { get: readSidebarText });
    for (let index = 0; index < 300; index++) {
      const row = document.createElement('div');
      const control = document.createElement('button');
      control.textContent = `Chat ${index}`;
      Object.defineProperty(control, 'innerText', { get: readSidebarText });
      Object.defineProperty(row, 'innerText', { get: readSidebarText });
      row.append(control); sidebar.append(row);
    }
    document.body.append(sidebar);
    const card = document.createElement('div');
    card.innerHTML = '<p>Resume stream unavailable </p><button>Reintentar</button>';
    document.body.append(card);

    for (let tick = 0; tick < 3; tick++) {
      expect(api.errors()).toEqual([
        expect.objectContaining({ text: 'Resume stream unavailable', recoverable: true })
      ]);
    }
    expect(readSidebarText.mock.calls.length).toBe(0);
  });

  it.each(['nav', 'aside', 'header', 'form', '[role="navigation"]', '[role="menu"]'])(
    'does not read or classify a retry-like control inside %s', selector => {
      const host = document.createElement(selector.startsWith('[') ? 'div' : selector);
      if (selector.startsWith('[')) host.setAttribute('role', selector.includes('navigation') ? 'navigation' : 'menu');
      host.innerHTML = '<p>Resume stream unavailable </p><button>Reintentar</button>';
      const readText = vi.fn(function (this: HTMLElement) { return this.textContent; });
      Object.defineProperty(host, 'innerText', { get: readText });
      Object.defineProperty(host.querySelector('button')!, 'innerText', { get: readText });
      document.body.append(host);

      expect(api.errors()).toEqual([]);
      expect(readText.mock.calls.length).toBe(0);
    }
  );

  it('still finds an English Retry card rendered beside the composer', () => {
    const form = document.createElement('form');
    form.innerHTML = '<div><p>A network error occurred. </p><button>Retry</button></div><div contenteditable="true"></div>';
    document.body.append(form);

    expect(api.errors()).toEqual([
      expect.objectContaining({ text: 'A network error occurred. Retry', recoverable: true })
    ]);
  });

  it('classifies Stream cache expired with a localized Retry control as recoverable', () => {
    const card = document.createElement('div');
    card.innerHTML = '<p>Stream cache expired </p><button>Reintentar</button>';
    document.body.append(card);

    expect(api.errors()).toEqual([
      expect.objectContaining({ text: 'Stream cache expired', recoverable: true })
    ]);
  });

  it.each([500, 5000])('rejects a %i-character container before reading its rendered text', length => {
    const host = document.createElement('div');
    const control = document.createElement('button');
    control.textContent = 'Reintentar';
    host.append('x'.repeat(length - control.textContent.length), control);
    const readText = vi.fn(() => 'Resume stream unavailable Reintentar');
    Object.defineProperty(host, 'innerText', { get: readText });
    document.body.append(host);

    expect(host.textContent).toHaveLength(length);
    expect(api.errors()).toEqual([]);
    expect(readText.mock.calls.length).toBe(0);
  });
});

describe('provider limit notice', () => {
  it('records and acknowledges the exact Korean access notice once without accepting other dialogs', () => {
    const notice = document.createElement('div'); notice.setAttribute('role', 'dialog');
    notice.innerHTML = '<h2>요청이 너무 많습니다</h2><p>요청을 너무 빠르게 보내고 있습니다. 데이터를 보호하기 위해 대화에 대한 액세스가 일시적으로 제한되었습니다. 몇 분 후 다시 시도해 주세요.</p><button>알겠습니다</button>';
    document.body.append(notice);
    const click = vi.fn(); notice.querySelector('button')!.addEventListener('click', click);
    expect(api.errors()).toEqual([expect.objectContaining({ blocking: true, recoverable: false })]);
    expect(click).toHaveBeenCalledTimes(1);
    api.errors(); expect(click).toHaveBeenCalledTimes(1);
    const unrelated = notice.cloneNode(true) as HTMLElement;
    unrelated.querySelector('h2')!.textContent = 'Permission required';
    const accept = vi.fn(); unrelated.querySelector('button')!.addEventListener('click', accept);
    document.body.append(unrelated); api.errors(); expect(accept).not.toHaveBeenCalled();
    const hidden = notice.cloneNode(true) as HTMLElement; hidden.setAttribute('aria-hidden', 'true');
    hidden.querySelector('button')!.addEventListener('click', accept); document.body.append(hidden);
    api.errors(); expect(accept).not.toHaveBeenCalled();
  });
  it('recognizes only the visible provider access-limit dialog as a blocking nontransport error', () => {
    const notice = document.createElement('div');
    notice.innerHTML = '<h2>Too many requests</h2><p>We have temporarily limited access to conversations to protect your data. Please wait a few minutes.</p>';
    document.body.append(notice);
    expect(api.errors()).toEqual([]);
    notice.setAttribute('role', 'dialog');
    expect(api.errors()).toEqual([expect.objectContaining({ blocking: true, recoverable: false, text: expect.stringContaining('Too many requests') })]);
    notice.querySelector('p')!.setAttribute('role', 'alert');
    expect(api.errors()).toHaveLength(1);
    notice.setAttribute('aria-hidden', 'true'); expect(api.errors()).toEqual([]);
    notice.querySelector('p')!.removeAttribute('role');
    notice.removeAttribute('aria-hidden'); notice.querySelector('p')!.textContent = 'An article about rate limits';
    expect(api.errors()).toEqual([]);
  });
});

describe('rendered temporary-chat state independent of language', () => {
  function toggle(label: string, checked: boolean) {
    const control = document.createElement('button');
    control.setAttribute('aria-label', label);
    control.innerHTML = `<svg style="opacity:${checked ? 0 : 1}"><use href="/cdn/assets/sprites-shell-anyhash.svg#chat-temp"></use></svg><svg aria-hidden="true" style="opacity:${checked ? 1 : 0}"><use href="/cdn/assets/sprites-shell-anyhash.svg#chat-temp-checked"></use></svg>`;
    document.body.append(control);
    return control;
  }
  function currentToggle(label: string, active: boolean) {
    const control = document.createElement('button');
    control.setAttribute('aria-label', label);
    const paths = [
      'M16.8525 7.06128C17.1968 6.93341 17.5801 7.10859 17.708 7.45288Z',
      'M2.29199 7.45288C2.41986 7.10859 2.80317 6.93341 3.14746 7.06128Z',
      'M11.957 7.40698C12.1557 7.09821 12.5671 7.00824 12.8756 7.20697Z'
    ];
    if (active) paths.push('M9.99902 2.25171C11.8772 2.25171 13.6066 2.88171 14.9531 3.93042Z');
    control.innerHTML = `<svg viewBox="0 0 20 20">${paths.map(d => `<path d="${d}"></path>`).join('')}</svg>`;
    document.body.append(control);
    return control;
  }
  it.each(['Temporären Chat ausschalten', '一時チャットをオフにする', 'Turn off temporary chat', ''])('reads the checked glyph with arbitrary label %s', label => {
    toggle(label, true);
    expect(api.temporaryChatReady()).toBe(true);
  });
  it.each(['beliebig', '任意', ''])('reads the current four-path active temporary-chat icon with arbitrary label %s', label => {
    currentToggle(label, true);
    expect(api.temporaryChatReady()).toBe(true);
  });
  it('does not mistake the current three-path inactive temporary-chat icon for active mode', () => {
    currentToggle('Temporary chat', false);
    expect(api.temporaryChatReady()).toBe(false);
  });
  it('accepts the current Temporary Chat introduction wording', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = '<h2>Temporary chat</h2><p>This chat won\'t appear in history.</p><button>Continue</button>';
    document.body.append(dialog);
    const clicked = vi.fn();
    dialog.querySelector('button')!.addEventListener('click', clicked);
    api.confirmTemporaryChatIntroduction();
    expect(clicked).toHaveBeenCalledOnce();
  });
  /**
   * The same answer from the page's own state, for a layout that no longer draws the glyph.
   *
   * Measured on 2026-09-25 across both kinds of chat: React holds `entry.isTemporaryChat`, true
   * on `/c/<id>?temporary-chat=true` and false on an ordinary chat. `fiber.js` stamps that onto
   * the turn with the pathname it was observed on, so a stamp left behind by another route
   * cannot answer for this one — the same rule the running hint beside it follows.
   */
  it('accepts the state a mounted turn published, and only for this route', () => {
    const shell = document.createElement('main');
    shell.setAttribute('data-app-shell-main-surface', '');
    shell.innerHTML = '<div data-thread-find-target="conversation"><div data-turn-key="t-1"></div></div>';
    document.body.append(shell);
    const turn = shell.querySelector('[data-turn-key]')!;
    expect(api.temporaryChatReady(), 'an unstamped turn claimed the mode').toBe(false);

    turn.setAttribute('data-clf-temporary-chat', '/c/somewhere-else');
    expect(api.temporaryChatReady(), 'a stamp from another route answered for this one').toBe(false);

    turn.setAttribute('data-clf-temporary-chat', dom.window.location.pathname);
    expect(api.temporaryChatReady()).toBe(true);
  });

  it('does not mistake a hidden checked glyph, English wording or URL intent for active mode', () => {
    dom.reconfigure({ url: 'https://chatgpt.com/?temporary-chat=true' });
    toggle('Turn off temporary chat', false);
    expect(api.temporaryChatReady()).toBe(false);
  });
  it('rejects a hidden toolbar or a glyph quoted in assistant content', () => {
    const control = toggle('arbitrary', true);
    control.hidden = true;
    expect(api.temporaryChatReady()).toBe(false);
    control.hidden = false;
    const authored = document.createElement('div'); authored.setAttribute('data-message-author-role', 'assistant');
    document.body.append(authored); authored.append(control);
    expect(api.temporaryChatReady()).toBe(false);
  });
});


describe('locale-independent provider composer evidence', () => {
  it.each([['ja', '送信', '回答を停止'], ['ar', 'إرسال', 'إيقاف الإجابة']])('uses provider Send and Stop identities in %s', (language, sendLabel, stopLabel) => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    button.setAttribute('aria-label', sendLabel);
    button.textContent = sendLabel;
    expect(api.sendButton()).toBe(button);
    expect(api.generating()).toBe(false);
    button.dataset.testid = 'stop-button';
    button.id = 'composer-submit-button';
    button.setAttribute('aria-label', stopLabel);
    expect(api.sendButton()).toBeNull();
    expect(api.generating()).toBe(true);
    expect(api.stopGeneration(() => true)).toBe(true);
  });

  it.each([['ja', '音声入力'], ['ar', 'إملاء']])('anchors to the provider microphone glyph in %s', (language, label) => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    button.removeAttribute('data-testid'); button.setAttribute('aria-label', label);
    button.id = 'composer-submit-button';
    button.innerHTML = '<svg><use href="#microphone-regular-24"></use></svg>';
    const trailing = button.parentElement!;
    // The observed grid area survives even when no test id names its action row.
    trailing.removeAttribute('data-testid'); trailing.className = '[grid-area:trailing]';
    expect(api.composerActions()).toEqual({ host: trailing, before: button });
    expect(api.sendButton()).toBeNull();
    expect(api.generating()).toBe(false);
    expect(api.stopGeneration(() => true)).toBe(false);
  });

  it('does not anchor to a microphone glyph in prose or an unrelated composer control', () => {
    button.parentElement!.removeAttribute('data-testid');
    button.removeAttribute('data-testid'); button.removeAttribute('aria-label');
    button.innerHTML = '<svg><use href="#microphone-regular-24"></use></svg>';
    const quote = document.createElement('section'); quote.setAttribute('data-testid', 'conversation-turn-1');
    quote.innerHTML = '<button><svg><use href="#microphone-regular-24"></use></svg></button>';
    document.body.prepend(quote);
    expect(api.composerActions()).toBeNull();
    expect(api.sendButton()).toBeNull();
    expect(api.generating()).toBe(false);
  });

  it.each(['画像.webp', 'صورة.webp'])('recognizes the provider attachment group independently of translated removal labels (%s)', name => {
    const group = document.createElement('div'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', name);
    group.innerHTML = '<div data-default-action="true"><button type="button">開く</button></div><button aria-label="削除" type="button">×</button>';
    document.querySelector('form')!.append(group);
    expect(api.hasComposerAttachments()).toBe(true);
    group.querySelector('[data-default-action]')!.removeAttribute('data-default-action');
    expect(api.hasComposerAttachments()).toBe(false);
    group.firstElementChild!.setAttribute('data-default-action', 'true');
    group.append(group.lastElementChild!.cloneNode(true));
    expect(api.hasComposerAttachments()).toBe(false);
  });

  it.each(['画像を編集', '分享此图片'])('keeps a localized generated-output action beside a hidden duplicate tool row (%s)', actionLabel => {
    const section = document.createElement('section');
    section.setAttribute('data-testid', 'conversation-turn-output-action');
    section.setAttribute('data-turn', 'assistant');
    section.setAttribute('data-turn-id', 'output-action');
    const layout = document.createElement('div');
    const branch = document.createElement('div');
    const tool = document.createElement('span'); tool.className = 'tool-message'; tool.textContent = 'Called image tool';
    const disclosure = document.createElement('button'); disclosure.setAttribute('aria-label', 'Called image tool');
    const action = document.createElement('button'); action.setAttribute('aria-label', actionLabel);
    branch.append(tool, disclosure, action); layout.append(branch); section.append(layout); document.body.append(section);

    const turn = api.turns().find(item => item.id === 'output-action')!;
    const blocks = api.toolBlocks(turn);
    expect(blocks).toEqual([tool]);
    api.hideActivity(turn, blocks);
    expect(tool.getAttribute('data-clf-native-hidden')).toBe('1');
    expect(disclosure.getAttribute('data-clf-native-hidden')).toBe('1');
    expect(action.closest('[data-clf-native-hidden]')).toBeNull();
  });
});
