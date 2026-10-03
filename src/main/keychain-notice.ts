/**
 * The macOS Keychain prompt after an update.
 *
 * macOS builds are ad-hoc signed (electron-builder.yml, `identity: null`), so the Keychain knows
 * each build only by its code hash. The first launch of a new build therefore asks for the login
 * password before it may read "chat-on-steroids Safe Storage", and until the prompt is answered
 * the saved keys, the browser pairing and the chat list all wait for it: on 2.1.26 the window sat
 * on "Loading chats…" with no word about why.
 *
 * Nothing reliably reaches the window once that read has started, so the window is told *before*
 * it: secrets.ts awaits beforeKeychainRead() ahead of every safeStorage call (the first of them,
 * whichever it is, sets up the encryptor and reads the key). When this build has not opened the
 * Keychain before, the open window is asked to arm its notice, and the read starts once it
 * answers (or after a short wait, so a missing window never holds the read up). The renderer
 * shows the notice only if the read is still running after a moment, so a build the Keychain
 * lets through silently shows nothing. A successful read records the build, so the next launch
 * of the same build is not gated.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { WebContents } from 'electron';
import { logInfo } from './logger.js';

export const KEYCHAIN_NOTICE_CHANNEL = 'keychain:waiting';
const FILE_NAME = 'keychain-build.json';
/** How long a window that is still loading may take before the read goes ahead without it. */
export const WINDOW_LOAD_WAIT_MS = 5000;
/** How long the renderer may take to confirm it armed the notice. */
export const RENDERER_ACK_WAIT_MS = 1500;

type Deps = {
  platform: NodeJS.Platform;
  /** The main window's contents, or null when there is none (a background launch at login). */
  contents: () => WebContents | null;
  /** Identifies this build: the Keychain trusts exactly one build per code hash. */
  fingerprint: () => Promise<string>;
};

let filePath = '';
let deps: Deps | null = null;
/** One gate per process, shared by concurrent first callers so none of them slips past it. */
let gate: Promise<void> | null = null;
let armed = false;
/** This build is recorded as one the Keychain trusts; nothing left to check or write. */
let known = false;
let startedAt = 0;
let acknowledge: (() => void) | null = null;

/** The executable's version, size and modification time: they change with every build. */
export async function executableFingerprint(version: string, executable = process.execPath): Promise<string> {
  const stat = await fs.stat(executable);
  return `${version}:${stat.size}:${Math.round(stat.mtimeMs)}`;
}

export function initKeychainNotice(userDataDir: string, options: Deps): void {
  filePath = path.join(userDataDir, FILE_NAME);
  deps = options;
  gate = null;
  armed = false;
  known = false;
  acknowledge = null;
}

async function recordedFingerprint(): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as { build?: unknown };
    return typeof parsed.build === 'string' ? parsed.build : null;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function loaded(contents: WebContents): Promise<boolean> {
  if (!contents.isLoading() && contents.getURL() !== '') return true;
  return Promise.race([
    new Promise<boolean>(resolve => contents.once('did-finish-load', () => resolve(true))),
    delay(WINDOW_LOAD_WAIT_MS).then(() => false)
  ]);
}

/** Awaited by secrets.ts before every safeStorage call. Never rejects. */
export function beforeKeychainRead(): Promise<void> {
  if (!deps || deps.platform !== 'darwin') return Promise.resolve();
  return gate ??= openGate(deps);
}

async function openGate(deps: Deps): Promise<void> {
  try {
    const current = await deps.fingerprint();
    if (current === (await recordedFingerprint())) { known = true; return; }
    const contents = deps.contents();
    if (!contents || contents.isDestroyed() || !(await loaded(contents)) || contents.isDestroyed()) return;
    const answered = new Promise<void>(resolve => { acknowledge = resolve; });
    armed = true;
    startedAt = Date.now();
    contents.send(KEYCHAIN_NOTICE_CHANNEL, true);
    await Promise.race([answered, delay(RENDERER_ACK_WAIT_MS)]);
  } catch {
    // A notice is a courtesy; it must never stand between the app and its own credentials.
  } finally {
    acknowledge = null;
  }
}

/** The renderer has armed its notice; the read may start. */
export function keychainNoticeReady(): void {
  acknowledge?.();
}

/** Called by secrets.ts after each safeStorage call. Records the build only when the Keychain answered. */
export async function afterKeychainRead(ok: boolean): Promise<void> {
  if (!deps || deps.platform !== 'darwin') return;
  if (armed) {
    armed = false;
    const contents = deps.contents();
    if (contents && !contents.isDestroyed()) contents.send(KEYCHAIN_NOTICE_CHANNEL, false);
    const waited = Date.now() - startedAt;
    if (waited >= 1000) logInfo(`Keychain: saved keys ${ok ? 'unlocked' : 'stayed locked'} after ${Math.round(waited / 1000)} s`);
  }
  if (!ok || known) return;
  known = true;
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ build: await deps.fingerprint() }), { mode: 0o600 });
  } catch {
    known = false;
    // Not recorded: the next launch shows the notice once more, which is harmless.
  }
}
