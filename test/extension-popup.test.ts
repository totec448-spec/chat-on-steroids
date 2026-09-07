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

it('omits the debugging reload action even when the worker is unavailable', () => {
  const reload = vi.fn();
  const document = openPopup(reload);
  expect(document.getElementById('reloadBtn')).toBeNull();
  expect(document.getElementById('reloadStatus')).toBeNull();
  expect(script).not.toContain('chrome.runtime.reload');
  expect(reload).not.toHaveBeenCalled();
});

it('starts neutral and requires explicit protocol compatibility before reporting Connected', () => {
  const document = openPopup(vi.fn());
  expect(document.getElementById('pill')!.classList.contains('off')).toBe(true);
  (popup!.window as any).paintHeader({ connected: true, paired: true, port: 8765 });
  expect(document.getElementById('state')!.textContent).not.toContain('Connected');
  (popup!.window as any).paintHeader({ connected: true, paired: true, compatible: true, port: 8765 });
  expect(document.getElementById('state')!.textContent).toContain('Connected');
});

it('explains manual mismatch recovery with both versions without adding a reload action', () => {
  const document = openPopup(vi.fn());
  (popup!.window as any).paintAlert({ connected: true, paired: true, compatible: false, appVersion: '2.0.7', appProtocol: 13, extensionVersion: '2.0.6', extensionProtocol: 12 }, null);
  const alert = document.getElementById('alert')!;
  expect(alert.textContent).toContain('2.0.7'); expect(alert.textContent).toContain('2.0.6');
  expect(alert.textContent).toContain('protocol 13'); expect(alert.textContent).toContain('protocol 12');
  expect(alert.textContent).toContain('Developer mode'); expect(alert.textContent).toContain('Open extension folder');
  expect(document.getElementById('reloadBtn')).toBeNull();
});

it('keeps blocked delivery distinct from network unreachability and requires pairing too', () => {
  const document = openPopup(vi.fn());
  (popup!.window as any).paintHeader({ connected: true, paired: false, compatible: true, port: 8765 });
  expect(document.getElementById('state')!.textContent).not.toContain('Connected');
  const result = (popup!.window as any).pipeline({ isChat: true, recorder: true, page: { events: 1 }, pending: 1 }, false);
  expect(result.why[1]).toContain('protocol compatibility');
  expect(result.why[1]).not.toContain('not reachable');
});
