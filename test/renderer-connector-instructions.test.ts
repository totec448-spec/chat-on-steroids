import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/main/config.js';

vi.mock('../src/renderer/workspace-terminal.js', () => ({ createWorkspaceTerminal: () => ({ update: vi.fn() }) }));
vi.mock('../src/renderer/pet.js', () => ({ initPet: () => () => {} }));

let dom: JSDOM | undefined;
afterEach(() => {
  dom?.window.close();
  vi.resetModules();
});

async function editor(instructions = 'Keep changes focused.', legacy = false) {
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLElement.prototype.animate = vi.fn() as any;
  w.HTMLElement.prototype.scrollIntoView = vi.fn();
  Object.assign(globalThis, { window: w, document: w.document, Node: w.Node, Element: w.Element,
    HTMLElement: w.HTMLElement, DocumentFragment: w.DocumentFragment, HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement, HTMLTextAreaElement: w.HTMLTextAreaElement, HTMLButtonElement: w.HTMLButtonElement });
  const config = defaultConfig();
  config.mcp.instructions = instructions;
  if (legacy) delete (config as any).mcp;
  let current: any = {
    config, hasApiKey: false, hasGoalKey: false, resolvedBinary: null, bundledTunnelVersion: null,
    status: { state: 'disconnected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null,
      lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] },
    bridge: { running: false, port: 0, paired: false, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.1.14', latest: null, stage: 'idle', error: null, checkedAt: null }
  };
  const calls: Array<{ patch: any; base: any; resolve: (reply: any) => void }> = [];
  let listener: (state: any) => void = () => {};
  const ok = (data: any) => Promise.resolve({ ok: true, data: structuredClone(data) });
  const api = new Proxy({
    getState: () => ok(current), getLog: () => ok([]),
    listSessions: () => ok({ sessions: [], activeId: null, pressure: [] }),
    getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
    onStateChanged: (fn: typeof listener) => { listener = fn; return () => {}; },
    saveSettings: (patch: any, base: any) => new Promise(resolve => calls.push({
      patch: structuredClone(patch), base: structuredClone(base), resolve
    }))
  }, { get: (target, prop) => prop in target ? (target as any)[prop] : () => ok(null) });
  Object.defineProperty(w, 'api', { value: api });
  await import('../src/renderer/main.js');
  await vi.waitFor(() => expect(w.document.getElementById('mcpInstructions')).not.toBeNull());
  await new Promise(resolve => setTimeout(resolve, 0));
  const field = w.document.getElementById('mcpInstructions') as HTMLTextAreaElement;
  return {
    w, field, calls,
    edit(value: string) { field.focus(); field.value = value; field.dispatchEvent(new w.Event('input', { bubbles: true })); },
    save() { field.dispatchEvent(new w.Event('change', { bubbles: true })); field.blur(); },
    push(value = current.config.mcp?.instructions) {
      current = { ...current, config: { ...current.config, mcp: { instructions: value } } };
      listener(structuredClone(current));
    },
    async settle(index: number, success = true) {
      const call = calls[index]!;
      if (success) current = { ...current, config: { ...current.config, ...call.patch } };
      call.resolve(success ? { ok: true, data: structuredClone(current) } : { ok: false, error: 'Save failed' });
      await new Promise(resolve => setTimeout(resolve, 0));
    },
    notice: () => w.document.querySelector('.toast')?.textContent ?? ''
  };
}

it('loads saved instructions with the existing limit, label and automatic direction', async () => {
  const { field, w } = await editor('Use approved folders.\n保持原文。');
  expect(field.value).toBe('Use approved folders.\n保持原文。');
  expect(field.maxLength).toBe(4000);
  expect(field.dir).toBe('auto');
  expect(w.document.querySelector('label[for="mcpInstructions"]')?.textContent).toBe('Your own instructions');
});

it('loads legacy settings without an mcp group as empty', async () => {
  expect((await editor('', true)).field.value).toBe('');
});

it('saves edited text through the current snapshot/base flow and notifies only after acknowledgement', async () => {
  const e = await editor();
  e.edit('  Run tests.\n保持原文。  '); e.save();
  await vi.waitFor(() => expect(e.calls).toHaveLength(1));
  expect(e.calls[0]!.base.mcp.instructions).toBe('Keep changes focused.');
  expect(e.calls[0]!.patch.mcp.instructions).toBe('Run tests.\n保持原文。');
  expect(e.notice()).toBe('');
  await e.settle(0);
  expect(e.notice()).toContain('Instructions saved.');
  expect(e.notice()).toContain('Reload the connector');
  expect(e.field.value).toBe('Run tests.\n保持原文。');
  e.push();
  expect(e.field.value).toBe('Run tests.\n保持原文。');
});

it.each(['', ' \n\t '])('persists explicit clearing with %j and notifies', async value => {
  const e = await editor();
  e.edit(value); e.save();
  await vi.waitFor(() => expect(e.calls).toHaveLength(1));
  expect(e.calls[0]!.patch.mcp.instructions).toBe('');
  await e.settle(0);
  expect(e.field.value).toBe('');
  expect(e.notice()).toContain('Instructions saved.');
});

it('preserves a focused edit and selection during status pushes, but updates clean fields', async () => {
  const e = await editor();
  e.push('Changed externally.');
  expect(e.field.value).toBe('Changed externally.');
  e.edit('My unfinished draft');
  e.field.setSelectionRange(3, 7);
  e.push();
  expect(e.field.value).toBe('My unfinished draft');
  expect(e.field.selectionStart).toBe(3);
  expect(e.field.selectionEnd).toBe(7);
  expect(e.calls).toHaveLength(0);
});

it.each(['Second edit', 'Keep changes focused.'])('preserves queued %j through an older save reply and an unrelated save', async value => {
  const e = await editor();
  e.edit('First edit'); e.save();
  await vi.waitFor(() => expect(e.calls).toHaveLength(1));
  e.edit(value); e.save();
  await e.settle(0);
  await vi.waitFor(() => expect(e.calls).toHaveLength(2));
  expect(e.field.value).toBe(value);
  expect(e.calls[1]!.patch.mcp.instructions).toBe(value);
  const auto = e.w.document.getElementById('autoConnect') as HTMLInputElement;
  auto.checked = !auto.checked;
  auto.dispatchEvent(new e.w.Event('change', { bubbles: true }));
  await e.settle(1);
  await vi.waitFor(() => expect(e.calls).toHaveLength(3));
  expect(e.calls[2]!.patch.mcp.instructions).toBe(value);
  await e.settle(2);
  expect(e.field.value).toBe(value);
});

it('does not announce unchanged instructions and retains a failed save for retry', async () => {
  const e = await editor();
  e.edit('  Keep changes focused.  '); e.save();
  await vi.waitFor(() => expect(e.calls).toHaveLength(1));
  await e.settle(0);
  expect(e.notice()).toBe('');
  e.edit('Unsaved'); e.save();
  await vi.waitFor(() => expect(e.calls).toHaveLength(2));
  await e.settle(1, false);
  expect(e.notice()).toBe('Save failed');
  expect(e.field.value).toBe('Unsaved');
  e.push();
  expect(e.field.value).toBe('Unsaved');
  e.save();
  await vi.waitFor(() => expect(e.calls).toHaveLength(3));
  expect(e.calls[2]!.patch.mcp.instructions).toBe('Unsaved');
  await e.settle(2);
  expect(e.notice()).toContain('Instructions saved.');
});
