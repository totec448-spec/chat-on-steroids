/** Semantic fresh-chat controller for one TP-derived ordinary Frontier manual session. */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCommand } from './exec.js';
import { currentCall } from './mcp/call-context.js';
import {
  FRONTIER_MANUAL_SESSION_ACTIONS,
  FRONTIER_MANUAL_SESSION_AUTOMATION,
  FRONTIER_MANUAL_SESSION_MAX_TEXT_BYTES,
  FRONTIER_MANUAL_SESSION_MAX_TEXT_CLAIMS,
  FRONTIER_MANUAL_SESSION_MAX_TTL_SECONDS,
  FRONTIER_MANUAL_SESSION_MODEL,
  FRONTIER_MANUAL_SESSION_REASONING,
  frontierManualSessionGrantDigest,
  frontierManualSessionOperationDigest,
  frontierManualSessionProjectBindingDigest,
  validateFrontierManualSessionEnvelope,
  type FrontierManualSessionAction,
  type FrontierManualSessionScope,
} from './frontier-manual-session-contract.js';
import type { RemoteSteeringOutcome } from './remote-steering.js';

export type FrontierManualSessionControllerAction = 'start' | 'send' | 'status';
export interface FrontierManualSessionControllerInput {
  readonly action: FrontierManualSessionControllerAction;
  readonly scope: FrontierManualSessionScope;
  readonly label: string;
  readonly prompt?: string;
  readonly ttl_hours?: number;
}
export interface FrontierManualSessionControllerProjection {
  readonly scope: FrontierManualSessionScope;
  readonly textClaimsUsed: number;
  readonly textClaimsRemaining: number;
  readonly sessionCreated: boolean;
  readonly lastMutationSeq: number;
  readonly model: typeof FRONTIER_MANUAL_SESSION_MODEL;
  readonly reasoning: typeof FRONTIER_MANUAL_SESSION_REASONING;
  readonly automation: false;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly live: boolean;
}
export interface FrontierManualSessionControllerResult {
  readonly kind: 'intent';
  readonly action: FrontierManualSessionControllerAction;
  readonly scope: FrontierManualSessionScope;
  readonly label: string;
  readonly childReplay: boolean | null;
  readonly child: FrontierManualSessionControllerProjection;
  readonly relay: RemoteSteeringOutcome;
}

interface CommandBinding { nodePath: string; cliPath: string; cwd: string; }
const DEFAULT_BINDING: CommandBinding = {
  nodePath: 'C:\\Dev\\Tools\\nodejs\\node.exe',
  cliPath: 'C:\\Dev\\NEXORA\\apps\\command-center\\apps\\cli\\dist\\main.js',
  cwd: 'C:\\Dev\\NEXORA',
};
const COMMAND_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 100_000;
const MAX_TTL_HOURS = 72;
const REQUEST_DOMAIN = 'nexora.cos.frontier-manual-session.request.v1:';
const CHILD_REQUEST_DOMAIN = 'nexora.cos.frontier-manual-session.child-request.v1:';
const SCOPES: readonly FrontierManualSessionScope[] = ['command_center','nkb','vyper'];
const CHILD_FAMILIES = ['frontier_longrun_parent','frontier_manual_session'] as const;

let testBinding: CommandBinding | null = null;
let commandRunner: typeof runCommand = runCommand;
export class FrontierManualSessionControllerError extends Error {}

export function normalizeFrontierManualSessionLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '-');
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized) ? normalized : null;
}
function binding(): CommandBinding { return testBinding ?? DEFAULT_BINDING; }
async function regularNonLinkFile(file: string, label: string): Promise<void> {
  if (!path.isAbsolute(file)) throw new FrontierManualSessionControllerError(`${label} binding is not absolute`);
  let stat; try { stat = await fs.lstat(file); } catch (error) { throw new FrontierManualSessionControllerError(`${label} binding is unavailable (${error instanceof Error ? error.message : String(error)})`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new FrontierManualSessionControllerError(`${label} binding is not a regular non-link file`);
}
async function regularNonLinkDirectory(directory: string): Promise<void> {
  if (!path.isAbsolute(directory)) throw new FrontierManualSessionControllerError('Command Center cwd binding is not absolute');
  let stat; try { stat = await fs.lstat(directory); } catch (error) { throw new FrontierManualSessionControllerError(`Command Center cwd binding is unavailable (${error instanceof Error ? error.message : String(error)})`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new FrontierManualSessionControllerError('Command Center cwd binding is not a regular non-link directory');
}
async function verifyBinding(value: CommandBinding): Promise<void> {
  await Promise.all([regularNonLinkFile(value.nodePath, 'Node executable'), regularNonLinkFile(value.cliPath, 'Command Center CLI'), regularNonLinkDirectory(value.cwd)]);
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value); const set = new Set(expected);
  return keys.length === expected.length && keys.every(key => set.has(key)) && expected.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FrontierManualSessionControllerError(`${label} was not a JSON object`);
  return value as Record<string, unknown>;
}
function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new FrontierManualSessionControllerError(`Command Center returned invalid ${label}`);
  return value;
}
function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new FrontierManualSessionControllerError(`Command Center returned invalid ${label}`);
  return value;
}
function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new FrontierManualSessionControllerError(`Command Center returned invalid ${label}`);
  return value;
}
function warnings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 8 || value.some(item => typeof item !== 'string' || item.length > 500)) throw new FrontierManualSessionControllerError('Command Center returned malformed manual-session warnings');
  return value as string[];
}
function reason(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[A-Z0-9_]{1,100}$/.test(value)) throw new FrontierManualSessionControllerError('Command Center returned malformed manual-session reason');
  return value;
}
function scopeValue(value: unknown): FrontierManualSessionScope {
  if (typeof value !== 'string' || !SCOPES.includes(value as FrontierManualSessionScope)) throw new FrontierManualSessionControllerError('scope must be command_center, nkb, or vyper');
  return value as FrontierManualSessionScope;
}
function ttlHours(action: FrontierManualSessionControllerAction, value: unknown): number | null {
  if (action !== 'start') {
    if (value !== undefined) throw new FrontierManualSessionControllerError(`${action} does not accept ttl_hours`);
    return null;
  }
  if (value === undefined) return MAX_TTL_HOURS;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_TTL_HOURS) throw new FrontierManualSessionControllerError('ttl_hours must be a whole number from 1 to 72');
  return value;
}
function promptBytes(action: FrontierManualSessionControllerAction, prompt: unknown): Buffer | null {
  if (action === 'status') {
    if (prompt !== undefined) throw new FrontierManualSessionControllerError('status does not accept a prompt');
    return null;
  }
  if (typeof prompt !== 'string' || prompt.trim().length === 0) throw new FrontierManualSessionControllerError(`${action} requires a non-empty prompt`);
  const bytes = Buffer.from(prompt, 'utf8');
  if (bytes.length > FRONTIER_MANUAL_SESSION_MAX_TEXT_BYTES) throw new FrontierManualSessionControllerError(`prompt exceeds ${FRONTIER_MANUAL_SESSION_MAX_TEXT_BYTES} UTF-8 bytes`);
  return bytes;
}
function requestIds(action: FrontierManualSessionControllerAction, scope: FrontierManualSessionScope, label: string, bytes: Buffer | null, ttlSeconds: number | null): { controller: string; child: string } {
  const exactRequestId = currentCall()?.caller.requestId;
  if (!exactRequestId) throw new FrontierManualSessionControllerError('frontier_session requires ChatGPT request identity for exact retry safety; no temporary file or Command Center operation was created');
  const semantic = JSON.stringify({ action, scope, label, taskSha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null, taskLength: bytes?.length ?? null, ttlSeconds });
  const derive = (domain: string) => createHash('sha256').update(domain).update(exactRequestId).update('\n').update(semantic).digest('hex').slice(0, 32);
  return { controller: derive(REQUEST_DOMAIN), child: derive(CHILD_REQUEST_DOMAIN) };
}
async function invokeCc(argv: readonly string[]): Promise<unknown> {
  const fixed = binding(); await verifyBinding(fixed);
  const result = await commandRunner(fixed.nodePath, [fixed.cliPath, ...argv], fixed.cwd, COMMAND_TIMEOUT_MS);
  if (result.timedOut) throw new FrontierManualSessionControllerError('Command Center manual-session command timed out');
  if (result.truncated || Buffer.byteLength(result.stdout, 'utf8') > MAX_OUTPUT_BYTES) throw new FrontierManualSessionControllerError('Command Center manual-session output exceeded the accepted bound');
  if (result.exitCode !== 0) { const detail = result.stderr.trim().slice(0, 300); throw new FrontierManualSessionControllerError(`Command Center manual-session command failed${detail ? `: ${detail}` : ''}`); }
  const text = result.stdout.trim(); if (!text) throw new FrontierManualSessionControllerError('Command Center manual-session command returned no JSON');
  try { return JSON.parse(text) as unknown; } catch { throw new FrontierManualSessionControllerError('Command Center manual-session command returned malformed JSON'); }
}
async function withTaskFile<T>(bytes: Buffer, body: (file: string) => Promise<T>): Promise<T> {
  const file = path.join(os.tmpdir(), `cos-frontier-session-${randomUUID()}.txt`);
  try { await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); return await body(file); }
  finally { await fs.unlink(file).catch(() => undefined); }
}

function strictParent(value: unknown, expectedScope: FrontierManualSessionScope): { expiresAt: string; fingerprint: string } {
  const parent = record(value, 'Command Center Travel Parent');
  if (!exactKeys(parent, ['allowedChildFamilies','allowedScopes','maxChildrenTotal','maxChildrenPerScope','childrenUsedTotal','childrenUsedByScope','issuedAt','expiresAt','signingKeyFingerprint','operatorIntentDigest','travelParentDigest','live','revoked'])) throw new FrontierManualSessionControllerError('Command Center returned malformed Travel Parent metadata');
  if (!Array.isArray(parent.allowedChildFamilies) || parent.allowedChildFamilies.length !== 2 || parent.allowedChildFamilies.some((v,i) => v !== CHILD_FAMILIES[i]) ||
      !Array.isArray(parent.allowedScopes) || parent.allowedScopes.some(v => typeof v !== 'string' || !SCOPES.includes(v as FrontierManualSessionScope)) ||
      new Set(parent.allowedScopes).size !== parent.allowedScopes.length || !parent.allowedScopes.includes(expectedScope) || parent.maxChildrenTotal !== 9 || parent.maxChildrenPerScope !== 3 ||
      typeof parent.live !== 'boolean' || typeof parent.revoked !== 'boolean') throw new FrontierManualSessionControllerError('Command Center returned malformed Travel Parent profile metadata');
  const counts = record(parent.childrenUsedByScope, 'Travel Parent child counts');
  if (!exactKeys(counts, SCOPES)) throw new FrontierManualSessionControllerError('Command Center returned malformed Travel Parent scope counts');
  const total = integer(parent.childrenUsedTotal, 'Travel Parent child count', 0, 9);
  const sum = SCOPES.reduce((n, scope) => n + integer(counts[scope], `${scope} child count`, 0, 3), 0);
  if (total !== sum) throw new FrontierManualSessionControllerError('Command Center returned inconsistent Travel Parent child counts');
  const issuedAt = timestamp(parent.issuedAt, 'Travel Parent issuedAt'); const expiresAt = timestamp(parent.expiresAt, 'Travel Parent expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(issuedAt) || Date.parse(expiresAt) - Date.parse(issuedAt) > 7 * 24 * 60 * 60_000) throw new FrontierManualSessionControllerError('Command Center returned invalid Travel Parent window');
  const fingerprint = digest(parent.signingKeyFingerprint, 'Travel Parent signing key fingerprint'); digest(parent.operatorIntentDigest, 'Travel Parent operator intent'); digest(parent.travelParentDigest, 'Travel Parent digest');
  if (!parent.live || parent.revoked) throw new FrontierManualSessionControllerError('Command Center returned a non-live Travel Parent for manual-session creation');
  return { expiresAt, fingerprint };
}

function strictChild(value: unknown, expectedScope: FrontierManualSessionScope): FrontierManualSessionControllerProjection & { grantDigest: string; projectBindingDigest: string; fingerprint: string } {
  const child = record(value, 'Command Center manual-session child');
  if (!exactKeys(child, ['scope','projectBindingDigest','allowedActions','maxTextClaims','textClaimsUsed','textClaimsRemaining','sessionCreated','lastMutationSeq','model','reasoning','automation','issuedAt','expiresAt','signingKeyFingerprint','grantDigest','live'])) throw new FrontierManualSessionControllerError('Command Center returned malformed manual-session child metadata');
  if (child.scope !== expectedScope || digest(child.projectBindingDigest, 'manual-session project binding') !== frontierManualSessionProjectBindingDigest(expectedScope) ||
      !Array.isArray(child.allowedActions) || child.allowedActions.length !== FRONTIER_MANUAL_SESSION_ACTIONS.length || child.allowedActions.some((v,i) => v !== FRONTIER_MANUAL_SESSION_ACTIONS[i]) ||
      child.maxTextClaims !== FRONTIER_MANUAL_SESSION_MAX_TEXT_CLAIMS || child.model !== FRONTIER_MANUAL_SESSION_MODEL || child.reasoning !== FRONTIER_MANUAL_SESSION_REASONING ||
      child.automation !== FRONTIER_MANUAL_SESSION_AUTOMATION || typeof child.sessionCreated !== 'boolean' || typeof child.live !== 'boolean') throw new FrontierManualSessionControllerError('Command Center returned unexpected manual-session child profile');
  const used = integer(child.textClaimsUsed, 'manual-session text claims used', 0, FRONTIER_MANUAL_SESSION_MAX_TEXT_CLAIMS);
  const remaining = integer(child.textClaimsRemaining, 'manual-session text claims remaining', 0, FRONTIER_MANUAL_SESSION_MAX_TEXT_CLAIMS);
  const seq = integer(child.lastMutationSeq, 'manual-session mutation sequence', 0);
  if (used + remaining !== FRONTIER_MANUAL_SESSION_MAX_TEXT_CLAIMS || (!child.sessionCreated && (used !== 0 || seq !== 0)) || (child.sessionCreated && (used < 1 || seq < 1))) throw new FrontierManualSessionControllerError('Command Center returned inconsistent manual-session child counters');
  const issuedAt = timestamp(child.issuedAt, 'manual-session issuedAt'); const expiresAt = timestamp(child.expiresAt, 'manual-session expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(issuedAt) || Date.parse(expiresAt) - Date.parse(issuedAt) > FRONTIER_MANUAL_SESSION_MAX_TTL_SECONDS * 1000) throw new FrontierManualSessionControllerError('Command Center returned invalid manual-session child window');
  return { scope: expectedScope, textClaimsUsed: used, textClaimsRemaining: remaining, sessionCreated: child.sessionCreated, lastMutationSeq: seq,
    model: FRONTIER_MANUAL_SESSION_MODEL, reasoning: FRONTIER_MANUAL_SESSION_REASONING, automation: false, issuedAt, expiresAt, live: child.live,
    grantDigest: digest(child.grantDigest, 'manual-session grant digest'), projectBindingDigest: child.projectBindingDigest as string, fingerprint: digest(child.signingKeyFingerprint, 'manual-session signing key fingerprint') };
}

function strictCreate(value: unknown, scope: FrontierManualSessionScope, label: string, ttlSeconds: number): { replay: boolean; child: ReturnType<typeof strictChild> } {
  const payload = record(value, 'Command Center manual-session create output');
  if (!exactKeys(payload, ['command','mode','status','scope','label','parent','child','certificateDigest','replay','reason','warnings']) || payload.command !== 'cc.remote.steering.travel-parent.manual-session.create' || payload.mode !== 'issued') throw new FrontierManualSessionControllerError('Command Center returned unexpected manual-session create payload');
  warnings(payload.warnings); const why = reason(payload.reason);
  if (payload.status !== 'ok' || why !== null || payload.scope !== scope || payload.label !== label || payload.parent === null || payload.child === null || typeof payload.replay !== 'boolean') throw new FrontierManualSessionControllerError(`Command Center refused manual-session creation: ${why ?? 'FRONTIER_MANUAL_SESSION_CREATE_REFUSED'}`);
  digest(payload.certificateDigest, 'manual-session certificate digest');
  const parent = strictParent(payload.parent, scope); const child = strictChild(payload.child, scope);
  if (!child.live || child.sessionCreated && !payload.replay || Date.parse(child.expiresAt) > Date.parse(parent.expiresAt) || child.fingerprint !== parent.fingerprint || (Date.parse(child.expiresAt) - Date.parse(child.issuedAt)) / 1000 !== ttlSeconds) throw new FrontierManualSessionControllerError('Command Center returned inconsistent manual-session child creation metadata');
  return { replay: payload.replay, child };
}

function strictIntent(value: unknown, requested: FrontierManualSessionControllerAction, scope: FrontierManualSessionScope, label: string, bytes: Buffer | null, expectedGrantDigest?: string): { child: FrontierManualSessionControllerProjection; envelope: Record<string, unknown> } {
  const payload = record(value, 'Command Center manual-session intent output');
  if (!exactKeys(payload, ['command','status','intent','scope','label','child','operation','envelope','reason','warnings']) || payload.command !== 'cc.remote.steering.manual-session.intent') throw new FrontierManualSessionControllerError('Command Center returned unexpected manual-session intent payload');
  warnings(payload.warnings); const why = reason(payload.reason);
  if (payload.status !== 'ok' || why !== null || payload.intent !== requested || payload.scope !== scope || payload.label !== label || payload.child === null || payload.operation === null || payload.envelope === null) throw new FrontierManualSessionControllerError(`Command Center refused ${requested}: ${why ?? 'FRONTIER_MANUAL_SESSION_INTENT_REFUSED'}`);
  const child = strictChild(payload.child, scope);
  const envelope = validateFrontierManualSessionEnvelope(payload.envelope);
  if (!envelope) throw new FrontierManualSessionControllerError('Command Center returned malformed signed manual-session envelope');
  const grant = envelope.grant.payload; const operation = envelope.operation.payload;
  const expectedAction: FrontierManualSessionAction = requested === 'start' ? 'SESSION_CREATE' : requested === 'send' ? 'SESSION_PROMPT' : 'SESSION_STATUS';
  if (operation.action !== expectedAction || grant.scope !== scope || grant.model !== FRONTIER_MANUAL_SESSION_MODEL || grant.reasoning !== FRONTIER_MANUAL_SESSION_REASONING || grant.automation !== false ||
      child.grantDigest !== frontierManualSessionGrantDigest(grant) || child.projectBindingDigest !== grant.projectBindingDigest || child.fingerprint !== grant.signingKeyFingerprint ||
      child.issuedAt !== grant.issuedAt || child.expiresAt !== grant.expiresAt || (expectedGrantDigest && child.grantDigest !== expectedGrantDigest)) throw new FrontierManualSessionControllerError('Command Center manual-session intent metadata does not match its signed grant');
  const operationView = record(payload.operation, 'Command Center manual-session operation view');
  if (!exactKeys(operationView, ['action','mutationSeq','inputId','taskSha256','taskLength','issuedAt','expiresAt','operationDigest']) || operationView.action !== operation.action || operationView.mutationSeq !== operation.mutationSeq ||
      operationView.inputId !== operation.inputId || operationView.taskSha256 !== operation.taskSha256 || operationView.taskLength !== operation.taskLength || operationView.issuedAt !== operation.issuedAt || operationView.expiresAt !== operation.expiresAt || operationView.operationDigest !== frontierManualSessionOperationDigest(operation)) throw new FrontierManualSessionControllerError('Command Center manual-session operation view does not match its signed envelope');
  if (bytes) {
    const text = bytes.toString('utf8'); if (operation.taskText !== text || operation.taskLength !== bytes.length || operation.taskSha256 !== createHash('sha256').update(bytes).digest('hex')) throw new FrontierManualSessionControllerError('Command Center signed manual-session task does not match requested prompt bytes');
  } else if (operation.taskText !== null || operation.taskSha256 !== null || operation.taskLength !== null || operation.inputId !== null) throw new FrontierManualSessionControllerError('Command Center signed task text for status');
  return { child, envelope: payload.envelope as Record<string, unknown> };
}

export async function runFrontierManualSessionController(input: FrontierManualSessionControllerInput, relay: (envelope: Record<string, unknown>) => Promise<RemoteSteeringOutcome>): Promise<FrontierManualSessionControllerResult> {
  if (input.action !== 'start' && input.action !== 'send' && input.action !== 'status') throw new FrontierManualSessionControllerError('unsupported frontier_session action');
  const scope = scopeValue(input.scope); const label = normalizeFrontierManualSessionLabel(input.label);
  if (!label) throw new FrontierManualSessionControllerError("label must normalize to 1..64 lowercase letters/digits plus '.', '_' or '-'");
  const bytes = promptBytes(input.action, input.prompt); const hours = ttlHours(input.action, input.ttl_hours); const ttlSeconds = hours === null ? null : hours * 3600;
  const ids = requestIds(input.action, scope, label, bytes, ttlSeconds);
  let childReplay: boolean | null = null; let expectedGrantDigest: string | undefined;
  if (input.action === 'start') {
    const created = strictCreate(await invokeCc(['cc.remote.steering.travel-parent.manual-session.create','--scope',scope,'--label',label,'--travel-parent-request-id',ids.child,'--ttl-seconds',String(ttlSeconds!),'--confirm']), scope, label, ttlSeconds!);
    childReplay = created.replay; expectedGrantDigest = created.child.grantDigest;
  }
  const args = ['cc.remote.steering.manual-session.intent','--scope',scope,'--label',label,'--intent',input.action,'--controller-request-id',ids.controller];
  const payload = bytes ? await withTaskFile(bytes, file => invokeCc([...args,'--task-file',file])) : await invokeCc(args);
  const issued = strictIntent(payload, input.action, scope, label, bytes, expectedGrantDigest);
  const relayResult = await relay(issued.envelope);
  return { kind: 'intent', action: input.action, scope, label, childReplay, child: issued.child, relay: relayResult };
}

export function setFrontierManualSessionCommandBindingForTests(value: CommandBinding | null): void { testBinding = value ? { ...value } : null; }
export function setFrontierManualSessionCommandRunnerForTests(value: typeof runCommand | null): void { commandRunner = value ?? runCommand; }
export function resetFrontierManualSessionControllerForTests(): void { testBinding = null; commandRunner = runCommand; }
