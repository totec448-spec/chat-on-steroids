import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { CODE_MODE_WORKER_SOURCE } from './code-mode-worker.js';
import type { ToolContent, ToolResult } from './kernel.js';
import { validateImageBytes, MAX_VIEW_IMAGE_BYTES } from '../codex/view-image.js';

export const CODE_MODE_LIMITS = Object.freeze({
  codeChars: 64_000, cpuMs: 2_000, wallMs: 60_000, memoryBytes: 32 * 1024 * 1024,
  calls: 32, concurrentCalls: 8, argumentBytes: 1024 * 1024, resultBytes: 12 * 1024 * 1024,
  totalResultBytes: 32 * 1024 * 1024, outputBytes: 12 * 1024 * 1024, outputItems: 32,
  textBytes: 40_000, images: 4, activeRuns: 4
});
export const codeModeSchema = z.object({ code: z.string().min(1).max(CODE_MODE_LIMITS.codeChars)
  .describe('Raw JavaScript source with top-level await. Emit results with text(...) or image(...).') }).strict();
export type CodeModeTool = { name: string; description: string };
export type CodeModeOptions = { windowsDesktop?: boolean };
const requireRuntime = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
let activeRuns = 0;

/** Decode before emitting through the same image authority as view_image. Never fetch a URL. */
async function emittedImage(value: unknown): Promise<ToolContent> {
  let data: unknown, mime: unknown;
  if (typeof value === 'string' || (value && typeof value === 'object' && 'image_url' in value)) {
    const url = typeof value === 'string' ? value : (value as { image_url: unknown }).image_url;
    if (typeof url !== 'string') throw new Error('IMAGE_INVALID');
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
    if (!match) throw new Error('IMAGE_INVALID');
    [, mime, data] = match;
  } else if (value && typeof value === 'object' && 'type' in value && value.type === 'image') {
    ({ data, mimeType: mime } = value as { data?: unknown; mimeType?: unknown });
  }
  if (typeof data !== 'string' || typeof mime !== 'string' || data.length > Math.ceil(MAX_VIEW_IMAGE_BYTES / 3) * 4 ||
      data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('IMAGE_INVALID');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) throw new Error('IMAGE_INVALID');
  const actual = await validateImageBytes(bytes);
  if (mime !== actual && mime !== 'application/octet-stream') throw new Error('IMAGE_INVALID');
  return { type: 'image', data: bytes.toString('base64'), mimeType: actual };
}

/** A fresh interpreter per call. Accepted child operations retain their dispatcher lifetime
 * after interpreter termination; this owner never pretends a filesystem/process action rolled back. */
export async function runCodeMode(
  code: string, tools: CodeModeTool[], invoke: (name: string, args: unknown) => Promise<ToolResult>,
  limits: { [Key in keyof typeof CODE_MODE_LIMITS]: number } = CODE_MODE_LIMITS,
  options: CodeModeOptions = {}
): Promise<ToolResult> {
  const errorResult = (reason: string): ToolResult => ({ content: [{ type: 'text', text: `CODE_MODE_${reason}` }], isError: true });
  if (!code.trim() || code.length > limits.codeChars) return errorResult('CODE_LIMIT');
  if (activeRuns >= limits.activeRuns) return errorResult('BUSY: too many code executions or unsettled nested calls.');
  // Yield/resume requires another durable lifecycle. Keep this endpoint one bounded call;
  // ordinary exec_command/write_stdin already own long-running process continuations.
  if (/^\s*\/\/ @exec:/m.test(code)) return errorResult('UNSUPPORTED_PRAGMA: use plain JavaScript; execution is bounded to one call.');
  activeRuns++;
  const pending = new Set<Promise<void>>();
  const emissions: Array<{ kind: 'text' | 'image'; json: string }> = [];
  let worker: Worker | undefined, ended = false, calls = 0, resultBytes = 0, emittedBytes = 0;
  let textBytes = 0, images = 0;
  const allowed = new Set(tools.map(tool => tool.name));
  try {
    const status = await new Promise<string | null>(resolve => {
      const finish = (reason: string | null) => {
        if (ended) return;
        ended = true; clearTimeout(timer);
        void worker?.terminate();
        resolve(reason);
      };
      const timer = setTimeout(() => finish('TIME_LIMIT'), limits.wallMs);
      try {
        worker = new Worker(CODE_MODE_WORKER_SOURCE, { eval: true, workerData: {
          code, tools, limits, windowsDesktop: options.windowsDesktop === true, coreModule: requireRuntime.resolve('quickjs-emscripten-core'),
          wasmModule: requireRuntime.resolve('@jitl/quickjs-wasmfile-release-sync')
        }, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
      } catch { finish('RUNTIME_ERROR'); return; }
      worker.on('error', () => finish('RUNTIME_ERROR'));
      worker.on('exit', code => { if (!ended) finish(code === 0 ? null : 'RUNTIME_ERROR'); });
      worker.on('message', (message: { type: string; id?: number; json?: string; kind?: string; error?: string | null }) => {
        if (ended) return;
        if (message.type === 'done') { finish(message.error ?? null); return; }
        if (typeof message.json !== 'string') { finish('BRIDGE_ERROR'); return; }
        const bytes = Buffer.byteLength(message.json);
        if (message.type === 'emit') {
          if ((message.kind !== 'text' && message.kind !== 'image') || emissions.length >= limits.outputItems ||
              bytes > limits.resultBytes || (emittedBytes += bytes) > limits.outputBytes) { finish('OUTPUT_LIMIT'); return; }
          if (message.kind === 'text' ? (textBytes += bytes) > limits.textBytes : ++images > limits.images) { finish('OUTPUT_LIMIT'); return; }
          emissions.push({ kind: message.kind, json: message.json });
          return;
        }
        if (message.type !== 'call' || !Number.isSafeInteger(message.id) || calls >= limits.calls ||
            pending.size >= limits.concurrentCalls || bytes > limits.argumentBytes) { finish('CALL_LIMIT'); return; }
        const id = message.id;
        let request: { name: string; args?: unknown };
        try { request = JSON.parse(message.json); } catch { finish('BRIDGE_ERROR'); return; }
        if (!allowed.has(request.name)) { finish('UNKNOWN_TOOL'); return; }
        // Admission is synchronous. No late worker message may start another action after finish.
        calls++;
        const work = Promise.resolve().then(() => invoke(request.name, request.args)).then(result => {
          if (ended) return;
          const json = JSON.stringify(result);
          const bytes = Buffer.byteLength(json);
          if (bytes > limits.resultBytes || (resultBytes += bytes) > limits.totalResultBytes) { finish('RESULT_LIMIT'); return; }
          worker!.postMessage({ type: 'result', id, json });
        }, () => { if (!ended) worker!.postMessage({ type: 'result', id, json: JSON.stringify(errorResult('TOOL_ERROR')) }); })
          .catch(() => finish('RESULT_INVALID'));
        pending.add(work);
        void work.then(() => pending.delete(work));
      });
    });
    const content: ToolContent[] = [];
    for (const emission of emissions) {
      try {
        const value: unknown = JSON.parse(emission.json);
        if (emission.kind === 'text' && typeof value === 'string') content.push({ type: 'text', text: value });
        else if (emission.kind === 'image') content.push(await emittedImage(value));
        else throw new Error('OUTPUT_INVALID');
      } catch { return { content: [...content, ...errorResult('OUTPUT_INVALID: image or text could not be validated.').content], isError: true }; }
    }
    if (status) {
      const effects = calls
        ? `${calls} tool calls already dispatched; side effects were not rolled back. Inspect current state before retrying.`
        : 'No tool calls were dispatched.';
      content.push(...errorResult(`${status}: execution stopped. ${effects} Unemitted values remain private.`).content);
    }
    if (pending.size) content.push(...errorResult('UNAWAITED_CALLS: dispatched tool calls are still running and remain recorded. Side effects were not cancelled.').content);
    return { content, ...(status || pending.size ? { isError: true } : {}) };
  } finally {
    ended = true;
    await worker?.terminate();
    // Do not allow fire-and-forget scripts to evade the global host-work bound.
    if (pending.size) void Promise.allSettled([...pending]).then(() => { activeRuns--; });
    else activeRuns--;
  }
}
