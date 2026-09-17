/**
 * Bounded renderer-memory flight recorder.
 *
 * Ordinary samples live only in RAM. A threshold crossing or unusually large one-sample jump
 * publishes the preceding few minutes of numeric/boolean diagnostics under userData. No authored
 * text, ids, paths, URLs, image data or credentials are accepted by this module's type or IPC
 * schema. Snapshot count and bytes are independently bounded.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  RENDERER_MEMORY_HYSTERESIS_KIB,
  RENDERER_MEMORY_MAX_SNAPSHOT_BYTES,
  RENDERER_MEMORY_MAX_SNAPSHOTS,
  RENDERER_MEMORY_RING_SAMPLES,
  RENDERER_MEMORY_STEP_COOLDOWN_MS,
  RENDERER_MEMORY_STEP_KIB,
  RENDERER_MEMORY_THRESHOLDS_KIB,
  type RendererMemoryClientSample,
  type RendererMemoryFlightSample,
  type RendererMemoryLevel,
  type RendererMemorySnapshot,
  type RendererProcessMemory
} from '../shared/renderer-memory.js';

const SNAPSHOT_NAME = /^renderer-memory-\d{13}-\d+\.json$/;

const rendererMemoryCountersSchema = z.object({
  domNodes: z.number().int().nonnegative(),
  imageElements: z.number().int().nonnegative(),
  dataUrlImageChars: z.number().int().nonnegative(),
  sessionRows: z.number().int().nonnegative(),
  eventRows: z.number().int().nonnegative(),
  renderedTimelineRows: z.number().int().nonnegative(),
  rowCacheEntries: z.number().int().nonnegative(),
  toolGroups: z.number().int().nonnegative(),
  openTools: z.number().int().nonnegative(),
  eventTextChars: z.number().int().nonnegative(),
  inputDrafts: z.number().int().nonnegative(),
  inputDraftChars: z.number().int().nonnegative(),
  attachmentDrafts: z.number().int().nonnegative(),
  attachmentDraftBytes: z.number().int().nonnegative(),
  startingInputs: z.number().int().nonnegative(),
  pendingInputs: z.number().int().nonnegative(),
  taskPlans: z.number().int().nonnegative(),
  goalModels: z.number().int().nonnegative()
}).strict();

/** Exact IPC admission schema: extra fields are rejected so content cannot hitchhike. */
export const rendererMemoryClientSampleSchema = z.object({
  at: z.number().int().nonnegative(),
  hidden: z.boolean(),
  jsHeap: z.object({
    usedBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    limitBytes: z.number().int().nonnegative()
  }).strict().nullable(),
  counters: rendererMemoryCountersSchema
}).strict();

let root = '';
let ring: RendererMemoryFlightSample[] = [];
let sequence = 0;
let previousPrivateKiB: number | null = null;
let lastStepCaptureAt = 0;
let writeQueue: Promise<void> = Promise.resolve();
const armed: Record<RendererMemoryLevel, boolean> = { warning: true, high: true, critical: true };

export function initRendererMemoryDiagnostics(userDataDir: string): void {
  root = path.join(userDataDir, 'diagnostics', 'renderer-memory');
  ring = [];
  sequence = 0;
  previousPrivateKiB = null;
  lastStepCaptureAt = 0;
  writeQueue = Promise.resolve();
  armed.warning = true;
  armed.high = true;
  armed.critical = true;
}

function effectivePrivateKiB(memory: RendererProcessMemory): number {
  return memory.privateKiB ?? memory.workingSetKiB;
}

function rearm(privateKiB: number): void {
  for (const level of ['warning', 'high', 'critical'] as const) {
    if (privateKiB < RENDERER_MEMORY_THRESHOLDS_KIB[level] - RENDERER_MEMORY_HYSTERESIS_KIB) {
      armed[level] = true;
    }
  }
}

function thresholdReason(privateKiB: number): RendererMemoryLevel | null {
  for (const level of ['critical', 'high', 'warning'] as const) {
    if (privateKiB >= RENDERER_MEMORY_THRESHOLDS_KIB[level] && armed[level]) return level;
  }
  return null;
}

function disarmCrossed(privateKiB: number): void {
  for (const level of ['warning', 'high', 'critical'] as const) {
    if (privateKiB >= RENDERER_MEMORY_THRESHOLDS_KIB[level]) armed[level] = false;
  }
}

async function pruneSnapshots(): Promise<void> {
  let names: string[];
  try {
    names = (await fs.readdir(root)).filter(name => SNAPSHOT_NAME.test(name)).sort().reverse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(names.slice(RENDERER_MEMORY_MAX_SNAPSHOTS).map(name =>
    fs.rm(path.join(root, name), { force: true })
  ));
}

async function writeSnapshot(snapshot: RendererMemorySnapshot): Promise<void> {
  if (!root) return;
  const body = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (Buffer.byteLength(body, 'utf8') > RENDERER_MEMORY_MAX_SNAPSHOT_BYTES) return;
  await fs.mkdir(root, { recursive: true });
  const name = `renderer-memory-${snapshot.capturedAt}-${sequence++}.json`;
  const target = path.join(root, name);
  const temporary = `${target}.tmp`;
  try {
    await fs.writeFile(temporary, body, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
  await pruneSnapshots();
}

export async function recordRendererMemorySample(
  sample: RendererMemoryClientSample,
  processMemory: RendererProcessMemory,
  appVersion: string,
  observedAt = Date.now()
): Promise<boolean> {
  const privateKiB = effectivePrivateKiB(processMemory);
  rearm(privateKiB);
  const full: RendererMemoryFlightSample = { ...sample, observedAt, process: processMemory };
  ring.push(full);
  if (ring.length > RENDERER_MEMORY_RING_SAMPLES) ring.splice(0, ring.length - RENDERER_MEMORY_RING_SAMPLES);

  const level = thresholdReason(privateKiB);
  const deltaKiB = previousPrivateKiB === null ? 0 : Math.max(0, privateKiB - previousPrivateKiB);
  previousPrivateKiB = privateKiB;
  const step = !level && deltaKiB >= RENDERER_MEMORY_STEP_KIB &&
    observedAt - lastStepCaptureAt >= RENDERER_MEMORY_STEP_COOLDOWN_MS;
  if (!level && !step) return false;

  if (level) disarmCrossed(privateKiB);
  else lastStepCaptureAt = observedAt;
  const snapshot: RendererMemorySnapshot = {
    schemaVersion: 1,
    capturedAt: observedAt,
    appVersion,
    reason: level ? { kind: 'threshold', level } : { kind: 'step', deltaKiB },
    samples: ring.map(entry => ({ ...entry, counters: { ...entry.counters }, jsHeap: entry.jsHeap ? { ...entry.jsHeap } : null,
      process: { ...entry.process } }))
  };
  const write = writeQueue.then(() => writeSnapshot(snapshot));
  writeQueue = write.catch(() => undefined);
  await write;
  return true;
}

/** Test-only visibility into the bounded in-memory state; returns numeric diagnostics only. */
export function rendererMemoryRingForTests(): RendererMemoryFlightSample[] {
  return ring.map(entry => ({ ...entry, counters: { ...entry.counters }, jsHeap: entry.jsHeap ? { ...entry.jsHeap } : null,
    process: { ...entry.process } }));
}
