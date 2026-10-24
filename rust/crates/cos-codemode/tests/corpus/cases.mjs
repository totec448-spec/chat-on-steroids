// The code-mode script corpus. `record.test.ts` runs every case through the TypeScript runtime
// (`runCodeMode`) and writes corpus.json; `tests/corpus.rs` runs the same cases through the
// Rust runtime against the same fixture tools and compares each result and each child call.

export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const WINDOW = { id: 42, app: 'fixture.exe', title: 'Fixture' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Fixture tools. tests/corpus.rs implements the same answers. */
export const fixtures = {
  lookup: async args => ({ content: [{ type: 'text', text: 'PRIVATE-' + JSON.stringify(args) }] }),
  fail: async () => ({ content: [{ type: 'text', text: 'STALE_WINDOW: observe again' }], isError: true }),
  pixel: async () => ({ content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] }),
  slow: async args => { await sleep(args.ms); return { content: [{ type: 'text', text: 'slow ' + args.ms }] }; },
  big: async args => ({ content: [{ type: 'text', text: 'B'.repeat(args.n) }] }),
  structured: async () => ({ content: [{ type: 'text', text: '5' }], structuredContent: { value: 5 } }),
  list_windows: async () => ({ content: [], structuredContent: { value: [WINDOW] } }),
  get_window_state: async () => ({
    content: [{ type: 'image', data: PNG, mimeType: 'image/png' }],
    structuredContent: { value: { window: WINDOW, accessibility: { tree: '0: Button "Fixture"' } } }
  }),
  press_key: async () => ({ content: [], structuredContent: { value: null } }),
  type_text: async () => ({ content: [{ type: 'text', text: 'STALE_WINDOW: observe again' }], isError: true })
};

export const tools = Object.keys(fixtures).map(name => ({ name, description: `Fixture ${name}.` }));

/** Limits are CODE_MODE_LIMITS with each case's overrides. `known` marks an engine difference
 * the Rust test reports instead of asserting. */
export const cases = [
  { name: 'text-number', code: 'text(1 + 1)' },
  { name: 'no-output', code: 'const x = 1;' },
  { name: 'await-without-output', code: 'await tools.lookup({id:3})' },
  { name: 'parallel-filtered', code: 'const rows = await Promise.all([tools.lookup({id:1}), tools.lookup({id:2})]);\ntext(rows.map((row, index) => ({index, chars:row.content[0].text.length})));' },
  { name: 'result-shape', code: 'const r = await tools.fail({}); text(r); text(await tools.structured({}));' },
  { name: 'delivery-order', code: 'const a = tools.slow({ms:100}); const b = tools.lookup({id:2}); text(await b); text(await a);' },
  { name: 'text-values', code: 'text(); text(null); text({a:[1,"x"]}); text(Symbol("s")); text([0.1+0.2, 1e21, -0, 2**53, 1/3]); text("é\\u2028");' },
  { name: 'text-bigint', code: 'text(1n)' },
  { name: 'unknown-tool', code: 'await tools.no_such_tool({});' },
  { name: 'unknown-tool-caught', code: 'try { await tools.read_clipboard({}); } catch (error) { text(String(error)); }' },
  { name: 'throw-sync', code: 'throw new Error("golden failure")' },
  { name: 'throw-after-await', code: 'await tools.lookup({}); throw new Error("x")' },
  { name: 'reference-error-sync', code: 'undeclared = 1' },
  { name: 'syntax-error', code: 'let = ;' },
  { name: 'unterminated-string', code: "await tools.lookup({text:'PRIVATE_SOURCE" },
  { name: 'import', code: "import fs from 'node:fs'; text(fs)" },
  { name: 'module-this', code: 'text(typeof this)' },
  { name: 'no-node', code: 'text(typeof require + " " + typeof process)' },
  { name: 'no-host-authority', code: 'text([typeof process, typeof require, typeof fetch, typeof console, typeof WebAssembly, typeof __bridge, typeof setTimeout, typeof queueMicrotask]); globalThis.privateValue=42;' },
  { name: 'globals', code: 'text(Object.getOwnPropertyNames(globalThis).sort())' },
  { name: 'all-tools', code: 'text(ALL_TOOLS); text([Object.isFrozen(ALL_TOOLS), Object.isFrozen(tools), Object.isFrozen(ALL_TOOLS[0]), typeof tools.exec, Object.getPrototypeOf(tools)]);' },
  { name: 'exit', code: 'text("a"); exit(); text("b")' },
  { name: 'exit-after-await', code: 'await tools.lookup({}); text("a"); exit(); text("b")' },
  { name: 'pragma', code: '  // @exec: yield_time_ms=10\ntext(1)' },
  { name: 'blank-code', code: '  \n\t﻿ ' },
  { name: 'code-limit', code: 'x;'.repeat(32001) },
  { name: 'image-forward', code: 'const r = await tools.pixel({}); image(r.content.find(c => c.type === "image"));' },
  { name: 'image-data-url', code: `image("data:image/png;base64,${PNG}")` },
  { name: 'image-url-object', code: `image({image_url: "data:application/octet-stream;base64,${PNG}"})` },
  { name: 'image-remote', code: 'image("https://example.com/image.png")' },
  { name: 'image-not-an-image', code: 'text("first"); text("second"); image("data:image/png;base64,YWJj");' },
  { name: 'image-mime-mismatch', code: `image({type:"image", mimeType:"image/jpeg", data:"${PNG}"})` },
  { name: 'image-undefined', code: 'image()' },
  { name: 'image-limit', code: `for (let i = 0; i < 5; i++) image("data:image/png;base64,${PNG}");` },
  { name: 'oversized-text', code: 'text("x".repeat(50000))' },
  { name: 'utf8-truncation', code: 'text("界".repeat(100)); await tools.lookup({});', limits: { textBytes: 100 } },
  { name: 'escaped-text-fits', code: 'text("\\n".repeat(90));', limits: { textBytes: 100 } },
  { name: 'full-preview-after-call', code: 'await tools.lookup({id:1}); text("x".repeat(40001)); await tools.lookup({id:2});' },
  { name: 'output-items', code: 'for (let i = 0; i < 33; i++) text("a")' },
  { name: 'output-limit-latched', code: 'for(let i=0;i<33;i++){try{text("a")}catch{}} await tools.lookup({});' },
  { name: 'call-limit-concurrency', code: 'await Promise.all(Array.from({length:40},()=>tools.lookup({})))' },
  { name: 'call-limit-total', code: 'for (let i = 0; i < 33; i++) await tools.lookup({i});' },
  { name: 'call-limit-caught', code: 'try { await Promise.all(Array.from({length:9},()=>tools.slow({ms:50}))); } catch { text("caught"); }' },
  { name: 'result-limit', code: 'text(await tools.big({n:200}))', limits: { resultBytes: 100 } },
  { name: 'cpu-limit', code: 'while(true) {}', limits: { cpuMs: 100 } },
  { name: 'cpu-limit-after-await', code: 'await tools.lookup({}); while(true) {}', limits: { cpuMs: 100 } },
  { name: 'cpu-limit-caught', code: 'try { while(true) {} } catch { text("caught") }', limits: { cpuMs: 100 } },
  { name: 'cpu-within-budget', code: 'let s = 0; for (let i = 0; i < 1e6; i++) s += i; text(s)' },
  { name: 'time-limit', code: 'await new Promise(()=>{})', limits: { wallMs: 250 } },
  { name: 'time-limit-unawaited', code: 'text("retained"); tools.slow({ms:600}); await new Promise(()=>{})', limits: { wallMs: 250 } },
  { name: 'fire-and-forget', code: 'tools.slow({ms:50}); text("done")' },
  { name: 'memory-bomb', code: 'const a=[]; while(true) a.push(new Array(50000).fill("x"));', limits: { cpuMs: 1000, memoryBytes: 2 * 1024 * 1024 }, known: 'QuickJS fills new Array(50000) one element at a time and passes the 1 s CPU budget before memory runs out (CPU_LIMIT); QuickJS-ng runs out of memory within milliseconds' },
  { name: 'memory-bomb-after-await', code: 'await tools.lookup({}); const a=[]; while(true) a.push(new Array(50000).fill("x"));', limits: { cpuMs: 1000, memoryBytes: 2 * 1024 * 1024 }, known: 'QuickJS fills new Array(50000) one element at a time and passes the 1 s CPU budget before memory runs out (CPU_LIMIT); QuickJS-ng runs out of memory within milliseconds' },
  { name: 'memory-bomb-strings', code: 'const a=[]; while(true) a.push("x".repeat(100000) + a.length);', limits: { cpuMs: 1000, memoryBytes: 2 * 1024 * 1024 }, known: 'QuickJS builds repeat() results as shared ropes and, under a 2 MiB heap, collects garbage on nearly every allocation, so it passes the 1 s CPU budget first (CPU_LIMIT); QuickJS-ng runs out of memory within milliseconds' },
  { name: 'memory-bomb-strings-after-await', code: 'await tools.lookup({}); const a=[]; while(true) a.push("x".repeat(100000) + a.length);', limits: { cpuMs: 1000, memoryBytes: 2 * 1024 * 1024 }, known: 'QuickJS builds repeat() results as shared ropes and, under a 2 MiB heap, collects garbage on nearly every allocation, so it passes the 1 s CPU budget first (CPU_LIMIT); QuickJS-ng runs out of memory within milliseconds' },
  { name: 'memory-bomb-caught', code: 'let caught = false; try { const a=[]; while(true) a.push("x".repeat(100000) + a.length); } catch { caught = true } text(caught)', limits: { cpuMs: 1000, memoryBytes: 2 * 1024 * 1024 }, known: 'QuickJS builds repeat() results as shared ropes and, under a 2 MiB heap, collects garbage on nearly every allocation, so it passes the 1 s CPU budget first (CPU_LIMIT); QuickJS-ng runs out of memory within milliseconds' },
  { name: 'memory-bomb-default', code: 'let s = "x"; while(true) s += s;' },
  { name: 'memory-bomb-default-after-await', code: 'await tools.lookup({}); let s = "x"; while(true) s += s;' },
  { name: 'memory-bomb-default-caught', code: 'let s = "x"; try { while(true) s += s; } catch { text("caught"); }' },
  { name: 'deep-recursion', code: 'function f(n) { return f(n + 1) + 1; } f(0);' },
  { name: 'deep-recursion-after-await', code: 'await tools.lookup({}); function f(n) { return f(n + 1) + 1; } f(0);' },
  { name: 'deep-recursion-caught', code: 'function f(n) { return f(n + 1) + 1; } try { f(0) } catch (e) { text(e instanceof Error) }' },
  { name: 'deep-recursion-class', code: 'function f(n) { return f(n + 1) + 1; } try { f(0) } catch (e) { text(e.name + ": " + e.message) }', known: 'QuickJS-ng throws RangeError where QuickJS throws InternalError' },
  { name: 'sky-absent', code: 'text([typeof sky, typeof nodeRepl])' },
  { name: 'sky-values', windowsDesktop: true, code: 'const windows = await sky.list_windows();\nconst state = await sky.get_window_state({window: windows[0], include_text:true});\nnodeRepl.write(state.accessibility.tree);\ntext([sky.target, typeof sky.launch_app, typeof sky.read_clipboard, typeof sky.press_key]);\ntext(await sky.press_key({window: windows[0], key: "a"}));' },
  { name: 'sky-failure', windowsDesktop: true, code: 'await sky.type_text({window:{id:1,app:"fixture"},text:"a"}); await sky.press_key({});' },
  { name: 'sky-timer', windowsDesktop: true, code: 'await sky.press_key({window:{id:1,app:"fixture"},key:"Control_L+l"});\nawait sky.press_key({window:{id:1,app:"fixture"},key:"Return"});\nawait new Promise(resolve => setTimeout(resolve, 1));\nawait sky.press_key({window:{id:1,app:"fixture"},key:"Return"});' }
];
