import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';
import { hideSlidingPanel, showSlidingPanel } from '../src/renderer/panel-motion.js';

it('keeps an outgoing pane painted but logically hidden until its exit finishes', async () => {
  const dom = new JSDOM('<aside></aside>');
  const pane = dom.window.document.querySelector<HTMLElement>('aside')!;
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const cancel = vi.fn();
  pane.animate = vi.fn(() => ({ finished, cancel }) as unknown as Animation);

  hideSlidingPanel(pane, 'right');
  expect(pane.hidden).toBe(true);
  expect(pane.inert).toBe(true);
  expect(pane.classList.contains('is-closing')).toBe(true);
  expect(pane.animate).toHaveBeenCalledWith(expect.arrayContaining([
    expect.objectContaining({ transform: 'translateX(14px)' })
  ]), expect.objectContaining({ duration: 170 }));

  finish();
  await finished;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(pane.classList.contains('is-closing')).toBe(false);
  expect(cancel).toHaveBeenCalledOnce();
  dom.window.close();
});

it('cancels a pending exit when the same pane is reopened, without hiding it later', async () => {
  const dom = new JSDOM('<aside></aside>');
  const pane = dom.window.document.querySelector<HTMLElement>('aside')!;
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const cancel = vi.fn();
  pane.animate = vi.fn().mockReturnValueOnce({ finished, cancel }).mockReturnValue({ finished: Promise.resolve(), cancel: vi.fn() });

  hideSlidingPanel(pane, 'up');
  showSlidingPanel(pane, 'up');
  expect(cancel).toHaveBeenCalledOnce();
  expect(pane.hidden).toBe(false);
  expect(pane.inert).toBe(false);
  finish();
  await finished;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(pane.hidden).toBe(false);
  expect(pane.classList.contains('is-closing')).toBe(false);
  dom.window.close();
});

it('makes reduced-motion exits immediate', () => {
  const dom = new JSDOM('<aside></aside>');
  const pane = dom.window.document.querySelector<HTMLElement>('aside')!;
  dom.window.matchMedia = vi.fn(() => ({ matches: true }) as MediaQueryList);
  pane.animate = vi.fn();
  hideSlidingPanel(pane, 'right');
  expect(pane.hidden).toBe(true);
  expect(pane.classList.contains('is-closing')).toBe(false);
  expect(pane.animate).not.toHaveBeenCalled();
  dom.window.close();
});
