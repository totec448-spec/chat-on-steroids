import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  initRendererMemoryDiagnostics,
  recordRendererMemorySample,
  rendererMemoryClientSampleSchema,
  rendererMemoryRingForTests
} from '../src/main/renderer-memory.js';
import {
  RENDERER_MEMORY_MAX_SNAPSHOT_BYTES,
  RENDERER_MEMORY_MAX_SNAPSHOTS,
  RENDERER_MEMORY_RING_SAMPLES,
  type RendererMemoryClientSample,
  type RendererMemoryCounters,
  type RendererProcessMemory,
  type RendererMemorySnapshot
} from '../src/shared/renderer-memory.js';

const MiB = 1024;
const BASE_TIME = 1_800_000_000_000;

let userData = '';

const counters = (overrides: Partial<RendererMemoryCounters> = {}): RendererMemoryCounters => ({
  domNodes: 120,
  imageElements: 2,
  dataUrlImageChars: 0,
  sessionRows: 4,
  eventRows: 80,
  renderedTimelineRows: 40,
  rowCacheEntries: 40,
  toolGroups: 3,
  openTools: 1,
  eventTextChars: 60_000,
  inputDrafts: 1,
  inputDraftChars: 400,
  attachmentDrafts: 0,
  attachmentDraftBytes: 0,
  startingInputs: 0,
  pendingInputs: 1,
  taskPlans: 0,
  goalModels: 0,
  ...overrides
});

const sample = (at: number, overrides: Partial<RendererMemoryClientSample> = {}): RendererMemoryClientSample => ({
  at,
  hidden: false,
  jsHeap: { usedBytes: 32 * 1024 * 1024, totalBytes: 48 * 1024 * 1024, limitBytes: 4 * 1024 * 1024 * 1024 },
  counters: counters(),
  ...overrides
});

const memory = (privateMiB: number, peakMiB = privateMiB): RendererProcessMemory => ({
  pid: 15484,
  privateKiB: privateMiB * MiB,
  workingSetKiB: Math.max(1, privateMiB - 8) * MiB,
  peakWorkingSetKiB: peakMiB * MiB
});

const diagnosticDir = () => path.join(userData, 'diagnostics', 'renderer-memory');

async function snapshotFiles(): Promise<string[]> {
  try {
    return (await fs.readdir(diagnosticDir())).filter(name => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function readLatest(): Promise<{ body: string; parsed: RendererMemorySnapshot }> {
  const names = await snapshotFiles();
  const body = await fs.readFile(path.join(diagnosticDir(), names.at(-1)!), 'utf8');
  return { body, parsed: JSON.parse(body) as RendererMemorySnapshot };
}

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-renderer-memory-'));
  initRendererMemoryDiagnostics(userData);
});

afterEach(async () => {
  await fs.rm(userData, { recursive: true, force: true });
});

it('admits only the numeric/boolean privacy schema and rejects content hitchhiking', () => {
  const safe = sample(BASE_TIME);
  expect(rendererMemoryClientSampleSchema.parse(safe)).toEqual(safe);
  for (const extra of [
    { message: 'secret transcript text' },
    { path: 'C:\\private\\source.ts' },
    { url: 'https://private.example/' },
    { credential: 'sk-do-not-record' }
  ]) {
    expect(() => rendererMemoryClientSampleSchema.parse({ ...safe, ...extra })).toThrow();
  }
  expect(() => rendererMemoryClientSampleSchema.parse({
    ...safe,
    counters: { ...safe.counters, title: 'private session title' }
  })).toThrow();
  expect(() => rendererMemoryClientSampleSchema.parse({
    ...safe,
    jsHeap: { ...safe.jsHeap!, label: 'secret' }
  })).toThrow();
});

it('keeps ordinary samples in a bounded RAM ring and writes nothing below a trigger', async () => {
  for (let index = 0; index < RENDERER_MEMORY_RING_SAMPLES + 9; index++) {
    expect(await recordRendererMemorySample(
      sample(BASE_TIME + index * 15_000, { counters: counters({ domNodes: 100 + index }) }),
      memory(180),
      '2.1.12',
      BASE_TIME + index * 15_000
    )).toBe(false);
  }
  expect(rendererMemoryRingForTests()).toHaveLength(RENDERER_MEMORY_RING_SAMPLES);
  expect(rendererMemoryRingForTests()[0]!.counters.domNodes).toBe(109);
  expect(await snapshotFiles()).toEqual([]);
});

it('captures the preceding ring on a threshold crossing and rearms only below hysteresis', async () => {
  expect(await recordRendererMemorySample(sample(BASE_TIME), memory(300), '2.1.12', BASE_TIME)).toBe(false);
  expect(await recordRendererMemorySample(sample(BASE_TIME + 15_000), memory(540), '2.1.12', BASE_TIME + 15_000)).toBe(true);
  expect(await snapshotFiles()).toHaveLength(1);
  let { body, parsed } = await readLatest();
  expect(parsed.reason).toEqual({ kind: 'threshold', level: 'warning' });
  expect(parsed.samples).toHaveLength(2);
  expect(parsed.samples.at(-1)?.process.privateKiB).toBe(540 * MiB);
  expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(RENDERER_MEMORY_MAX_SNAPSHOT_BYTES);

  // Still above the 512 MiB warning line: no duplicate snapshot.
  expect(await recordRendererMemorySample(sample(BASE_TIME + 30_000), memory(600), '2.1.12', BASE_TIME + 30_000)).toBe(false);
  expect(await snapshotFiles()).toHaveLength(1);
  // Warning rearms only after falling below 512 - 128 = 384 MiB.
  expect(await recordRendererMemorySample(sample(BASE_TIME + 45_000), memory(370), '2.1.12', BASE_TIME + 45_000)).toBe(false);
  expect(await recordRendererMemorySample(sample(BASE_TIME + 60_000), memory(530), '2.1.12', BASE_TIME + 60_000)).toBe(true);
  expect(await snapshotFiles()).toHaveLength(2);
  ({ body, parsed } = await readLatest());
  expect(parsed.reason).toEqual({ kind: 'threshold', level: 'warning' });
  expect(body).not.toContain('secret transcript text');
});

it('records the highest crossed severity once and a large sub-threshold step with cooldown', async () => {
  expect(await recordRendererMemorySample(sample(BASE_TIME), memory(200), '2.1.12', BASE_TIME)).toBe(false);
  expect(await recordRendererMemorySample(sample(BASE_TIME + 15_000), memory(1100), '2.1.12', BASE_TIME + 15_000)).toBe(true);
  expect((await readLatest()).parsed.reason).toEqual({ kind: 'threshold', level: 'critical' });
  expect(await snapshotFiles()).toHaveLength(1);

  initRendererMemoryDiagnostics(userData);
  expect(await recordRendererMemorySample(sample(BASE_TIME), memory(90), '2.1.12', BASE_TIME)).toBe(false);
  expect(await recordRendererMemorySample(sample(BASE_TIME + 15_000), memory(390), '2.1.12', BASE_TIME + 15_000)).toBe(true);
  expect((await readLatest()).parsed.reason).toEqual({ kind: 'step', deltaKiB: 300 * MiB });
  const count = (await snapshotFiles()).length;
  expect(await recordRendererMemorySample(sample(BASE_TIME + 30_000), memory(80), '2.1.12', BASE_TIME + 30_000)).toBe(false);
  expect(await recordRendererMemorySample(sample(BASE_TIME + 45_000), memory(380), '2.1.12', BASE_TIME + 45_000)).toBe(false);
  expect(await snapshotFiles()).toHaveLength(count);
});

it('bounds durable diagnostics to the newest snapshot count', async () => {
  let at = BASE_TIME;
  for (let index = 0; index < RENDERER_MEMORY_MAX_SNAPSHOTS + 3; index++) {
    expect(await recordRendererMemorySample(sample(at), memory(300), '2.1.12', at)).toBe(false);
    at += 15_000;
    expect(await recordRendererMemorySample(sample(at), memory(530), '2.1.12', at)).toBe(true);
    at += 15_000;
  }
  const names = await snapshotFiles();
  expect(names).toHaveLength(RENDERER_MEMORY_MAX_SNAPSHOTS);
  for (const name of names) {
    expect((await fs.stat(path.join(diagnosticDir(), name))).size).toBeLessThanOrEqual(RENDERER_MEMORY_MAX_SNAPSHOT_BYTES);
  }
  const parsed = JSON.parse(await fs.readFile(path.join(diagnosticDir(), names.at(-1)!), 'utf8')) as RendererMemorySnapshot;
  expect(Object.keys(parsed).sort()).toEqual(['appVersion', 'capturedAt', 'reason', 'samples', 'schemaVersion']);
  expect(Object.keys(parsed.samples.at(-1)!.process).sort()).toEqual(['peakWorkingSetKiB', 'pid', 'privateKiB', 'workingSetKiB']);
  expect(Object.values(parsed.samples.at(-1)!.counters).every(value => typeof value === 'number')).toBe(true);
});
