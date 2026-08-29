/**
 * Computer use: seeing the screen and driving the mouse and keyboard.
 *
 * This is deliberately the smallest surface that still lets a model actually operate
 * the machine. The action vocabulary mirrors OpenAI's computer-use tool — click,
 * double_click, scroll, type, keypress, drag, move, wait, screenshot — so a model
 * that already knows how to drive a computer does not have to learn a private
 * dialect, plus the two things a native desktop needs and a browser viewport does not:
 * listing windows and bringing one to the front.
 *
 * Coordinates are always in *screenshot pixels*. Each helper keeps capture and input in
 * one native screen coordinate space; the scale between that space and the returned
 * image is applied here, and every screenshot states the size it was returned at.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureUsablePath, normalizeEnvironment, setEnvValue } from '../env.js';
import { findWindowsPowerShell, terminateProcessTree } from '../exec.js';
import { logInfo, logWarn } from '../logger.js';
import { HELPER_SCRIPT } from './helper.js';

/** Width the screenshot is scaled down to, matching computer-use convention. */
export const DEFAULT_SCREENSHOT_WIDTH = 1280;
export const MAX_SCREENSHOT_WIDTH = 2560;
const HELPER_TIMEOUT_MS = 30_000;
const HELPER_STARTUP_GRACE_MS = 10_000;
const MAX_FRAMES = 16;

export class ComputerError extends Error {
  readonly completedCount: number | null;
  readonly failedIndex: number | null;

  constructor(message: string, details: { completedCount?: number; failedIndex?: number } = {}) {
    super(message);
    this.completedCount = details.completedCount ?? null;
    this.failedIndex = details.failedIndex ?? null;
  }
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowInfo {
  id: number;
  title: string;
  process: string;
  x: number;
  y: number;
  width: number;
  height: number;
  state: 'foreground' | 'minimized' | 'open';
}

export interface UiElementInfo {
  /** Opaque state-scoped reference accepted by click_ref/set_value. */
  ref: string;
  name: string;
  role: string;
  automationId: string;
  enabled: boolean;
  offscreen: boolean;
  bounds: Rect;
  /** Present when the element is fully inside the most recent screenshot frame. */
  imageBounds: Rect | null;
  imageCenter: { x: number; y: number } | null;
}

export interface Screenshot {
  /** Base64 PNG. */
  data: string;
  /** Stable id for the coordinate frame used by later pointing actions. */
  frameId: number;
  /** Size of the returned image, which is what coordinates refer to. */
  width: number;
  height: number;
  /** The screen region it shows, in the helper's coordinate space. */
  region: Rect;
  scale: number;
  /**
   * For a window capture: whether that window was actually in front when the pixels were
   * taken. Null for whole-screen captures, where the question does not arise.
   *
   * Window capture never activates its target. False means it was not foreground; this is
   * harmless for direct background capture and relevant only when captureMode says the
   * helper had to fall back to visible screen pixels.
   */
  focused: boolean | null;
  /** How window pixels were obtained; screen_fallback can be occluded. */
  captureMode: 'screen' | 'window' | 'screen_fallback';
  /** Window id whose geometry this frame is bound to, if any. */
  windowId: number | null;
}

export interface ActionResult {
  cursor: PointerResult | null;
  clipboard: string[];
  completedCount: number;
  routes: Array<'uia' | 'sendinput' | 'focus' | 'local'>;
}

export type VerificationSpec =
  | { until: 'foreground'; window: number; timeoutMs?: number }
  | { until: 'window_exists'; match: string; timeoutMs?: number }
  | { until: 'window_closed'; match: string; timeoutMs?: number }
  | { until: 'ui_appears'; window?: number; match: string; role?: string; timeoutMs?: number }
  | { until: 'ui_disappears'; window?: number; match: string; role?: string; timeoutMs?: number };

export interface VerificationResult {
  until: VerificationSpec['until'];
  elapsedMs: number;
  detail: string;
  snapshotId: number | null;
}

export type Action =
  | { type: 'click_ref'; ref: string }
  | { type: 'set_value'; ref: string; text: string }
  | { type: 'move'; x: number; y: number }
  | { type: 'click'; x: number; y: number; button?: string }
  | { type: 'double_click'; x: number; y: number; button?: string }
  | { type: 'scroll'; x: number; y: number; scroll_x?: number; scroll_y?: number }
  | { type: 'drag'; path: Array<{ x: number; y: number }>; button?: string }
  | { type: 'type'; text: string }
  | { type: 'keypress'; keys: string[] }
  | { type: 'focus'; window: number }
  | { type: 'wait'; ms?: number }
  // The clipboard is part of driving a desktop — it is how text gets into an app that has
  // no accessible text field. These two are done in Electron rather than by the helper, but
  // they run inside the same lock and in the caller's order, so "put this on the clipboard,
  // then press ctrl+v" is one uninterrupted sequence.
  | { type: 'read_clipboard' }
  | { type: 'write_clipboard'; text: string };

/**
 * One long-lived native helper process.
 *
 * Windows launches the fixed PowerShell/Win32 bridge; macOS launches the packaged Swift
 * helper. Both speak the same newline-delimited JSON protocol, so frame identity, stale
 * refs, batching and model-facing semantics remain platform-neutral in this file.
 */
interface PendingHelperRequest {
  resolve: (value: Record<string, any>) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface HelperRuntime {
  child: ChildProcessWithoutNullStreams;
  stdoutBuffer: string;
  stderrTail: string;
  pending: PendingHelperRequest | null;
  /** True after the helper has produced its first valid protocol reply. */
  ready: boolean;
}

let helperRuntime: HelperRuntime | null = null;
let helperStarting: Promise<HelperRuntime> | null = null;
let helperQueue: Promise<void> = Promise.resolve();
let helperGeneration = 0;
let helperStopping = false;
const helperRetirements = new Set<Promise<void>>();

function helperTimeoutMs(request: Record<string, unknown>): number {
  switch (request['op']) {
    case 'windows':
    case 'active':
    case 'focus':
    case 'cursor':
      return 5_000;
    case 'find_ui':
      return 8_000;
    case 'capture':
    case 'snapshot':
      // macOS may spend 12s enumerating ScreenCaptureKit content, then up to 10s
      // starting a pre-14 stream and 15s waiting for its first frame. Snapshot can
      // additionally traverse the AX tree, so the parent must outlive those native
      // budgets instead of retiring a helper that is still within its own deadline.
      // A visible-screen fallback may then capture more than one intersecting display
      // sequentially, so retain enough headroom for a normal multi-monitor host too.
      return process.platform === 'darwin' ? 120_000 : 10_000;
    case 'warm':
      return 10_000;
    case 'act':
      return 15_000;
    default:
      return HELPER_TIMEOUT_MS;
  }
}

function retireHelper(runtime: HelperRuntime): Promise<void> {
  if (helperRuntime === runtime) helperRuntime = null;
  const task = (async () => {
    if (runtime.child.exitCode !== null || runtime.child.pid === undefined) return;
    const closed = new Promise<void>((resolve) => runtime.child.once('close', () => resolve()));
    await terminateProcessTree(runtime.child.pid);
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  })();
  helperRetirements.add(task);
  void task.finally(() => helperRetirements.delete(task));
  return task;
}

function readableHelperFailure(stderr: string): string {
  const clean = stderr
    .replace(/^#< CLIXML[\s\S]*/m, '')
    .trim()
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0);
  return clean?.slice(0, 300) ?? 'the helper process exited unexpectedly';
}

/**
 * A broken helper must be gone before the serialized request is allowed to settle. `runHelper`
 * advances its queue when this request promise settles; rejecting first would let the next call
 * spawn a replacement while the retired process tree could still be executing desktop input.
 */
function rejectAfterHelperRetirement(runtime: HelperRuntime, pending: PendingHelperRequest, error: ComputerError): void {
  clearTimeout(pending.timer);
  if (runtime.pending === pending) runtime.pending = null;
  void retireHelper(runtime).then(
    () => pending.reject(error),
    () => pending.reject(error)
  );
}

async function startHelper(): Promise<HelperRuntime> {
  if (helperStopping) throw new ComputerError('The desktop helper is shutting down.');
  if (helperRuntime) return helperRuntime;
  if (helperStarting) return helperStarting;

  helperStarting = new Promise<HelperRuntime>((resolve, reject) => {
    const env = normalizeEnvironment(process.env);
    ensureUsablePath(env);
    let host: string;
    let args: string[];
    if (process.platform === 'darwin') {
      host = locateMacOSDesktopHelper();
      args = [];
    } else {
      const bootstrap = Buffer.from('Invoke-Expression $env:CLF_HELPER', 'utf16le').toString('base64');
      // `powershell.exe` is found through the environment handed to the child, so that
      // environment has to be sound before the spawn rather than after it.
      setEnvValue(env, 'CLF_HELPER', HELPER_SCRIPT);
      host = findWindowsPowerShell() ?? 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand', bootstrap];
    }
    const child = spawn(host, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env as NodeJS.ProcessEnv
    });
    const runtime: HelperRuntime = {
      child,
      stdoutBuffer: '',
      stderrTail: '',
      pending: null,
      ready: false
    };
    let started = false;

    child.stdout.on('data', (chunk: Buffer) => {
      runtime.stdoutBuffer += chunk.toString('utf8');
      for (;;) {
        const newline = runtime.stdoutBuffer.indexOf('\n');
        if (newline === -1) break;
        const line = runtime.stdoutBuffer.slice(0, newline).trim();
        runtime.stdoutBuffer = runtime.stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        const pending = runtime.pending;
        if (!pending) {
          logWarn(`desktop helper sent unsolicited output: ${line.slice(0, 200)}`);
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          rejectAfterHelperRetirement(
            runtime,
            pending,
            new ComputerError('The desktop helper returned malformed JSON.')
          );
          continue;
        }
        if (
          parsed === null ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed) ||
          (((parsed as Record<string, unknown>)['ok'] !== true) && (parsed as Record<string, unknown>)['ok'] !== false)
        ) {
          rejectAfterHelperRetirement(
            runtime,
            pending,
            new ComputerError('The desktop helper returned a malformed protocol response.')
          );
          continue;
        }
        const reply = parsed as Record<string, any>;
        runtime.ready = true;
        clearTimeout(pending.timer);
        runtime.pending = null;
        if (reply['ok'] === false) {
          const code = String(reply['error_code'] ?? 'HELPER_ERROR');
          const message = String(reply['message'] ?? 'Desktop helper failed');
          const completed = Number(reply['completed_count']);
          const failed = Number(reply['failed_index']);
          pending.reject(
            new ComputerError(`${code}: ${message}`, {
              ...(Number.isInteger(completed) && completed >= 0 ? { completedCount: completed } : {}),
              ...(Number.isInteger(failed) && failed >= 0 ? { failedIndex: failed } : {})
            })
          );
        } else {
          pending.resolve(reply);
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      runtime.stderrTail = `${runtime.stderrTail}${chunk.toString('utf8')}`.slice(-8000);
    });
    child.once('spawn', () => {
      started = true;
      helperRuntime = runtime;
      helperGeneration += 1;
      resolve(runtime);
    });
    child.once('error', (error) => {
      if (helperRuntime === runtime) helperRuntime = null;
      if (!started) {
        reject(new ComputerError(`Could not start the desktop helper: ${error.message}`));
        return;
      }
      const pending = runtime.pending;
      if (pending) {
        rejectAfterHelperRetirement(
          runtime,
          pending,
          new ComputerError(`Desktop helper process error: ${error.message}`)
        );
      } else {
        void retireHelper(runtime);
      }
    });
    child.once('close', () => {
      if (helperRuntime === runtime) helperRuntime = null;
      const pending = runtime.pending;
      if (pending) {
        clearTimeout(pending.timer);
        runtime.pending = null;
        pending.reject(new ComputerError(`Desktop helper failed: ${readableHelperFailure(runtime.stderrTail)}`));
      }
    });
  }).finally(() => {
    helperStarting = null;
  });

  return helperStarting;
}

function locateMacOSDesktopHelper(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    process.env['COS_MACOS_DESKTOP_HELPER'],
    resourcesPath ? path.join(resourcesPath, 'desktop', 'macos-desktop-helper') : null,
    path.resolve(
      process.cwd(),
      'resources',
      'packaging',
      'desktop',
      'darwin',
      process.arch,
      'macos-desktop-helper'
    )
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
  const helper = candidates.find((candidate) => existsSync(candidate));
  if (helper) return helper;
  throw new ComputerError(
    `The macOS desktop helper is missing for ${process.arch}. Run npm run desktop:mac before development, or rebuild the macOS package.`
  );
}

/**
 * Stops the long-lived native desktop helper and waits for its process tree to exit.
 *
 * The helper is an app-owned process, not an implementation detail of one request: a
 * timeout or Electron shutdown must therefore retire the whole tree before the process
 * can be forgotten. Otherwise the compiled helper can survive the UI that owned it.
 */
export async function stopComputerHelper(): Promise<void> {
  helperStopping = true;
  const starting = helperStarting;
  if (starting) await starting.catch(() => null);
  const runtime = helperRuntime;
  helperRuntime = null;
  helperStarting = null;
  uiRefs.clear();
  frames.clear();
  lastFrame = null;
  if (!runtime) {
    await Promise.allSettled([...helperRetirements]);
    return;
  }

  const pending = runtime.pending;
  runtime.pending = null;
  if (pending) {
    clearTimeout(pending.timer);
    pending.reject(new ComputerError('The desktop helper was stopped because the app is shutting down.'));
  }
  try {
    runtime.child.stdin.end();
  } catch {
    // The helper may already have closed its pipe.
  }
  await retireHelper(runtime);
  await Promise.allSettled([...helperRetirements]);
}

async function sendHelperRequest(request: Record<string, unknown>): Promise<Record<string, any>> {
  const runtime = await startHelper();
  if (runtime.pending) throw new ComputerError('Desktop helper received overlapping requests.');

  return new Promise<Record<string, any>>((resolve, reject) => {
    let pending: PendingHelperRequest;
    const timer = setTimeout(() => {
      if (runtime.pending !== pending) return;
      rejectAfterHelperRetirement(runtime, pending, new ComputerError('The desktop helper did not answer in time.'));
    }, helperTimeoutMs(request) + (runtime.ready ? 0 : HELPER_STARTUP_GRACE_MS));
    pending = { resolve, reject, timer };
    runtime.pending = pending;
    runtime.child.stdin.write(`${JSON.stringify(request)}\n`, 'utf8', (error) => {
      if (!error) return;
      if (runtime.pending !== pending) return;
      rejectAfterHelperRetirement(
        runtime,
        pending,
        new ComputerError(`Could not send a desktop helper request: ${error.message}`)
      );
    });
  });
}

function runHelper(request: Record<string, unknown>): Promise<Record<string, any>> {
  const queuedAt = Date.now();
  const operation = typeof request['op'] === 'string' ? request['op'] : 'unknown';
  const result = helperQueue.then(async () => {
    const startedAt = Date.now();
    try {
      return await sendHelperRequest(request);
    } finally {
      logInfo(
        `desktop timing op=${operation} helper_queue_ms=${startedAt - queuedAt} helper_ms=${Date.now() - startedAt}`
      );
    }
  });
  helperQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * The region and scale of the most recent screenshot.
 *
 * Actions arrive in the coordinates of the picture the model was looking at, so the
 * conversion back to screen coordinates needs to remember what that picture showed.
 */
interface Frame {
  id: number;
  region: Rect;
  scale: number;
  width: number;
  height: number;
  windowId: number | null;
  windowGeometry: Rect | null;
  captureMode: Screenshot['captureMode'];
}

let nextFrameId = 1;
let lastFrame: Frame | null = null;
const frames = new Map<number, Frame>();

/**
 * Serialises whole multi-step acquisitions, not just single helper requests.
 *
 * `lastFrame` is one global coordinate system shared by every chat and every agent in
 * this app. get_window_state captures a screenshot and then maps UI element bounds into
 * it; without this lock another caller's capture can land between those two awaits and
 * the reply would pair one screenshot with centres computed against a different one.
 */
let exclusiveQueue: Promise<unknown> = Promise.resolve();

function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const queuedAt = Date.now();
  const measured = async (): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await task();
    } finally {
      logInfo(`desktop timing exclusive_queue_ms=${startedAt - queuedAt} exclusive_ms=${Date.now() - startedAt}`);
    }
  };
  const result = exclusiveQueue.then(measured, measured);
  exclusiveQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}
const uiRefs = new Map<
  string,
  { window: number; runtimeKey: string; generation: number; snapshotId: number }
>();

/**
 * Refs carry the helper generation that minted them. A native accessibility identity only
 * means anything to the helper process that issued it, so once the helper restarts every
 * outstanding ref is meaningless — and acting on one would click whatever now happens to
 * hold that id. Stamping the generation makes that detectable instead of silent.
 */
function rememberUiRef(window: number, runtimeKey: string, index: number, snapshotId: number): string {
  const generation = helperGeneration;
  const ref = `g${generation}_s${snapshotId}_e${index + 1}`;
  uiRefs.set(ref, { window, runtimeKey, generation, snapshotId });
  while (uiRefs.size > 1000) {
    const oldest = uiRefs.keys().next().value as string | undefined;
    if (!oldest) break;
    uiRefs.delete(oldest);
  }
  return ref;
}

function uiTarget(ref: string): { window: number; runtimeKey: string; snapshotId: number } {
  const target = uiRefs.get(ref);
  if (!target) {
    throw new ComputerError(
      `UNKNOWN_UI_REF: ${ref}. Call get_window_state or find_ui again and use a ref from that reply.`
    );
  }
  if (!helperRuntime || helperRuntime.child.exitCode !== null || target.generation !== helperGeneration) {
    throw new ComputerError(
      `STALE_REF: ${ref} was issued by a desktop helper that is no longer active, so it no longer identifies anything. Call get_window_state again and use a ref from that reply.`
    );
  }
  return target;
}

function rememberFrame(frame: Frame): void {
  frames.set(frame.id, frame);
  lastFrame = frame;
  while (frames.size > MAX_FRAMES) {
    const oldest = frames.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    frames.delete(oldest);
  }
}

function frameById(id: number | undefined): Frame | null {
  return id === undefined ? null : (frames.get(id) ?? null);
}

export async function listWindows(): Promise<{ windows: WindowInfo[]; screen: Rect }> {
  const reply = await runHelper({ op: 'windows' });
  return { windows: (reply['windows'] as WindowInfo[]) ?? [], screen: reply['screen'] as Rect };
}

export async function focusWindow(id: number): Promise<boolean> {
  const reply = await runHelper({ op: 'focus', id });
  return reply['focused'] === true;
}

export async function activeWindow(): Promise<{ window: WindowInfo | null; screen: Rect }> {
  const reply = await runHelper({ op: 'active' });
  const value = reply['window'];
  const window = value && typeof value === 'object' ? (value as WindowInfo) : null;
  return { window, screen: reply['screen'] as Rect };
}

export async function findUi(opts: {
  window?: number;
  query?: string;
  role?: string;
  maxResults?: number;
}): Promise<{ window: number; snapshotId: number; elements: UiElementInfo[] }> {
  return exclusive(() => findUiLocked(opts, lastFrame));
}

/**
 * Maps elements into `frame` rather than into whatever `lastFrame` happens to be by the
 * time the helper answers. The caller states which picture the coordinates belong to.
 */
async function findUiLocked(
  opts: {
    window?: number;
    query?: string;
    role?: string;
    maxResults?: number;
  },
  frame: Frame | null,
  suppliedReply?: Record<string, any>
): Promise<{ window: number; snapshotId: number; elements: UiElementInfo[] }> {
  const request = {
    op: 'find_ui',
    ...(opts.window === undefined ? {} : { id: opts.window }),
    query: opts.query ?? '',
    role: opts.role ?? '',
    maxResults: Math.min(100, Math.max(1, Math.floor(opts.maxResults ?? 30)))
  };
  const reply = suppliedReply ?? (await runHelper(request));
  const raw = Array.isArray(reply['elements']) ? (reply['elements'] as Array<Record<string, any>>) : [];
  const snapshotId = Number(reply['snapshotId']);
  if (!Number.isInteger(snapshotId) || snapshotId < 1) {
    throw new ComputerError('The desktop helper returned UI elements without a valid snapshot identity.');
  }
  const windowId = Number(reply['window']);
  logInfo(
    `desktop uia window_snapshot=${snapshotId} visited=${Number(reply['visited']) || 0} returned=${raw.length} truncated=${reply['truncated'] === true}`
  );
  const elements = raw.map((item, index): UiElementInfo => {
    const bounds = item['bounds'] as Rect;
    let imageBounds: Rect | null = null;
    let imageCenter: { x: number; y: number } | null = null;
    if (
      frame &&
      bounds.x >= frame.region.x &&
      bounds.y >= frame.region.y &&
      bounds.x + bounds.width <= frame.region.x + frame.region.width &&
      bounds.y + bounds.height <= frame.region.y + frame.region.height
    ) {
      imageBounds = {
        x: Math.round((bounds.x - frame.region.x) * frame.scale),
        y: Math.round((bounds.y - frame.region.y) * frame.scale),
        width: Math.round(bounds.width * frame.scale),
        height: Math.round(bounds.height * frame.scale)
      };
      imageCenter = {
        x: Math.round(imageBounds.x + imageBounds.width / 2),
        y: Math.round(imageBounds.y + imageBounds.height / 2)
      };
    }
    const runtimeKey = String(item['runtimeKey'] ?? '');
    return {
      ref: runtimeKey
        ? rememberUiRef(windowId, runtimeKey, index, snapshotId)
        : `unavailable-${snapshotId}-${index + 1}`,
      name: String(item['name'] ?? ''),
      role: String(item['role'] ?? ''),
      automationId: String(item['automationId'] ?? ''),
      enabled: item['enabled'] === true,
      offscreen: item['offscreen'] === true,
      bounds,
      imageBounds,
      imageCenter
    };
  });
  return { window: windowId, snapshotId, elements };
}

export async function getWindowState(opts: {
  window?: number;
  maxWidth?: number;
  maxElements?: number;
  includeScreenshot?: boolean;
  includeUi?: boolean;
}): Promise<{
  window: WindowInfo;
  snapshotId: number | null;
  screenshot: Screenshot | null;
  elements: UiElementInfo[];
  uiUnavailable: { code: string; message: string } | null;
}> {
  return exclusive(async () => {
    const includeScreenshot = opts.includeScreenshot !== false;
    const includeUi = opts.includeUi !== false;
    const limit = Math.min(MAX_SCREENSHOT_WIDTH, Math.max(320, Math.floor(opts.maxWidth ?? DEFAULT_SCREENSHOT_WIDTH)));
    const dir = includeScreenshot ? await fs.mkdtemp(path.join(os.tmpdir(), 'clf-shot-')) : null;
    const file = dir ? path.join(dir, 'screen.png') : null;
    try {
      // Target lookup, pixels and UIA are one helper transaction. Besides saving two native
      // round trips, this is what gives every semantic ref and pixel coordinate one shared
      // snapshot identity instead of stitching together observations from different moments.
      const reply = await runHelper({
        op: 'snapshot',
        ...(opts.window === undefined ? {} : { id: opts.window }),
        includeScreenshot,
        includeUi,
        maxWidth: limit,
        maxResults: Math.min(100, Math.max(1, Math.floor(opts.maxElements ?? 60))),
        ...(file ? { file } : {})
      });
      const value = reply['window'];
      const window = value && typeof value === 'object' ? (value as WindowInfo) : null;
      if (!window) throw new ComputerError('WINDOW_NOT_FOUND: no matching visible window is available');
      const shot = file ? await screenshotFromReply(reply, file, window.id) : null;
      const frame = shot ? frameById(shot.frameId) : null;
      const unavailableValue = reply['uiUnavailable'];
      const uiUnavailable =
        unavailableValue && typeof unavailableValue === 'object'
          ? {
              code: String((unavailableValue as Record<string, unknown>)['code'] ?? 'UI_UNAVAILABLE'),
              message: String((unavailableValue as Record<string, unknown>)['message'] ?? 'UI controls are unavailable')
            }
          : null;
      const found = includeUi && uiUnavailable === null
        ? await findUiLocked({ window: window.id, maxResults: opts.maxElements ?? 60 }, frame, reply)
        : { window: window.id, snapshotId: null, elements: [] as UiElementInfo[] };
      return {
        window,
        snapshotId: found.snapshotId,
        screenshot: shot,
        elements: found.elements,
        uiUnavailable
      };
    } finally {
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

export async function waitForWindow(opts: {
  title?: string;
  process?: string;
  foreground?: boolean;
  timeoutMs?: number;
}): Promise<WindowInfo> {
  const title = opts.title?.trim().toLowerCase();
  const processName = opts.process?.trim().toLowerCase();
  if (!title && !processName) throw new ComputerError('wait_for_window needs title or process');
  const timeoutMs = Math.min(60_000, Math.max(0, Math.floor(opts.timeoutMs ?? 10_000)));
  const deadline = Date.now() + timeoutMs;
  const matches = (window: WindowInfo): boolean =>
    (!title || window.title.toLowerCase().includes(title)) &&
    (!processName || window.process.toLowerCase().includes(processName));

  for (;;) {
    if (opts.foreground === true) {
      const { window } = await activeWindow();
      if (window && matches(window)) return window;
    } else {
      const { windows } = await listWindows();
      const found = windows.find(matches);
      if (found) return found;
    }
    if (Date.now() >= deadline) {
      throw new ComputerError(
        `WAIT_TIMEOUT: no matching ${opts.foreground === true ? 'foreground ' : ''}window appeared within ${timeoutMs} ms`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Captures the primary monitor, every monitor, or one window.
 *
 * The helper does the downscaling while the bitmap is still in its hands, because a
 * 4K screenshot is slow to encode, slow to base64 and harder for a model to point at
 * accurately than a 1280-wide one. Nothing downstream ever wants the full-size image,
 * so it is never produced.
 */
export async function screenshot(opts: {
  window?: number;
  full?: boolean;
  maxWidth?: number;
  /** Crop in pixels of the most recent returned screenshot. */
  crop?: Rect;
}): Promise<Screenshot> {
  return exclusive(() => screenshotLocked(opts));
}

async function screenshotFromReply(
  reply: Record<string, any>,
  file: string,
  requestedWindow: number | null,
  inheritedWindowGeometry?: Rect | null
): Promise<Screenshot> {
  const region = reply['region'] as Rect;
  const size = reply['image'] as { width: number; height: number };
  if (
    !region ||
    !size ||
    !Number.isFinite(region.x) ||
    !Number.isFinite(region.y) ||
    !Number.isFinite(region.width) ||
    !Number.isFinite(region.height) ||
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    region.width <= 0 ||
    region.height <= 0 ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    throw new ComputerError('The desktop helper returned invalid screenshot geometry.');
  }
  const readStartedAt = Date.now();
  const png = await fs.readFile(file).catch(() => {
    throw new ComputerError('The screen capture produced no image.');
  });
  if (png.length === 0) throw new ComputerError('The screen capture came back empty.');
  const readMs = Date.now() - readStartedAt;

  const rawMode = String(reply['captureMode'] ?? (requestedWindow === null ? 'screen' : 'screen_fallback'));
  const captureMode: Screenshot['captureMode'] =
    rawMode === 'window' || rawMode === 'screen_fallback' ? rawMode : 'screen';
  const scale = size.width / region.width;
  const replyWindowGeometry = reply['windowGeometry'] as Rect | undefined;
  const frame: Frame = {
    id: nextFrameId++,
    region,
    scale,
    width: size.width,
    height: size.height,
    windowId: requestedWindow,
    windowGeometry:
      inheritedWindowGeometry === undefined
        ? requestedWindow === null
          ? null
          : replyWindowGeometry ?? { ...region }
        : inheritedWindowGeometry,
    captureMode
  };
  rememberFrame(frame);
  const encodeStartedAt = Date.now();
  const data = png.toString('base64');
  logInfo(
    `desktop timing screenshot_read_ms=${readMs} screenshot_base64_ms=${Date.now() - encodeStartedAt} screenshot_bytes=${png.length}`
  );
  return {
    data,
    frameId: frame.id,
    width: frame.width,
    height: frame.height,
    region: frame.region,
    scale: frame.scale,
    focused: requestedWindow === null ? null : reply['focused'] === true,
    captureMode,
    windowId: requestedWindow
  };
}

/**
 * @param cropFrame Frame a crop is expressed in. Callers that ran something between the
 * frame the model saw and this capture pass it explicitly; everyone else means the
 * current one.
 */
async function screenshotLocked(
  opts: {
    window?: number;
    full?: boolean;
    maxWidth?: number;
    crop?: Rect;
  },
  cropFrame?: Frame | null
): Promise<Screenshot> {
  if (opts.crop && (opts.window !== undefined || opts.full === true)) {
    throw new ComputerError('crop cannot be combined with window or full capture');
  }

  let cropRegion: Rect | undefined;
  if (opts.crop) {
    const frame = cropFrame === undefined ? lastFrame : cropFrame;
    if (!frame) throw new ComputerError('Take a screenshot first — crop coordinates refer to the most recent frame.');
    const crop = {
      x: Math.floor(opts.crop.x),
      y: Math.floor(opts.crop.y),
      width: Math.floor(opts.crop.width),
      height: Math.floor(opts.crop.height)
    };
    if (crop.width <= 0 || crop.height <= 0) throw new ComputerError('crop width and height must be positive');
    if (
      crop.x < 0 ||
      crop.y < 0 ||
      crop.x + crop.width > frame.width ||
      crop.y + crop.height > frame.height
    ) {
      throw new ComputerError(
        `crop must fit inside frame ${frame.id} (${frame.width}x${frame.height})`
      );
    }
    const left = Math.round(frame.region.x + crop.x / frame.scale);
    const top = Math.round(frame.region.y + crop.y / frame.scale);
    const right = Math.round(frame.region.x + (crop.x + crop.width) / frame.scale);
    const bottom = Math.round(frame.region.y + (crop.y + crop.height) / frame.scale);
    cropRegion = {
      x: left,
      y: top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top)
    };
  }

  // By default a crop preserves roughly the pixel density the model selected from
  // the previous frame instead of expanding a small crop back to 1280px wide.
  const requestedWidth =
    opts.maxWidth ?? (opts.crop ? Math.max(1, Math.floor(opts.crop.width)) : DEFAULT_SCREENSHOT_WIDTH);
  const limit = Math.min(
    MAX_SCREENSHOT_WIDTH,
    opts.crop && opts.maxWidth === undefined
      ? Math.max(1, requestedWidth)
      : Math.max(320, Math.floor(requestedWidth))
  );
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-shot-'));
  const file = path.join(dir, 'screen.png');
  try {
    const reply = await runHelper({
      op: 'capture',
      file,
      maxWidth: limit,
      ...(cropRegion === undefined ? {} : { region: cropRegion }),
      ...(opts.window === undefined ? {} : { id: opts.window }),
      ...(opts.full === true ? { full: true } : {})
    });
    return await screenshotFromReply(
      reply,
      file,
      opts.crop ? (cropFrame === undefined ? lastFrame?.windowId ?? null : cropFrame?.windowId ?? null) : opts.window ?? null,
      opts.crop ? (cropFrame === undefined ? lastFrame?.windowGeometry ?? null : cropFrame?.windowGeometry ?? null) : undefined
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Performs a batch of actions.
 *
 * Image coordinates are converted to screen coordinates against the region the last
 * screenshot showed, so the model can point at what it saw without knowing anything
 * about monitor layout or scaling.
 */
export interface PointerResult {
  screen: { x: number; y: number };
  image: { x: number; y: number } | null;
  frameId: number | null;
  imageSize: { width: number; height: number } | null;
}

export async function act(
  actions: Action[],
  opts: { frameId?: number } = {}
): Promise<ActionResult> {
  return exclusive(() => actLocked(actions, opts));
}

/**
 * Acts and then verifies, as one indivisible operation.
 *
 * Doing this as act() followed by screenshot() takes the lock twice, and another chat or
 * agent can focus a window, click, or capture in the gap — so the "after" picture could
 * show someone else's result. That would defeat the only reason to ask for a capture in
 * the same call. The crop is resolved against the frame that was current before the
 * actions ran, which is the one whose coordinates the caller was looking at.
 */
export async function actAndCapture(
  actions: Action[],
  opts: {
    frameId?: number;
    capture?: {
      window?: number;
      full?: boolean;
      maxWidth?: number;
      crop?: Rect;
      /** Privacy mode: capture whatever window is in front once the actions have run. */
      preferActiveWindow?: boolean;
    };
    verify?: VerificationSpec;
  } = {}
): Promise<ActionResult & { screenshot: Screenshot | null; verification: VerificationResult | null }> {
  return exclusive(async () => {
    const before = opts.frameId === undefined ? lastFrame : frameById(opts.frameId);
    // capture.crop is expressed in pixels of the screenshot the caller saw, exactly like a
    // coordinate action. Another chat/agent can replace the app-global lastFrame between that
    // screenshot and this call, so using whichever frame happens to be current would crop an
    // unrelated picture. Bind the crop to the same explicit frame identity used by pointing.
    if (opts.capture?.crop) {
      if (opts.frameId === undefined) {
        throw new ComputerError(
          'FRAME_REQUIRED: captureCrop must include the frameId returned with the screenshot its coordinates came from.'
        );
      }
      if (!before) {
        throw new ComputerError(
          `STALE_FRAME: captureCrop is for frame ${opts.frameId}, but that frame is no longer retained. Take a new screenshot and crop that frame.`
        );
      }
    }
    const result = await actLocked(actions, opts);
    let verification: VerificationResult | null = null;
    if (opts.verify) {
      try {
        verification = await verifyDesktopLocked(opts.verify);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ComputerError(
          `POSTCONDITION_FAILED: completed_count=${result.completedCount}. ${message}`,
          { completedCount: result.completedCount, failedIndex: result.completedCount }
        );
      }
    }
    if (!opts.capture) return { ...result, screenshot: null, verification };

    const { preferActiveWindow, ...capture } = opts.capture;
    // Resolved here rather than by the caller: the actions may have changed which window
    // is in front, and resolving it outside the lock would reopen the gap this closes.
    if (preferActiveWindow && capture.window === undefined && capture.full !== true && capture.crop === undefined) {
      capture.window = (await activeWindow()).window?.id;
    }
    return {
      ...result,
      screenshot: await screenshotLocked(capture, before),
      verification
    };
  });
}

async function verifyDesktopLocked(spec: VerificationSpec): Promise<VerificationResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.min(10_000, Math.max(0, Math.floor(spec.timeoutMs ?? 2_000)));
  const deadline = startedAt + timeoutMs;
  const needle = 'match' in spec ? spec.match.trim().toLowerCase() : '';
  for (;;) {
    if (spec.until === 'foreground') {
      const current = (await activeWindow()).window;
      if (current?.id === spec.window) {
        return {
          until: spec.until,
          elapsedMs: Date.now() - startedAt,
          detail: `window ${spec.window} is foreground`,
          snapshotId: null
        };
      }
    } else if (spec.until === 'window_exists' || spec.until === 'window_closed') {
      const { windows } = await listWindows();
      const found = windows.find(
        (window) =>
          window.title.toLowerCase().includes(needle) || window.process.toLowerCase().includes(needle)
      );
      if ((spec.until === 'window_exists' && found) || (spec.until === 'window_closed' && !found)) {
        return {
          until: spec.until,
          elapsedMs: Date.now() - startedAt,
          detail: found ? `found window ${found.id} ${JSON.stringify(found.title)}` : `no window matches ${JSON.stringify(spec.match)}`,
          snapshotId: null
        };
      }
    } else {
      try {
        const found = await findUiLocked(
          { window: spec.window, query: spec.match, role: spec.role, maxResults: 1 },
          null
        );
        const present = found.elements.length > 0;
        if ((spec.until === 'ui_appears' && present) || (spec.until === 'ui_disappears' && !present)) {
          return {
            until: spec.until,
            elapsedMs: Date.now() - startedAt,
            detail: present
              ? `found ${found.elements[0]?.ref ?? 'matching control'}`
              : `no control matches ${JSON.stringify(spec.match)}`,
            snapshotId: found.snapshotId
          };
        }
      } catch (err) {
        // A closing window is a satisfied disappearance, but other UIA failures must remain
        // visible rather than being retried until they look like success.
        if (
          spec.until === 'ui_disappears' &&
          err instanceof ComputerError &&
          /WINDOW_NOT_FOUND|UIA_FAILED: no accessible window/i.test(err.message)
        ) {
          return {
            until: spec.until,
            elapsedMs: Date.now() - startedAt,
            detail: 'target window/control is gone',
            snapshotId: null
          };
        }
        throw err;
      }
    }
    if (Date.now() >= deadline) {
      throw new ComputerError(`VERIFY_TIMEOUT: ${spec.until} was not satisfied within ${timeoutMs} ms`);
    }
    // UIA/WinEvent providers are inconsistent across frameworks. A short bounded polling
    // fallback owns the wait locally so the model does not burn turns asking again.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function actLocked(
  actions: Action[],
  opts: { frameId?: number }
): Promise<ActionResult> {
  const pointing = new Set(['move', 'click', 'double_click', 'scroll', 'drag']);
  const needsFrame = actions.some((a) => pointing.has(a.type));
  if (needsFrame && frames.size === 0) {
    throw new ComputerError('Take a screenshot first — pointing needs a picture to point at.');
  }
  if (needsFrame && opts.frameId === undefined) {
    // The screenshot frame id is the identity of pixel coordinates. `lastFrame` is global to
    // the app and may have been replaced by another chat/agent after this caller saw its image;
    // silently assuming the latest frame turns an attribution failure into a real mouse action
    // on unrelated pixels. Semantic refs do not use image coordinates and stay exempt.
    throw new ComputerError(
      'FRAME_REQUIRED: coordinate actions must include the frameId returned with the screenshot they came from.'
    );
  }
  const requestedFrame = frameById(opts.frameId);
  // Keep a small immutable history so an unrelated observation does not invalidate a
  // caller's coordinates. The helper revalidates a window-bound frame's exact geometry
  // immediately before input, so retaining it does not turn old pixels into blind clicks.
  if (needsFrame && !requestedFrame) {
    throw new ComputerError(
      `STALE_FRAME: frame ${opts.frameId} is no longer retained. Take a screenshot or call get_window_state again and point at the new frame.`
    );
  }
  const frame =
    requestedFrame ?? lastFrame ?? {
      id: 0,
      region: { x: 0, y: 0, width: 1, height: 1 },
      scale: 1,
      width: 1,
      height: 1,
      windowId: null,
      windowGeometry: null,
      captureMode: 'screen' as const
    };
  if (needsFrame) {
    const assertPointInFrame = (x: number, y: number, label: string): void => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
        throw new ComputerError(
          `OUT_OF_FRAME: ${label} (${x},${y}) is outside frame ${frame.id} (${frame.width}x${frame.height}). Take a screenshot that includes the target and use coordinates inside that image.`
        );
      }
    };
    for (const action of actions) {
      switch (action.type) {
        case 'move':
        case 'click':
        case 'double_click':
        case 'scroll':
          assertPointInFrame(action.x, action.y, action.type);
          break;
        case 'drag':
          action.path.forEach((point, index) => assertPointInFrame(point.x, point.y, `drag point ${index + 1}`));
          break;
        default:
          break;
      }
    }
  }
  const toScreenX = (x: number): number => Math.round(frame.region.x + x / frame.scale);
  const toScreenY = (y: number): number => Math.round(frame.region.y + y / frame.scale);

  // Resolve every semantic ref before the first side effect in the batch. Clipboard and wait
  // actions run locally and can occur before a later click_ref/set_value; resolving refs lazily
  // inside that loop used to let an invented/stale ref reject the call only *after* an earlier
  // clipboard write had already happened. Runtime failures can still occur after an action has
  // genuinely started, but deterministic validation errors must not create partial batches.
  const uiTargets = new Map<string, { window: number; runtimeKey: string; snapshotId: number }>();
  for (const action of actions) {
    if (action.type !== 'click_ref' && action.type !== 'set_value') continue;
    if (!uiTargets.has(action.ref)) uiTargets.set(action.ref, uiTarget(action.ref));
  }

  const mapOne = (action: Action): Record<string, unknown> => {
    switch (action.type) {
      case 'click_ref': {
        const target = uiTargets.get(action.ref);
        if (!target) throw new ComputerError(`UNKNOWN_UI_REF: ${action.ref}`);
        return {
          type: 'click_ui',
          window: target.window,
          snapshotId: target.snapshotId,
          runtimeKey: target.runtimeKey
        };
      }
      case 'set_value': {
        const target = uiTargets.get(action.ref);
        if (!target) throw new ComputerError(`UNKNOWN_UI_REF: ${action.ref}`);
        return {
          type: 'set_value_ui',
          window: target.window,
          snapshotId: target.snapshotId,
          runtimeKey: target.runtimeKey,
          value: action.text
        };
      }
      case 'move':
      case 'click':
      case 'double_click':
        return {
          type: action.type,
          x: toScreenX(action.x),
          y: toScreenY(action.y),
          button: 'button' in action ? (action.button ?? 'left') : 'left'
        };
      case 'scroll':
        return {
          type: 'scroll',
          x: toScreenX(action.x),
          y: toScreenY(action.y),
          scroll_x: action.scroll_x ?? 0,
          scroll_y: action.scroll_y ?? 0
        };
      case 'drag':
        return {
          type: 'drag',
          xs: action.path.map((p) => toScreenX(p.x)),
          ys: action.path.map((p) => toScreenY(p.y)),
          button: action.button ?? 'left'
        };
      case 'type':
        return { type: 'type', text: action.text };
      case 'keypress':
        return { type: 'keypress', keys: action.keys };
      case 'focus':
        return { type: 'focus', window: action.window };
      default:
        throw new ComputerError(`Unsupported action`);
    }
  };

  // Clipboard steps are not desktop input, so the helper never sees them: the pending
  // batch is flushed at each one instead. That keeps every step in the order it was
  // asked for — put text on the clipboard, then press ctrl+v — without giving up the
  // lock in between, which a second call from the tool layer would have done.
  const clipboard: string[] = [];
  const routes: ActionResult['routes'] = [];
  let completedCount = 0;
  let batch: ReturnType<typeof mapOne>[] = [];
  let batchIndices: number[] = [];
  let reply: Record<string, any> | null = null;
  let helperUsed = false;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const sending = batch;
    const sendingIndices = batchIndices;
    batch = [];
    batchIndices = [];
    try {
      reply = await runHelper({
        op: 'act',
        actions: sending,
        ...(needsFrame
          ? {
              frame: {
                id: frame.id,
                window: frame.windowId,
                region: frame.region,
                windowGeometry: frame.windowGeometry,
                captureMode: frame.captureMode
              }
            }
          : {})
      });
      helperUsed = true;
      const helperRoutes = Array.isArray(reply['routes']) ? reply['routes'].map(String) : [];
      for (let index = 0; index < sending.length; index++) {
        const route = helperRoutes[index];
        routes.push(route === 'uia' || route === 'focus' ? route : 'sendinput');
      }
      completedCount += sending.length;
    } catch (err) {
      const partial = err instanceof ComputerError ? (err.completedCount ?? 0) : 0;
      const failedBatchIndex = err instanceof ComputerError ? (err.failedIndex ?? partial) : partial;
      for (let index = 0; index < partial; index++) {
        const action = sending[index];
        routes.push(action?.['type'] === 'click_ui' || action?.['type'] === 'set_value_ui' ? 'uia' : 'sendinput');
      }
      const totalCompleted = completedCount + partial;
      const originalFailed = sendingIndices[failedBatchIndex] ?? sendingIndices[partial] ?? totalCompleted;
      const message = err instanceof Error ? err.message : String(err);
      throw new ComputerError(
        `PARTIAL_BATCH: completed_count=${totalCompleted} failed_index=${originalFailed}. ${message}`,
        { completedCount: totalCompleted, failedIndex: originalFailed }
      );
    }
  };
  for (const [index, action] of actions.entries()) {
    if (action.type === 'wait') {
      await flush();
      const ms = Math.min(10_000, Math.max(0, action.ms ?? 2000));
      if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
      routes.push('local');
      completedCount += 1;
      continue;
    }
    if (action.type === 'read_clipboard') {
      await flush();
      try {
        clipboard.push((await electronClipboard()).readText());
      } catch (err) {
        throw localActionFailure(err, completedCount, index);
      }
      routes.push('local');
      completedCount += 1;
      continue;
    }
    if (action.type === 'write_clipboard') {
      await flush();
      try {
        (await electronClipboard()).writeText(action.text);
      } catch (err) {
        throw localActionFailure(err, completedCount, index);
      }
      routes.push('local');
      completedCount += 1;
      continue;
    }
    batch.push(mapOne(action));
    batchIndices.push(index);
  }
  // A pure clipboard/wait batch must not depend on a native accessibility helper at all. This is
  // what makes the connector genuinely useful when the user granted only clipboard access or
  // when the desktop helper is unavailable. Mixed desktop batches still take one final cursor
  // sample after any trailing local wait/clipboard work so the pointer report remains current.
  if (batch.length > 0) {
    await flush();
  } else if (helperUsed) {
    reply = await runHelper({ op: 'cursor' });
  }

  if (reply === null) return { cursor: null, clipboard, completedCount, routes };

  const raw = reply['cursor'] as { x?: unknown; y?: unknown } | undefined;
  const sx = Number(raw?.x);
  const sy = Number(raw?.y);
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) {
    throw new ComputerError('The desktop helper returned an invalid pointer position.');
  }
  const current = requestedFrame ?? lastFrame;
  const image = current
    ? {
        x: Math.round((sx - current.region.x) * current.scale),
        y: Math.round((sy - current.region.y) * current.scale)
      }
    : null;
  return {
    cursor: {
      screen: { x: sx, y: sy },
      image,
      frameId: current?.id ?? null,
      imageSize: current ? { width: current.width, height: current.height } : null
    },
    clipboard,
    completedCount,
    routes
  };
}

function localActionFailure(err: unknown, completedCount: number, failedIndex: number): ComputerError {
  const message = err instanceof Error ? err.message : String(err);
  return new ComputerError(
    `PARTIAL_BATCH: completed_count=${completedCount} failed_index=${failedIndex}. ${message}`,
    { completedCount, failedIndex }
  );
}

/**
 * Electron's clipboard, loaded only if a clipboard action is actually used.
 *
 * Imported lazily rather than at the top of the file because everything else here runs
 * happily outside Electron — the desktop tests drive the helper directly — and a static
 * import would make that impossible for the sake of two actions.
 */
async function electronClipboard(): Promise<{ readText: () => string; writeText: (text: string) => void }> {
  try {
    const { clipboard } = await import('electron');
    if (!clipboard) throw new Error('no clipboard');
    return clipboard;
  } catch {
    throw new ComputerError('The clipboard is only available while the app is running.');
  }
}

/** Confirms the helper can run at all, so the UI can say so before ChatGPT tries. */
export async function checkAvailable(): Promise<string | null> {
  try {
    await listWindows();
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(`computer use unavailable: ${message}`);
    return message;
  }
}

/**
 * Starts and initializes the helper off the first tool call's critical path.
 *
 * Connection owns when Desktop becomes publishable; shutdown remains owned by
 * `stopComputerHelper`. Clipboard-only configurations deliberately never call this.
 */
export async function prewarmComputerHelper(): Promise<void> {
  try {
    const reply = await runHelper({ op: 'warm' });
    if (process.platform === 'darwin') {
      logInfo(
        `desktop macos permissions screen=${reply['screenPermission'] === true ? 'granted' : 'missing'} ` +
          `accessibility=${reply['accessibilityPermission'] === true ? 'granted' : 'missing'}`
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(`computer use prewarm failed: ${message}`);
  }
}
