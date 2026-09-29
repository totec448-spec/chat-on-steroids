import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { enableTabReorder, reorderKey } from '../src/renderer/tab-reorder.js';

let dom: JSDOM;
afterEach(() => dom?.window.close());

function strip(keys: string[]) {
  dom = new JSDOM(`<div class="strip">${keys.map(key => `<div class="tab" data-key="${key}"><button class="btn">${key}</button><button class="btn btn-icon">x</button></div>`).join('')}</div>`);
  const window = dom.window, host = window.document.querySelector<HTMLElement>('.strip')!;
  // Tabs are 100px wide with 4px gaps.
  const place = () => [...host.children].forEach((node, index) => {
    (node as HTMLElement).getBoundingClientRect = () => ({ left: index * 104, right: index * 104 + 100, width: 100, top: 0, bottom: 28, height: 28 }) as DOMRect;
  });
  place();
  host.setPointerCapture = vi.fn(); host.hasPointerCapture = vi.fn(() => true); host.releasePointerCapture = vi.fn();
  const move = vi.fn((key: string, index: number) => {
    const node = host.querySelector(`[data-key="${key}"]`)!; node.remove();
    host.insertBefore(node, host.children[index] ?? null); place();
  });
  enableTabReorder(host, { item: '.tab', key: node => node.dataset.key, move });
  const pointer = (type: string, target: Element, clientX: number) => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX });
    Object.defineProperty(event, 'pointerId', { value: 3 }); target.dispatchEvent(event);
  };
  return { window, host, move, pointer };
}

it('moves a dragged tab to the slot under its centre and slides the neighbours aside', () => {
  const { host, move, pointer } = strip(['a', 'b', 'c']);
  const a = host.querySelector('[data-key=a] .btn')!;
  pointer('pointerdown', a, 50);
  pointer('pointermove', host, 53);
  expect(host.classList.contains('is-reordering')).toBe(false);
  pointer('pointermove', host, 170);
  expect(host.classList.contains('is-reordering')).toBe(true);
  expect(host.querySelector<HTMLElement>('[data-key=b]')!.style.transform).toBe('translateX(-104px)');
  expect(host.querySelector<HTMLElement>('[data-key=c]')!.style.transform).toBe('');
  pointer('pointerup', host, 170);
  expect(move).toHaveBeenCalledWith('a', 1);
  expect([...host.children].map(node => (node as HTMLElement).dataset.key)).toEqual(['b', 'a', 'c']);
  expect([...host.children].every(node => !(node as HTMLElement).style.transform)).toBe(true);
  expect(host.classList.contains('is-reordering')).toBe(false);
});

it('clamps a drag to the strip and does not start from the close control or a single tab', () => {
  const { host, move, pointer } = strip(['a', 'b', 'c']);
  pointer('pointerdown', host.querySelector('[data-key=a] .btn')!, 50);
  pointer('pointermove', host, 900);
  expect(host.querySelector<HTMLElement>('[data-key=a]')!.style.transform).toBe('translateX(208px)');
  pointer('pointerup', host, 900);
  expect(move).toHaveBeenLastCalledWith('a', 2);
  move.mockClear();
  pointer('pointerdown', host.querySelector('[data-key=b] .btn-icon')!, 50);
  pointer('pointermove', host, 300); pointer('pointerup', host, 300);
  expect(move).not.toHaveBeenCalled();
  const single = strip(['only']);
  single.pointer('pointerdown', single.host.querySelector('.btn')!, 50);
  single.pointer('pointermove', single.host, 300);
  expect(single.host.classList.contains('is-reordering')).toBe(false);
});

it('releasing where it started keeps the order', () => {
  const { host, move, pointer } = strip(['a', 'b']);
  pointer('pointerdown', host.querySelector('[data-key=b] .btn')!, 150);
  pointer('pointermove', host, 160); pointer('pointerup', host, 160);
  expect(move).not.toHaveBeenCalled();
});

it('maps Ctrl+Shift+Left/Right to one-place moves', () => {
  const key = (init: KeyboardEventInit) => reorderKey(new (new JSDOM('').window.KeyboardEvent)('keydown', init) as unknown as KeyboardEvent);
  expect(key({ key: 'ArrowLeft', ctrlKey: true, shiftKey: true })).toBe(-1);
  expect(key({ key: 'ArrowRight', ctrlKey: true, shiftKey: true })).toBe(1);
  expect(key({ key: 'ArrowRight', ctrlKey: true })).toBe(0);
  expect(key({ key: 'ArrowRight', ctrlKey: true, shiftKey: true, altKey: true })).toBe(0);
});
