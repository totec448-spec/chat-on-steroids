import { z } from 'zod';
import { REASONING_EFFORTS } from './session.js';

// Browser-supplied diagnostics contain identities and enums, never captions, page text or props.
const model = z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/);
const effort = z.enum(REASONING_EFFORTS);
const pair = z.object({ model, effort }).strict();
// Native version IDs and legacy requested selectors may contain spaces.
const version = z.string().max(80).regex(/^[\p{L}\p{N}._: -]+$/u).nullable();
const phase = z.enum(['passive', 'trigger', 'chat-surface', 'open', 'read', 'enumerate-version', 'resolve', 'select-version', 'select-effort', 'restore-version', 'restore-effort', 'close']);
export const modelSelectionDiagnostic = z.object({
  attempt: z.number().int().min(1).max(2), phase, outcome: z.enum(['pending', 'confirmed', 'failed']),
  failure: z.enum(['unreadable', 'not-offered', 'ambiguous-model', 'ambiguous-choice', 'changed', 'mismatch', 'close-failed', 'owner-lost', 'unknown']).nullable(),
  failedPhase: phase.nullable(), failedVersion: version,
  requested: z.object({ model: version, effort: effort.nullable() }).strict(),
  resolved: pair.nullable(), before: pair.nullable(), selected: pair.nullable(), after: pair.nullable(),
  targetVersion: version, observedVersion: version,
  restore: z.enum(['not-needed', 'skipped', 'failed', 'confirmed']), closed: z.boolean().nullable(),
  offered: z.array(pair.extend({ available: z.boolean() }).strict()).max(16), offeredTruncated: z.boolean(),
  elapsedMs: z.number().int().min(0).max(600000), visibility: z.enum(['visible', 'hidden'])
}).strict();
export type ModelSelectionDiagnostic = z.infer<typeof modelSelectionDiagnostic>;
