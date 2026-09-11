import { expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { CODE_MODE_LIMITS, runCodeMode } from '../src/main/mcp/code-mode-runtime.js';
import type { ToolResult } from '../src/main/mcp/kernel.js';

const result = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });
const tools = [{ name: 'lookup', description: 'Fixture lookup returning a normal MCP result.' }];
const limits = { ...CODE_MODE_LIMITS, wallMs: 2000, cpuMs: 100 };
const rendered = (value: ToolResult) => JSON.stringify(value.content);

it('runs concurrent tools, keeps intermediates private, and returns only explicit filtered output', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = 0;
  const invoke = vi.fn(async (_name, args) => {
    if (++entered === 2) release();
    await gate;
    return result('PRIVATE-' + args.id);
  });
  const output = await runCodeMode(`
    const rows = await Promise.all([tools.lookup({id:1}), tools.lookup({id:2})]);
    text(rows.map((row, index) => ({index, chars:row.content[0].text.length})));
  `, tools, invoke, limits);
  expect(output.isError).not.toBe(true);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(output.content).toEqual([{ type: 'text', text: '[{"index":0,"chars":9},{"index":1,"chars":9}]' }]);
  expect(rendered(output)).not.toContain('PRIVATE');
  expect((await runCodeMode('await tools.lookup({id:3})', tools, invoke, limits)).content).toEqual([]);
});

it('exposes Windows sky values and displays each observation image once through the existing dispatcher', async () => {
  const png = (await sharp({ create: { width: 2, height: 2, channels: 3, background: 'green' } }).png().toBuffer()).toString('base64');
  const window = { id: 42, app: 'fixture.exe', title: 'Fixture' };
  const methods = ['list_windows', 'get_window_state', 'press_key'].map(name => ({ name, description: name }));
  const invoke = vi.fn(async (name: string) => ({
    content: name === 'get_window_state' ? [{ type: 'image' as const, mimeType: 'image/png', data: png }] : [],
    structuredContent: { value: name === 'list_windows' ? [window] : name === 'get_window_state' ? {
      window, accessibility: { tree: '0: Button "Fixture"' }, screenshots: [{ id: 'frame-1', width: 2, height: 2, zIndex: 0 }]
    } : null }
  }));
  const output = await runCodeMode(`
    const windows = await sky.list_windows();
    const state = await sky.get_window_state({window: windows[0], include_text:true});
    nodeRepl.write(state.accessibility.tree);
    text([sky.target, typeof sky.launch_app, typeof sky.read_clipboard]);
  `, methods, invoke, limits, { windowsDesktop: true });
  expect(output.isError).not.toBe(true);
  expect(output.content.filter(part => part.type === 'image')).toEqual([{ type: 'image', mimeType: 'image/png', data: png }]);
  expect(output.content.filter(part => part.type === 'text')).toEqual([
    { type: 'text', text: '0: Button "Fixture"' }, { type: 'text', text: '["windows","undefined","undefined"]' }
  ]);
  expect(invoke).toHaveBeenNthCalledWith(2, 'get_window_state', { window, include_text: true });
  expect(rendered(await runCodeMode('text([typeof sky,typeof nodeRepl])', methods, invoke, limits))).toContain('undefined');
});

it('throws a sky tool failure before a dependent input and preserves its useful error text', async () => {
  const invoke = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'STALE_WINDOW: observe again' }], isError: true }));
  const output = await runCodeMode('await sky.press_key({window:{id:1,app:"fixture"},key:"a"}); await sky.press_key({});',
    [{ name: 'press_key', description: 'fixture' }], invoke, limits, { windowsDesktop: true });
  expect(output.isError).toBe(true);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(rendered(output)).toContain('STALE_WINDOW: observe again');
});

it('reports already dispatched inputs when an unsupported timer stops a Desktop script', async () => {
  const invoke = vi.fn(async () => ({ content: [], structuredContent: { value: null } }));
  const output = await runCodeMode(`
    await sky.press_key({window:{id:1,app:'fixture'},key:'Control_L+l'});
    await sky.type_text({window:{id:1,app:'fixture'},text:'https://example.test/'});
    await sky.press_key({window:{id:1,app:'fixture'},key:'Return'});
    await new Promise(resolve => setTimeout(resolve, 1));
    await sky.press_key({window:{id:1,app:'fixture'},key:'Return'});
  `, ['press_key', 'type_text'].map(name => ({ name, description: 'fixture' })), invoke, limits, { windowsDesktop: true });
  expect(output.isError).toBe(true);
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(rendered(output)).toContain('3 tool calls already dispatched');
  expect(rendered(output)).toContain('not rolled back');
  expect(rendered(output)).toContain('Inspect current state before retrying');
  const noCalls = await runCodeMode('throw new Error("UNEMITTED_SECRET")', [], invoke, limits);
  expect(rendered(noCalls)).toContain('No tool calls were dispatched');
  expect(rendered(noCalls)).not.toContain('UNEMITTED_SECRET');
});

it('has no host authority or state shared with the next invocation', async () => {
  const code = `text([typeof process, typeof require, typeof fetch, typeof console, typeof WebAssembly, typeof __bridge]); globalThis.privateValue=42;`;
  const output = await runCodeMode(code, [], async () => result('unused'), limits);
  expect(output.content).toEqual([{ type: 'text', text: '["undefined","undefined","undefined","undefined","undefined","undefined"]' }]);
  expect((await runCodeMode('text(typeof privateValue)', [], async () => result('unused'), limits)).content).toEqual([{ type: 'text', text: 'undefined' }]);
  expect((await runCodeMode(`import fs from 'node:fs'; text(fs)`, [], async () => result('unused'), limits)).isError).toBe(true);
  expect(rendered(await runCodeMode(`throw new Error('UNEMITTED_SECRET')`, [], async () => result('unused'), limits))).not.toContain('UNEMITTED_SECRET');
});

it('bounds CPU, unresolved promises, memory, output and call admission', async () => {
  const invoke = vi.fn(async () => result('yes'));
  expect(rendered(await runCodeMode('while(true) {}', [], invoke, limits))).toContain('CPU_LIMIT');
  expect(rendered(await runCodeMode('await new Promise(()=>{})', [], invoke, { ...limits, wallMs: 250 }))).toContain('TIME_LIMIT');
  expect((await runCodeMode('const a=[]; while(true) a.push(new Array(50000).fill("x"));', [], invoke, { ...limits, cpuMs: 1000, memoryBytes: 2 * 1024 * 1024 })).isError).toBe(true);
  expect(rendered(await runCodeMode('text("x".repeat(10000))', [], invoke, { ...limits, textBytes: 100 }))).toContain('OUTPUT_LIMIT');
  expect((await runCodeMode('await Promise.all(Array.from({length:40},()=>tools.lookup({})))', tools, invoke, limits)).isError).toBe(true);
  expect(invoke.mock.calls.length).toBeLessThanOrEqual(limits.concurrentCalls);
});

it('rejects circular or oversized host results without leaking them or hanging', async () => {
  const circular = result('INTERNAL'); (circular as any).cycle = circular;
  expect(rendered(await runCodeMode('text(await tools.lookup({}))', tools, async () => circular, limits))).toContain('RESULT_INVALID');
  const output = await runCodeMode('text(await tools.lookup({}))', tools, async () => result('PRIVATE'.repeat(100)), { ...limits, resultBytes: 100 });
  expect(rendered(output)).toContain('RESULT_LIMIT');
  expect(rendered(output)).not.toContain('PRIVATE');
});

it('latches a worker limit even when the script catches it and tries another tool', async () => {
  const invoke = vi.fn(async () => result('unexpected'));
  const output = await runCodeMode('for(let i=0;i<33;i++){try{text("a")}catch{}} await tools.lookup({});', tools, invoke, limits);
  expect(rendered(output)).toContain('OUTPUT_LIMIT');
  expect(invoke).not.toHaveBeenCalled();
});

it('emits valid native images and rejects malformed or remote image payloads', async () => {
  const data = (await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer()).toString('base64');
  const img: ToolResult = { content: [{ type: 'image', mimeType: 'image/png', data }] };
  const output = await runCodeMode('const r=await tools.lookup({}); image(r.content[0]);', tools, async () => img, limits);
  expect(output).toEqual(img);
  for (const value of ['https://example.com/image.png', 'data:image/png;base64,YWJj', { type: 'image', mimeType: 'image/jpeg', data }]) {
    expect((await runCodeMode(`image(${JSON.stringify(value)})`, [], async () => img, limits)).isError).toBe(true);
  }
});

it('stops new admission on timeout while an accepted tool finishes under its own owner', async () => {
  let resolve!: (value: ToolResult) => void;
  const invoke = vi.fn(() => new Promise<ToolResult>(done => { resolve = done; }));
  const output = await runCodeMode('await tools.lookup({}); await tools.lookup({});', tools, invoke, { ...limits, wallMs: 500 });
  expect(rendered(output)).toContain('TIME_LIMIT');
  expect(rendered(output)).toContain('UNAWAITED_CALLS');
  expect(invoke).toHaveBeenCalledTimes(1);
  resolve(result('late private value'));
  await new Promise(done => setImmediate(done));
  expect(invoke).toHaveBeenCalledTimes(1);
});
