import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { createSidebarOrder } from '../src/renderer/sidebar-order.js';

let dom: JSDOM;
afterEach(() => dom?.window.close());

function fixture(saved?: string) {
  dom = new JSDOM('<div class="scroll"><div id="list"></div></div>', { url: 'https://local.test' });
  const w = dom.window;
  Object.assign(globalThis, { window: w, document: w.document });
  if (saved) w.localStorage.setItem('chat-on-steroids.sidebar-order', saved);
  const list = w.document.getElementById('list')!;
  list.setPointerCapture = vi.fn(); list.hasPointerCapture = () => false;
  let entries = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => ({ id, scope: index < 3 ? 'project' : '' }));
  const paint = vi.fn(() => {
    list.replaceChildren(...['project', ''].flatMap(scope => order.ordered(scope, entries.filter(row => row.scope === scope))).map((entry, index) => {
      const row = w.document.createElement('div'); row.dataset.id = entry.id; row.dataset.sortScope = entry.scope; row.tabIndex = 0;
      row.innerHTML = '<b>Title</b><button>Delete</button>';
      row.getClientRects = () => [{ top: index * 40, height: 40 }] as unknown as DOMRectList;
      row.getBoundingClientRect = () => ({ top: index * 40, height: 40 }) as DOMRect;
      return row;
    }));
  });
  const order = createSidebarOrder(list, () => entries, paint); paint();
  const row = (id: string) => [...list.children].find(node => (node as HTMLElement).dataset.id === id) as HTMLElement;
  const pointer = (target: Element | Window, type: string, y: number) => target.dispatchEvent(new w.MouseEvent(type, {
    bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: y,
  }));
  const drag = (id: string, y: number) => {
    pointer(row(id), 'pointerdown', row(id).getBoundingClientRect().top + 10);
    pointer(list, 'pointermove', y); pointer(w as unknown as Window, 'pointerup', y);
  };
  return { w, list, order, paint, row, pointer, drag,
    ids: (scope: string) => order.ordered(scope, entries.filter(row => row.scope === scope)).map(row => row.id),
    update: (next: typeof entries) => { entries = next; },
    saved: () => w.localStorage.getItem('chat-on-steroids.sidebar-order')!,
  };
}

it('moves a held chat two positions, clamps to its folder and persists across reload', () => {
  const f = fixture(); f.drag('a', 500);
  expect(f.ids('project')).toEqual(['b', 'c', 'a']);
  expect(f.ids('')).toEqual(['d', 'e', 'f']);
  const saved = f.saved(); f.w.close();
  const reloaded = fixture(saved);
  expect(reloaded.ids('project')).toEqual(['b', 'c', 'a']);
  reloaded.drag('a', -100);
  expect(reloaded.ids('project')).toEqual(['a', 'b', 'c']);
});

it('reorders unfiled chats without changing folder members and suppresses the drop click', () => {
  const f = fixture(); const click = vi.fn(); f.list.addEventListener('click', click);
  f.drag('f', -100);
  expect(f.ids('')).toEqual(['f', 'd', 'e']);
  expect(f.ids('project')).toEqual(['a', 'b', 'c']);
  f.row('f').click(); expect(click).not.toHaveBeenCalled();
});

it('keeps simple clicks and action buttons working and cancels Escape without saving', () => {
  const f = fixture(); const click = vi.fn(); f.list.addEventListener('click', click);
  f.pointer(f.row('b'), 'pointerdown', 50); f.pointer(f.w as unknown as Window, 'pointerup', 50);
  f.row('b').click(); expect(click).toHaveBeenCalledTimes(1);
  f.pointer(f.row('b').querySelector('button')!, 'pointerdown', 50);
  expect(f.order.interacting).toBe(false);
  f.pointer(f.row('b'), 'pointerdown', 50); f.pointer(f.list, 'pointermove', 300);
  expect(f.order.interacting).toBe(true);
  f.w.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Escape' }));
  expect(f.order.interacting).toBe(false); expect(f.ids('project')).toEqual(['a', 'b', 'c']);
  expect(f.saved()).toBeNull();
});

it('rejects a stale drag when the source is removed or changes folder during the gesture', () => {
  const f = fixture();
  f.pointer(f.row('a'), 'pointerdown', 10); f.pointer(f.list, 'pointermove', 300);
  f.update([{ id: 'a', scope: '' }, { id: 'b', scope: 'project' }, { id: 'c', scope: 'project' }]);
  f.pointer(f.w as unknown as Window, 'pointerup', 300);
  expect(f.saved()).toBeNull(); expect(f.ids('project')).toEqual(['b', 'c']);
});

it('retains off-page order and manual order across activity refreshes, while new chats appear first', () => {
  const f = fixture(); f.drag('a', 110);
  f.update([{ id: 'a', scope: 'project' }, { id: 'c', scope: 'project' }]); f.paint();
  f.drag('a', -50);
  f.update(['new', 'c', 'a', 'b'].map(id => ({ id, scope: 'project' })));
  expect(f.ids('project')).toEqual(['new', 'b', 'a', 'c']);
});

it('supports keyboard movement, preserves focus and tolerates corrupt preferences', () => {
  const f = fixture('{broken');
  f.row('b').dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }));
  expect(f.ids('project')).toEqual(['b', 'a', 'c']);
  expect(f.w.document.activeElement).toBe(f.row('b'));
});
