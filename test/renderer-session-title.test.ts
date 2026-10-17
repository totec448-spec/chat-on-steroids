import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../src/shared/session.js';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM('<body></body>', { url: 'https://local.test/' });
  for (const key of ['window', 'document'] as const) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key]);
});
afterEach(() => { vi.unstubAllGlobals(); dom.window.close(); });

const summary = (title: string, conversationId: string | null): SessionSummary => ({ id: 's', title, conversationId } as SessionSummary);

it('shows the unattributed activity chat under its name in the interface language', async () => {
  // Its stored title is the English marker the app recognizes it by; a German sidebar showed
  // "Unattributed activity" inside "Nicht zugeordnete Aktivität" (2.1.41 pass).
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  const { shownSessionTitle } = await import('../src/renderer/session-title.js');
  expect(shownSessionTitle(summary('Unattributed activity', null))).toBe('Nicht zugeordnete Aktivität');
  // A real chat someone named that keeps its name, and an untitled chat says so.
  expect(shownSessionTitle(summary('Unattributed activity', 'c-1'))).toBe('Unattributed activity');
  expect(shownSessionTitle(summary('', 'c-2'))).toBe('Unbenannte Sitzung');
});
