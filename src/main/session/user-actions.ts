import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { rawPromises as fs } from '../rawfs.js';
import {
  getSession,
  sessionsRoot
} from './store.js';
import type {
  UserActionReceiptInput,
  UserActionRequest,
  UserActionRequestInput
} from '../../shared/user-action.js';

export const MAX_USER_ACTIONS = 64;
export const MAX_USER_ACTION_LEDGER_BYTES = 512 * 1024;

const command = z.string().min(1).max(24_000);
const shell = z.string().min(1).max(200);
const cwd = z.string().min(1).max(32_768);
const prose = z.string().min(1).max(4_000);
const item = z.string().min(1).max(2_000);
const items = z.array(item).max(16);
const receiptInputSchema = z.object({
  outcome: z.enum(['reported_executed', 'reported_failed', 'cancelled']),
  note: prose.optional(),
  evidence: items.optional()
}).strict();
const requestInputSchema = z.object({
  command,
  shell,
  cwd,
  purpose: prose,
  reportedProviderReason: prose.optional(),
  reportedRiskNote: prose.optional(),
  constraints: items.optional(),
  expectedEvidence: items.optional()
}).strict();
const receiptSchema = z.object({
  outcome: z.enum(['reported_executed', 'reported_failed', 'cancelled']),
  reportedAt: z.number().int().nonnegative(),
  note: prose.optional(),
  evidence: items
}).strict();
const requestSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.number().int().nonnegative(),
  command,
  shell,
  cwd,
  purpose: prose,
  reportedProviderReason: prose.optional(),
  reportedRiskNote: prose.optional(),
  constraints: items,
  expectedEvidence: items,
  receipt: receiptSchema.optional()
}).strict();
const ledgerSchema = z.object({
  version: z.literal(1),
  rows: z.array(requestSchema).max(MAX_USER_ACTIONS)
}).strict();

type Ledger = z.infer<typeof ledgerSchema>;
const mutationQueues = new Map<string, Promise<void>>();

export class UserActionSessionNotFoundError extends Error {
  constructor() { super('Session not found'); }
}

function fileFor(sessionId: string): string {
  return path.join(sessionsRoot(), sessionId, 'user-actions.json');
}

async function ensureSession(sessionId: string): Promise<void> {
  if (!(await getSession(sessionId))) throw new UserActionSessionNotFoundError();
}

async function readLedger(sessionId: string): Promise<Ledger> {
  const file = fileFor(sessionId);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(file, 'r');
    const bytes = Buffer.alloc(MAX_USER_ACTION_LEDGER_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_USER_ACTION_LEDGER_BYTES) throw new Error('User action ledger exceeds its storage budget');
    if (bytesRead === 0) throw new Error('User action ledger is invalid or corrupt');
    let parsed: unknown;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
      parsed = JSON.parse(text);
    } catch {
      throw new Error('User action ledger is invalid or corrupt');
    }
    const ledger = ledgerSchema.safeParse(parsed);
    if (!ledger.success) throw new Error('User action ledger is invalid or corrupt');
    if (new Set(ledger.data.rows.map(row => row.id)).size !== ledger.data.rows.length) {
      throw new Error('User action ledger is invalid or corrupt');
    }
    return ledger.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, rows: [] };
    throw error;
  } finally {
    await handle?.close();
  }
}

async function writeLedger(sessionId: string, ledger: Ledger): Promise<void> {
  const serialized = JSON.stringify(ledger, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_USER_ACTION_LEDGER_BYTES) {
    throw new Error('User action ledger exceeds its storage budget');
  }
  const dir = path.join(sessionsRoot(), sessionId);
  const target = fileFor(sessionId);
  const tmp = path.join(dir, `.user-actions.${process.pid}.${randomUUID()}.tmp`);
  // Never create a session directory here. A deletion racing this writer must win or make the
  // write fail; this feature is not another owner of session lifetime.
  const stat = await fs.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) throw new UserActionSessionNotFoundError();
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(tmp, 'wx');
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    // Catch deletion after the mutation began. Even if it races after this check, rename cannot
    // recreate the directory, and a later delete removes the committed file.
    await ensureSession(sessionId);
    await fs.rename(tmp, target);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

function enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(sessionId) ?? Promise.resolve();
  const work = previous.then(operation);
  const settled = work.then(() => undefined, () => undefined);
  mutationQueues.set(sessionId, settled);
  void settled.finally(() => {
    if (mutationQueues.get(sessionId) === settled) mutationQueues.delete(sessionId);
  });
  return work;
}

function sameReceipt(
  existing: UserActionRequest['receipt'],
  input: z.infer<typeof receiptInputSchema>
): boolean {
  return !!existing && existing.outcome === input.outcome && existing.note === input.note &&
    JSON.stringify(existing.evidence) === JSON.stringify(input.evidence ?? []);
}

export function createUserActionRequest(sessionId: string, input: UserActionRequestInput): Promise<UserActionRequest> {
  const normalized = requestInputSchema.parse(input);
  return enqueue(sessionId, async () => {
    await ensureSession(sessionId);
    const ledger = await readLedger(sessionId);
    if (ledger.rows.length >= MAX_USER_ACTIONS) throw new Error('User action request limit reached');
    const row: UserActionRequest = {
      id: randomUUID(),
      createdAt: Date.now(),
      command: normalized.command,
      shell: normalized.shell,
      cwd: normalized.cwd,
      purpose: normalized.purpose,
      ...(normalized.reportedProviderReason ? { reportedProviderReason: normalized.reportedProviderReason } : {}),
      ...(normalized.reportedRiskNote ? { reportedRiskNote: normalized.reportedRiskNote } : {}),
      constraints: [...(normalized.constraints ?? [])],
      expectedEvidence: [...(normalized.expectedEvidence ?? [])]
    };
    const next: Ledger = { version: 1, rows: [...ledger.rows, row] };
    await ensureSession(sessionId);
    await writeLedger(sessionId, next);
    return row;
  });
}

export function recordUserActionReceipt(
  sessionId: string,
  requestId: string,
  input: UserActionReceiptInput
): Promise<UserActionRequest> {
  const id = z.string().uuid().parse(requestId);
  const normalized = receiptInputSchema.parse(input);
  return enqueue(sessionId, async () => {
    await ensureSession(sessionId);
    const ledger = await readLedger(sessionId);
    const index = ledger.rows.findIndex(row => row.id === id);
    if (index < 0) throw new Error('User action request not found');
    const current = ledger.rows[index]!;
    if (current.receipt) {
      if (sameReceipt(current.receipt, normalized)) return current;
      throw new Error('User action request already has a different receipt');
    }
    const updated: UserActionRequest = {
      ...current,
      receipt: {
        outcome: normalized.outcome,
        reportedAt: Date.now(),
        ...(normalized.note ? { note: normalized.note } : {}),
        evidence: [...(normalized.evidence ?? [])]
      }
    };
    const rows = [...ledger.rows];
    rows[index] = updated;
    await ensureSession(sessionId);
    await writeLedger(sessionId, { version: 1, rows });
    return updated;
  });
}

export async function listUserActionRequests(sessionId: string): Promise<UserActionRequest[]> {
  await ensureSession(sessionId);
  const ledger = await readLedger(sessionId);
  await ensureSession(sessionId);
  return ledger.rows.map(row => ({
    ...row,
    constraints: [...row.constraints],
    expectedEvidence: [...row.expectedEvidence],
    ...(row.receipt ? { receipt: { ...row.receipt, evidence: [...row.receipt.evidence] } } : {})
  }));
}

/** Test seam: no durable state is owned in memory; only pending mutation queues are forgotten. */
export function resetUserActionsForTests(): void {
  mutationQueues.clear();
}
