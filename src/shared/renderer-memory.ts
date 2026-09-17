/**
 * Privacy-preserving renderer memory diagnostics.
 *
 * This wire shape is deliberately numeric/boolean only. Renderer memory incidents must remain
 * diagnosable without copying conversations, tool results, file names, URLs or credentials into
 * another durable store. Main validates this exact shape before it can reach the flight recorder.
 */

export const RENDERER_MEMORY_SAMPLE_INTERVAL_MS = 15_000;
export const RENDERER_MEMORY_RING_SAMPLES = 24;
export const RENDERER_MEMORY_MAX_SNAPSHOTS = 12;
export const RENDERER_MEMORY_MAX_SNAPSHOT_BYTES = 64 * 1024;

export const RENDERER_MEMORY_THRESHOLDS_KIB = {
  warning: 512 * 1024,
  high: 768 * 1024,
  critical: 1024 * 1024
} as const;

export const RENDERER_MEMORY_HYSTERESIS_KIB = 128 * 1024;
export const RENDERER_MEMORY_STEP_KIB = 256 * 1024;
export const RENDERER_MEMORY_STEP_COOLDOWN_MS = 10 * 60 * 1000;

export type RendererMemoryLevel = 'warning' | 'high' | 'critical';

export interface RendererMemoryCounters {
  domNodes: number;
  imageElements: number;
  dataUrlImageChars: number;
  sessionRows: number;
  eventRows: number;
  renderedTimelineRows: number;
  rowCacheEntries: number;
  toolGroups: number;
  openTools: number;
  eventTextChars: number;
  inputDrafts: number;
  inputDraftChars: number;
  attachmentDrafts: number;
  attachmentDraftBytes: number;
  startingInputs: number;
  pendingInputs: number;
  taskPlans: number;
  goalModels: number;
}

export interface RendererMemoryClientSample {
  at: number;
  hidden: boolean;
  jsHeap: {
    usedBytes: number;
    totalBytes: number;
    limitBytes: number;
  } | null;
  counters: RendererMemoryCounters;
}

export interface RendererProcessMemory {
  pid: number;
  privateKiB: number | null;
  workingSetKiB: number;
  peakWorkingSetKiB: number;
}

export interface RendererMemoryFlightSample extends RendererMemoryClientSample {
  observedAt: number;
  process: RendererProcessMemory;
}

export type RendererMemoryCaptureReason =
  | { kind: 'threshold'; level: RendererMemoryLevel }
  | { kind: 'step'; deltaKiB: number };

export interface RendererMemorySnapshot {
  schemaVersion: 1;
  capturedAt: number;
  appVersion: string;
  reason: RendererMemoryCaptureReason;
  samples: RendererMemoryFlightSample[];
}
