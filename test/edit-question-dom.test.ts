import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it } from 'vitest';

// Edit & resubmit (#365): ChatGPT's own editor on one question, opened without its translated labels.
// Shapes measured on chatgpt.com 2026-10-17 (German page): the question's turn is [data-turn-key=<id>];
// its Edit button's handler carries action:"edit" on surface "user_message"; pressing it puts a
// ProseMirror editor in a form with Cancel (type=button) and Send (type=submit) into that turn.
const domSource = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const fiberSource = readFileSync(new URL('../extension/fiber.js', import.meta.url), 'utf8');
const QUESTION = '6ad3a59b-1111-83eb-8bc4-8c84e68dd911';
let page: JSDOM;
afterEach(() => { page?.window.close(); });

const EDIT = function () { return { action: 'edit', eventKind: 'action', metadata: { surface: 'user_message' } }; };
const COPY = function () { return { action: 'copy', metadata: { surface: 'user_message' } }; };

function fixture(options: { handlers?: Array<() => unknown>; turnKey?: string } = {}) {
  const { handlers = [COPY, EDIT], turnKey = QUESTION } = options;
  page = new JSDOM(`<main><section data-turn-key="${turnKey}"><div>Fix the logn bug</div><div class="actions"></div></section>
    <section data-turn-key="other"><button id="other-edit">Bearbeiten</button></section></main>`,
  { url: 'https://chatgpt.com/c/6ad3a59b-2454-83eb-8bc4-8c84e68dd911', runScripts: 'outside-only' });
  const win = page.window, doc = win.document;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return this.isConnected && !this.hidden ? [{}] : []; } });
  win.postMessage = (data: unknown) => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { data, source: win as unknown as Window, origin: win.location.origin })));
  // ChatGPT's editor takes the native insertion into its own paragraph.
  (doc as any).execCommand = (command: string, _ui: boolean, html: string) => {
    const box = doc.activeElement as HTMLElement;
    if (command !== 'insertHTML' || !box?.isContentEditable && box?.getAttribute('contenteditable') !== 'true') return false;
    box.innerHTML = html; return true;
  };
  const turn = doc.querySelector('section')!;
  const events: string[] = [];
  handlers.forEach((handler, index) => {
    const button = doc.createElement('button'); button.textContent = ['Kopieren', 'Bearbeiten', 'Noch einer'][index]!;
    (button as any).__reactFiber$fixture = { memoizedProps: { onClick: handler }, return: null };
    if (handler === EDIT) button.addEventListener('click', () => {
      const form = doc.createElement('form');
      form.innerHTML = '<div class="ProseMirror" contenteditable="true"><p>Fix the logn bug</p></div><button type="button">Abbrechen</button><button type="submit">Senden</button>';
      form.querySelector('[type=button]')!.addEventListener('click', () => { events.push('cancel'); form.remove(); });
      form.querySelector('[type=submit]')!.addEventListener('click', () => events.push(`submit:${form.querySelector('.ProseMirror')!.textContent}`));
      turn.append(form);
    });
    turn.querySelector('.actions')!.append(button);
  });
  win.eval(fiberSource);
  win.eval(domSource);
  return { api: (win as any).CLF_DOM, doc, events };
}

it('opens ChatGPT\'s editor on the question by its handler, writes the new text and resubmits it', async () => {
  const f = fixture();
  const edit = await f.api.openQuestionEdit(QUESTION);
  expect(edit.failure).toBeUndefined();
  expect(edit.current()).toBe(true);
  expect(edit.write('Fix the login bug')).toBe(true);
  expect(edit.submit()).toBe(true);
  expect(f.events).toEqual(['submit:Fix the login bug']);
});

it('closes the editor without sending when the edit is given up', async () => {
  const f = fixture();
  const edit = await f.api.openQuestionEdit(QUESTION);
  edit.cancel();
  expect(f.events).toEqual(['cancel']);
  expect(f.doc.querySelector('.ProseMirror')).toBeNull();
});

it.each([
  ['the question is not on the page', { turnKey: 'another-question' }, 'edit_message_missing'],
  ['the question has no Edit control', { handlers: [COPY] }, 'edit_unavailable'],
  ['two controls could be Edit', { handlers: [EDIT, EDIT] }, 'edit_unavailable']
] as const)('changes nothing when %s', async (_name, options, failure) => {
  const f = fixture(options as any);
  expect((await f.api.openQuestionEdit(QUESTION)).failure).toBe(failure);
  expect(f.doc.querySelector('.ProseMirror')).toBeNull();
});

it('stops before pressing anything when the page is no longer the one it started on', async () => {
  const f = fixture();
  expect((await f.api.openQuestionEdit(QUESTION, () => false)).failure).toBe('edit_unavailable');
  expect(f.doc.querySelector('.ProseMirror')).toBeNull();
});
