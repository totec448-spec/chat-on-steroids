import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

// Branch in new chat (#482): ChatGPT's own action on one reply, chosen without its translated labels.
// Shapes measured on chatgpt.com 2026-10-17 (German page): an ellipsis "More actions" menu button,
// a Branch item with a branch icon opening a submenu [Work mode, New chat], told apart only by handler.
const domSource = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const fiberSource = readFileSync(new URL('../extension/fiber.js', import.meta.url), 'utf8');
let page: JSDOM;
afterEach(() => { page?.window.close(); });

const WORK = function () { return ['clicked', 'upsell', { source: 'work_mode_upsell', checkoutOriginProductExperience: 'work' }]; };
const NEW_CHAT = () => undefined;

function fixture(options: { items?: Array<(() => unknown) | null>; trigger?: boolean; branchItem?: boolean } = {}) {
  const { items = [WORK, NEW_CHAT], trigger = true, branchItem = true } = options;
  page = new JSDOM(`<main><section data-turn-key="turn-1">
      <div data-content-search-unit-key="a:user"><button aria-label="Nachricht kopieren">c</button></div>
      <button aria-haspopup="menu" aria-label="Antwort neu generieren"><svg><use href="/sprites.svg#arrows-clockwise-rotate-lg-light-16"></use></svg></button>
      ${trigger ? '<button aria-haspopup="menu" aria-label="Weitere Aktionen" id="more"><svg><use href="/sprites.svg#ellipsis-horizontal-light-16"></use></svg></button>' : ''}
    </section></main>`, { url: 'https://chatgpt.com/c/6ad337fe-47a4-83ed-a21f-c2e24d5829a4', runScripts: 'outside-only' });
  const win = page.window, doc = win.document;
  Object.defineProperty(win.HTMLElement.prototype, 'getClientRects', { value() { return this.isConnected && !this.hidden ? [{}] : []; } });
  win.postMessage = (data: unknown) => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { data, source: win as unknown as Window, origin: win.location.origin })));
  const chosen: string[] = [];
  const escapes = vi.fn();
  doc.addEventListener('keydown', event => { if (event.key === 'Escape') { escapes(); doc.querySelectorAll('[role="menu"]').forEach(menu => menu.remove()); } });
  doc.getElementById('more')?.addEventListener('click', () => {
    const menu = doc.createElement('div'); menu.setAttribute('role', 'menu');
    menu.innerHTML = `<div role="menuitem">heute, 10:56</div>${branchItem ? '<div role="menuitem" aria-haspopup="menu" aria-expanded="false" aria-controls="branch-sub" tabindex="0"><svg><use href="/sprites.svg#branch-light-16"></use></svg>Gespräch verzweigen<svg><use href="/sprites.svg#chevron-right-md-light-16"></use></svg></div>' : ''}`;
    doc.body.append(menu);
    const branch = menu.querySelector<HTMLElement>('[aria-haspopup="menu"]');
    branch?.addEventListener('keydown', event => {
      if (event.key !== 'ArrowRight' || doc.getElementById('branch-sub')) return;
      branch.setAttribute('aria-expanded', 'true');
      const sub = doc.createElement('div'); sub.setAttribute('role', 'menu'); sub.id = 'branch-sub';
      items.forEach((handler, index) => {
        const item = doc.createElement('div'); item.setAttribute('role', 'menuitem');
        item.textContent = ['In den Work-Modus verzweigen', 'In neuem Chat verzweigen', 'Noch etwas'][index]!;
        // The real handler sits a few React levels above the DOM node.
        (item as any).__reactFiber$fixture = { memoizedProps: { role: 'menuitem' }, return: { memoizedProps: {}, return: { memoizedProps: handler ? { onSelect: handler } : {}, return: null } } };
        item.addEventListener('click', () => chosen.push(item.textContent!));
        sub.append(item);
      });
      doc.body.append(sub);
    });
  });
  win.eval(fiberSource);
  win.eval(domSource);
  const turn = doc.querySelector('[data-turn-key]')!;
  return { api: (win as any).CLF_DOM, turn, chosen, escapes, doc };
}

it('chooses ChatGPT\'s Branch in new chat by its handler, never by its translated label', async () => {
  const f = fixture();
  expect(await f.api.branchInNewChat(f.turn)).toBe('clicked');
  expect(f.chosen).toEqual(['In neuem Chat verzweigen']);
  expect(f.escapes).not.toHaveBeenCalled();
});

it('takes the only branch entry on a plan without Work mode', async () => {
  const f = fixture({ items: [NEW_CHAT] });
  expect(await f.api.branchInNewChat(f.turn)).toBe('clicked');
  // Its label here reads like Work mode on purpose: only the handler decides.
  expect(f.chosen).toEqual(['In den Work-Modus verzweigen']);
});

it.each([
  ['the reply has no More actions menu', { trigger: false }],
  ['the menu has no Branch entry', { branchItem: false }],
  ['two entries could be the new chat', { items: [NEW_CHAT, NEW_CHAT] }],
  ['no entry has a readable handler', { items: [null, null] }],
  ['only Work mode is offered', { items: [WORK] }]
])('changes nothing and closes its menus when %s', async (_name, options) => {
  const f = fixture(options);
  expect(await f.api.branchInNewChat(f.turn)).toBe('branch_unavailable');
  expect(f.chosen).toEqual([]);
  expect(f.doc.querySelectorAll('[role="menu"]')).toHaveLength(0);
});

it('stops before choosing when the page is no longer the one it started on', async () => {
  const f = fixture();
  let current = true;
  f.doc.getElementById('more')!.addEventListener('click', () => { current = false; });
  expect(await f.api.branchInNewChat(f.turn, () => current)).toBe('branch_unavailable');
  expect(f.chosen).toEqual([]);
});
