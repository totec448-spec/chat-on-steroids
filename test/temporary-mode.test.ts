import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it } from 'vitest';

const fiberSource = readFileSync(new URL('../extension/fiber.js', import.meta.url), 'utf8');
const domSource = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
let page: JSDOM;
afterEach(() => page?.window.close());

/**
 * The newer shell's header toggle, as measured on 2026-09-26: inline SVG paths (no
 * `#chat-temp-checked` sprite), a translated label, and `isTemporaryChat` a few Fibers up.
 */
function load(state: boolean | null, url = 'https://chatgpt.com/?temporary-chat=true') {
  page = new JSDOM(`<div id="root"><nav><button id="side">New chat</button></nav><header>
    <button id="toggle" aria-label="Turn off temporary chat"><svg><path d="M11.957 7.40698"></path></svg></button></header>
    <main></main></div>`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = page.window;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{ width: 10, height: 10 }]; } });
  win.postMessage = (data: unknown) => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { data, source: win as any, origin: win.location.origin })));
  const owner = { memoizedProps: state === null ? { children: [] } : { isTemporaryChat: state, children: [] }, return: null };
  const host = { memoizedProps: { 'aria-label': 'Turn off temporary chat' }, return: { memoizedProps: {}, return: owner } };
  (win.document.getElementById('toggle') as any).__reactFiber$test = host;
  win.eval(fiberSource); win.eval(domSource);
  const scan = () => new Promise<void>((resolve) => {
    const nonce = `temp-${Math.random()}`;
    const receive = (event: MessageEvent) => {
      if (event.data?.source === 'clf-fiber-reply' && event.data.nonce === nonce) { win.removeEventListener('message', receive as any); resolve(); }
    };
    win.addEventListener('message', receive as any);
    win.postMessage({ source: 'clf-fiber-ask', nonce }, win.location.origin);
  });
  return { api: (win as any).CLF_DOM as { temporaryChatReady(): boolean }, win, scan };
}

it('proves an empty temporary chat from the toggle owner state, with no sprite and any label', async () => {
  const { api, scan } = load(true);
  expect(api.temporaryChatReady(), 'nothing scanned yet').toBe(false);
  await scan();
  expect(api.temporaryChatReady()).toBe(true);
});

it('does not claim the mode when React says it is off or says nothing', async () => {
  for (const state of [false, null] as const) {
    const { api, scan } = load(state);
    await scan();
    expect(api.temporaryChatReady(), `state ${state}`).toBe(false);
  }
});

it('drops the stamp when the page leaves that route', async () => {
  const { api, scan, win } = load(true);
  await scan();
  expect(api.temporaryChatReady()).toBe(true);
  page.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
  expect(api.temporaryChatReady(), 'a stamp from another route answered for this one').toBe(false);
  expect(win.document.documentElement.getAttribute('data-clf-temporary-page')).toBe('/');
});
