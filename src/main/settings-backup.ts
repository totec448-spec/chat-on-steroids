/**
 * A settings backup: one file that carries this app's preferences to another computer, or keeps
 * a copy of them.
 *
 * It holds exactly what the Settings form saves, so importing one goes through the same save,
 * with the same checks and the same effects, as changing those switches by hand. What belongs to
 * this computer stays out: approved folders, the tunnel and its connector ids, the connector name
 * suffix, the browser bridge port and stable connector URLs. Two computers sharing one of those
 * would answer each other's chats.
 *
 * Saved keys (API keys, plugin keys) travel only when asked for, sealed with a passphrase the
 * person chooses: scrypt for the key, AES-256-GCM for the data, so a wrong passphrase or a changed
 * file opens nothing. Keys that belong to this install (the browser bridge's token, setup profile
 * and stable URL secrets) never travel.
 */

import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback, type ScryptOptions } from 'node:crypto';
import type { z } from 'zod';

export const BACKUP_FORMAT = 'chat-on-steroids-settings';
export const BACKUP_VERSION = 1;
/** Far above any real backup (a few KB), far below what could hurt to read. */
const MAX_BACKUP_CHARS = 2_000_000;
const MIN_PASSPHRASE_CHARS = 8;
/** Counted in characters a person types, so an emoji is one, not two. */
export const passphraseLongEnough = (passphrase: string): boolean => [...passphrase].length >= MIN_PASSPHRASE_CHARS;
/** scrypt cost: about half a second on a laptop, 128 MiB of memory. */
const SCRYPT = { N: 2 ** 17, r: 8, p: 1 } as const;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const SEAL_AAD = Buffer.from(`${BACKUP_FORMAT}/${BACKUP_VERSION}`);

/** Paths that belong to this computer; a backup never carries them, and an import never takes them. */
const PER_COMPUTER: ReadonlyArray<readonly string[]> = [
  ['connectorSuffix'], ['tunnel'], ['ui', 'browserBridgePort'], ['mcp', 'persistentUrls'],
  // Reported by this computer's window and browser extension, or this install's own answer.
  ['ui', 'browserPreferences'], ['ui', 'cosBrowserTrayHint'], ['ui', 'autoRefreshPluginsAsked'],
  // The OS login item of this computer: an import never registers or removes it elsewhere.
  ['ui', 'startAtLogin']
];

export type BackupErrorCode = 'not-a-backup' | 'newer-version' | 'too-large' | 'wrong-passphrase' | 'passphrase-too-short' | 'invalid-settings';

export class BackupError extends Error {
  constructor(readonly code: BackupErrorCode, message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

export interface SealedSecrets { kdf: 'scrypt'; N: number; r: number; p: number; salt: string; iv: string; tag: string; data: string; count: number }
type Settings = Record<string, unknown>;

export interface ParsedBackup {
  appVersion: string | null;
  exportedAt: string | null;
  settings: Settings;
  secrets: SealedSecrets | null;
  secretCount: number;
}

/**
 * The saved keys a person can carry to another computer: their own API and plugin keys, and the
 * phone notifications' access token (#1800), whose server and topic travel in the settings.
 */
export function exportableSecret(key: string): boolean {
  return key === 'openaiApiKey' || key === 'openRouterApiKey' || key === 'customProviderApiKey' || key === 'ntfyToken' || key.startsWith('plugin:');
}

const isPlainObject = (value: unknown): value is Settings =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The object schema inside optional, default, catch and pipe wrappers, or null for a leaf. */
function shapeOf(schema: z.ZodType): Record<string, z.ZodType> | null {
  let current: unknown = schema;
  for (let depth = 0; depth < 8 && current; depth++) {
    const def = (current as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
    if (!def) return null;
    if (def.type === 'object') return (current as { shape: Record<string, z.ZodType> }).shape;
    current = def.innerType ?? (def.type === 'pipe' ? def.in : undefined);
  }
  return null;
}

/** The parts of `value` the schema names, recursively; everything else is left out. */
export function pickByShape(schema: z.ZodType, value: unknown): Settings {
  const shape = shapeOf(schema);
  if (!shape || !isPlainObject(value)) return {};
  const out: Settings = {};
  for (const [key, child] of Object.entries(shape)) {
    const item = value[key];
    if (item === undefined) continue;
    out[key] = shapeOf(child) && isPlainObject(item) ? pickByShape(child, item) : structuredClone(item);
  }
  return out;
}

/**
 * The settings a backup carries: every setting the form owns, with one that was never changed
 * written as null. A setting at its default is often not stored at all, and a backup that simply
 * left it out would not put it back on import (a missing setting keeps today's value).
 */
export function settingsForBackup(schema: z.ZodType, value: unknown): Settings {
  const shape = shapeOf(schema);
  if (!shape) return {};
  const source = isPlainObject(value) ? value : {};
  const out: Settings = {};
  for (const [key, child] of Object.entries(shape)) {
    const item = source[key];
    if (item === undefined) out[key] = null;
    else out[key] = shapeOf(child) && isPlainObject(item) ? settingsForBackup(child, item) : structuredClone(item);
  }
  return out;
}

function withoutPerComputer(settings: Settings): Settings {
  const out = structuredClone(settings);
  for (const path of PER_COMPUTER) {
    let parent: unknown = out;
    for (const key of path.slice(0, -1)) parent = isPlainObject(parent) ? parent[key] : undefined;
    if (isPlainObject(parent)) delete parent[path[path.length - 1]!];
  }
  return out;
}

/**
 * `current` with every setting `incoming` has, where the schema knows it. A setting the backup
 * lacks (it is older) keeps today's value; one it has as null was never changed there and is unset
 * here, where a setting may be unset at all (elsewhere, as in a hand-edited file, null is ignored);
 * a whole section as null (never set up there) keeps today's section;
 * one this version does not know is ignored; a list is taken whole. Per-computer settings are never taken.
 */
export function overlaySettings(schema: z.ZodType, current: Settings, incoming: Settings): Settings {
  const merge = (shape: Record<string, z.ZodType>, base: Settings, next: Settings): Settings => {
    const out: Settings = { ...base };
    for (const [key, child] of Object.entries(shape)) {
      const item = next[key];
      if (item === undefined) continue;
      if (item === null) {
        // One setting is unset; a whole section never is. A computer that never set up phone
        // notifications must not wipe another's (its topic is what the phone subscribed to).
        if (!shapeOf(child) && child.safeParse(undefined).success) delete out[key];
        continue;
      }
      const childShape = shapeOf(child);
      if (childShape) {
        if (isPlainObject(item)) out[key] = merge(childShape, isPlainObject(base[key]) ? base[key] : {}, item);
      } else out[key] = structuredClone(item);
    }
    return out;
  };
  const shape = shapeOf(schema);
  return shape ? merge(shape, current, withoutPerComputer(incoming)) : { ...current };
}

const at = (settings: Settings, path: string): unknown => path.split('.').reduce<unknown>((node, key) => isPlainObject(node) ? node[key] : undefined, settings);

/**
 * The changes an import would make that give ChatGPT more access to this computer, as dotted paths,
 * sorted: a permission switched on, read-only off, the command rules switched off or changed, the
 * control API or its actions on, the strict chat allowlist off, unattributed calls allowed, or the
 * secrets shield off. The import dialog names these where nobody can miss them.
 */
export function widerAccess(before: Settings, after: Settings): string[] {
  const wider: string[] = [];
  const turnedOn = (path: string) => at(before, path) !== true && at(after, path) === true;
  const turnedOff = (path: string, missing: boolean) => (at(before, path) ?? missing) !== false && (at(after, path) ?? missing) === false;
  const capabilities = at(after, 'capabilities');
  if (isPlainObject(capabilities)) for (const key of Object.keys(capabilities)) if (turnedOn(`capabilities.${key}`)) wider.push(`capabilities.${key}`);
  if (at(before, 'readOnly') === true && at(after, 'readOnly') === false) wider.push('readOnly');
  const rulesBefore = at(before, 'commandAllowlist'), rulesAfter = at(after, 'commandAllowlist');
  if (isPlainObject(rulesBefore) && rulesBefore['enabled'] === true && JSON.stringify(rulesBefore) !== JSON.stringify(rulesAfter)) wider.push('commandAllowlist');
  for (const path of ['controlApi.enabled', 'controlApi.allowActions', 'multiAgent.allowUnattributedCalls']) if (turnedOn(path)) wider.push(path);
  if (turnedOff('multiAgent.strictChatAllowlist', false)) wider.push('multiAgent.strictChatAllowlist');
  // Missing means on, as in the saved settings.
  if (turnedOff('ui.secretsShield', true)) wider.push('ui.secretsShield');
  return wider.sort();
}

/** Dotted paths of the settings that differ, sorted; lists and values compare whole. */
export function changedSettings(before: Settings, after: Settings, prefix = ''): string[] {
  const changed: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[key], b = after[key], path = prefix + key;
    if (isPlainObject(a) && isPlainObject(b)) changed.push(...changedSettings(a, b, `${path}.`));
    else if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(path);
  }
  return changed.sort();
}

function deriveKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { ...params, maxmem: SCRYPT_MAXMEM };
  return new Promise((resolve, reject) => scryptCallback(passphrase.normalize('NFC'), salt, 32, options,
    (error, key) => error ? reject(error) : resolve(key)));
}

async function seal(values: Record<string, string>, passphrase: string): Promise<SealedSecrets> {
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt, SCRYPT);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(SEAL_AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
  return { kdf: 'scrypt', ...SCRYPT, salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'), count: Object.keys(values).length };
}

/** The backup file's text. Keys are included only with a passphrase, and only the exportable ones. */
export async function buildBackup(input: {
  settings: Settings; appVersion: string; now: Date; secrets?: { values: Record<string, string>; passphrase: string };
}): Promise<string> {
  let sealed: SealedSecrets | null = null;
  if (input.secrets) {
    if (!passphraseLongEnough(input.secrets.passphrase)) {
      throw new BackupError('passphrase-too-short', `Use a passphrase of at least ${MIN_PASSPHRASE_CHARS} characters.`);
    }
    const values = Object.fromEntries(Object.entries(input.secrets.values).filter(([key]) => exportableSecret(key)));
    if (Object.keys(values).length) sealed = await seal(values, input.secrets.passphrase);
  }
  const backup = {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, appVersion: input.appVersion, exportedAt: input.now.toISOString(),
    settings: withoutPerComputer(input.settings), ...(sealed ? { secrets: sealed } : {})
  };
  return `${JSON.stringify(backup, null, 2)}\n`;
}

const NOT_A_BACKUP = 'This file is not a Chat On Steroids settings backup.';
const base64 = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(value);

function sealedSecrets(value: unknown): SealedSecrets {
  const sealed = value as Partial<SealedSecrets>;
  const ok = isPlainObject(value) && sealed.kdf === 'scrypt' &&
    // Bounded, so a crafted file cannot make the import spend minutes or gigabytes deriving a key.
    Number.isInteger(sealed.N) && sealed.N! >= 2 ** 14 && sealed.N! <= 2 ** 18 && (sealed.N! & (sealed.N! - 1)) === 0 &&
    Number.isInteger(sealed.r) && sealed.r! >= 1 && sealed.r! <= 16 && Number.isInteger(sealed.p) && sealed.p! >= 1 && sealed.p! <= 4 &&
    128 * sealed.N! * sealed.r! * sealed.p! <= SCRYPT_MAXMEM / 2 &&
    base64(sealed.salt) && base64(sealed.iv) && base64(sealed.tag) && base64(sealed.data) &&
    Number.isInteger(sealed.count) && sealed.count! >= 0 && sealed.count! <= 1000;
  if (!ok) throw new BackupError('not-a-backup', NOT_A_BACKUP);
  return sealed as SealedSecrets;
}

/** The file's contents, checked; per-computer settings are already gone. Nothing is opened yet. */
export function readBackup(text: string): ParsedBackup {
  if (text.length > MAX_BACKUP_CHARS) throw new BackupError('too-large', 'This file is too large to be a settings backup.');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new BackupError('not-a-backup', NOT_A_BACKUP); }
  if (!isPlainObject(parsed) || parsed.format !== BACKUP_FORMAT) throw new BackupError('not-a-backup', NOT_A_BACKUP);
  if (typeof parsed.version === 'number' && parsed.version > BACKUP_VERSION) {
    throw new BackupError('newer-version', 'This backup comes from a newer Chat On Steroids. Update the app, then import it.');
  }
  if (parsed.version !== BACKUP_VERSION || !isPlainObject(parsed.settings)) throw new BackupError('not-a-backup', NOT_A_BACKUP);
  const secrets = parsed.secrets === undefined ? null : sealedSecrets(parsed.secrets);
  return {
    appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion.slice(0, 40) : null,
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt.slice(0, 40) : null,
    settings: withoutPerComputer(parsed.settings),
    secrets,
    secretCount: secrets?.count ?? 0
  };
}

/** The sealed keys, with the passphrase. A wrong passphrase and a changed file look the same. */
export async function openSecrets(sealed: SealedSecrets, passphrase: string): Promise<Record<string, string>> {
  const wrong = () => new BackupError('wrong-passphrase', 'That passphrase does not open the saved keys in this backup.');
  const key = await deriveKey(passphrase, Buffer.from(sealed.salt, 'base64'), sealed);
  let plain: string;
  try {
    // A fixed 16-byte tag: Node would otherwise accept a truncated one, which is easier to forge.
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'), { authTagLength: 16 });
    decipher.setAAD(SEAL_AAD);
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    plain = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
  } catch { throw wrong(); }
  let values: unknown;
  try { values = JSON.parse(plain); } catch { throw wrong(); }
  if (!isPlainObject(values)) throw wrong();
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] =>
    exportableSecret(entry[0]) && typeof entry[1] === 'string' && entry[1].length > 0 && entry[1].length <= 4096));
}
