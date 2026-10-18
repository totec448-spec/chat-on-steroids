/**
 * Path sandbox. Every filesystem tool goes through here.
 *
 * Model-facing filesystem results use virtual paths like "/project/src/main.ts". This module
 * maps them onto real filesystem paths and also accepts native absolute input copied from command
 * output when it names the same approved tree. Anything outside an approved root is refused.
 * Containment is decided by canonicalising with fs.realpath and then
 * comparing against the canonicalised root, which is what defeats symlinks, NTFS
 * junctions and other reparse points planted inside an approved tree: following them
 * is fine as long as the destination is still inside the root.
 *
 * Enforcement lives here, in code. It is never delegated to prompt text.
 */

import { rawPromises as fs, rawRealpathNative } from './rawfs.js';
import path from 'node:path';
import type { RemoteFolder, Root } from '../shared/types.js';
import { sftpFor } from './remote/ssh.js';
import { SftpError } from './remote/sftp.js';

const IS_WINDOWS = process.platform === 'win32';
/** Windows file-name rules for paths on this computer; a server's paths never take them. */
let windowsNameRules = IS_WINDOWS;
/** Test seam: apply (true) or drop (false) the Windows name rules on any platform; null restores. */
export function setWindowsPathRulesForTests(on: boolean | null): void {
  windowsNameRules = on ?? IS_WINDOWS;
}

/** WSL's local redirector aliases; the Linux part of their paths is case-sensitive. */
const WSL_PATH = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(.*)$/i;

/** Native path identity shared by the sandbox and project catalog. */
export function nativePathIdentity(input: string): string {
  const resolved = path.resolve(input);
  if (!IS_WINDOWS) return resolved;
  const wsl = WSL_PATH.exec(resolved);
  return wsl ? `\\\\wsl.localhost\\${wsl[1]!.toLowerCase()}${wsl[2]}` : resolved.toLowerCase();
}

/** Final-path identity, using Windows' native canonicalizer when path spelling is ambiguous. */
async function canonicalRealpath(target: string): Promise<string> {
  return IS_WINDOWS ? rawRealpathNative(target) : fs.realpath(target);
}

/** Windows treats these as devices no matter which directory they appear in. */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul', 'conin$', 'conout$',
  'com0', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt0', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

/**
 * Root names this app keeps for itself.
 *
 * `/skills` is the virtual namespace the design reserves for progressive-disclosure skill
 * files reachable through `read` (`docs/tool-surface.md` §5). Reserving it here rather
 * than inside `read` is the point: once a user has an approved folder called `skills`,
 * `/skills/x/SKILL.md` is ambiguous between their disk and ours, and no amount of care in
 * the reader can undo that. Cheap to reserve now, impossible to reclaim later.
 */
export const RESERVED_ROOT_NAMES = new Set(['skills']);

export class SandboxError extends Error {}

export interface Resolved {
  /** Canonical absolute path on disk. */
  real: string;
  /** Normalised virtual path, always "/root/..." with forward slashes. */
  virtual: string;
  /** The root this path belongs to. */
  root: Root;
}

/**
 * The approved spelling a refused path most likely meant, or null.
 *
 * `C:\\marscraft\\src\\ui\\Hud.js` and `/totec/marscraft/src/ui/Hud.js` both name an approved
 * root by its folder name somewhere inside them, and in the recorded sessions that is what
 * nearly every refused path was: a real file under a root, spelled from a guessed drive or one
 * folder too high. The first segment that names a root wins and the rest is carried over. It
 * is a suggestion in the error text and never a resolution — nothing is read from it.
 */
export function suggestApprovedSpelling(roots: readonly Root[], segments: readonly string[]): string | null {
  for (const [index, segment] of segments.entries()) {
    const slugs = new Set([normaliseRootName(segment), legacyRootName(segment)]);
    const root = roots.find((candidate) => slugs.has(candidate.name));
    if (root) return `/${root.name}${segments.slice(index + 1).map((part) => `/${part}`).join('')}`;
  }
  return null;
}

/** Letters spelled with two ASCII letters by custom, or that Unicode does not decompose. */
const ASCII_SPELLINGS: Readonly<Record<string, string>> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', ð: 'd', þ: 'th' };

function slugOf(lowered: string): string {
  const slug = lowered
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 32);
  return slug || 'folder';
}

/**
 * Normalises a user-supplied root name into the slug used in virtual paths. Letters keep an
 * ASCII spelling instead of being dropped: "Größe" is `groesse`, "Café" is `cafe` (older
 * versions made "Kundenprojekt Größe & Ä" `/kundenprojekt-gr-e`).
 */
export function normaliseRootName(input: string): string {
  return slugOf(input.toLowerCase().replace(/[äöüßæœøłđðþ]/g, letter => ASCII_SPELLINGS[letter]!)
    .normalize('NFKD').replace(/\p{M}+/gu, ''));
}

/** The slug older versions gave a root, which existing roots keep as their name. */
function legacyRootName(input: string): string {
  return slugOf(input.toLowerCase());
}

/** Picks a root name derived from a folder that does not collide with existing ones. */
export function uniqueRootName(folderPath: string, existing: readonly Root[]): string {
  const base = normaliseRootName(path.basename(folderPath) || 'folder');
  const taken = new Set([...RESERVED_ROOT_NAMES, ...existing.map((r) => r.name)]);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new SandboxError('Could not find a free root name');
}

/**
 * Validates one path segment. Traversal/control constraints apply everywhere; Windows also
 * rejects drive/ADS syntax, reserved device names and names Win32 silently aliases.
 */
function checkSegment(segment: string, windows = windowsNameRules): void {
  if (segment === '' || segment === '.') {
    throw new SandboxError('Path contains an empty segment');
  }
  if (segment === '..') {
    throw new SandboxError('Path traversal ("..") is not allowed');
  }
  if (segment.includes('\0')) {
    throw new SandboxError('Path contains a null byte');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(segment)) {
    throw new SandboxError('Path contains a control character');
  }
  if (windows) {
    // ":" would open an alternate data stream or a drive-relative path.
    if (segment.includes(':')) {
      throw new SandboxError('Path contains ":", which is not allowed');
    }
    if (/[<>"|?*]/.test(segment)) {
      throw new SandboxError('Path contains a character Windows does not allow');
    }
    if (/[. ]$/.test(segment)) {
      throw new SandboxError('Path segment ends with a dot or space');
    }
    const stem = segment.split('.')[0]!.toLowerCase();
    if (RESERVED_NAMES.has(stem)) {
      throw new SandboxError(`"${segment}" is a reserved Windows device name`);
    }
  }
  if (segment.length > 255) {
    throw new SandboxError('Path segment is too long');
  }
}

/**
 * Splits a virtual path into validated segments. Windows accepts both native separators. A path
 * in a folder on a server (`posix`) splits on "/" only and keeps the server's own name rules: a
 * Linux file may be called `it's "quoted".txt` or `a\b`, and Windows has no say over it.
 */
export function splitVirtualPath(input: string, { posix = false }: { posix?: boolean } = {}): string[] {
  if (typeof input !== 'string') {
    throw new SandboxError('Path must be a string');
  }
  if (input.includes('\0')) {
    throw new SandboxError('Path contains a null byte');
  }
  if (input.length > 4096) {
    throw new SandboxError('Path is too long');
  }
  const windows = windowsNameRules && !posix;
  const segments = (windows ? input.split(/[/\\]+/) : input.split(/\/+/)).filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new SandboxError('Path is empty. Use an approved virtual root such as /<root>/file.txt.');
  }
  for (const segment of segments) checkSegment(segment, windows);
  return segments;
}

/** True when `child` is `parent` or lives underneath it; WSL retains Linux path case. */
export function isContained(parent: string, child: string): boolean {
  const na = nativePathIdentity(parent);
  const nb = nativePathIdentity(child);
  if (na === nb) return true;
  // The separator check stops "C:\Root" from matching "C:\RootEvil".
  const prefix = na.endsWith(path.sep) ? na : na + path.sep;
  return nb.startsWith(prefix);
}

/**
 * Canonicalises the deepest part of `absPath` that exists, returning it along with
 * the segments that do not exist yet. Used so a create/write can be checked for
 * containment before anything is written.
 */
async function realpathDeepest(absPath: string): Promise<{ real: string; missing: string[] }> {
  let current = path.resolve(absPath);
  const missing: string[] = [];
  for (;;) {
    try {
      return { real: await canonicalRealpath(current), missing };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      if (IS_WINDOWS && WSL_PATH.test(current)) {
        // The WSL redirector can report ENOENT for an existing Linux link it cannot
        // canonicalize. Never interpret that link as a missing path available for writes.
        const exists = await fs.lstat(current).then(() => true, (probe: NodeJS.ErrnoException) => {
          if (probe.code === 'ENOENT' || probe.code === 'ENOTDIR') return false;
          throw new SandboxError('Path could not be resolved safely');
        });
        if (exists) throw new SandboxError('Path contains a link that could not be resolved');
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new SandboxError('Path has no existing parent directory');
    }
    missing.unshift(path.basename(current));
    current = parent;
  }
}

/** Reads the canonical path of an approved root, failing loudly if it has gone away. */
async function realRoot(root: Root): Promise<string> {
  try {
    const current = await canonicalRealpath(root.path);
    // roots:add persists validateNewRoot()'s canonical path. Re-resolving that pathname is a
    // liveness check, not permission to follow a new reparse target: otherwise replacing the
    // approved directory itself with a junction silently moves the sandbox boundary to whatever
    // unapproved tree the junction names. isContained() applies the native path's case rules.
    if (!isContained(root.path, current) || !isContained(current, root.path)) {
      throw new SandboxError(`Root "/${root.name}" changed on disk. Remove it and approve the folder again.`);
    }
    return current;
  } catch {
    throw new SandboxError(`Root "/${root.name}" is not available or changed on disk. Remove it and approve the folder again.`);
  }
}

export interface ResolveOptions {
  /** Allow the final path to not exist yet (for create/write). Defaults to false. */
  allowMissing?: boolean;
  /**
   * Virtual folder a path without a leading slash is taken to start from — the calling
   * chat's workspace. Absent means relative paths have nowhere to start and are refused.
   *
   * Applied by textual prefixing *before* any validation, so a relative path is checked by
   * exactly the same rules as the absolute path it is shorthand for. In particular `..` is
   * still refused segment by segment: this cannot climb out of the workspace, let alone out
   * of the root, because there is no point at which a traversal is normalised away first.
   */
  base?: string | null;
  /**
   * The caller works on a server folder (#1469) through its `ProjectFs`. Every other caller acts
   * on this computer's disk, where a server path would name some unrelated local file, so a
   * server folder is refused to it rather than handed over.
   */
  remote?: boolean;
}

/** True for a path that names its root, rather than starting from somewhere already known. */
export function isAbsoluteVirtualPath(input: string): boolean {
  if (typeof input !== 'string') return false;
  const trimmed = input.trim();
  return IS_WINDOWS ? /^[/\\]/.test(trimmed) : trimmed.startsWith('/');
}

/** A drive-letter path or a UNC share — what Windows itself prints and the model copies. */
const NATIVE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** True when a model-supplied path is an absolute native Windows path. */
export function isNativeWindowsPath(input: unknown): input is string {
  return IS_WINDOWS && typeof input === 'string' && NATIVE_PATH.test(input.trim());
}

/**
 * POSIX absolute paths and virtual paths both begin with `/`. The virtual namespace wins when
 * the first segment is an approved root name; every other absolute spelling is treated as a
 * native path copied from shell output and must prove containment before it is translated.
 */
function isNativePosixPath(roots: readonly Root[], input: unknown): input is string {
  if (IS_WINDOWS || typeof input !== 'string') return false;
  const trimmed = input.trim();
  if (!path.posix.isAbsolute(trimmed)) return false;
  const first = trimmed.split('/').find((part) => part.length > 0)?.toLowerCase();
  return first !== undefined && !roots.some((root) => root.name.toLowerCase() === first);
}

/**
 * Converts a native absolute path inside an approved root to the virtual spelling used by
 * the rest of the sandbox. Native paths outside the approved roots are still refused.
 *
 * Paths here are virtual on purpose: `/root/...` names an approved folder and nothing else
 * can be addressed. But the model spends its time reading command output, stack traces and
 * error messages, all of which print `C:\Users\...`, and pasting one back got a single
 * sentence about a colon — true, unhelpful, and about the wrong thing. It reads as the
 * sandbox rejecting a path it can plainly see is inside an approved folder.
 *
 * Keeping two independent resolution paths would be dangerous, so this does not bypass any
 * sandbox validation. It performs only a lexical approved-root lookup and returns the
 * equivalent virtual path; resolvePath then runs that through the exact same realpath,
 * symlink/junction and allowMissing checks as an originally-virtual path.
 */
/**
 * A path as a server prints it (`pwd`, error output), inside a server root's folder (#1469), as
 * the virtual path it names. Lexical only, on every platform: the result is validated like any
 * virtual path, and its folder is checked on the server. Local roots and virtual spellings win.
 */
function serverNativePath(roots: readonly Root[], input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null;
  const first = trimmed.split('/').find(part => part.length > 0)?.toLowerCase();
  if (first !== undefined && roots.some(root => root.name.toLowerCase() === first)) return null;
  if (roots.some(root => !root.remote && path.posix.isAbsolute(root.path) && isContained(root.path, trimmed))) return null;
  for (const root of roots) {
    if (!root.remote) continue;
    const prefix = root.remote.path.replace(/\/+$/, '');
    if (trimmed === prefix || trimmed === `${prefix}/` || trimmed.startsWith(`${prefix}/`)) {
      return `/${root.name}${trimmed.slice(prefix.length).replace(/\/+$/, '')}`;
    }
  }
  return null;
}

async function normaliseNativePath(roots: readonly Root[], input: string): Promise<string | null> {
  const onServer = typeof input === 'string' ? serverNativePath(roots, input) : null;
  if (onServer) return onServer;
  const nativeWindows = isNativeWindowsPath(input);
  const nativePosix = isNativePosixPath(roots, input);
  if (!nativeWindows && !nativePosix) return null;
  const trimmed = input.trim();
  // Preserve the same lexical invariant virtual paths get. `path.resolve()` erases `..`
  // (and `.`) before `splitVirtualPath()` can see it, which meant a native spelling copied
  // from command output could take a different validation path from the equivalent virtual
  // spelling. Strip only the native root prefix, then validate the user-supplied segments
  // before any normalization happens.
  const withoutNativeRoot = nativeWindows
    ? trimmed.replace(/^[A-Za-z]:[\\/]+/, '').replace(/^\\\\[^\\/]+[\\/]+[^\\/]+[\\/]*/, '')
    : trimmed.replace(/^\/+/, '');
  const nativeSegments = nativeWindows ? withoutNativeRoot.split(/[/\\]+/) : withoutNativeRoot.split(/\/+/);
  for (const segment of nativeSegments.filter((part) => part.length > 0)) checkSegment(segment);
  const native = path.resolve(trimmed);
  // A WSL folder (or a mapped drive's canonical UNC root) may be approved. Reject every
  // other UNC spelling lexically, before a remote host can trigger DNS/SMB or credentials.
  if (nativeWindows && native.startsWith('\\\\') && !roots.some(root => isContained(root.path, native))) {
    const names = roots.map((r) => `/${r.name}`).join(', ') || '(none approved)';
    throw new SandboxError(
      `Native path "${trimmed}" is not inside an approved folder. ` +
        `Approved roots: ${names}`
    );
  }
  let canonicalNative: string;
  try {
    const { real, missing } = await realpathDeepest(native);
    canonicalNative = missing.length === 0 ? real : path.join(real, ...missing);
  } catch {
    canonicalNative = native;
  }
  for (const root of roots) {
    // A server root has no path on this computer to compare with.
    if (root.remote) continue;
    let rootReal: string;
    try {
      rootReal = await realRoot(root);
    } catch {
      continue;
    }
    if (isContained(rootReal, canonicalNative)) {
      return toVirtualPath(root, rootReal, canonicalNative);
    }
    // Preserve the useful distinction between a genuinely outside native path and a spelling
    // that started under the approved root but was redirected out by a junction/symlink.
    if (isContained(rootReal, native)) {
      throw new SandboxError('Path escapes its approved folder via a link');
    }
  }
  const names = roots.map((r) => `/${r.name}`).join(', ') || '(none approved)';
  const suggestion = suggestApprovedSpelling(roots, nativeSegments.filter((part) => part.length > 0));
  throw new SandboxError(
    `Native path "${input.trim()}" is not inside an approved folder. ` +
      `Approved roots: ${names}` +
      (suggestion ? ` If you meant the approved folder, its path is ${suggestion}.` : '')
  );
}

/**
 * Maps a virtual path onto a real path inside an approved root.
 *
 * Throws SandboxError for anything that is not clearly inside a root. Callers treat
 * every SandboxError as a refusal and never fall back to the raw input.
 */
export async function resolvePath(
  roots: readonly Root[],
  virtualPath: string,
  options: ResolveOptions = {}
): Promise<Resolved> {
  const normalisedNative = await normaliseNativePath(roots, virtualPath);
  const suppliedPath = normalisedNative ?? virtualPath;
  // A relative path is shorthand for one absolute path, and is turned into that path here,
  // before anything is validated — so there stays exactly one piece of code deciding what
  // may be reached. `..` is still refused segment by segment below, because nothing
  // normalises a traversal away first: shorthand cannot climb out of the workspace, and
  // certainly not out of the root.
  const requested =
    isAbsoluteVirtualPath(suppliedPath) || !options.base
      ? suppliedPath
      : IS_WINDOWS
        ? `${options.base.replace(/[/\\]+$/, '')}/${String(suppliedPath).replace(/^[/\\]+/, '')}`
        : `${options.base.replace(/\/+$/, '')}/${String(suppliedPath).replace(/^\/+/, '')}`;
  if (typeof requested === 'string' && requested.trim() !== '' && !isAbsoluteVirtualPath(requested)) {
    // Not "Unknown root src": the caller was using shorthand, and being told their first
    // folder is not a root explains nothing about what to do instead.
    const names = roots.map((r) => `/${r.name}`).join(', ') || '(none approved)';
    throw new SandboxError(
      `"${requested.slice(0, 120)}" is relative and this chat has no active folder yet. Use a full path: ${names}`
    );
  }
  // The root decides which name rules apply, so find it before checking the rest of the path.
  const firstName = (windowsNameRules ? String(requested).split(/[/\\]+/) : String(requested).split(/\/+/)).find(Boolean)?.toLowerCase();
  const onServer = roots.some((r) => !!r.remote && r.name.toLowerCase() === firstName);
  const segments = splitVirtualPath(requested, { posix: onServer });
  const rootName = segments[0]!.toLowerCase();
  const root = roots.find((r) => r.name.toLowerCase() === rootName);
  if (!root) {
    const names = roots.map((r) => `/${r.name}`).join(', ') || '(none approved)';
    const suggestion = suggestApprovedSpelling(roots, segments.slice(1));
    throw new SandboxError(
      `Unknown root "/${segments[0]}". Approved roots: ${names}` +
        (suggestion ? ` If you meant the approved folder, its path is ${suggestion}.` : '')
    );
  }

  const rest = segments.slice(1);
  if (root.remote && options.remote !== true) {
    throw new SandboxError(`/${root.name} is a folder on a server; this works only in folders on this computer.`);
  }
  if (root.remote) return resolveRemote(root as Root & { remote: RemoteFolder }, rest, options);
  const rootReal = await realRoot(root);
  const candidate = rest.length === 0 ? rootReal : path.join(rootReal, ...rest);

  // Cheap structural check before touching the disk.
  if (!isContained(rootReal, candidate)) {
    throw new SandboxError('Path escapes its approved folder');
  }

  const { real, missing } = await realpathDeepest(candidate);

  // The canonical existing part must still be inside the root. This is the check
  // that catches a symlink or junction inside the tree pointing somewhere else.
  if (!isContained(rootReal, real)) {
    throw new SandboxError('Path escapes its approved folder via a link');
  }

  if (missing.length > 0 && !options.allowMissing) {
    throw new SandboxError(`Not found: ${toVirtualPath(root, rootReal, candidate)}`);
  }

  const finalReal = missing.length === 0 ? real : path.join(real, ...missing);
  if (!isContained(rootReal, finalReal)) {
    throw new SandboxError('Path escapes its approved folder');
  }

  return {
    real: finalReal,
    virtual: toVirtualPath(root, rootReal, finalReal),
    root
  };
}

/** POSIX containment for a path on a server; the server's paths are case-sensitive. */
function containedOnServer(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

/**
 * The same rules for a folder on a server (#1469): segments were checked above; containment is
 * POSIX, and where a link really goes is what the server's own realpath says.
 */
async function resolveRemote(root: Root & { remote: RemoteFolder }, rest: string[], options: ResolveOptions): Promise<Resolved> {
  const rootReal = root.remote.path;
  const unavailable = () => new SandboxError(`Root "/${root.name}" is not available on the server or changed there. Remove it and add the folder again.`);
  let client;
  try { client = await sftpFor(root.remote); }
  catch (error) { throw new SandboxError(`Root "/${root.name}" could not be reached: ${error instanceof Error ? error.message : String(error)}`); }
  // OpenSSH's realpath answers for a path whose last part does not exist, so existence is a stat.
  try { if (!(await client.stat(rootReal)).isDirectory || await client.realpath(rootReal) !== rootReal) throw unavailable(); }
  catch (error) { throw error instanceof SandboxError ? error : unavailable(); }
  const candidate = rest.length ? path.posix.join(rootReal, ...rest) : rootReal;
  if (!containedOnServer(rootReal, candidate)) throw new SandboxError('Path escapes its approved folder');
  let current = candidate;
  const missing: string[] = [];
  let real: string;
  for (;;) {
    try { await client.stat(current); real = await client.realpath(current); break; }
    catch (error) {
      if (!(error instanceof SftpError) || error.code !== 'ENOENT') throw error;
      // A link whose target is missing is not a new file: writing through it would create the
      // target wherever the link points.
      if (await client.lstat(current).then(() => true, () => false)) throw new SandboxError('Path contains a link that could not be resolved');
      if (current === rootReal) throw unavailable();
      missing.unshift(path.posix.basename(current));
      current = path.posix.dirname(current);
    }
  }
  if (!containedOnServer(rootReal, real)) throw new SandboxError('Path escapes its approved folder via a link');
  const virtualOf = (target: string) => `/${root.name}${target === rootReal ? '' : target.slice(rootReal.length)}`;
  if (missing.length > 0 && !options.allowMissing) throw new SandboxError(`Not found: ${virtualOf(candidate)}`);
  const finalReal = missing.length === 0 ? real : path.posix.join(real, ...missing);
  if (!containedOnServer(rootReal, finalReal)) throw new SandboxError('Path escapes its approved folder');
  return { real: finalReal, virtual: virtualOf(finalReal), root };
}

/** Converts a real path back into the virtual path the model sees. */
export function toVirtualPath(root: Root, rootReal: string, realPath: string): string {
  // path.win32.relative folds case even on WSL. Containment already proved the Linux
  // prefix, so retain the exact suffix and treat only the local host/distro as aliases.
  const rel = IS_WINDOWS && WSL_PATH.test(path.resolve(rootReal)) && isContained(rootReal, realPath)
    ? nativePathIdentity(realPath).slice(nativePathIdentity(rootReal).replace(/\\$/, '').length).replace(/^\\/, '')
    : path.relative(rootReal, realPath);
  if (rel === '') return `/${root.name}`;
  return `/${root.name}/${rel.split(path.sep).join('/')}`;
}

/**
 * Validates a folder the user picked in the UI before it becomes a root.
 * Allows local WSL folders, rejects other network paths and overlapping roots.
 */
export async function validateNewRoot(folderPath: string, existing: readonly Root[]): Promise<string> {
  if (!path.isAbsolute(folderPath)) {
    throw new SandboxError('Folder path must be absolute');
  }
  // WSL's local redirector is not an arbitrary SMB host. Both supported aliases still
  // have to exist on this Windows installation; no fallback or remote lookup is added.
  const windowsPath = folderPath.replace(/\//g, '\\');
  if (IS_WINDOWS && windowsPath.startsWith('\\\\') && !WSL_PATH.test(windowsPath)) {
    throw new SandboxError('Network (UNC) paths are not supported. Map it to a drive letter first.');
  }
  if (IS_WINDOWS && WSL_PATH.test(windowsPath)) {
    for (const segment of windowsPath.split(/\\+/).slice(1).filter(Boolean)) checkSegment(segment);
  }
  const real = await canonicalRealpath(folderPath);
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) {
    throw new SandboxError('That is not a folder');
  }
  const parsed = path.parse(real);
  const sameRoot = nativePathIdentity(parsed.root) === nativePathIdentity(real);
  if (sameRoot) {
    throw new SandboxError(
      IS_WINDOWS
        ? 'Approving an entire drive is not allowed. Pick a folder inside it.'
        : 'Approving the entire filesystem root is not allowed. Pick a folder inside it.'
    );
  }
  for (const other of existing) {
    let otherReal: string;
    try {
      otherReal = await canonicalRealpath(other.path);
    } catch {
      continue;
    }
    if (isContained(otherReal, real) || isContained(real, otherReal)) {
      throw new SandboxError(`That folder overlaps the existing root "/${other.name}"`);
    }
  }
  return real;
}

/**
 * A virtual path written inside a shell command, which nothing will translate.
 *
 * `exec_command` resolves `cwd` and hands `cmd` to the shell verbatim — it has to, since
 * a command is a program and not a path, and rewriting text inside one would corrupt
 * quoting, regexes and URLs the moment it guessed wrong. But every other field of every
 * other tool takes virtual paths as well as approved native paths, so the
 * model is taught exactly one path dialect and then meets one field that does not speak
 * it. Path-taking fields can normalize a native path, but command text is an opaque program
 * and cannot be rewritten safely. What the model wrote was `/project/example/...`, and PowerShell reads a leading
 * slash as the root of the current drive: the command ran against `C:\project\...`, did not
 * exist, and failed in a way that looks like a missing folder rather than a wrong dialect.
 *
 * So the one field that cannot translate says so instead of running. Only a `/name/…`
 * whose first segment is an approved root is claimed, unless it also spells an approved
 * native POSIX path. This is a command diagnostic, not filesystem authorization.
 * `de/example/doppel` inside a regex or
 * `https://host/example` are left alone because neither starts at a boundary a virtual path
 * can start at.
 */
export function strayVirtualPath(text: string, roots: readonly Root[]): string | null {
  if (typeof text !== 'string' || roots.length === 0) return null;
  const names = new Set(roots.map((root) => root.name.toLowerCase()));
  // A candidate must start the string or follow whitespace or an opening quote/bracket:
  // anything else in front of it means it is part of a longer token, not a path.
  const candidate = /(^|[\s'"`(,=[{])(\/[A-Za-z0-9._-]+(?:\/[^\s'"`;|)\]}]*)?)/g;
  for (let match = candidate.exec(text); match; match = candidate.exec(text)) {
    const found = match[2]!;
    const first = found.slice(1).split('/')[0]!.toLowerCase();
    if (!names.has(first)) continue;
    // Root paths carry the native dialect. A POSIX /Users root may have the alias
    // "users"; that must not make its real spelling virtual-only. Keep exact case
    // and a segment boundary, and never reinterpret a Windows drive-rooted path.
    const native = roots.some(root => {
      if (!path.posix.isAbsolute(root.path)) return false;
      const prefix = root.path.replace(/\/+$/, '');
      return found === prefix || found.startsWith(`${prefix}/`);
    });
    if (!native) return found;
  }
  return null;
}
