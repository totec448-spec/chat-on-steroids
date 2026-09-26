import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it } from 'vitest';

const source = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const THREAD = '6ab792f5-a100-83ed-99c4-196a7ccfa267';
let dom: JSDOM;
afterEach(() => dom?.window.close());

function load(main: string, url = `https://chatgpt.com/c/${THREAD}`) {
  dom = new JSDOM(`<div id="root"><nav><button>Neuer Chat</button><button>Suchen</button></nav>
    <div data-app-shell-focus-area="main">${main}</div></div>`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{ width: 10, height: 10 }]; } });
  dom.window.eval(source);
  return (dom.window as unknown as { CLF_DOM: { conversationLoadFailure(): HTMLButtonElement | null } }).CLF_DOM;
}

// The surface as measured 2026-09-26 (de-DE), classes trimmed.
const FAILED = `<div class="relative h-full min-h-0"><div class="flex w-full flex-col items-center justify-center px-3 py-6">
  <div class="flex w-full max-w-xl flex-col items-center justify-center text-center gap-3">
    <div class="flex flex-col items-center gap-2"><div class="text-lg">Dieses ChatGPT-Gespräch konnte nicht geladen werden</div></div>
    <div class="flex w-full flex-wrap items-center justify-center gap-2"><button type="button" id="retry">Erneut versuchen</button></div>
  </div></div></div>`;

it('recognises the could-not-load surface by structure, whatever its language', () => {
  expect(load(FAILED).conversationLoadFailure()?.id).toBe('retry');
  expect(load(FAILED.replace('Dieses ChatGPT-Gespräch konnte nicht geladen werden', '无法加载此对话').replace('Erneut versuchen', '重试'))
    .conversationLoadFailure()?.id).toBe('retry');
});

it('leaves a loaded chat, a mounting shell and a new chat alone', () => {
  expect(load(`<div data-turn-key="t1">hello</div>${FAILED}`).conversationLoadFailure()).toBeNull();
  expect(load(`<form data-chatgpt-composer><div contenteditable="true" role="textbox"></div></form>`).conversationLoadFailure()).toBeNull();
  // Mounting: empty, or a skeleton with no control at all.
  expect(load('').conversationLoadFailure()).toBeNull();
  expect(load('<div class="skeleton">Loading</div>').conversationLoadFailure()).toBeNull();
  // Two controls is some other surface; a guess is worse than waiting.
  expect(load(FAILED.replace('</button>', '</button><button>Neuer Chat</button>')).conversationLoadFailure()).toBeNull();
  expect(load(FAILED, 'https://chatgpt.com/').conversationLoadFailure()).toBeNull();
  expect(load(FAILED.replace('<button type="button"', '<button type="button" disabled')).conversationLoadFailure()).toBeNull();
});
