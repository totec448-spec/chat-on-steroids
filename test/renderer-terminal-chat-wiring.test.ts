import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

const terminals = vi.hoisted(() => ({ options: [] as { id?: string; onSendSelection?: (text: string) => boolean }[] }));
vi.mock('../src/renderer/workspace-terminal.js', () => ({
  createWorkspaceTerminal: (_toggle: unknown, _mount: unknown, options: { id?: string; onSendSelection?: (text: string) => boolean }) => {
    terminals.options.push(options);
    return { update: vi.fn(), show: vi.fn(), hide: vi.fn(), newTab: vi.fn(() => null), tabs: vi.fn(() => []), selectTab: vi.fn(), closeTab: vi.fn() };
  }
}));

let dom: JSDOM | null = null;
afterEach(() => { dom?.window.close(); dom = null; terminals.options.length = 0; vi.resetModules(); });

it('gives the bottom and the right-dock terminal a Send to chat that fills the real composer', async () => {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, {
    window: w, document: w.document, HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node, Event: w.Event,
    DocumentFragment: w.DocumentFragment, HTMLInputElement: w.HTMLInputElement, HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement, HTMLButtonElement: w.HTMLButtonElement
  });
  const ok = (data: unknown) => Promise.resolve({ ok: true as const, data });
  const api = new Proxy({
    listSessions: () => ok({ sessions: [], activeId: null, pressure: [], total: 0, nextCursor: null, blocked: [] }),
    getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
    onSessionChanged: () => () => undefined, onSwarmChanged: () => () => undefined
  }, { get: (target, prop) => prop in target ? (target as any)[prop] : () => ok(null) });
  Object.defineProperty(w, 'api', { value: api, configurable: true });
  const { initChat } = await import('../src/renderer/chat.js');
  initChat({ save: async () => undefined, state: () => ({ config: { sessions: { record: true, limitTokens: 533000 }, compaction: { auto: true, autoTokens: 400000 }, ui: { developerMode: true } } }) as any });

  expect(terminals.options.map(options => options.id)).toEqual([undefined, 'workspaceTerminalRight']);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  for (const [index, options] of terminals.options.entries()) {
    input.value = '';
    expect(options.onSendSelection?.(`$ make\nError ${index}`)).toBe(true);
    expect(input.value).toBe(`\`\`\`\n$ make\nError ${index}\n\`\`\`\n\n`);
  }
});
