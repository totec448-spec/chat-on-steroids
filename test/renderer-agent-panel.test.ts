import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgentPanel } from '../src/renderer/agent-panel.js';
import type { SessionSummary } from '../src/shared/session.js';

let dom: JSDOM;
afterEach(() => dom?.window.close());
it('keeps Prime selection independent and rejects late results after parent navigation', async () => {
  dom = new JSDOM('<main></main><button></button>');
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!;
  const toggle = document.querySelector('button')!;
  let resolve!: (value: { events: [] }) => void;
  const load = vi.fn(() => new Promise<{ events: [] }>(done => { resolve = done; }));
  const render = vi.fn(() => [document.createElement('article')]);
  const openMain = vi.fn();
  const panel = createAgentPanel({ host, toggle, load, render, openMain, working: () => false });
  const worker = { id: 'worker-session', title: 'Worker', updatedAt: 1 } as SessionSummary;
  panel.update('prime-session', [worker]); toggle.click();
  expect(host.textContent).toContain('History · 1');
  const opening = panel.open(worker.id);
  expect(openMain).not.toHaveBeenCalled();
  panel.update('another-prime', []);
  resolve({ events: [] }); await opening;
  expect(render).not.toHaveBeenCalled();
  expect(host.querySelector('aside')!.hidden).toBe(true);
  await panel.open(worker.id);
  expect(load).toHaveBeenCalledTimes(1);
});

it('renders a selected worker and offers an explicit full-chat navigation', async () => {
  dom = new JSDOM('<main></main><button></button>');
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!, toggle = document.querySelector('button')!;
  const openMain = vi.fn();
  const panel = createAgentPanel({ host, toggle, load: async () => ({ events: [] }),
    render: () => { const p = document.createElement('p'); p.textContent = 'Recorded response'; return [p]; }, openMain, working: () => true });
  panel.update('prime', [{ id: 'worker', title: 'Worker', updatedAt: 1 } as SessionSummary]);
  await panel.open('worker');
  expect(host.textContent).toContain('Recorded response');
  expect(openMain).not.toHaveBeenCalled();
  [...host.querySelectorAll('button')].find(button => button.textContent === 'Open full chat')!.click();
  expect(openMain).toHaveBeenCalledWith('worker');
  expect(host.querySelector('aside')!.hidden).toBe(true);
});

it('preserves a readers scroll position during refresh and Escape returns focus', async () => {
  dom = new JSDOM('<main></main><button></button>', { pretendToBeVisual: true });
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!, toggle = document.querySelector('button')!;
  let resolve!: (value: { events: [] }) => void;
  const load = vi.fn().mockResolvedValueOnce({ events: [] }).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const panel = createAgentPanel({ host, toggle, load, render: () => [document.createElement('article')], openMain: vi.fn(), working: () => false });
  const worker = { id: 'worker', title: 'Worker', updatedAt: 1 } as SessionSummary;
  panel.update('prime', [worker]); await panel.open(worker.id);
  const body = host.querySelector<HTMLElement>('.agent-panel-body')!;
  Object.defineProperties(body, { scrollHeight: { value: 1000 }, clientHeight: { value: 100 } });
  body.scrollTop = 250;
  const article = body.querySelector('article');
  panel.update('prime', [{ ...worker, updatedAt: 2 }]);
  expect(body.querySelector('article')).toBe(article);
  resolve({ events: [] }); await Promise.resolve(); await Promise.resolve();
  expect(body.scrollTop).toBe(250);
  body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(host.querySelector('aside')!.hidden).toBe(true);
  expect(document.activeElement).toBe(toggle);
});
