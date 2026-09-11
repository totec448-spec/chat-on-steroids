import { WINDOWS_COMPUTER_METHODS } from '../../shared/windows-computer.js';

/** Trusted worker bootstrap. Model source runs only inside the bounded QuickJS WASM heap,
 * never in Node's evaluator. The bridge copies JSON strings; no host object enters QuickJS. */
export const CODE_MODE_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { newQuickJSWASMModuleFromVariant } = require(workerData.coreModule);
const variant = require(workerData.wasmModule).default;
let closed = false;
const send = message => { if (!closed) parentPort.postMessage(message); };
function finish(error) { if (closed) return; send({ type: 'done', error }); closed = true; }
(async () => {
  const QuickJS = await newQuickJSWASMModuleFromVariant(variant);
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(workerData.limits.memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  const vm = runtime.newContext();
  let usedCpu = 0, sliceStart = 0, fatal = null, nextId = 0, emitted = 0, outputBytes = 0;
  const pending = new Map();
  runtime.setInterruptHandler(() => usedCpu + performance.now() - sliceStart > workerData.limits.cpuMs);
  const enter = fn => { sliceStart = performance.now(); try { return fn(); } finally { usedCpu += performance.now() - sliceStart; } };
  const bridge = vm.newFunction('__bridge', (operation, payload) => {
    const kind = vm.getString(operation), json = vm.getString(payload);
    if (fatal) return { error: vm.newError('Script limit reached') };
    if (kind === 'exit') { finish(null); return vm.undefined; }
    if (closed) return { error: vm.newError('Script closed') };
    if (kind === 'call') {
      if (++nextId > workerData.limits.calls || pending.size >= workerData.limits.concurrentCalls || Buffer.byteLength(json) > workerData.limits.argumentBytes) {
        fatal = 'CALL_LIMIT'; return { error: vm.newError('Call limit') };
      }
      const promise = vm.newPromise();
      pending.set(nextId, promise);
      send({ type: 'call', id: nextId, json });
      return promise.handle.dup();
    }
    if (kind === 'text' || kind === 'image') {
      const size = Buffer.byteLength(json);
      outputBytes += size;
      if (++emitted > workerData.limits.outputItems || size > workerData.limits.resultBytes || outputBytes > workerData.limits.outputBytes) {
        fatal = 'OUTPUT_LIMIT'; return { error: vm.newError('Output limit') };
      }
      send({ type: 'emit', kind, json });
      return vm.undefined;
    }
    fatal = 'BRIDGE_ERROR'; return { error: vm.newError('Invalid bridge operation') };
  });
  vm.setProp(vm.global, '__bridge', bridge); bridge.dispose();
  const setup = enter(() => vm.evalCode('(() => { ' +
    'const bridge = globalThis.__bridge; delete globalThis.__bridge; ' +
    'const stringify = JSON.stringify, parse = JSON.parse, String_ = String; ' +
    'const tools = Object.create(null); ' +
    'const entries = ' + JSON.stringify(workerData.tools) + '; ' +
    'for (const entry of entries) { Object.freeze(entry); tools[entry.name] = args => bridge("call", stringify({name:entry.name,args})).then(parse); } ' +
    'Object.defineProperties(globalThis, {' +
      'tools: {value:Object.freeze(tools)}, ALL_TOOLS:{value:Object.freeze(entries)}, ' +
      'text:{value:value => bridge("text", stringify(typeof value === "string" ? value : (stringify(value) ?? String_(value))))}, ' +
      'image:{value:value => bridge("image", stringify(value))}, ' +
      'exit:{value:() => { bridge("exit", "null"); throw undefined; }}' +
    '}); ' +
    (workerData.windowsDesktop ?
      'const sky = Object.create(null); ' +
      'for (const name of ${JSON.stringify(WINDOWS_COMPUTER_METHODS)}) { if (!tools[name]) continue; ' +
        'sky[name] = async (args = {}) => { const result = await tools[name](args); ' +
          'if (result.isError) { const message = (result.content || []).filter(item => item.type === "text").map(item => item.text).join("\\n"); ' +
            'text(message); throw new Error(message || "Desktop operation failed"); } ' +
          'if (!result.structuredContent || !("value" in result.structuredContent)) throw new Error("Invalid Desktop result"); ' +
          'const value = result.structuredContent.value; ' +
          'if (name === "get_window_state") { for (const part of result.content) { if (part.type === "image") image(part); } } ' +
          'return value === null ? undefined : value; }; } ' +
      'sky.target = "windows"; Object.defineProperties(globalThis, {sky:{value:Object.freeze(sky)}, nodeRepl:{value:Object.freeze({write:text})}}); '
      : '') +
    '})()'));
  if (setup.error) { setup.error.dispose(); finish('RUNTIME_ERROR'); return; }
  setup.value.dispose();
  let execution;
  const check = () => {
    if (closed) return;
    if (fatal) { finish(fatal); return; }
    if (usedCpu > workerData.limits.cpuMs) { finish('CPU_LIMIT'); return; }
    const jobs = enter(() => runtime.executePendingJobs(64));
    if (jobs.error) { jobs.error.dispose(); finish(usedCpu > workerData.limits.cpuMs ? 'CPU_LIMIT' : 'SCRIPT_ERROR'); return; }
    const state = enter(() => vm.getPromiseState(execution));
    if (state.type === 'rejected') { state.error.dispose(); finish(fatal || (usedCpu > workerData.limits.cpuMs ? 'CPU_LIMIT' : 'SCRIPT_ERROR')); return; }
    if (state.type === 'fulfilled') { state.value.dispose(); finish(fatal); return; }
    if (runtime.hasPendingJob()) setImmediate(check);
  };
  parentPort.on('message', message => {
    if (closed || message.type !== 'result') return;
    const promise = pending.get(message.id);
    if (!promise) return;
    pending.delete(message.id);
    enter(() => {
      const value = vm.newString(message.json);
      promise.resolve(value); value.dispose(); promise.dispose();
    });
    check();
  });
  const evaluated = enter(() => vm.evalCode(workerData.code, 'code-mode.mjs', { type: 'module' }));
  if (evaluated.error) { evaluated.error.dispose(); finish(fatal || (usedCpu > workerData.limits.cpuMs ? 'CPU_LIMIT' : 'SCRIPT_ERROR')); return; }
  execution = evaluated.value;
  check();
})().catch(() => finish('RUNTIME_ERROR'));
`;
