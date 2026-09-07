import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
let popup: JSDOM | undefined;
afterEach(() => { popup?.window.close(); });

function openPopup(reload: () => void, sendMessage?: (message: { type: string }) => Promise<unknown>) {
  popup = new JSDOM(html, { url: 'https://extension-popup.test/', runScripts: 'outside-only' });
  const unavailable = () => new Promise(() => undefined);
  Object.assign(popup.window, {
    chrome: { runtime: { reload, sendMessage: sendMessage ?? unavailable }, storage: { local: { get: unavailable } } },
    setInterval: () => 0
  });
  popup.window.eval(script);
  return popup.window.document;
}

it('reloads directly once even when the old worker and preference reads never answer', () => {
  const reload = vi.fn();
  const document = openPopup(reload);
  const button = document.getElementById('reloadBtn') as HTMLButtonElement;
  expect(button.closest('details')).toBeNull();
  button.click(); button.click();
  expect(reload).toHaveBeenCalledTimes(1);
  expect(button.disabled).toBe(true);
  expect(document.getElementById('reloadStatus')?.textContent).toContain('Reopen');
});

it('reports a synchronous Chrome reload failure and allows another explicit attempt', () => {
  const reload = vi.fn().mockImplementationOnce(() => { throw new Error('Extension context invalidated'); });
  const document = openPopup(reload);
  const button = document.getElementById('reloadBtn') as HTMLButtonElement;
  button.click();
  expect(button.disabled).toBe(false);
  expect(document.getElementById('reloadStatus')?.textContent).toContain('Extension context invalidated');
  button.click();
  expect(reload).toHaveBeenCalledTimes(2);
});

const mismatch = {
  connected: true, paired: true, compatible: false, port: 8765,
  appVersion: '2.0.6', appProtocol: 12, extensionVersion: '2.0.2', extensionProtocol: 8
};
const capturedTab = {
  isChat: true, recorder: true, pending: 28,
  page: { events: 29, calls: 0, trace: [] }
};

it('keeps the initial popup neutral until the worker answers', () => {
  const document = openPopup(vi.fn());
  expect(document.getElementById('pill')?.classList.contains('off')).toBe(true);
  expect(document.getElementById('state')?.textContent).toBe('Looking for the app');
});

it('shows both versions, protocols and manual recovery beside the existing reload action', async () => {
  const reload = vi.fn();
  const document = openPopup(reload, async ({ type }) => type === 'status' ? mismatch : capturedTab);
  await popup!.window.eval('refresh()');
  const alert = document.getElementById('alert')!;
  expect(alert.hidden).toBe(false);
  expect(alert.textContent).toContain('App v2.0.6 (protocol 12)');
  expect(alert.textContent).toContain('extension v2.0.2 (protocol 8)');
  expect(alert.textContent).toContain('Reload companion');
  expect(alert.textContent).toContain('Extensions');
  expect(alert.textContent).toContain('Developer mode');
  expect(alert.textContent).toContain('Update');
  expect(alert.textContent).toContain('Open extension folder');
  expect(alert.closest('details')).toBeNull();
  expect(alert.compareDocumentPosition(document.getElementById('reloadBtn')!) & 4).toBe(4);
  expect(document.getElementById('why')?.textContent).not.toContain('not reachable');
  expect(document.getElementById('n-sent')?.textContent).toBe('28 held');
  expect(reload).not.toHaveBeenCalled();
});

it('does not report recovery until a compatible, paired connection is confirmed', async () => {
  let status: Record<string, unknown> = mismatch;
  const document = openPopup(vi.fn(), async ({ type }) => type === 'status' ? status : null);
  await popup!.window.eval('refresh()');
  expect(document.getElementById('state')?.textContent).toBe('Version mismatch');

  // Equal release versions alone are not evidence of protocol compatibility.
  status = { ...mismatch, extensionVersion: '2.0.6', compatible: null };
  await popup!.window.eval('refresh()');
  expect(document.getElementById('pill')?.classList.contains('off')).toBe(true);
  expect(document.getElementById('state')?.textContent).not.toContain('Connected');

  status = { ...status, compatible: true, paired: false };
  await popup!.window.eval('refresh()');
  expect(document.getElementById('state')?.textContent).not.toContain('Connected');

  status = { ...status, paired: true, extensionProtocol: 12 };
  await popup!.window.eval('refresh()');
  expect(document.getElementById('state')?.textContent).toBe('Connected · Port 8765');
  expect(document.getElementById('alert')?.hidden).toBe(true);
  expect(document.getElementById('r-app')?.className).toBe('row off');
});

it('does not turn missing version metadata into a guessed version or HTML', async () => {
  const status = { ...mismatch, appVersion: null, appProtocol: null, extensionVersion: '<b>test</b>' };
  const document = openPopup(vi.fn(), async ({ type }) => type === 'status' ? status : null);
  await popup!.window.eval('refresh()');
  const alert = document.getElementById('alert')!;
  expect(alert.textContent).toContain('App v? (protocol ?)');
  expect(alert.textContent).toContain('extension v<b>test</b> (protocol 8)');
  expect(alert.querySelector('b')).toBeNull();
});
