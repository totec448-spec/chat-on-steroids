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
