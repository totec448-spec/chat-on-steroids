import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';
import { moveWorkDock } from '../src/renderer/panel-motion.js';

function dockFixture(tracks: string[], property: 'gridTemplateColumns' | 'gridTemplateRows' = 'gridTemplateColumns') {
  const dom = new JSDOM('<main><section class="card is-session"></section><aside hidden></aside></main>');
  const window = dom.window, host = window.document.querySelector<HTMLElement>('main')!;
  const pane = window.document.querySelector<HTMLElement>('aside')!, chat = window.document.querySelector<HTMLElement>('section')!;
  const queue = [...tracks];
  window.getComputedStyle = vi.fn(() => ({ [property]: queue.shift() ?? tracks.at(-1) }) as unknown as CSSStyleDeclaration);
  host.getClientRects = () => [{}] as unknown as DOMRectList;
  const runs: Array<{ keyframes: Keyframe[]; finish: () => void; cancel: ReturnType<typeof vi.fn> }> = [];
  host.animate = vi.fn((keyframes: Keyframe[]) => {
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const run = { keyframes, finish, cancel: vi.fn() }; runs.push(run);
    return { finished, cancel: run.cancel } as unknown as Animation;
  });
  chat.animate = vi.fn(() => ({ finished: Promise.resolve(), cancel: vi.fn() }) as unknown as Animation);
  return { dom, host, pane, chat, runs };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

it('slides the right dock between resolved pixel tracks with its content at resting width', async () => {
  const { dom, host, pane, runs } = dockFixture(['1171px 0px', '679px 492px']);
  const settled = vi.fn();
  moveWorkDock(host, pane, () => { pane.hidden = false; host.classList.add('has-work-dock'); }, settled);
  expect(runs[0]!.keyframes).toEqual([{ gridTemplateColumns: '1171px 0px' }, { gridTemplateColumns: '679px 492px' }]);
  expect(pane.classList.contains('is-sliding')).toBe(true);
  expect(pane.style.getPropertyValue('--work-dock-motion-size')).toBe('492px');
  expect(settled).not.toHaveBeenCalled();
  runs[0]!.finish(); await flush();
  expect(pane.classList.contains('is-moving')).toBe(false);
  expect(pane.style.getPropertyValue('--work-dock-motion-size')).toBe('');
  expect(settled).toHaveBeenCalledOnce();
  dom.window.close();
});

it('keeps a closing dock painted until its exit ends, and a reopen continues from the current frame', async () => {
  const { dom, host, pane, runs } = dockFixture(['679px 492px', '1171px 0px', '900px 271px', '679px 492px']);
  pane.hidden = false;
  const retired = vi.fn();
  moveWorkDock(host, pane, () => { pane.hidden = true; }, retired);
  expect(pane.hidden).toBe(true); expect(pane.inert).toBe(true);
  expect(pane.classList.contains('is-closing')).toBe(true);
  moveWorkDock(host, pane, () => { pane.hidden = false; });
  expect(runs[0]!.cancel).toHaveBeenCalled();
  expect(retired).toHaveBeenCalledOnce();
  expect(runs[1]!.keyframes[0]).toEqual({ gridTemplateColumns: '900px 271px' });
  expect(pane.classList.contains('is-closing')).toBe(false);
  expect(pane.style.getPropertyValue('--work-dock-motion-size')).toBe('492px');
  dom.window.close();
});

it('hands the width between chat and dock on expand without squeezing the chat', () => {
  const { dom, host, pane, chat } = dockFixture(['679px 492px', '0px 1171px']);
  pane.hidden = false;
  moveWorkDock(host, pane, () => host.classList.add('is-work-dock-expanded'));
  expect(host.classList.contains('is-dock-handover')).toBe(true);
  expect(host.style.getPropertyValue('--chat-motion-width')).toBe('679px');
  expect(pane.classList.contains('is-sliding')).toBe(false);
  expect(chat.animate).toHaveBeenCalledWith([{ opacity: 1 }, { opacity: 0 }], expect.anything());
  dom.window.close();
});

it('changes the dock layout immediately under reduced motion', () => {
  const { dom, host, pane, runs } = dockFixture(['1171px 0px', '679px 492px']);
  dom.window.matchMedia = vi.fn(() => ({ matches: true }) as MediaQueryList);
  const settled = vi.fn();
  moveWorkDock(host, pane, () => { pane.hidden = false; }, settled);
  expect(runs).toHaveLength(0); expect(settled).toHaveBeenCalledOnce();
  expect(pane.classList.contains('is-moving')).toBe(false);
  dom.window.close();
});

it('raises the bottom dock from a track that exists only while it is open', async () => {
  const { dom, host, pane, runs } = dockFixture(['28px 40px 0px 832px', '28px 40px 0px 582px 250px', '28px 40px 0px 582px 250px', '28px 40px 0px 832px'], 'gridTemplateRows');
  const hidden = vi.fn();
  moveWorkDock(host, pane, () => { pane.hidden = false; }, undefined, 'y');
  expect(runs[0]!.keyframes).toEqual([{ gridTemplateRows: '28px 40px 0px 832px 0px' }, { gridTemplateRows: '28px 40px 0px 582px 250px' }]);
  expect(pane.style.getPropertyValue('--work-dock-motion-size')).toBe('250px');
  runs[0]!.finish(); await flush();
  expect(pane.classList.contains('is-sliding')).toBe(false);
  moveWorkDock(host, pane, () => { pane.hidden = true; }, hidden, 'y');
  expect(pane.classList.contains('is-closing')).toBe(true);
  expect(hidden).not.toHaveBeenCalled();
  runs[1]!.finish(); await flush();
  expect(pane.classList.contains('is-closing')).toBe(false);
  expect(hidden).toHaveBeenCalledOnce();
  dom.window.close();
});
