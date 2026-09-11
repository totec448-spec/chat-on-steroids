/**
 * Small durable JSON files in the app's user-data folder.
 *
 * Two things outlive a restart but are not session history: the multi-agent run's
 * state, and the queue of commands waiting for the Chrome extension. Both are tiny,
 * both are rewritten whole, and losing either one silently is the failure that matters
 * — a pending worker→prime message or a "resume in a new chat" command that evaporates
 * because the app was reopened is exactly the class of loss this app exists to prevent.
 *
 * So: write to a temp file, rename over the target (atomic on NTFS), and coalesce
 * bursts on a short timer so a chatty broker does not rewrite the file per message.
 * A parse failure returns null rather than throwing — a corrupt state file must cost
 * the pending work, never the app's ability to start.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logWarn } from './logger.js';

const WRITE_DELAY_MS = 300;
const RETRY_MAX_MS = 5_000;

let root = '';
interface PendingWrite {
  generation: number;
  value: unknown;
  snapshot?: () => unknown;
  background?: boolean;
  work?: Promise<void>;
}

const pending = new Map<string, PendingWrite>();
const timers = new Map<string, NodeJS.Timeout>();
const retryAttempts = new Map<string, number>();
const inFlight = new Map<string, Promise<void>>();
let nextGeneration = 1;

export function initDurableStore(userDataDir: string): void {
  root = path.join(userDataDir, 'state');
}

export function durableStoreReady(): boolean {
  return root !== '';
}

function fileFor(name: string): string {
  if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error(`Invalid durable state name: ${name}`);
  return path.join(root, `${name}.json`);
}

export async function readDurable<T>(name: string): Promise<T | null> {
  if (!root) return null;
  try {
    const raw = await fs.readFile(fileFor(name), 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && code !== 'ENOENT') {
      logWarn(`could not read ${name} state: ${(err as Error).message}`);
    }
    return null;
  }
}

function nextWrite(value: unknown): PendingWrite {
  return { generation: nextGeneration++, value };
}

function enqueue(name: string, write: () => Promise<void>): Promise<void> {
  const queued = (inFlight.get(name) ?? Promise.resolve()).then(write);
  // Only generations of the same file share a temp path and require serialization.
  // Cross-file transaction boundaries belong to the caller's explicit await.
  const tracked = queued.catch(() => undefined).then(() => {
    if (inFlight.get(name) === tracked) inFlight.delete(name);
  });
  inFlight.set(name, tracked);
  return queued;
}

function enqueueSlot(name: string, slot: PendingWrite): Promise<void> {
  if (slot.work) return slot.work;
  const work = enqueue(name, () => flushOne(name, slot));
  slot.work = work;
  const settled = (): void => { delete slot.work; };
  void work.then(settled, settled);
  return work;
}

function schedule(name: string, delay: number): void {
  if (timers.has(name) || !pending.has(name)) return;
  const timer = setTimeout(() => {
    timers.delete(name);
    const slot = pending.get(name);
    if (!slot) return;
    void enqueueSlot(name, slot).catch(() => scheduleRetry(name));
  }, delay);
  timer.unref?.();
  timers.set(name, timer);
}

function scheduleRetry(name: string): void {
  if (!pending.has(name) || timers.has(name)) return;
  const attempt = (retryAttempts.get(name) ?? 0) + 1;
  retryAttempts.set(name, attempt);
  const delay = Math.min(RETRY_MAX_MS, WRITE_DELAY_MS * 2 ** Math.min(attempt, 4));
  schedule(name, delay);
}

async function flushOne(name: string, slot: PendingWrite): Promise<void> {
  if (slot.background && pending.get(name) !== slot) return;
  const target = fileFor(name);
  const tmp = `${target}.tmp`;
  try {
    // Capture once, synchronously at the write boundary. A failed disk write retries this
    // exact value; later live mutations must not silently alter its generation.
    if (slot.snapshot) {
      slot.value = slot.snapshot();
      delete slot.snapshot;
    }
    await fs.mkdir(root, { recursive: true });
    if (slot.value === null) {
      await fs.rm(target, { force: true });
    } else {
      await fs.writeFile(tmp, JSON.stringify(slot.value), 'utf8');
      await fs.rename(tmp, target);
    }
  } catch (err) {
    logWarn(`could not save ${name} state: ${(err as Error).message}`);
    throw err;
  }

  // A newer generation may have arrived while this one was on disk. Completing the older
  // write is still useful, but it must never erase the newer pending snapshot.
  if (pending.get(name)?.generation === slot.generation) {
    pending.delete(name);
    retryAttempts.delete(name);
  }
}

/** Queues a write. Repeated calls before the timer fires collapse into one. */
export function writeDurableSoon(name: string, value: unknown): void {
  if (!root) return;
  pending.set(name, { ...nextWrite(value), background: true });
  if (timers.has(name)) return;
  schedule(name, WRITE_DELAY_MS);
}

/** Coalesces background projections before allocating a snapshot. Never use for a commit barrier. */
export function writeDurableSnapshotSoon(name: string, snapshot: () => unknown): void {
  if (!root) return;
  pending.set(name, { ...nextWrite(undefined), snapshot, background: true });
  schedule(name, WRITE_DELAY_MS);
}

/**
 * Atomically writes one named state before returning.
 *
 * Used for transaction intent immediately before another durable commit: a debounced
 * snapshot is correct for ordinary progress, but cannot close a crash window between two
 * files when recovery needs to know which side of the boundary the process reached.
 */
export async function writeDurableNow(name: string, value: unknown): Promise<void> {
  if (!root) return;
  const timer = timers.get(name);
  if (timer) {
    clearTimeout(timer);
    timers.delete(name);
  }
  const slot = nextWrite(value);
  pending.set(name, slot);
  try {
    // Flush this exact generation even if a newer debounced value arrives while it waits in
    // the serialization queue. Transactional callers need proof that *their* boundary landed,
    // not merely that some later state happened to be written instead.
    await enqueueSlot(name, slot);
  } catch (err) {
    // Keep the newest pending generation recoverable. Callers which deliberately roll a
    // failed staged transition back can supersede it by queueing their safe snapshot.
    scheduleRetry(name);
    throw err;
  }
}

/** Writes everything queued right now. Called before the app quits, and by tests. */
export async function flushDurable(): Promise<void> {
  for (const [name, timer] of timers) {
    clearTimeout(timer);
    timers.delete(name);
  }
  // A failed background write deliberately survives without a timer until retry scheduling,
  // so shutdown must look at pending state itself rather than treating `timers` as authority.
  for (;;) {
    const entries = [...pending.entries()];
    const active = [...inFlight.values()];
    if (entries.length === 0 && active.length === 0) return;
    // Start pending independent files before waiting for a busy file. Reuse an admitted
    // generation's promise so shutdown cannot write an immediate commit twice.
    const results = await Promise.allSettled([...active, ...entries.map(([name, slot]) => enqueueSlot(name, slot))]);
    // Every independent file gets its shutdown attempt, even when another fails.
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
}

/** Test seam: drops queued writes without touching disk. */
export function resetDurableForTests(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  pending.clear();
  retryAttempts.clear();
  root = '';
  nextGeneration = 1;
  inFlight.clear();
}
