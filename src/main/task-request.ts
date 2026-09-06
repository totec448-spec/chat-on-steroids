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
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(new Error('task_cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, ms);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
export function runTaskRequest<T>(id: string, fingerprint: string, work: (signal: AbortSignal) => Promise<T>,
  publish: (progress: TaskProgressUpdate) => void): Promise<T> {
  const previous = requests.get(id);
  if (previous) return previous.fingerprint === fingerprint ? previous.promise as Promise<T> : Promise.reject(new Error('task_request_conflict'));
  for (const [key, request] of requests) { if (requests.size < 64) break; if (request.settled) requests.delete(key); }
  if (requests.size >= 64) return Promise.reject(new Error('too_many_task_requests'));
  const controller = new AbortController(), startedAt = Date.now();
  const row: Request = { fingerprint, controller, promise: Promise.resolve(), settled: false };
  requests.set(id, row);
  row.promise = (async () => {
    try {
      for (let attempt = 1; ; attempt++) {
        if (controller.signal.aborted) throw new Error('task_cancelled');
        try {
          const result = await work(controller.signal);
          if (controller.signal.aborted) throw new Error('task_cancelled');
          return result;
        } catch (error) {
          if (controller.signal.aborted) throw new Error('task_cancelled');
          const delay = error instanceof TaskRequestError ? Math.max(1000, error.retryAfterMs ?? 15000) : 0;
          if (!(error instanceof TaskRequestError) || !error.retryable || attempt >= 3 || Date.now() + delay - startedAt > 180000) throw error;
          publish({ phase: 'retrying', text: '', error: error.message, attempt: attempt + 1, retryAt: Date.now() + delay });
          await wait(delay, controller.signal);
        }
      }
    } catch (error) {
      publish({ phase: controller.signal.aborted ? 'cancelled' : 'failed', text: '', error: error instanceof Error ? error.message : 'task_failed' });
      throw error;
    } finally { row.settled = true; }
  })();
  return row.promise as Promise<T>;
}
