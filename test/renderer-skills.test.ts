import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { invokedSkills } from '../src/shared/skill-invocation.js';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM('<textarea id="input"></textarea><button id="skills">Skills</button><div id="picker" hidden></div>', { url: 'https://local.test' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event, Node: dom.window.Node });
});
afterEach(() => dom.window.close());
const skill = { id: 'review', name: 'Review', description: 'Check changes', path: '/skills/review/SKILL.md' };
async function fixture() {
  const { initSkills } = await import('../src/renderer/skills.js');
  const input = document.getElementById('input') as HTMLTextAreaElement;
  const button = document.getElementById('skills')!;
  const host = document.getElementById('picker')!;
  let owner = 'a:1';
  const list = vi.fn(async () => ({ ok: true as const, data: [skill] }));
  const importFile = vi.fn(async () => ({ ok: true as const, data: skill }));
  const picker = initSkills({ input, button, host, owner: () => owner, list, importFile });
  const type = (value: string) => { input.value = value; input.setSelectionRange(value.length, value.length); input.dispatchEvent(new Event('input')); };
  const key = (value: string) => picker.keydown(new dom.window.KeyboardEvent('keydown', { key: value, cancelable: true }));
  return { input, button, host, list, importFile, picker, type, key, owner: (value: string) => { owner = value; } };
}
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };

it('parses only leading commands, supports /prompt, and deduplicates without consuming prose', () => {
  expect(invokedSkills('/review\n/prompt audit\n/review\nDo this /other')).toEqual(['review', 'audit']);
  expect(invokedSkills('Do /review')).toEqual([]);
  expect(invokedSkills('```\n/review\n```')).toEqual([]);
  expect(invokedSkills('/project/file.md')).toEqual([]);
  expect(() => invokedSkills('/prompt')).toThrow(/Choose/);
});

it('offers /prompt completion and preserves earlier selection and complete task', async () => {
  const f = await fixture();
  f.type('/audit\n/prompt re'); await settle();
  expect(f.host.hidden).toBe(false);
  expect(f.key('Enter')).toBe(true);
  expect(f.input.value).toBe('/audit\n/review ');
  f.type('/audit\nTask must stay exactly here');
  f.button.click(); await settle();
  (f.host.querySelector('.skill-choice') as HTMLButtonElement).click();
  expect(f.input.value).toBe('/review\n/audit\nTask must stay exactly here');
});

it('never traps Enter when loading, empty or unmatched and does not refetch on each character', async () => {
  const f = await fixture();
  let resolve!: (value: { ok: true; data: typeof skill[] }) => void;
  f.list.mockImplementation(() => new Promise(done => { resolve = done; }));
  f.type('/'); expect(f.key('Enter')).toBe(false);
  resolve({ ok: true, data: [] }); await settle();
  f.type('/z'); expect(f.key('Enter')).toBe(false);
  f.type('/zz'); expect(f.key('Enter')).toBe(false);
  expect(f.list).toHaveBeenCalledTimes(1);
});

it('does not apply stale choices after caret movement or a selection', async () => {
  const f = await fixture(); f.type('/re'); await settle();
  f.input.setSelectionRange(1, 2);
  expect(f.key('Enter')).toBe(false); expect(f.input.value).toBe('/re');
});
it('waits for committed IME composition before opening autocomplete', async () => {
  const f = await fixture();
  f.input.dispatchEvent(new dom.window.CompositionEvent('compositionstart'));
  f.input.value = '/re'; f.input.setSelectionRange(3, 3);
  f.input.dispatchEvent(new dom.window.InputEvent('input', { isComposing: true }));
  await settle(); expect(f.list).not.toHaveBeenCalled(); expect(f.host.hidden).toBe(true);
  f.input.dispatchEvent(new dom.window.CompositionEvent('compositionend'));
  await settle(); expect(f.list).toHaveBeenCalledTimes(1); expect(f.host.hidden).toBe(false);
});

it('rejects pending import across A→B→A draft epochs and Escape closes button-focused popup', async () => {
  const f = await fixture();
  let resolve!: (value: { ok: true; data: typeof skill }) => void;
  f.importFile.mockImplementation(() => new Promise(done => { resolve = done; }));
  f.type('Original task'); f.button.click(); await settle();
  (f.host.querySelector('.skill-import') as HTMLButtonElement).click();
  f.owner('b:2'); f.picker.close(); f.owner('a:3');
  resolve({ ok: true, data: skill }); await settle();
  expect(f.input.value).toBe('Original task');
  f.button.click(); await settle();
  const button = f.host.querySelector('button')!; button.focus();
  button.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(f.host.hidden).toBe(true);
});
