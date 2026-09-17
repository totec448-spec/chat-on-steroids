/**
 * Narrow phone-controller transport for Frontier Longrun.
 *
 * The model supplies semantic intent only. Executable, CLI file, cwd, model, reasoning,
 * authority ids, slot ids and TTL are all local/fixed. Command Center resolves the semantic
 * label/focus into one signed parent operation; CoS then verifies/carries that envelope through
 * the existing remote-steering verifier. This adapter never mints or renews the root parent.
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCommand } from './exec.js';
import {
  frontierLongrunParentOperationDigest,
  validateFrontierLongrunParentEnvelope,
} from './frontier-longrun-parent-contract.js';
import { currentCall } from './mcp/call-context.js';
import type { RemoteSteeringOutcome } from './remote-steering.js';

export type FrontierLongrunControllerAction = 'start' | 'continue' | 'status' | 'show' | 'stop';

export interface FrontierLongrunControllerInput {
  readonly action: FrontierLongrunControllerAction;
  readonly prompt?: string;
  readonly label?: string;
}

export interface FrontierLongrunControllerSessionProjection {
  readonly state: string;
  readonly activeTurn: boolean | null;
  readonly blocked: boolean | null;
  readonly superseded: boolean | null;
  readonly modelClass: 'astra' | 'other' | 'unknown' | null;
  readonly loopEnabled: boolean | null;
  readonly pendingUserInput: boolean | null;
}

export interface FrontierLongrunControllerShowProjection {
  readonly parent: {
    readonly mission: string;
    readonly live: boolean;
    readonly revoked: boolean;
    readonly allocated: number;
    readonly remaining: number;
    readonly textClaimsUsed: number;
    readonly textClaimsRemaining: number;
    readonly issuedAt: string;
    readonly expiresAt: string;
    readonly focus: string | null;
  } | null;
  readonly slots: ReadonlyArray<{
    readonly label: string;
    readonly lastMutationSeq: number;
    readonly textClaimsUsed: number;
    readonly focused: boolean;
  }>;
  readonly warnings: readonly string[];
}

export type FrontierLongrunControllerResult =
  | { readonly kind: 'intent'; readonly action: Exclude<FrontierLongrunControllerAction, 'show'>; readonly label: string | null; readonly relay: RemoteSteeringOutcome }
  | { readonly kind: 'show'; readonly show: FrontierLongrunControllerShowProjection };

interface CommandBinding {
  nodePath: string;
  cliPath: string;
  cwd: string;
}

const DEFAULT_BINDING: CommandBinding = {
  nodePath: 'C:\\Dev\\Tools\\nodejs\\node.exe',
  cliPath: 'C:\\Dev\\NEXORA\\apps\\command-center\\apps\\cli\\dist\\main.js',
  cwd: 'C:\\Dev\\NEXORA',
};
const COMMAND_TIMEOUT_MS = 20_000;
const MAX_PROMPT_BYTES = 16_000;
const MAX_OUTPUT_BYTES = 100_000;
const CONTROLLER_REQUEST_DOMAIN = 'nexora.cos.frontier-longrun.controller-request.v1:';

let testBinding: CommandBinding | null = null;
let commandRunner: typeof runCommand = runCommand;

export class FrontierLongrunControllerError extends Error {}

export function normalizeFrontierLongrunControllerLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '-');
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized) ? normalized : null;
}

function binding(): CommandBinding { return testBinding ?? DEFAULT_BINDING; }

async function regularNonLinkFile(file: string, label: string): Promise<void> {
  if (!path.isAbsolute(file)) throw new FrontierLongrunControllerError(`${label} binding is not absolute`);
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { throw new FrontierLongrunControllerError(`${label} binding is unavailable (${error instanceof Error ? error.message : String(error)})`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new FrontierLongrunControllerError(`${label} binding is not a regular non-link file`);
}

async function regularNonLinkDirectory(directory: string): Promise<void> {
  if (!path.isAbsolute(directory)) throw new FrontierLongrunControllerError('Command Center cwd binding is not absolute');
  let stat;
  try { stat = await fs.lstat(directory); }
  catch (error) { throw new FrontierLongrunControllerError(`Command Center cwd binding is unavailable (${error instanceof Error ? error.message : String(error)})`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new FrontierLongrunControllerError('Command Center cwd binding is not a regular non-link directory');
}

async function verifyBinding(value: CommandBinding): Promise<void> {
  await Promise.all([
    regularNonLinkFile(value.nodePath, 'Node executable'),
    regularNonLinkFile(value.cliPath, 'Command Center CLI'),
    regularNonLinkDirectory(value.cwd),
  ]);
}

function controllerRequestId(input: FrontierLongrunControllerInput, bytes: Buffer | null, label: string | null): string {
  const requestId = currentCall()?.caller.requestId;
  if (!requestId) {
    throw new FrontierLongrunControllerError(
      'frontier_longrun requires ChatGPT request identity for exact retry safety; no Command Center operation was issued'
    );
  }
  // ChatGPT may reuse one x-request-id across several tool calls in the same model turn.
  // Bind the hidden idempotency key to this exact semantic controller call as well, so two
  // different intents/prompts in one turn never collide while an exact retry stays identical.
  const promptDigest = bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
  const semantic = JSON.stringify({
    action: input.action,
    label,
    promptSha256: promptDigest,
    promptLength: bytes?.length ?? null,
  });
  return createHash('sha256')
    .update(CONTROLLER_REQUEST_DOMAIN)
    .update(requestId)
    .update('\n')
    .update(semantic)
    .digest('hex')
    .slice(0, 32);
}

function promptBytes(input: FrontierLongrunControllerInput): Buffer | null {
  if (input.action !== 'start' && input.action !== 'continue') {
    if (input.prompt !== undefined) throw new FrontierLongrunControllerError(`${input.action} does not accept a prompt`);
    return null;
  }
  if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
    throw new FrontierLongrunControllerError(`${input.action} requires a non-empty prompt`);
  }
  const bytes = Buffer.from(input.prompt, 'utf8');
  if (bytes.length > MAX_PROMPT_BYTES) throw new FrontierLongrunControllerError(`prompt exceeds ${MAX_PROMPT_BYTES} UTF-8 bytes`);
  return bytes;
}

function controllerLabel(input: FrontierLongrunControllerInput): string | null {
  if (input.action === 'show') {
    if (input.label !== undefined) throw new FrontierLongrunControllerError('show does not accept a label');
    return null;
  }
  if (input.action === 'start' && input.label === undefined) {
    throw new FrontierLongrunControllerError('start requires an assistant-chosen semantic label');
  }
  if (input.label === undefined) return null;
  const normalized = normalizeFrontierLongrunControllerLabel(input.label);
  if (!normalized) throw new FrontierLongrunControllerError("label must normalize to 1..64 lowercase letters/digits plus '.', '_' or '-'");
  return normalized;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  const set = new Set(expected);
  return keys.length === expected.length && keys.every(key => set.has(key)) && expected.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FrontierLongrunControllerError(`${label} was not a JSON object`);
  return value as Record<string, unknown>;
}

function boundedWarnings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 8 || value.some(item => typeof item !== 'string' || item.length > 500)) {
    throw new FrontierLongrunControllerError('Command Center returned malformed warnings');
  }
  return value as string[];
}

function strictIntentPayload(
  value: unknown,
  requested: Exclude<FrontierLongrunControllerAction, 'show'>
): { payload: Record<string, unknown>; resolvedLabel: string } {
  const payload = record(value, 'Command Center intent output');
  if (!exactKeys(payload, ['command','mode','status','intent','slot','operation','envelope','reason','warnings']) ||
      payload.command !== 'cc.remote.steering.longrun.intent' || payload.mode !== 'issued') {
    throw new FrontierLongrunControllerError('Command Center returned an unexpected Longrun intent payload');
  }
  boundedWarnings(payload.warnings);
  if (payload.status !== 'ok') {
    const reason = typeof payload.reason === 'string' ? payload.reason : 'CC_LONGRUN_INTENT_REFUSED';
    throw new FrontierLongrunControllerError(`Command Center refused ${requested}: ${reason}`);
  }
  if (payload.intent !== requested || !payload.envelope) {
    throw new FrontierLongrunControllerError('Command Center returned an unexpected Longrun intent payload');
  }
  const slot = record(payload.slot, 'Command Center resolved Longrun slot');
  if (!exactKeys(slot, ['slot','label','lastMutationSeq','textClaimsUsed','focused']) ||
      integer(slot.slot, 'resolved slot number', 1) > 8 ||
      typeof slot.label !== 'string' || normalizeFrontierLongrunControllerLabel(slot.label) !== slot.label ||
      typeof slot.focused !== 'boolean') {
    throw new FrontierLongrunControllerError('Command Center returned malformed resolved Longrun slot metadata');
  }
  integer(slot.lastMutationSeq, 'resolved slot mutation sequence', 1);
  integer(slot.textClaimsUsed, 'resolved slot text-claim count');
  const envelope = validateFrontierLongrunParentEnvelope(payload.envelope);
  if (!envelope) throw new FrontierLongrunControllerError('Command Center returned a malformed signed Longrun envelope');
  const expected = requested === 'start' ? 'SESSION_CREATE'
    : requested === 'continue' ? 'LONGRUN_PROMPT'
    : requested === 'status' ? 'SESSION_STATUS'
    : 'LOOP_OFF';
  if (envelope.operation.payload.action !== expected) {
    throw new FrontierLongrunControllerError(`Command Center returned ${envelope.operation.payload.action} for ${requested}`);
  }
  const operation = record(payload.operation, 'Command Center Longrun operation view');
  if (!exactKeys(operation, [
        'slot','action','mutationSeq','inputId','longrunSha256','longrunLength','issuedAt','expiresAt','operationDigest'
      ]) ||
      operation.slot !== envelope.operation.payload.slot || operation.action !== envelope.operation.payload.action ||
      operation.mutationSeq !== envelope.operation.payload.mutationSeq || operation.inputId !== envelope.operation.payload.inputId ||
      operation.longrunSha256 !== envelope.operation.payload.longrunSha256 || operation.longrunLength !== envelope.operation.payload.longrunLength ||
      operation.issuedAt !== envelope.operation.payload.issuedAt || operation.expiresAt !== envelope.operation.payload.expiresAt ||
      operation.operationDigest !== frontierLongrunParentOperationDigest(envelope.operation.payload)) {
    throw new FrontierLongrunControllerError('Command Center Longrun operation view does not match its signed envelope');
  }
  if (slot.slot !== envelope.operation.payload.slot) {
    throw new FrontierLongrunControllerError('Command Center resolved slot does not match its signed envelope');
  }
  return { payload, resolvedLabel: slot.label };
}

function integer(value: unknown, label: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new FrontierLongrunControllerError(`Command Center returned invalid ${label}`);
  return value;
}

function strictShowPayload(value: unknown): FrontierLongrunControllerShowProjection {
  const payload = record(value, 'Command Center show output');
  if (!exactKeys(payload, ['command','status','parent','slots','reason','warnings']) || payload.command !== 'cc.remote.steering.longrun.show') {
    throw new FrontierLongrunControllerError('Command Center returned an unexpected Longrun show payload');
  }
  const warnings = boundedWarnings(payload.warnings);
  if (payload.status !== 'ok') {
    const reason = typeof payload.reason === 'string' ? payload.reason : 'CC_LONGRUN_SHOW_REFUSED';
    throw new FrontierLongrunControllerError(`Command Center refused Longrun show: ${reason}`);
  }
  if (!Array.isArray(payload.slots) || payload.slots.length > 8) throw new FrontierLongrunControllerError('Command Center returned malformed Longrun slots');
  const slots = payload.slots.map((raw) => {
    const slot = record(raw, 'Longrun slot');
    if (!exactKeys(slot, ['slot','label','lastMutationSeq','textClaimsUsed','focused']) ||
        integer(slot.slot, 'slot number', 1) > 8 ||
        typeof slot.label !== 'string' || normalizeFrontierLongrunControllerLabel(slot.label) !== slot.label || typeof slot.focused !== 'boolean') {
      throw new FrontierLongrunControllerError('Command Center returned malformed Longrun slot metadata');
    }
    return {
      label: slot.label,
      lastMutationSeq: integer(slot.lastMutationSeq, 'slot mutation sequence', 1),
      textClaimsUsed: integer(slot.textClaimsUsed, 'slot text-claim count'),
      focused: slot.focused,
    };
  });
  if (payload.parent === null) return { parent: null, slots, warnings };
  const parent = record(payload.parent, 'Longrun parent');
  if (!exactKeys(parent, [
        'missionId','missionDigest','maxSlots','allocatedSlots','remainingSlots','focusSlot','textClaimsUsed','textClaimsRemaining',
        'issuedAt','expiresAt','signingKeyFingerprint','operatorIntentDigest','grantDigest','model','reasoning','live','revoked'
      ]) ||
      typeof parent.missionId !== 'string' || parent.missionId.length < 1 || parent.missionId.length > 128 ||
      typeof parent.missionDigest !== 'string' || !/^[0-9a-f]{64}$/.test(parent.missionDigest) ||
      parent.maxSlots !== 8 ||
      (parent.focusSlot !== null && (typeof parent.focusSlot !== 'number' || !Number.isSafeInteger(parent.focusSlot) || parent.focusSlot < 1 || parent.focusSlot > 8)) ||
      typeof parent.signingKeyFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(parent.signingKeyFingerprint) ||
      typeof parent.operatorIntentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(parent.operatorIntentDigest) ||
      typeof parent.grantDigest !== 'string' || !/^[0-9a-f]{64}$/.test(parent.grantDigest) ||
      parent.model !== 'gpt-6-pro' || parent.reasoning !== 'pro' ||
      typeof parent.live !== 'boolean' || typeof parent.revoked !== 'boolean' ||
      typeof parent.issuedAt !== 'string' || !Number.isFinite(Date.parse(parent.issuedAt)) ||
      typeof parent.expiresAt !== 'string' || !Number.isFinite(Date.parse(parent.expiresAt))) {
    throw new FrontierLongrunControllerError('Command Center returned malformed Longrun parent metadata');
  }
  const allocated = integer(parent.allocatedSlots, 'allocated slot count');
  const remaining = integer(parent.remainingSlots, 'remaining slot count');
  const claimsUsed = integer(parent.textClaimsUsed, 'text-claim count');
  const claimsRemaining = integer(parent.textClaimsRemaining, 'remaining text-claim count');
  if (allocated + remaining !== 8 || allocated !== slots.length || claimsUsed + claimsRemaining !== 64) {
    throw new FrontierLongrunControllerError('Command Center returned inconsistent Longrun parent capacity metadata');
  }
  const focus = slots.find(slot => slot.focused)?.label ?? null;
  if ((parent.focusSlot === null) !== (focus === null) || (parent.focusSlot !== null && slots.filter(slot => slot.focused).length !== 1)) {
    throw new FrontierLongrunControllerError('Command Center returned inconsistent Longrun focus metadata');
  }
  return {
    parent: {
      mission: parent.missionId,
      live: parent.live,
      revoked: parent.revoked,
      allocated,
      remaining,
      textClaimsUsed: claimsUsed,
      textClaimsRemaining: claimsRemaining,
      issuedAt: parent.issuedAt,
      expiresAt: parent.expiresAt,
      focus,
    },
    slots,
    warnings,
  };
}

async function invokeCc(argv: readonly string[], requestId: string): Promise<unknown> {
  const fixed = binding();
  await verifyBinding(fixed);
  const result = await commandRunner(fixed.nodePath, [fixed.cliPath, ...argv, '--controller-request-id', requestId], fixed.cwd, COMMAND_TIMEOUT_MS);
  if (result.timedOut) throw new FrontierLongrunControllerError('Command Center Longrun command timed out');
  if (result.truncated || Buffer.byteLength(result.stdout, 'utf8') > MAX_OUTPUT_BYTES) throw new FrontierLongrunControllerError('Command Center Longrun output exceeded the accepted bound');
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().slice(0, 300);
    throw new FrontierLongrunControllerError(`Command Center Longrun command failed${detail ? `: ${detail}` : ''}`);
  }
  const text = result.stdout.trim();
  if (!text) throw new FrontierLongrunControllerError('Command Center Longrun command returned no JSON');
  try { return JSON.parse(text) as unknown; }
  catch { throw new FrontierLongrunControllerError('Command Center Longrun command returned malformed JSON'); }
}

async function withPromptFile<T>(bytes: Buffer, body: (file: string) => Promise<T>): Promise<T> {
  const file = path.join(os.tmpdir(), `cos-frontier-longrun-${randomUUID()}.txt`);
  await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  try { return await body(file); }
  finally { await fs.unlink(file).catch(() => undefined); }
}

export async function runFrontierLongrunController(
  input: FrontierLongrunControllerInput,
  relay: (envelope: Record<string, unknown>) => Promise<RemoteSteeringOutcome>
): Promise<FrontierLongrunControllerResult> {
  const bytes = promptBytes(input);
  const label = controllerLabel(input);
  const requestId = controllerRequestId(input, bytes, label);
  if (input.action === 'show') {
    const payload = await invokeCc(['cc.remote.steering.longrun.show'], requestId);
    return { kind: 'show', show: strictShowPayload(payload) };
  }
  const args = ['cc.remote.steering.longrun.intent', '--intent', input.action];
  if (label) args.push('--label', label);
  const payload = bytes
    ? await withPromptFile(bytes, file => invokeCc([...args, '--longrun-file', file], requestId))
    : await invokeCc(args, requestId);
  const parsed = strictIntentPayload(payload, input.action);
  const relayResult = await relay(record(parsed.payload.envelope, 'signed Longrun envelope'));
  return { kind: 'intent', action: input.action, label: parsed.resolvedLabel, relay: relayResult };
}

/** Test seams: neither is reachable from MCP input. */
export function setFrontierLongrunCommandBindingForTests(value: CommandBinding | null): void { testBinding = value ? { ...value } : null; }
export function setFrontierLongrunCommandRunnerForTests(value: typeof runCommand | null): void { commandRunner = value ?? runCommand; }
export function resetFrontierLongrunControllerForTests(): void { testBinding = null; commandRunner = runCommand; }
