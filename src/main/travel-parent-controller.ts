/**
 * Fresh-chat semantic adapter for the attended Travel Parent root.
 *
 * The caller supplies only one of three closed actions. The derivative Longrun action binds its
 * replay identity to the exact MCP request plus the exact semantic child request, writes only
 * app-owned temporary inputs, and invokes one pinned Command Center command. No local path,
 * process, provider/model, root/grant/session or slot selector crosses the MCP boundary.
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCommand } from './exec.js';
import {
  FRONTIER_LONGRUN_PARENT_MAX_SLOTS,
  FRONTIER_LONGRUN_PARENT_MAX_TTL_SECONDS,
  FRONTIER_LONGRUN_PARENT_MODEL,
  FRONTIER_LONGRUN_PARENT_REASONING,
} from './frontier-longrun-parent-contract.js';
import {
  FrontierLongrunControllerError,
  runFrontierLongrunController,
} from './frontier-longrun-controller.js';
import { currentCall } from './mcp/call-context.js';

export type TravelParentScope = 'command_center' | 'nkb' | 'vyper';
export type TravelParentControllerAction = 'show' | 'create_longrun' | 'revoke';

export interface TravelParentControllerInput {
  readonly action: TravelParentControllerAction;
  readonly scope?: TravelParentScope;
  readonly mission?: string;
  readonly label?: string;
  readonly ttl_hours?: number;
}

export interface TravelParentProjection {
  readonly allowedScopes: readonly TravelParentScope[];
  readonly childrenUsedTotal: number;
  readonly childrenUsedByScope: Readonly<Record<TravelParentScope, number>>;
  readonly remainingChildrenTotal: number;
  readonly remainingChildrenByScope: Readonly<Record<TravelParentScope, number>>;
  readonly maxChildrenTotal: 9;
  readonly maxChildrenPerScope: 3;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly live: boolean;
  readonly revoked: boolean;
}

export type TravelParentRenewalState = 'not_due' | 'due_within_24h' | 'expired' | 'revoked';

export interface TravelParentRenewalGuidance {
  readonly state: TravelParentRenewalState;
  readonly attendedPcRequired: boolean;
}

export interface TravelParentLongrunProjection {
  readonly mission: string;
  readonly model: typeof FRONTIER_LONGRUN_PARENT_MODEL;
  readonly reasoning: typeof FRONTIER_LONGRUN_PARENT_REASONING;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly live: boolean;
  readonly revoked: boolean;
}

export type TravelParentControllerResult =
  | {
      readonly kind: 'show';
      readonly parent: TravelParentProjection;
      readonly renewal: TravelParentRenewalGuidance;
      readonly warnings: readonly string[];
    }
  | {
      readonly kind: 'create_longrun_blocked';
      readonly scope: TravelParentScope;
      readonly label: string;
      readonly reason: 'frontier_longrun_parent_live';
      readonly nextAction: 'frontier_longrun';
      readonly existing: {
        readonly mission: string;
        readonly expiresAt: string;
        readonly focus: string | null;
      };
      readonly guidance: string;
    }
  | {
      readonly kind: 'create_longrun';
      readonly scope: TravelParentScope;
      readonly label: string;
      readonly replay: boolean;
      readonly parent: TravelParentProjection;
      readonly child: TravelParentLongrunProjection;
      readonly warnings: readonly string[];
    }
  | { readonly kind: 'revoke'; readonly replay: boolean; readonly parent: TravelParentProjection; readonly warnings: readonly string[] };

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
const MAX_MISSION_BYTES = 16_000;
const MAX_OUTPUT_BYTES = 100_000;
const DEFAULT_TTL_HOURS = 72;
const MAX_TTL_HOURS = 72;
const RENEWAL_WARNING_MS = 24 * 60 * 60 * 1_000;
const TRAVEL_PARENT_MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const TRAVEL_PARENT_REQUEST_DOMAIN = 'nexora.cos.travel-parent.longrun-request.v1:';
const SCOPES: readonly TravelParentScope[] = ['command_center', 'nkb', 'vyper'];
const CHILD_FAMILIES = ['frontier_longrun_parent', 'frontier_manual_session'] as const;
const TRAVEL_PARENT_REASONS = new Set([
  'TRAVEL_PARENT_ABSENT',
  'TRAVEL_PARENT_MALFORMED',
  'TRAVEL_PARENT_SIGNATURE_INVALID',
  'TRAVEL_PARENT_ACTIVE_EXISTS',
  'TRAVEL_PARENT_EXPIRED',
  'TRAVEL_PARENT_REVOKED',
  'TRAVEL_PARENT_SCOPE_NOT_ALLOWED',
  'TRAVEL_PARENT_CHILD_FAMILY_NOT_ALLOWED',
  'TRAVEL_PARENT_CAPACITY_EXHAUSTED',
  'TRAVEL_PARENT_SCOPE_CAPACITY_EXHAUSTED',
  'TRAVEL_PARENT_CHILD_WINDOW_INVALID',
  'TRAVEL_PARENT_REQUEST_REPLAY_ALTERED',
  'TRAVEL_PARENT_REQUEST_INDETERMINATE',
  'TRAVEL_PARENT_CHILD_CERTIFICATE_ABSENT',
  'TRAVEL_PARENT_CHILD_CERTIFICATE_INVALID',
  'TRAVEL_PARENT_CHILD_AUTHORITY_MISMATCH',
  'TRAVEL_PARENT_STORE_WRITE_FAILED',
  'TRAVEL_PARENT_SIGNING_FAILED',
  'TRAVEL_PARENT_LOCK_FAILED',
  'REMOTE_STEERING_KEY_ABSENT',
  'REMOTE_STEERING_KEY_STATE_INCONSISTENT',
]);

const FIXED_OPERATOR_INTENT = Buffer.from(
  'Travel Parent V1 derivative Frontier Longrun child.\n' +
  'This application-owned operator intent grants no T3 authority; no commit, push, merge, deploy, release, credentials, provider selection, model selection, shell, routing, landing, or governance authority.\n' +
  'It authorizes only the bounded Frontier Longrun child derived by Command Center from the live Travel Parent.\n',
  'utf8'
);
const FIXED_OPERATOR_INTENT_DIGEST = createHash('sha256').update(FIXED_OPERATOR_INTENT).digest('hex');

let testBinding: CommandBinding | null = null;
let commandRunner: typeof runCommand = runCommand;

export class TravelParentControllerError extends Error {}

export function normalizeTravelParentLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '-');
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized) ? normalized : null;
}

function binding(): CommandBinding { return testBinding ?? DEFAULT_BINDING; }

async function regularNonLinkFile(file: string, label: string): Promise<void> {
  if (!path.isAbsolute(file)) throw new TravelParentControllerError(`${label} binding is not absolute`);
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { throw new TravelParentControllerError(`${label} binding is unavailable (${error instanceof Error ? error.message : String(error)})`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new TravelParentControllerError(`${label} binding is not a regular non-link file`);
}

async function regularNonLinkDirectory(directory: string): Promise<void> {
  if (!path.isAbsolute(directory)) throw new TravelParentControllerError('Command Center cwd binding is not absolute');
  let stat;
  try { stat = await fs.lstat(directory); }
  catch (error) { throw new TravelParentControllerError(`Command Center cwd binding is unavailable (${error instanceof Error ? error.message : String(error)})`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TravelParentControllerError('Command Center cwd binding is not a regular non-link directory');
}

async function verifyBinding(value: CommandBinding): Promise<void> {
  await Promise.all([
    regularNonLinkFile(value.nodePath, 'Node executable'),
    regularNonLinkFile(value.cliPath, 'Command Center CLI'),
    regularNonLinkDirectory(value.cwd),
  ]);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TravelParentControllerError(`${label} was not a JSON object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  const set = new Set(expected);
  return keys.length === expected.length && keys.every(key => set.has(key)) && expected.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new TravelParentControllerError(`Command Center returned invalid ${label}`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TravelParentControllerError(`Command Center returned invalid ${label}`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TravelParentControllerError(`Command Center returned invalid ${label}`);
  }
  return value;
}

function boundedWarnings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 8 || value.some(item => typeof item !== 'string' || item.length > 500)) {
    throw new TravelParentControllerError('Command Center returned malformed Travel Parent warnings');
  }
  return value as string[];
}

function reason(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !TRAVEL_PARENT_REASONS.has(value)) {
    throw new TravelParentControllerError('Command Center returned malformed Travel Parent reason');
  }
  return value;
}

function strictParent(value: unknown): TravelParentProjection {
  const parent = record(value, 'Command Center Travel Parent');
  if (!exactKeys(parent, [
    'allowedChildFamilies','allowedScopes','maxChildrenTotal','maxChildrenPerScope','childrenUsedTotal','childrenUsedByScope',
    'issuedAt','expiresAt','signingKeyFingerprint','operatorIntentDigest','travelParentDigest','live','revoked'
  ])) {
    throw new TravelParentControllerError('Command Center returned malformed Travel Parent metadata');
  }
  if (!Array.isArray(parent.allowedChildFamilies) ||
      parent.allowedChildFamilies.length !== CHILD_FAMILIES.length ||
      parent.allowedChildFamilies.some((family, index) => family !== CHILD_FAMILIES[index])) {
    throw new TravelParentControllerError('Command Center returned malformed Travel Parent child-family metadata');
  }
  if (!Array.isArray(parent.allowedScopes) || parent.allowedScopes.length < 1 || parent.allowedScopes.length > SCOPES.length ||
      parent.allowedScopes.some(scope => typeof scope !== 'string' || !SCOPES.includes(scope as TravelParentScope))) {
    throw new TravelParentControllerError('Command Center returned malformed Travel Parent scope metadata');
  }
  const allowedScopes = parent.allowedScopes as TravelParentScope[];
  const canonicalScopes = SCOPES.filter(scope => allowedScopes.includes(scope));
  if (new Set(allowedScopes).size !== allowedScopes.length || canonicalScopes.join(',') !== allowedScopes.join(',')) {
    throw new TravelParentControllerError('Command Center returned non-canonical Travel Parent scope metadata');
  }
  if (parent.maxChildrenTotal !== 9 || parent.maxChildrenPerScope !== 3 || typeof parent.live !== 'boolean' || typeof parent.revoked !== 'boolean') {
    throw new TravelParentControllerError('Command Center returned malformed Travel Parent capacity/state metadata');
  }
  const counts = record(parent.childrenUsedByScope, 'Travel Parent per-scope child counts');
  if (!exactKeys(counts, SCOPES)) throw new TravelParentControllerError('Command Center returned malformed Travel Parent per-scope counts');
  const childrenUsedByScope = {
    command_center: integer(counts.command_center, 'command_center child count', 0, 3),
    nkb: integer(counts.nkb, 'nkb child count', 0, 3),
    vyper: integer(counts.vyper, 'vyper child count', 0, 3),
  };
  const total = integer(parent.childrenUsedTotal, 'Travel Parent total child count', 0, 9);
  if (total !== childrenUsedByScope.command_center + childrenUsedByScope.nkb + childrenUsedByScope.vyper) {
    throw new TravelParentControllerError('Command Center returned inconsistent Travel Parent child counts');
  }
  for (const scope of SCOPES) {
    if (!allowedScopes.includes(scope) && childrenUsedByScope[scope] !== 0) {
      throw new TravelParentControllerError('Command Center returned child usage outside the Travel Parent scope set');
    }
  }
  const remainingChildrenByScope = {
    command_center: allowedScopes.includes('command_center') ? 3 - childrenUsedByScope.command_center : 0,
    nkb: allowedScopes.includes('nkb') ? 3 - childrenUsedByScope.nkb : 0,
    vyper: allowedScopes.includes('vyper') ? 3 - childrenUsedByScope.vyper : 0,
  };
  const remainingChildrenTotal = Math.min(
    9 - total,
    remainingChildrenByScope.command_center + remainingChildrenByScope.nkb + remainingChildrenByScope.vyper
  );
  const issuedAt = timestamp(parent.issuedAt, 'Travel Parent issuedAt');
  const expiresAt = timestamp(parent.expiresAt, 'Travel Parent expiresAt');
  const parentWindowSeconds = (Date.parse(expiresAt) - Date.parse(issuedAt)) / 1000;
  if (!Number.isInteger(parentWindowSeconds) || parentWindowSeconds <= 0 || parentWindowSeconds > TRAVEL_PARENT_MAX_TTL_SECONDS) {
    throw new TravelParentControllerError('Command Center returned an invalid Travel Parent signed window');
  }
  digest(parent.signingKeyFingerprint, 'Travel Parent signing key fingerprint');
  digest(parent.operatorIntentDigest, 'Travel Parent operator-intent digest');
  digest(parent.travelParentDigest, 'Travel Parent digest');
  return {
    allowedScopes: [...allowedScopes],
    childrenUsedTotal: total,
    childrenUsedByScope,
    remainingChildrenTotal,
    remainingChildrenByScope,
    maxChildrenTotal: 9,
    maxChildrenPerScope: 3,
    issuedAt,
    expiresAt,
    live: parent.live,
    revoked: parent.revoked,
  };
}

function renewalGuidance(parent: TravelParentProjection, nowMs = Date.now()): TravelParentRenewalGuidance {
  if (parent.revoked) return { state: 'revoked', attendedPcRequired: true };
  const remainingMs = Date.parse(parent.expiresAt) - nowMs;
  if (!parent.live || remainingMs <= 0) return { state: 'expired', attendedPcRequired: true };
  if (remainingMs <= RENEWAL_WARNING_MS) return { state: 'due_within_24h', attendedPcRequired: true };
  return { state: 'not_due', attendedPcRequired: false };
}

function strictChild(
  value: unknown,
  expectedMissionId: string,
  expectedMissionDigest: string,
  expectedTtlSeconds: number
): TravelParentLongrunProjection {
  const child = record(value, 'Command Center Travel Parent Longrun child');
  if (!exactKeys(child, [
    'missionId','missionDigest','maxSlots','allocatedSlots','remainingSlots','focusSlot','textClaimsUsed','textClaimsRemaining',
    'issuedAt','expiresAt','signingKeyFingerprint','operatorIntentDigest','grantDigest','model','reasoning','live','revoked'
  ])) {
    throw new TravelParentControllerError('Command Center returned malformed Travel Parent Longrun metadata');
  }
  if (child.missionId !== expectedMissionId || child.maxSlots !== FRONTIER_LONGRUN_PARENT_MAX_SLOTS ||
      child.model !== FRONTIER_LONGRUN_PARENT_MODEL || child.reasoning !== FRONTIER_LONGRUN_PARENT_REASONING ||
      typeof child.live !== 'boolean' || typeof child.revoked !== 'boolean') {
    throw new TravelParentControllerError('Command Center returned unexpected Travel Parent Longrun profile metadata');
  }
  const allocatedSlots = integer(child.allocatedSlots, 'Travel Parent Longrun allocated slot count', 0, FRONTIER_LONGRUN_PARENT_MAX_SLOTS);
  const remainingSlots = integer(child.remainingSlots, 'Travel Parent Longrun remaining slot count', 0, FRONTIER_LONGRUN_PARENT_MAX_SLOTS);
  if (allocatedSlots + remainingSlots !== FRONTIER_LONGRUN_PARENT_MAX_SLOTS ||
      (child.focusSlot !== null &&
        (typeof child.focusSlot !== 'number' || !Number.isSafeInteger(child.focusSlot) || child.focusSlot < 1 || child.focusSlot > FRONTIER_LONGRUN_PARENT_MAX_SLOTS))) {
    throw new TravelParentControllerError('Command Center returned inconsistent Travel Parent Longrun slot metadata');
  }
  const claimsUsed = integer(child.textClaimsUsed, 'Travel Parent Longrun text-claim count', 0, 64);
  const claimsRemaining = integer(child.textClaimsRemaining, 'Travel Parent Longrun remaining text-claim count', 0, 64);
  if (claimsUsed + claimsRemaining !== 64) {
    throw new TravelParentControllerError('Command Center returned inconsistent Travel Parent Longrun text-claim metadata');
  }
  if (digest(child.missionDigest, 'Travel Parent Longrun mission digest') !== expectedMissionDigest) {
    throw new TravelParentControllerError('Command Center Travel Parent Longrun mission digest does not match the requested mission bytes');
  }
  digest(child.signingKeyFingerprint, 'Travel Parent Longrun signing key fingerprint');
  if (digest(child.operatorIntentDigest, 'Travel Parent Longrun operator-intent digest') !== FIXED_OPERATOR_INTENT_DIGEST) {
    throw new TravelParentControllerError('Command Center Travel Parent Longrun operator-intent digest does not match the application-owned template');
  }
  digest(child.grantDigest, 'Travel Parent Longrun grant digest');
  const issuedAt = timestamp(child.issuedAt, 'Travel Parent Longrun issuedAt');
  const expiresAt = timestamp(child.expiresAt, 'Travel Parent Longrun expiresAt');
  const childWindowSeconds = (Date.parse(expiresAt) - Date.parse(issuedAt)) / 1000;
  if (!Number.isInteger(childWindowSeconds) || childWindowSeconds !== expectedTtlSeconds ||
      childWindowSeconds <= 0 || childWindowSeconds > FRONTIER_LONGRUN_PARENT_MAX_TTL_SECONDS) {
    throw new TravelParentControllerError('Command Center returned an invalid Travel Parent Longrun signed window');
  }
  return {
    mission: expectedMissionId,
    model: FRONTIER_LONGRUN_PARENT_MODEL,
    reasoning: FRONTIER_LONGRUN_PARENT_REASONING,
    issuedAt,
    expiresAt,
    live: child.live,
    revoked: child.revoked,
  };
}

function strictShowPayload(value: unknown): Extract<TravelParentControllerResult, { kind: 'show' }> {
  const payload = record(value, 'Command Center Travel Parent show output');
  if (!exactKeys(payload, ['command','status','parent','reason','warnings']) || payload.command !== 'cc.remote.steering.travel-parent.show') {
    throw new TravelParentControllerError('Command Center returned an unexpected Travel Parent show payload');
  }
  const warnings = boundedWarnings(payload.warnings);
  const parsedReason = reason(payload.reason);
  if (payload.status !== 'ok' || parsedReason !== null || payload.parent === null) {
    throw new TravelParentControllerError(`Command Center refused Travel Parent show: ${parsedReason ?? 'TRAVEL_PARENT_SHOW_REFUSED'}`);
  }
  const parent = strictParent(payload.parent);
  return { kind: 'show', parent, renewal: renewalGuidance(parent), warnings };
}

function strictRevokePayload(value: unknown): Extract<TravelParentControllerResult, { kind: 'revoke' }> {
  const payload = record(value, 'Command Center Travel Parent revoke output');
  if (!exactKeys(payload, ['command','mode','status','parent','replay','reason','warnings']) ||
      payload.command !== 'cc.remote.steering.travel-parent.revoke' || payload.mode !== 'revoked') {
    throw new TravelParentControllerError('Command Center returned an unexpected Travel Parent revoke payload');
  }
  const warnings = boundedWarnings(payload.warnings);
  const parsedReason = reason(payload.reason);
  if (payload.status !== 'ok' || parsedReason !== null || payload.parent === null || typeof payload.replay !== 'boolean') {
    throw new TravelParentControllerError(`Command Center refused Travel Parent revoke: ${parsedReason ?? 'TRAVEL_PARENT_REVOKE_REFUSED'}`);
  }
  const parent = strictParent(payload.parent);
  if (!parent.revoked || parent.live) throw new TravelParentControllerError('Command Center returned a non-revoked parent after Travel Parent revoke');
  return { kind: 'revoke', replay: payload.replay, parent, warnings };
}

function strictCreatePayload(
  value: unknown,
  expectedScope: TravelParentScope,
  expectedMissionId: string,
  expectedMissionDigest: string,
  expectedTtlSeconds: number,
  label: string
): Extract<TravelParentControllerResult, { kind: 'create_longrun' }> {
  const payload = record(value, 'Command Center Travel Parent Longrun create output');
  if (!exactKeys(payload, ['command','mode','status','scope','parent','child','certificateDigest','replay','reason','warnings']) ||
      payload.command !== 'cc.remote.steering.travel-parent.longrun.create' || payload.mode !== 'issued') {
    throw new TravelParentControllerError('Command Center returned an unexpected Travel Parent Longrun create payload');
  }
  const warnings = boundedWarnings(payload.warnings);
  const parsedReason = reason(payload.reason);
  if (payload.status !== 'ok' || parsedReason !== null || payload.scope !== expectedScope || payload.parent === null || payload.child === null ||
      typeof payload.replay !== 'boolean') {
    throw new TravelParentControllerError(`Command Center refused Travel Parent Longrun create: ${parsedReason ?? 'TRAVEL_PARENT_LONGRUN_CREATE_REFUSED'}`);
  }
  digest(payload.certificateDigest, 'Travel Parent child certificate digest');
  const parentRaw = record(payload.parent, 'Command Center Travel Parent');
  const childRaw = record(payload.child, 'Command Center Travel Parent Longrun child');
  const parent = strictParent(payload.parent);
  const child = strictChild(payload.child, expectedMissionId, expectedMissionDigest, expectedTtlSeconds);
  if (!parent.live || parent.revoked || !child.live || child.revoked || !parent.allowedScopes.includes(expectedScope) ||
      Date.parse(child.expiresAt) > Date.parse(parent.expiresAt) ||
      parentRaw.signingKeyFingerprint !== childRaw.signingKeyFingerprint) {
    throw new TravelParentControllerError('Command Center returned inconsistent live Travel Parent child metadata');
  }
  return { kind: 'create_longrun', scope: expectedScope, label, replay: payload.replay, parent, child, warnings };
}

function missionBytes(value: unknown): Buffer {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TravelParentControllerError('create_longrun requires non-empty mission text');
  }
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > MAX_MISSION_BYTES) throw new TravelParentControllerError(`mission exceeds ${MAX_MISSION_BYTES} UTF-8 bytes`);
  return bytes;
}

function scopeValue(value: unknown): TravelParentScope {
  if (typeof value !== 'string' || !SCOPES.includes(value as TravelParentScope)) {
    throw new TravelParentControllerError('create_longrun scope must be command_center, nkb, or vyper');
  }
  return value as TravelParentScope;
}

function ttlHours(value: unknown): number {
  if (value === undefined) return DEFAULT_TTL_HOURS;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_TTL_HOURS) {
    throw new TravelParentControllerError('ttl_hours must be a whole number from 1 to 72');
  }
  return value;
}

function missionIdFor(scope: TravelParentScope, label: string): string {
  return `tp-${scope}-${label}`;
}

function childRequestId(
  scope: TravelParentScope,
  label: string,
  missionDigest: string,
  missionLength: number,
  ttlSeconds: number
): string {
  const exactRequestId = currentCall()?.caller.requestId;
  if (!exactRequestId) {
    throw new TravelParentControllerError(
      'travel_parent create_longrun requires ChatGPT request identity for exact retry safety; no temporary file or Command Center operation was created'
    );
  }
  const semantic = JSON.stringify({
    scope,
    label,
    missionSha256: missionDigest,
    missionLength,
    ttlSeconds,
  });
  return createHash('sha256')
    .update(TRAVEL_PARENT_REQUEST_DOMAIN)
    .update(exactRequestId)
    .update('\n')
    .update(semantic)
    .digest('hex')
    .slice(0, 32);
}

async function invokeCc(argv: readonly string[]): Promise<unknown> {
  const fixed = binding();
  await verifyBinding(fixed);
  const result = await commandRunner(fixed.nodePath, [fixed.cliPath, ...argv], fixed.cwd, COMMAND_TIMEOUT_MS);
  if (result.timedOut) throw new TravelParentControllerError('Command Center Travel Parent command timed out');
  if (result.truncated || Buffer.byteLength(result.stdout, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new TravelParentControllerError('Command Center Travel Parent output exceeded the accepted bound');
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().slice(0, 300);
    throw new TravelParentControllerError(`Command Center Travel Parent command failed${detail ? `: ${detail}` : ''}`);
  }
  const text = result.stdout.trim();
  if (!text) throw new TravelParentControllerError('Command Center Travel Parent command returned no JSON');
  try { return JSON.parse(text) as unknown; }
  catch { throw new TravelParentControllerError('Command Center Travel Parent command returned malformed JSON'); }
}

async function withInputFiles<T>(mission: Buffer, body: (missionFile: string, intentFile: string) => Promise<T>): Promise<T> {
  const missionFile = path.join(os.tmpdir(), `cos-travel-parent-mission-${randomUUID()}.txt`);
  const intentFile = path.join(os.tmpdir(), `cos-travel-parent-intent-${randomUUID()}.txt`);
  try {
    await fs.writeFile(missionFile, mission, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(intentFile, FIXED_OPERATOR_INTENT, { flag: 'wx', mode: 0o600 });
    return await body(missionFile, intentFile);
  } finally {
    // A failed write can still leave a newly-created partial file behind. These names are
    // app-generated and opened with wx, so clean both unconditionally on every exit path.
    await fs.unlink(intentFile).catch(() => undefined);
    await fs.unlink(missionFile).catch(() => undefined);
  }
}

async function preflightLongrunSingleton(): Promise<{
  mission: string;
  live: boolean;
  revoked: boolean;
  expiresAt: string;
  focus: string | null;
} | null> {
  try {
    const result = await runFrontierLongrunController(
      { action: 'show' },
      async () => { throw new TravelParentControllerError('Longrun singleton preflight unexpectedly attempted a relay'); }
    );
    if (result.kind !== 'show' || result.show.parent === null) {
      throw new TravelParentControllerError('Longrun singleton preflight returned indeterminate parent state');
    }
    if (result.show.parent.live && result.show.parent.revoked) {
      throw new TravelParentControllerError('Longrun singleton preflight returned inconsistent live/revoked state');
    }
    return result.show.parent;
  } catch (error) {
    if (error instanceof FrontierLongrunControllerError &&
        error.message === 'Command Center refused Longrun show: FRONTIER_LONGRUN_PARENT_ABSENT') {
      return null;
    }
    if (error instanceof TravelParentControllerError) throw error;
    throw new TravelParentControllerError(
      `Longrun singleton preflight failed closed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function runTravelParentController(input: TravelParentControllerInput): Promise<TravelParentControllerResult> {
  if (input.action === 'show') {
    return strictShowPayload(await invokeCc(['cc.remote.steering.travel-parent.show']));
  }
  if (input.action === 'revoke') {
    return strictRevokePayload(await invokeCc(['cc.remote.steering.travel-parent.revoke', '--confirm']));
  }
  if (input.action !== 'create_longrun') throw new TravelParentControllerError('unsupported travel_parent action');

  const scope = scopeValue(input.scope);
  const label = normalizeTravelParentLabel(input.label);
  if (!label) throw new TravelParentControllerError("label must normalize to 1..64 lowercase letters/digits plus '.', '_' or '-'");
  const mission = missionBytes(input.mission);
  const hours = ttlHours(input.ttl_hours);
  const ttlSeconds = hours * 3_600;
  const missionDigest = createHash('sha256').update(mission).digest('hex');
  const requestId = childRequestId(scope, label, missionDigest, mission.length, ttlSeconds);
  const missionId = missionIdFor(scope, label);

  const existingLongrun = await preflightLongrunSingleton();
  if (existingLongrun?.live) {
    return {
      kind: 'create_longrun_blocked',
      scope,
      label,
      reason: 'frontier_longrun_parent_live',
      nextAction: 'frontier_longrun',
      existing: {
        mission: existingLongrun.mission,
        expiresAt: existingLongrun.expiresAt,
        focus: existingLongrun.focus,
      },
      guidance: 'A singleton Frontier Longrun parent is already live. Use frontier_longrun show/status/continue for that parent. The requested mission was not attached to it; do not retry travel_parent create_longrun while it remains live.',
    };
  }

  return withInputFiles(mission, async (missionFile, intentFile) => {
    const payload = await invokeCc([
      'cc.remote.steering.travel-parent.longrun.create',
      '--scope', scope,
      '--travel-parent-request-id', requestId,
      '--mission-id', missionId,
      '--mission-file', missionFile,
      '--operator-intent-file', intentFile,
      '--ttl-seconds', String(ttlSeconds),
      '--confirm',
    ]);
    return strictCreatePayload(payload, scope, missionId, missionDigest, ttlSeconds, label);
  });
}

/** Test seams: neither binding nor runner is reachable from MCP input. */
export function setTravelParentCommandBindingForTests(value: CommandBinding | null): void { testBinding = value ? { ...value } : null; }
export function setTravelParentCommandRunnerForTests(value: typeof runCommand | null): void { commandRunner = value ?? runCommand; }
export function resetTravelParentControllerForTests(): void { testBinding = null; commandRunner = runCommand; }
