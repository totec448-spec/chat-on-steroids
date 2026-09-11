import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
interface DomApi {
  insertPrompt(text: string, mode?: boolean | 'append', failure?: (reason: string) => void): boolean;
  enterProject(entry: { id: string; sourceConversationId: string }, current?: () => boolean): Promise<boolean>;
  composerActions(): { host: HTMLElement; before: HTMLElement | null } | null;
  generating(): boolean;
  sendButton(): HTMLButtonElement | null;
  temporaryChatReady(): boolean;
  errors(): Array<{ text: string; recoverable: boolean; blocking?: boolean }>;
  captureComposerDraft(text: string, current?: () => boolean): { current(): boolean; clear(): Promise<boolean>; dispose(): void; attachments(nodes: Element[]): void };
  visibleModelSelection(): { model: string; reasoningEffort?: string } | null;
  hasComposerAttachments(): boolean;
  stopGeneration(current: () => boolean): boolean;
  inspectModelSettings(current?: () => boolean, failure?: (reason: string) => void): Promise<Array<{id: string; label: string; efforts: string[]}> | null>;
  send(options?: { acceptanceTimeoutMs?: number; stillCurrent?: () => boolean; beforeSend?: () => Promise<boolean> }): Promise<boolean>;
  selectModelSettings(model: string | null, effort: string | null, current?: () => boolean): Promise<boolean>;
  uploadImages(images: Array<{ name: string; dataUrl: string }>, current?: () => boolean, draft?: ReturnType<DomApi['captureComposerDraft']>, files?: File[]): Promise<boolean>;
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

describe('native Project entry readiness', () => {
  const entry = { id: 'g-p-11111111222233334444555555555555', sourceConversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
  const projectUrl = `https://chatgpt.com/g/${entry.id}-example/project`;
  function sourceLink() {
    dom.reconfigure({ url: `https://chatgpt.com/c/${entry.sourceConversationId}` });
    const header = document.createElement('header');
    header.innerHTML = `<a href="${projectUrl}"><span data-testid="project-folder-icon"></span>Project</a>`;
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

  it.each(['missing', 'draft', 'cancelled', 'foreign-route'])('never clicks an unready or retired source: %s', async reason => {
    const link = sourceLink();
    box.textContent = reason === 'draft' ? 'Keep my draft' : '';
    box.remove();
    let current = true;
    const clicks = vi.fn((event: Event) => event.preventDefault());
    link.addEventListener('click', clicks);
    const entered = api.enterProject(entry, () => current);
    if (reason === 'cancelled') current = false;
    if (reason === 'foreign-route') dom.reconfigure({ url: 'https://chatgpt.com/c/bbbbbbbb-1111-4222-8333-444444444444' });
    if (reason !== 'missing') document.querySelector('form')!.prepend(box);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await entered).toBe(false);
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
  it.each(['Temporären Chat ausschalten', '一時チャットをオフにする', 'Turn off temporary chat', ''])('reads the checked glyph with arbitrary label %s', label => {
    toggle(label, true);
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
});
