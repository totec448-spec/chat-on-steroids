import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

// Each registered link provider, and the one printed line every terminal shows.
const links = vi.hoisted(() => ({ providers: [] as { provideLinks(y: number, callback: (found?: { activate(event: { ctrlKey: boolean; metaKey: boolean }): void }[]) => void): void }[],
  line: 'src/app.ts:42:7 - error' }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options: Record<string, unknown> = {};
  buffer = { active: { getLine: (y: number) => y === 0 ? { length: links.line.length,
    getCell: (x: number) => ({ getChars: () => links.line[x]!, getWidth: () => 1 }) } : undefined } };
  registerLinkProvider(provider: (typeof links.providers)[number]): void { links.providers.push(provider); }
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
afterEach(() => { dom?.window.close(); links.providers.length = 0; });

function setup(saved?: unknown, options: Parameters<typeof createWorkspaceTerminal>[2] = {}) {
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
  const terminal = createWorkspaceTerminal(vi.fn(), document.getElementById('mount')!, options);
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

it('links file locations in a restored tab to the project saved with it, not the one selected now', async () => {
  const other = { id: 'c1e0a7d4-5b1f-4c52-8f6e-3a9d2b7e4c10', name: 'other' } as typeof project;
  const catalog = [project!, other!, { ...project!, id: '0f5c3a52-9d6e-4a0b-b1c4-6e2f8d7a9b33', name: 'server', remote: { host: 'example.test' } as never }] as typeof project[];
  const onOpenFile = vi.fn();
  const first = setup(undefined, { onOpenFile, projectById: id => catalog.find(row => row!.id === id) ?? null });
  first.terminal.update(project); first.terminal.newTab(); await settle();
  // A tab started now links to its own project.
  expect(links.providers).toHaveLength(1);
  links.providers.length = 0;

  const { terminal, panel } = setup(saved(), { onOpenFile, projectById: id => catalog.find(row => row!.id === id) ?? null });
  terminal.update(other);
  // Nothing is linked before the shell starts.
  expect(links.providers).toHaveLength(0);
  panel.querySelector<HTMLButtonElement>('.terminal-previous .btn')!.click();
  await settle();
  expect(links.providers).toHaveLength(1);
  let found: { activate(event: { ctrlKey: boolean; metaKey: boolean }): void }[] | undefined;
  links.providers[0]!.provideLinks(1, value => { found = value; });
  expect(found).toHaveLength(1);
  found![0]!.activate({ ctrlKey: true, metaKey: true });
  expect(onOpenFile).toHaveBeenCalledWith(project, expect.objectContaining({ path: 'src/app.ts', line: 42, column: 7 }));
});

it('links nothing in a project-less or server project tab', async () => {
  const server = { id: '0f5c3a52-9d6e-4a0b-b1c4-6e2f8d7a9b33', name: 'server', remote: { host: 'example.test' } } as unknown as typeof project;
  const { terminal } = setup(undefined, { onOpenFile: vi.fn(), projectById: id => id === server!.id ? server : null });
  terminal.update(null); terminal.newTab();
  terminal.update(server); terminal.newTab();
  await settle();
  expect(links.providers).toHaveLength(0);
});
