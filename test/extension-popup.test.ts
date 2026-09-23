import { afterEach, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
const i18nScript = await readFile(new URL('../extension/i18n.js', import.meta.url), 'utf8');
const script = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
let popup: JSDOM | undefined;
afterEach(() => { popup?.window.close(); });

function openPopup(messages: Record<string, string> = {}, uiLanguage = 'en') {
  popup = new JSDOM(html, { url: 'https://extension-popup.test/', runScripts: 'outside-only' });
  const unavailable = () => new Promise(() => undefined);
  const getMessage = (key: string, substitutions?: string | string[]) => {
    const message = messages[key];
    if (!message) return '';
    const values = substitutions === undefined ? [] : Array.isArray(substitutions) ? substitutions : [substitutions];
    return message.replace(/\$([1-9])/g, (token, index: string) => values[Number(index) - 1] ?? token);
  };
  Object.assign(popup.window, {
    chrome: {
      i18n: { getMessage, getUILanguage: () => uiLanguage },
      runtime: { sendMessage: unavailable },
      storage: { local: { get: unavailable } }
    },
    setInterval: () => 0
  });
  popup.window.eval(i18nScript);
  popup.window.eval(script);
  return popup.window.document;
}

it('declares Chrome locale placeholders and loads the shared i18n helper before popup code', () => {
  expect(manifest.default_locale).toBe('en');
  expect(manifest.name).toBe('__MSG_extension_name__');
  expect(manifest.description).toBe('__MSG_extension_description__');
  expect(manifest.action.default_title).toBe('__MSG_extension_action_title__');
  expect(manifest.content_scripts[0].js[0]).toBe('i18n.js');
  expect(html.indexOf('src="i18n.js"')).toBeLessThan(html.indexOf('src="popup.js"'));
  expect((html.match(/<script\b[^>]*>/gi) ?? []).every((tag) => /\bsrc=/.test(tag))).toBe(true);

  openPopup();
  expect((popup!.window as any).CLF_I18N.t('missing_key', 'Port $1', 8765)).toBe('Port 8765');
});

it('uses chrome.i18n for static and dynamic popup text in a non-English locale', () => {
  const document = openPopup({
    popup_section_session_capture: 'Oturum kaydı',
    popup_state_app_reachable_port: 'Uygulamaya erişiliyor · Port $1',
    popup_connect: 'Bağlan',
    popup_copy_chat_id: 'Sohbet kimliğini kopyala',
    popup_call_details: '$1 — bulundu $2 · uygulama alındısı $3 · sahip $4 · araç etkinliği $5',
    popup_yes: 'evet',
    popup_confirmed: 'doğrulandı',
    popup_no_record: 'kayıt yok'
  }, 'tr');

  expect(document.documentElement.lang).toBe('tr');
  expect(document.querySelector('[data-i18n="popup_section_session_capture"]')!.textContent).toBe('Oturum kaydı');
  expect(document.getElementById('d-chat')!.getAttribute('aria-label')).toBe('Sohbet kimliğini kopyala');
  (popup!.window as any).paintHeader({ connected: true, paired: true, compatible: true, port: 8765 });
  expect(document.getElementById('state')!.textContent).toBe('Uygulamaya erişiliyor · Port 8765');
  (popup!.window as any).paintHeader({ connected: true, paired: false, disconnected: true, compatible: true, port: 8765 });
  expect(document.getElementById('retryBtn')!.textContent).toBe('Bağlan');

  const requestId = 'wfr_raw_runtime_id';
  (popup!.window as any).paintCalls({ trace: [{ requestId, read: 1, sent: 1, confirmed: true, tool: 'runtime_tool' }] });
  const call = document.querySelector('.call')!;
  expect(call.getAttribute('title')).toContain(`${requestId} — bulundu evet`);
  expect(call.querySelector('.tool')!.textContent).toBe('runtime_tool');
});

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
  expect(document.getElementById('unpairBtn')).toBeNull();
  (popup!.window as any).paintHeader({ connected: true, paired: false, disconnected: true, compatible: true, port: 8765 });
  expect(document.getElementById('retryBtn')!.textContent).toBe('Connect');
  expect((document.getElementById('retryBtn') as HTMLButtonElement).hidden).toBe(false);
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
