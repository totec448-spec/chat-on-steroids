import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

const xterm = vi.hoisted(() => {
  type KeyHandler = (event: KeyboardEvent) => boolean;
  class FakeTerminal {
    static last: FakeTerminal | null = null;
    options: Record<string, unknown>; cols = 80; rows = 24;
    selection = ''; selectionListeners: (() => void)[] = []; keyHandler: KeyHandler | null = null;
    constructor(options: Record<string, unknown>) { this.options = options; FakeTerminal.last = this; }
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    write(): void {}
    writeln(): void {}
    dispose(): void {}
    onData(): void {}
    onSelectionChange(listener: () => void): void { this.selectionListeners.push(listener); }
    attachCustomKeyEventHandler(handler: KeyHandler): void { this.keyHandler = handler; }
    hasSelection(): boolean { return this.selection.length > 0; }
    getSelection(): string { return this.selection; }
    clearSelection(): void { this.select(''); }
    select(text: string): void { this.selection = text; for (const listener of this.selectionListeners) listener(); }
  }
  return { FakeTerminal };
});
vi.mock('@xterm/xterm', () => ({ Terminal: xterm.FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import { draftWithTerminalBlock, MAX_TERMINAL_CHARACTERS, sendTerminalSelection, terminalSelectionBlock } from '../src/renderer/terminal-selection.js';
import { createWorkspaceTerminal } from '../src/renderer/workspace-terminal.js';

let dom: JSDOM | null = null;
afterEach(() => { dom?.window.close(); dom = null; vi.unstubAllGlobals(); });

it('fences the selected lines without the blank lines and trailing spaces around them', () => {
  expect(terminalSelectionBlock('\n\n$ npm test   \n  Error: boom\n    at run (file.js:1:1)  \n\n')).toBe(
    '```\n$ npm test\n  Error: boom\n    at run (file.js:1:1)\n```');
  expect(terminalSelectionBlock('\r\n  \r\n')).toBeNull();
});

it('opens the fence with more backticks than any run in the output', () => {
  expect(terminalSelectionBlock('echo ```\n````')).toBe('`````\necho ```\n````\n`````');
});

it('keeps the last 400 lines of a long selection and says how many were selected', () => {
  const lines = Array.from({ length: 5_000 }, (_, index) => `line ${index + 1}`);
  const block = terminalSelectionBlock(lines.join('\n'))!;
  expect(block.startsWith('Only the end of the selection is here: the last 400 of 5,000 lines.\n\n```\nline 4601\n')).toBe(true);
  expect(block.endsWith('line 5000\n```')).toBe(true);
});

it('keeps whole lines under the character cap, and the end of one line longer than the cap', () => {
  const lines = Array.from({ length: 100 }, (_, index) => `${index}`.padEnd(300, '.'));
  const block = terminalSelectionBlock(lines.join('\n'))!;
  const kept = Math.floor((MAX_TERMINAL_CHARACTERS + 1) / 301);
  expect(block).toContain(`the last ${kept} of 100 lines.`);
  expect(block.split('\n').slice(3, -1)).toEqual(lines.slice(-kept));
  const long = terminalSelectionBlock(`${'a'.repeat(30_000)}tail`)!;
  expect(long.startsWith('Only the end of the selection is here: the last 20,000 characters.\n\n```\n')).toBe(true);
  expect(long.split('\n')[3]).toBe(`${'a'.repeat(MAX_TERMINAL_CHARACTERS - 4)}tail`);
});

it('puts the block after the typed draft with an empty line to write on', () => {
  expect(draftWithTerminalBlock('', '```\nx\n```')).toBe('```\nx\n```\n\n');
  expect(draftWithTerminalBlock('Why does this fail?\n\n', '```\nx\n```')).toBe('Why does this fail?\n\n```\nx\n```\n\n');
});

function setup() {
  dom = new JSDOM('<div class="app"><div id="dock"></div><form id="composer"><textarea id="chatInput"></textarea></form></div>', { pretendToBeVisual: true });
  const { window } = dom;
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('Event', window.Event);
  vi.stubGlobal('getComputedStyle', window.getComputedStyle.bind(window));
  vi.stubGlobal('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} });
  vi.stubGlobal('navigator', { platform: 'Win32' });
  Object.assign(window, { api: {
    terminalCreate: vi.fn(async () => ({ ok: true, data: { shell: 'bash', cwd: '/home/you' } })),
    terminalResize: vi.fn(), terminalClose: vi.fn(), terminalWrite: vi.fn(), terminalAck: vi.fn(),
    writeClipboard: vi.fn(), onTerminalEvent: () => () => {}
  } });
  const input = document.getElementById('chatInput') as HTMLTextAreaElement;
  const submitted = vi.fn(); document.getElementById('composer')!.addEventListener('submit', submitted);
  const terminal = createWorkspaceTerminal(() => {}, document.getElementById('dock')!,
    { onSendSelection: text => sendTerminalSelection(input, text) });
  terminal.newTab();
  return { input, submitted, term: xterm.FakeTerminal.last!, send: document.querySelector<HTMLButtonElement>('.terminal-send')! };
}

it('shows Send to chat while the shell has a selection and adds it to the draft without sending', () => {
  const { input, submitted, term, send } = setup();
  expect(send.hidden).toBe(true);
  input.value = 'Why does this fail?';
  term.select('$ make\nmake: *** [all] Error 2');
  expect(send.hidden).toBe(false);
  expect(send.title).toBe('Send to chat (Ctrl+Shift+Enter)');
  send.click();
  expect(input.value).toBe('Why does this fail?\n\n```\n$ make\nmake: *** [all] Error 2\n```\n\n');
  expect(input.selectionStart).toBe(input.value.length);
  expect(document.activeElement).toBe(input);
  expect(term.selection).toBe('');
  expect(send.hidden).toBe(true);
  expect(submitted).not.toHaveBeenCalled();
});

it('sends the selection with Ctrl+Shift+Enter, and leaves the key to the shell without one', () => {
  const { input, term } = setup();
  const press = () => new dom!.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true, cancelable: true });
  const empty = press();
  expect(term.keyHandler!(empty)).toBe(true);
  expect(empty.defaultPrevented).toBe(false);
  expect(input.value).toBe('');
  term.select('Error: placeholder');
  const event = press();
  expect(term.keyHandler!(event)).toBe(false);
  expect(event.defaultPrevented).toBe(true);
  expect(input.value).toBe('```\nError: placeholder\n```\n\n');
});

it('leaves Ctrl+Shift+Enter to an input method that is still composing', () => {
  const { input, term } = setup();
  term.select('Error: placeholder');
  const event = new dom!.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true, isComposing: true, cancelable: true });
  expect(term.keyHandler!(event)).toBe(true);
  expect(event.defaultPrevented).toBe(false);
  expect(input.value).toBe('');
  expect(term.selection).toBe('Error: placeholder');
});

it('sends a selection from a shell started out of a previous-session tab, and shows no button while the tab is inert', async () => {
  dom = new JSDOM('<div class="app"><div id="dock"></div><textarea id="chatInput"></textarea></div>', { url: 'https://local.test', pretendToBeVisual: true });
  const { window } = dom;
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('Event', window.Event);
  vi.stubGlobal('getComputedStyle', window.getComputedStyle.bind(window));
  vi.stubGlobal('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} });
  vi.stubGlobal('navigator', { platform: 'Win32' });
  const create = vi.fn(async () => ({ ok: true, data: { shell: 'bash', cwd: '/home/you' } }));
  Object.assign(window, { api: {
    terminalCreate: create, terminalResize: vi.fn(), terminalClose: vi.fn(), terminalWrite: vi.fn(), terminalAck: vi.fn(),
    writeClipboard: vi.fn(), onTerminalEvent: () => () => {}
  } });
  window.localStorage.setItem('chat-on-steroids.terminal-tabs.workspaceTerminal',
    JSON.stringify([{ projectId: null, title: 'bash', cwd: '/home/you' }]));
  const input = document.getElementById('chatInput') as HTMLTextAreaElement;
  const terminal = createWorkspaceTerminal(() => {}, document.getElementById('dock')!,
    { onSendSelection: text => sendTerminalSelection(input, text) });
  const term = xterm.FakeTerminal.last!, send = document.querySelector<HTMLButtonElement>('.terminal-send')!;
  expect(terminal.tabs().map(tab => tab.previous)).toEqual([true]);
  terminal.selectTab(terminal.tabs()[0]!.id);
  expect(send.hidden).toBe(true);
  document.querySelector<HTMLButtonElement>('.terminal-previous .btn')!.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(create).toHaveBeenCalledOnce();
  term.select('Error: boom');
  expect(send.hidden).toBe(false);
  send.click();
  expect(input.value).toBe('```\nError: boom\n```\n\n');
});
