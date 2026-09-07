import type { TaskProgressUpdate } from '../shared/task-progress.js';

/** One explicit native invocation, including its bounded pre-delivery retries. */
export class TaskRequestError extends Error {
  constructor(message: string, readonly retryable = false, readonly retryAfterMs?: number) { super(message); }
}
type Request = { fingerprint: string; controller: AbortController; promise: Promise<unknown>; settled: boolean };
const requests = new Map<string, Request>();
export function cancelTaskRequest(id: string): boolean {
  const request = requests.get(id);
  if (!request || request.settled) return false;
  request.controller.abort(); return true;
}
async function wait(ms: number, signal: AbortSignal): Promise<void> {
  // Node clamps an overflowing timeout to 1 ms. Long Retry-After values must wait,
  // not turn a provider's backoff into an immediate request loop.
  while (ms > 0) {
    const interval = Math.min(ms, 2147483647);
    await new Promise<void>((resolve, reject) => {
      const aborted = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(new Error('task_cancelled')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, interval);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    });
    ms -= interval;
  }
}
/** Retry only classified pre-delivery failures; the caller owns cancellation and publication. */
export async function retryTaskRequest<T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal,
  publish: (progress: TaskProgressUpdate) => void,
  limits: { attempts: number; durationMs: number } = { attempts: Infinity, durationMs: Infinity }): Promise<T> {
  const startedAt = Date.now();
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    try {
      const result = await work(signal);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      const delay = error instanceof TaskRequestError ? Math.max(1000, error.retryAfterMs ?? 15000) : 0;
      if (!(error instanceof TaskRequestError) || !error.retryable || attempt >= limits.attempts || Date.now() + delay - startedAt > limits.durationMs) throw error;
      publish({ phase: 'retrying', text: '', error: error.message, attempt: attempt + 1, retryAt: Date.now() + delay });
      await wait(delay, signal);
    }
  }
}
export function runTaskRequest<T>(id: string, fingerprint: string, work: (signal: AbortSignal) => Promise<T>,
  publish: (progress: TaskProgressUpdate) => void): Promise<T> {
  const previous = requests.get(id);
  if (previous) return previous.fingerprint === fingerprint ? previous.promise as Promise<T> : Promise.reject(new Error('task_request_conflict'));
  for (const [key, request] of requests) { if (requests.size < 64) break; if (request.settled) requests.delete(key); }
  if (requests.size >= 64) return Promise.reject(new Error('too_many_task_requests'));
  const controller = new AbortController();
  const row: Request = { fingerprint, controller, promise: Promise.resolve(), settled: false };
  requests.set(id, row);
  row.promise = (async () => {
    try {
      return await retryTaskRequest(work, controller.signal, publish, { attempts: 3, durationMs: 180000 });
    } catch (error) {
      publish({ phase: controller.signal.aborted ? 'cancelled' : 'failed', text: '', error: error instanceof Error ? error.message : 'task_failed' });
      if (controller.signal.aborted) throw new Error('task_cancelled');
      throw error;
    } finally { row.settled = true; }
  })();
  return row.promise as Promise<T>;
}
