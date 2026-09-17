import { afterEach, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
let popup: JSDOM | undefined;
afterEach(() => { popup?.window.close(); });

function openPopup() {
  popup = new JSDOM(html, { url: 'https://extension-popup.test/', runScripts: 'outside-only' });
  const unavailable = () => new Promise(() => undefined);
  Object.assign(popup.window, {
    chrome: { runtime: { sendMessage: unavailable }, storage: { local: { get: unavailable } } },
    setInterval: () => 0
  });
  popup.window.eval(script);
  return popup.window.document;
}

it('reports only app reachability from compatible health and pairing', () => {
  const document = openPopup();
  expect(document.getElementById('pill')!.classList.contains('off')).toBe(true);
  (popup!.window as any).paintHeader({ connected: true, paired: true, port: 8765 });
  expect(document.getElementById('state')!.textContent).not.toContain('Connected');
  (popup!.window as any).paintHeader({ connected: true, paired: true, compatible: true, port: 8765 });
  expect(document.getElementById('state')!.textContent).toBe('App reachable · Port 8765');
  expect(document.getElementById('state')!.textContent).not.toContain('Connected');
  (popup!.window as any).paintHeader({ connected: false });
  expect(document.getElementById('state')!.textContent).toBe('App not reachable');
});

it('explains manual mismatch recovery with both versions', () => {
  const document = openPopup();
  (popup!.window as any).paintAlert({ connected: true, paired: true, compatible: false, appVersion: '2.0.7', appProtocol: 13, extensionVersion: '2.0.6', extensionProtocol: 12 }, null);
  const alert = document.getElementById('alert')!;
  expect(alert.textContent).toContain('2.0.7'); expect(alert.textContent).toContain('2.0.6');
  expect(alert.textContent).toContain('protocol 13'); expect(alert.textContent).toContain('protocol 12');
  expect(alert.textContent).toContain('Developer mode'); expect(alert.textContent).toContain('Open extension folder');
});

it('requires this chat session receipt before claiming delivery even with global delivery success', () => {
  openPopup();
  const info = { isChat: true, recorder: true, page: { events: 3 }, pending: 0, delivery: { ok: true, total: 50 } };
  const waiting = (popup!.window as any).pipeline(info, true);
  expect(waiting.sent[0]).toBe('running');
  expect(waiting.proc[0]).toBe('running');
  expect(waiting.why[1]).toContain('this chat’s session receipt');
  const recorded = (popup!.window as any).pipeline({ ...info, page: { events: 3, session: 'local-session' } }, true);
  expect(recorded.sent[0]).toBe('off');
  expect(recorded.proc[0]).toBe('off');
  expect(recorded.why[1]).toContain('latest turn');
});

it('distinguishes queued, received, owner confirmed and recorded tool activity for the current ID', () => {
  openPopup();
  const project = (trace: unknown[]) => (popup!.window as any).pipeline({
    isChat: true, recorder: true, pending: 0, delivery: { ok: true, total: 999 },
    page: { events: 1000, session: 'local-session', trace }
  }, true);
  const request = { requestId: 'wfr_current', read: 1, queued: 2 };
  expect(project([request]).sent[0]).toBe('running');
  expect(project([{ ...request, sent: 3 }]).why[1]).toContain('Waiting for owner confirmation');
  const confirmed = project([{ ...request, sent: 3, confirmed: true }]);
  expect(confirmed.proc[0]).toBe('done');
  expect(confirmed.why[1]).toContain('No matching tool activity');
  expect(project([{ ...request, app: 'request_id' }]).why[1]).toContain('matched to recorded tool activity');
  expect(project([]).proc[0]).toBe('off');
});

it('keeps blocked delivery distinct from network unreachability and requires pairing too', () => {
  const document = openPopup();
  (popup!.window as any).paintHeader({ connected: true, paired: false, compatible: true, port: 8765 });
  expect(document.getElementById('state')!.textContent).not.toContain('Connected');
  const result = (popup!.window as any).pipeline({ isChat: true, recorder: true, page: { events: 1 }, pending: 1 }, false);
  expect(result.why[1]).toContain('protocol compatibility');
  expect(result.why[1]).not.toContain('not reachable');
});
