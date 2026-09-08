import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
let popup: JSDOM | undefined;
afterEach(() => { popup?.window.close(); });

function openPopup(reload: () => void) {
  popup = new JSDOM(html, { url: 'https://extension-popup.test/', runScripts: 'outside-only' });
  const unavailable = () => new Promise(() => undefined);
  Object.assign(popup.window, {
    chrome: { runtime: { reload, sendMessage: unavailable }, storage: { local: { get: unavailable } } },
    setInterval: () => 0
  });
  popup.window.eval(script);
  return popup.window.document;
}

it('reloads only on explicit click even when the worker is unavailable', () => {
  const reload = vi.fn();
  const document = openPopup(reload);
  expect(reload).not.toHaveBeenCalled();
  document.getElementById('reloadBtn')!.click();
  expect(reload).toHaveBeenCalledTimes(1);
});

it('reports only app reachability from compatible health and pairing', () => {
  const document = openPopup(vi.fn());
  expect(document.getElementById('pill')!.classList.contains('off')).toBe(true);
  (popup!.window as any).paintHeader({ connected: true, paired: true, port: 8765 });
  expect(document.getElementById('state')!.textContent).not.toContain('Connected');
  (popup!.window as any).paintHeader({ connected: true, paired: true, compatible: true, port: 8765 });
  expect(document.getElementById('state')!.textContent).toBe('App reachable · Port 8765');
  expect(document.getElementById('state')!.textContent).not.toContain('Connected');
  (popup!.window as any).paintHeader({ connected: false });
  expect(document.getElementById('state')!.textContent).toBe('App not reachable');
});

it('explains manual mismatch recovery with both versions and keeps reload available', () => {
  const document = openPopup(vi.fn());
  (popup!.window as any).paintAlert({ connected: true, paired: true, compatible: false, appVersion: '2.0.7', appProtocol: 13, extensionVersion: '2.0.6', extensionProtocol: 12 }, null);
  const alert = document.getElementById('alert')!;
  expect(alert.textContent).toContain('2.0.7'); expect(alert.textContent).toContain('2.0.6');
  expect(alert.textContent).toContain('protocol 13'); expect(alert.textContent).toContain('protocol 12');
  expect(alert.textContent).toContain('Developer mode'); expect(alert.textContent).toContain('Open extension folder');
  expect(document.getElementById('reloadBtn')).not.toBeNull();
});

it('requires this chat session receipt before claiming delivery even with global delivery success', () => {
  openPopup(vi.fn());
  const info = { isChat: true, recorder: true, page: { events: 3 }, pending: 0, delivery: { ok: true, total: 50 } };
  const waiting = (popup!.window as any).pipeline(info, true);
  expect(waiting.sent[0]).toBe('running');
  expect(waiting.proc[0]).toBe('running');
  expect(waiting.why[1]).toContain('this chat’s session receipt');
  const recorded = (popup!.window as any).pipeline({ ...info, page: { events: 3, session: 'local-session' } }, true);
  expect(recorded.sent[0]).toBe('done');
  expect(recorded.proc[0]).toBe('done');
});

it('keeps blocked delivery distinct from network unreachability and requires pairing too', () => {
  const document = openPopup(vi.fn());
  (popup!.window as any).paintHeader({ connected: true, paired: false, compatible: true, port: 8765 });
  expect(document.getElementById('state')!.textContent).not.toContain('Connected');
  const result = (popup!.window as any).pipeline({ isChat: true, recorder: true, page: { events: 1 }, pending: 1 }, false);
  expect(result.why[1]).toContain('protocol compatibility');
  expect(result.why[1]).not.toContain('not reachable');
});
