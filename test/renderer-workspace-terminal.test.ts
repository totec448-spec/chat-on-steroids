import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options: Record<string, unknown> = {};
  loadAddon(): void {}
  open(node: HTMLElement): void { const screen = node.ownerDocument.createElement('div'); screen.className = 'xterm'; node.append(screen); }
  onData(): void {}
  onSelectionChange(): void {}
  attachCustomKeyEventHandler(): void {}
  write(): void {}
  writeln(): void {}
  focus(): void {}
  dispose(): void {}
  hasSelection(): boolean { return false; }
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
import { createWorkspaceTerminal } from '../src/renderer/workspace-terminal.js';

const KEY = 'chat-on-steroids.terminal-tabs.workspaceTerminal';
let dom: JSDOM;
afterEach(() => dom?.window.close());

function setup(saved?: unknown) {
  dom = new JSDOM('<div class="app"><div id="mount"></div></div>', { url: 'https://local.test', pretendToBeVisual: true });
  const shells = new Map<string, string>();
  const api = {
    terminalCreate: vi.fn(async (id: string, projectId: string | null) => {
      shells.set(id, projectId ?? 'home');
      return { ok: true, data: { id, projectId, cwd: projectId ? '/home/you/project' : '/home/you', shell: 'bash' } };
    }),
    terminalClose: vi.fn(async () => ({ ok: true })), terminalResize: vi.fn(async () => ({ ok: true })),
    terminalWrite: vi.fn(async () => ({ ok: true })), terminalAck: vi.fn(async () => ({ ok: true })),
    writeClipboard: vi.fn(async () => ({ ok: true })), onTerminalEvent: vi.fn(() => () => {})
  };
  Object.assign(dom.window, { api });
  dom.window.ResizeObserver = class { observe(): void {} disconnect(): void {} } as unknown as typeof ResizeObserver;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, ResizeObserver: dom.window.ResizeObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), getComputedStyle: dom.window.getComputedStyle.bind(dom.window) });
  if (saved !== undefined) dom.window.localStorage.setItem(KEY, typeof saved === 'string' ? saved : JSON.stringify(saved));
  const terminal = createWorkspaceTerminal(vi.fn(), document.getElementById('mount')!);
  return { api, terminal, panel: document.getElementById('workspaceTerminal')! };
}
const saved = () => JSON.parse(dom.window.localStorage.getItem(KEY) ?? 'null') as unknown;
const project = { id: '7b0c6f2e-1d1a-4c55-9a39-2d1f4f0e8a11', name: 'project' } as Parameters<ReturnType<typeof createWorkspaceTerminal>['update']>[0];
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

it('remembers open terminal tabs and brings them back after a restart as inert previous-session tabs', async () => {
  const first = setup();
  first.terminal.update(project); first.terminal.newTab();
  first.terminal.update(null); first.terminal.newTab();
  await settle();
  expect(saved()).toEqual([
    { projectId: project!.id, title: 'project · bash', cwd: '/home/you/project' },
    { projectId: null, title: 'bash', cwd: '/home/you' }
  ]);

  const { api, terminal, panel } = setup(saved());
  expect(terminal.tabs().map(tab => [tab.title, tab.previous])).toEqual([['project · bash', true], ['bash', true]]);
  expect([...panel.querySelectorAll('.terminal-tab .tab-label')].map(node => node.textContent))
    .toEqual(['project · bash · previous session', 'bash · previous session']);
  // No shell starts by itself, and the panel stays closed until it is opened.
  expect(api.terminalCreate).not.toHaveBeenCalled();
  expect(panel.hidden).toBe(true);
  terminal.show(document.getElementById('mount')!);
  expect(api.terminalCreate).not.toHaveBeenCalled();

  const [projectTab] = terminal.tabs();
  terminal.selectTab(projectTab!.id);
  const screen = [...panel.querySelectorAll<HTMLElement>('.terminal-screen')].find(node => !node.hidden)!;
  // xterm would take Tab as shell input, so the keyboard lands on Start shell here.
  expect(document.activeElement).toBe(screen.querySelector('.terminal-previous .btn'));
  expect(screen.title).toBe('/home/you/project');
  expect(screen.querySelector('.terminal-previous-cwd')?.textContent).toBe('/home/you/project');
  // The shell starts in the saved project, even when another one (or none) is selected now.
  screen.querySelector<HTMLButtonElement>('.terminal-previous .btn')!.click();
  await settle();
  expect(api.terminalCreate).toHaveBeenCalledOnce();
  expect(api.terminalCreate).toHaveBeenCalledWith(projectTab!.id, project!.id, 80, 24);
  expect(screen.querySelector('.terminal-previous')).toBeNull();
  expect(terminal.tabs()[0]).toMatchObject({ title: 'project · bash', previous: false, exited: false });
  expect(panel.querySelector('.terminal-tab .tab-label')?.textContent).toBe('project · bash');

  // Closing a tab forgets it; an untouched previous-session tab stays remembered.
  terminal.closeTab(projectTab!.id);
  expect(saved()).toEqual([{ projectId: null, title: 'bash', cwd: '/home/you' }]);
  terminal.closeTab(terminal.tabs()[0]!.id);
  expect(dom.window.localStorage.getItem(KEY)).toBeNull();
});

it('forgets a shell that exited or failed to start, and starts no tabs from broken storage', async () => {
  const { api, terminal } = setup('{not json');
  expect(terminal.tabs()).toEqual([]);
  api.terminalCreate.mockResolvedValueOnce({ ok: false, error: 'Command execution is disabled in Settings' } as never);
  terminal.newTab(); await settle();
  expect(terminal.tabs()[0]).toMatchObject({ exited: true });
  expect(dom.window.localStorage.getItem(KEY)).toBeNull();
});

it('brings back at most eight valid remembered tabs, each dock from its own list', () => {
  const tab = (index: number) => ({ projectId: null, title: `shell ${index}`, cwd: '/home/you' });
  const { terminal } = setup([
    { projectId: 7, title: 'bad', cwd: '' }, { projectId: null, title: '', cwd: '' }, { projectId: null, title: 'x'.repeat(201), cwd: '' },
    ...Array.from({ length: 10 }, (_, index) => tab(index))
  ]);
  expect(terminal.tabs().map(entry => entry.title)).toEqual(Array.from({ length: 8 }, (_, index) => `shell ${index}`));
  const right = createWorkspaceTerminal(vi.fn(), document.getElementById('mount')!, { id: 'workspaceTerminalRight', dockedTabs: true });
  expect(right.tabs()).toEqual([]);
});
