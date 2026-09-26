/**
 * Focused composer-state regressions adapted from Maximapple's public PRs
 * #405, #418 and #422. The production adaptation remains intentionally
 * stricter: only one rendered native primary control may supply authority.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const THREAD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SLOT = 'cursor-interaction size-token-button-composer flex items-center justify-center rounded-full bg-composer-primary p-0.5';
const STOP_PATH = 'M4.5 5.75C4.5 5.05964 5.05964 4.5 5.75 4.5H14.25C14.9404 4.5 15.5 5.05964 15.5 5.75V14.25C15.5 14.9404 14.9404 15.5 14.25 15.5H5.75C5.05964 15.5 4.5 14.9404 4.5 14.25V5.75Z';

interface DomApi {
  generating(): boolean;
  stopButton(): HTMLButtonElement | null;
  sendButton(): HTMLButtonElement | null;
  composerSubmitReady(): boolean;
}

let page: JSDOM | undefined;
afterEach(() => page?.window.close());

function fixture({ draft = '', running = false, controls = '' } = {}) {
  const pathname = `/c/${THREAD}`;
  page = new JSDOM(`<main data-app-shell-main-surface>
    <div data-thread-find-target="conversation"><div data-turn-key="turn-one"${running ? ` data-clf-shell-running="${pathname}"` : ''}></div></div>
    <form data-chatgpt-composer><div id="prompt-textarea" contenteditable="true" role="textbox">${draft}</div>${controls}</form>
  </main>`, { url: `https://chatgpt.com${pathname}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = page.window;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{}]; } });
  win.eval(source);
  return { doc: win.document, api: (win as unknown as { CLF_DOM: DomApi }).CLF_DOM };
}

const voice = () => `<button type="button" class="${SLOT}" aria-label="Sesli iletisimi baslat" data-state="closed">
  <svg><path d="M10 2.5v6"></path><path d="M6 6v2"></path><path d="M14 6v2"></path><path d="M10 12v5"></path></svg></button>`;
const stop = () => `<button type="button" class="${SLOT}" aria-label="Durdur"><svg><path d="${STOP_PATH}"></path></svg></button>`;
const send = () => `<button type="button" class="${SLOT}" aria-label="Gönder"><svg><path d="M5 10h10"></path><path d="M11 6l4 4-4 4"></path></svg></button>`;

describe('composer native state is locale-free and unique', () => {
  it('recognizes the translated Stop square without trusting its label', () => {
    const { api } = fixture({ controls: stop() });
    expect(api.generating()).toBe(true);
    expect(api.stopButton()?.getAttribute('aria-label')).toBe('Durdur');
    expect(api.sendButton()).toBeNull();
  });

  it('recognizes the translated Send slot with drafted text', () => {
    const { api } = fixture({ draft: 'Exact app prompt', controls: send() });
    expect(api.generating()).toBe(false);
    expect(api.sendButton()?.getAttribute('aria-label')).toBe('Gönder');
    expect(api.stopButton()).toBeNull();
  });

  it('lets a unique rendered voice control disprove stale React in_progress', () => {
    const { api } = fixture({ running: true, controls: voice() });
    expect(api.generating()).toBe(false);
    expect(api.composerSubmitReady()).toBe(true);
    expect(api.stopButton()).toBeNull();
    expect(api.sendButton()).toBeNull();
  });
  it('does not let a legacy or secondary labelled Send cancel exact current shell work', () => {
    const { api } = fixture({ running: true, controls: '<button type="submit" aria-label="Send message">Send</button>' });
    expect(api.generating()).toBe(true);
    expect(api.composerSubmitReady()).toBe(false);
  });
  it('retains the classic exact Stop while its sibling Send stays mounted', () => {
    const { api } = fixture({ controls: '<button type="submit" data-testid="send-button"></button><button data-testid="stop-button"></button>' });
    expect(api.generating()).toBe(true);
    expect(api.stopButton()?.getAttribute('data-testid')).toBe('stop-button');
    expect(api.sendButton()).toBeNull();
  });

  it.each([
    ['unknown', `<button type="button" class="${SLOT}" aria-label="Bilinmeyen"><svg><path d="M1 1h2"></path><path d="M2 2h2"></path><path d="M3 3h2"></path></svg></button>`],
    ['ambiguous', voice() + send()],
    ['unknown-data-state', `<button type="button" class="${SLOT}" data-state="closed"><svg><path d="M1 1h2"></path></svg></button>`]
  ])('does not authorize input from a %s primary-control state', (_kind, controls) => {
    const { api } = fixture({ controls });
    expect(api.composerSubmitReady()).toBe(false);
    expect(api.stopButton()).toBeNull();
    expect(api.sendButton()).toBeNull();
  });
});
