/**
 * Whether a newer Chat On Steroids has been published, and the file that becomes it.
 *
 * This is the whole updater: one pass, run at startup and repeated on a slow timer, that asks
 * GitHub for the latest release, stages the artifact this installation can actually apply, and
 * hands that file to the platform's own installer on the way out. There is no renderer-side
 * download state and no `electron-updater`; the shipping pipeline already publishes exactly the
 * artifacts named below, so the smallest correct updater is the one that fetches them by name.
 *
 * Three rules shape everything here:
 *
 * - **Nothing may wedge startup.** Every failure ends as `stage: 'failed'` plus a log line. The
 *   app is fully usable at the old version, which is why no caller ever awaits this.
 * - **One pass at a time.** Checking and downloading are one operation, deduplicated by one
 *   promise, so a second call while a download is running joins it rather than starting a
 *   second download of the same file. That is what makes the repeat timer free: a pass that
 *   finds the release it already staged stops at the release call.
 * - **The user restarts, not this app.** A staged update is applied during the ordinary quit
 *   sequence. Nothing here quits, relaunches, or interrupts what the user is doing.
 *
 * **What updates itself, and what does not.** Windows, and Linux installed as an AppImage. A
 * Linux `.deb` is owned by the system package manager and cannot be replaced without root, and
 * asking for a password during quit is not something this app will do — so a `.deb` install is
 * *told* a new version exists and is given the release page, and nothing is downloaded behind
 * it. That is a real limitation, not parity, and the notice says so rather than implying an
 * update is on its way. macOS is out entirely: those artifacts ship unsigned and unnotarized
 * (see electron-builder.yml), so an app that silently replaced itself there would be handing
 * Gatekeeper a binary the user never chose to trust.
 *
 * What this module does **not** own: the version of the browser extension. The bridge already
 * learns that from the authenticated `x-extension-version` header of a paired extension, and
 * `bridgeStatus()` reports it. A second source for the same fact would be a second thing to be
 * wrong.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { app } from 'electron';
import { logInfo, logWarn } from './logger.js';
import { APP_VERSION } from './version.js';
import { isNewer, type UpdateStatus } from '../shared/types.js';

const REPO = 'totec448-spec/chat-on-steroids';
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/**
 * How often the check repeats while the app is open.
 *
 * This app lives in the tray and is routinely left running for days, so "once per start" was in
 * practice "never" for exactly the installations nobody is about to restart to collect a fix.
 * Six hours is slow enough to be invisible, and costs one request whenever there is nothing new.
 */
const RECHECK_MS = 6 * 60 * 60_000;

/**
 * The artifact this exact installation can apply to itself, or null for one that cannot.
 *
 * Null is a normal answer, not a failure: macOS is out by policy, a Linux `.deb` belongs to the
 * system package manager and would need root to replace, and an architecture with no published
 * artifact has nothing to fetch. Those installations are still told a newer version exists —
 * that is what `latest` with a stage of `idle` means, and the notice turns it into a download
 * link — they are simply not updated for.
 *
 * `APPIMAGE` is the environment variable the AppImage runtime sets to the path of the file that
 * is running. Its absence is exactly what distinguishes a portable AppImage from a `.deb`
 * install, so it is both the eligibility test and the target of the swap.
 *
 * An unpackaged run — `electron-vite dev`, or a maintainer's working tree — is not an
 * installation. Its version is whatever the source says, so it reads as out of date the moment a
 * release ships, and staging for it would let quitting a dev session silently run an installer
 * over the real per-user install. It is told what is published and replaces nothing.
 */
export function stagedArtifact(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  appImage: string | undefined = process.env.APPIMAGE,
  packaged: boolean = app.isPackaged
): { name: string; kind: 'installer' | 'appimage'; target: string } | null {
  if (!packaged) return null;
  if (arch !== 'x64' && arch !== 'arm64') return null;
  if (platform === 'win32') return { name: `Chat-On-Steroids-Setup-${arch}.exe`, kind: 'installer', target: '' };
  if (platform === 'linux' && appImage) {
    return { name: `Chat-On-Steroids-Linux-${arch}.AppImage`, kind: 'appimage', target: appImage };
  }
  return null;
}

/** `v2.0.3` -> `2.0.3`, and anything that is not a release tag -> null. */
export function releaseVersion(tag: unknown): string | null {
  if (typeof tag !== 'string') return null;
  const version = tag.trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

const CLEAR: UpdateStatus = { current: APP_VERSION, latest: null, stage: 'idle', error: null, checkedAt: null };

let status: UpdateStatus = CLEAR;
let staged: { version: string; file: string; kind: 'installer' | 'appimage'; target: string } | null = null;
let pass: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function onUpdateChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateStatus(): UpdateStatus {
  return { ...status };
}

function set(next: Partial<UpdateStatus>): void {
  status = { ...status, ...next };
  for (const listener of listeners) listener();
}

/**
 * Runs the check at startup, and keeps running it for as long as the app is open.
 *
 * The timer is unreferenced: it is a background courtesy, never a reason for the process to stay
 * alive, and the shutdown sequence does not have to know it exists.
 */
export function startUpdateChecks(): void {
  void checkForUpdates();
  setInterval(() => void checkForUpdates(), RECHECK_MS).unref();
}

/**
 * Looks for a newer release and, if this installation can apply one, stages it.
 *
 * Concurrent callers get the pass that is already running, which is what keeps a second call
 * from downloading the same installer twice.
 */
export function checkForUpdates(): Promise<void> {
  if (pass) return pass;
  const run = runPass()
    .catch((err: Error) => {
      set({ stage: 'failed', error: err.message });
      logWarn(`update check failed: ${err.message}`);
    })
    .finally(() => {
      if (pass === run) pass = null;
    });
  pass = run;
  return run;
}

async function runPass(): Promise<void> {
  set({ stage: 'checking', error: null });
  const release = { version: await latestVersion() };
  // GitHub answered. From here the UI can tell "current" from "not asked yet", whatever the
  // rest of this pass does with the answer.
  set({ checkedAt: Date.now() });
  if (!isNewer(release.version, APP_VERSION)) {
    // Up to date, or ahead of the published release on a development build. Both mean nothing
    // to offer, and `latest` stays null so nothing in the UI claims otherwise.
    set({ latest: null, stage: 'idle' });
    return;
  }
  logInfo(`update: ${release.version} is available; this app is ${APP_VERSION}`);
  const artifact = stagedArtifact();
  // `latest` and what is being done about it are set in one go. Published separately, the
  // renderer would paint one frame of "a new version exists, and this install updates by
  // hand" for every install, including the ones about to download it themselves.
  if (!artifact) {
    set({ latest: release.version, stage: 'idle' });
    return;
  }
  if (staged?.version === release.version) {
    set({ latest: release.version, stage: 'ready' });
    return;
  }
  set({ latest: release.version, stage: 'downloading' });
  const file = await download(release.version, artifact.name);
  staged = { version: release.version, file, kind: artifact.kind, target: artifact.target };
  set({ stage: 'ready' });
  logInfo(`update: ${release.version} is staged and installs the next time the app starts`);
}

/** The one fact the release API is asked for: which version is newest. */
async function latestVersion(): Promise<string> {
  const response = await get(LATEST_RELEASE_API, CHECK_TIMEOUT_MS, {
    accept: 'application/vnd.github+json'
  });
  const body = (await response.json()) as { tag_name?: unknown };
  const version = releaseVersion(body.tag_name);
  if (!version) throw new Error('the latest release has no usable version tag');
  return version;
}

/**
 * The SHA-256 of every artifact in a release, from the `SHA256SUMS.txt` the pipeline publishes
 * beside them (see .github/workflows/release.yml, which generates it with `sha256sum` over the
 * exact files it then uploads).
 *
 * This doubles as the manifest of what a release contains: a name that is not in here is not
 * something to download, and a file whose digest is not in here is not something to run.
 */
async function releaseDigests(version: string): Promise<Map<string, string>> {
  const response = await get(assetUrl(version, 'SHA256SUMS.txt'), CHECK_TIMEOUT_MS);
  const digests = new Map<string, string>();
  for (const line of (await response.text()).split('\n')) {
    // `sha256sum` writes "<64 hex>  <name>", with a binary/text marker on the second space.
    const match = /^([0-9a-f]{64})\s+[*\s]?(\S+)\s*$/.exec(line.trim());
    if (match) digests.set(match[2]!, match[1]!);
  }
  return digests;
}

/** The url of one release asset. Built here, never taken from a response body. */
function assetUrl(version: string, name: string): string {
  return `https://github.com/${REPO}/releases/download/v${encodeURIComponent(version)}/${name}`;
}

async function get(url: string, timeout: number, headers: Record<string, string> = {}): Promise<Response> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
    headers: { 'user-agent': `chat-on-steroids/${APP_VERSION}`, ...headers }
  });
  if (!response.ok) throw new Error(`${new URL(url).pathname.split('/').pop()} answered ${response.status}`);
  return response;
}

/**
 * Fetches one release artifact into this app's own data directory, and proves it is that file.
 *
 * Every url here is built from the tag and the file name rather than read out of a response
 * body, for the same reason `extensionDownloadUrl` does it: the app decides what it downloads,
 * and no field in a reply can point it somewhere else.
 *
 * The artifact is then checked against the release's own published SHA-256, hashed as it
 * arrives so nothing is read twice. A length check would only catch a truncated download; this
 * is a file that becomes an executable installer the moment the app quits, so the bar is the
 * one the release pipeline already publishes for it. Anything that does not match is deleted
 * and staged as nothing.
 *
 * `.part` until it has passed: the rename is what publishes it, so a download that was
 * interrupted or is not the right file can never be handed to an installer.
 */
async function download(version: string, name: string): Promise<string> {
  const expected = (await releaseDigests(version)).get(name);
  if (!expected) throw new Error(`release ${version} publishes no ${name}`);
  const dir = path.join(app.getPath('userData'), 'updates');
  // One staged build at a time. Anything already here is either this same download starting
  // over or an artifact for a release nobody is going to install now.
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  const response = await get(assetUrl(version, name), DOWNLOAD_TIMEOUT_MS);
  if (!response.body) throw new Error(`downloading ${name} returned no content`);
  const hash = createHash('sha256');
  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on('data', (chunk: Buffer) => hash.update(chunk));
  await pipeline(body, createWriteStream(`${file}.part`));
  const digest = hash.digest('hex');
  if (digest !== expected) {
    await rm(`${file}.part`, { force: true });
    throw new Error(`${name} is not the published file: sha256 ${digest} instead of ${expected}`);
  }
  await rename(`${file}.part`, file);
  return file;
}

/**
 * Hands a staged update to the platform, during the quit this app is already performing.
 *
 * This is the only thing that installs anything, and it runs at the end of the shutdown
 * sequence — after the bridge, the child processes and every durable flush — so the version the
 * user next starts is the new one and nothing was interrupted to achieve that.
 *
 * Windows gets the NSIS installer in silent mode. It is a per-user install (electron-builder.yml
 * sets `perMachine: false`), so `/S` needs no elevation and shows no prompt. Detached, because
 * this process is about to stop existing.
 *
 * An AppImage has no installer: the file that is running is the whole application, so the update
 * is a rename over it. A rename rather than a copy, because the running AppImage is mounted from
 * that path — writing through it would corrupt the process that is still shutting down, while a
 * rename gives the new build a new inode and leaves the old one alive until it exits.
 */
export async function applyStagedUpdate(): Promise<void> {
  const ready = staged;
  staged = null;
  if (!ready) return;
  try {
    if (ready.kind === 'installer') {
      const installer = spawn(ready.file, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true });
      // An installer that cannot start reports it asynchronously, and an unhandled 'error' on a
      // child process would take the quit down with it.
      installer.on('error', (err: Error) => logWarn(`the ${ready.version} installer did not start: ${err.message}`));
      installer.unref();
    } else {
      const next = `${ready.target}.new`;
      await copyFile(ready.file, next);
      await chmod(next, 0o755);
      await rename(next, ready.target);
    }
    logInfo(`update: ${ready.version} handed over; the next start of this app is the new version`);
  } catch (err) {
    // Nothing is retried and nothing is left half-applied. The next app start checks again.
    logWarn(`could not apply the staged ${ready.version} update: ${(err as Error).message}`);
  }
}

/** Test seam: forgets the pass, the staged file and everything reported about them. */
export function resetUpdateForTests(): void {
  status = CLEAR;
  staged = null;
  pass = null;
  listeners.clear();
}
