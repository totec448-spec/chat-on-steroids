/**
 * Codex "unified exec": the runtime behind `exec_command` and `write_stdin`.
 *
 * Ported from `codex-rs/core/src/unified_exec/` — `mod.rs`, `process.rs`, `process_manager.rs`
 * and `errors.rs` — together with `ExecCommandToolOutput` from `codex-rs/core/src/tools/context.rs`.
 *
 * Nothing here shells out to Codex or depends on a Codex install. The Rust tokio machinery
 * (`Notify`, `CancellationToken`, `watch`, an interaction `Mutex`) is reproduced with the
 * JavaScript equivalents so the observable semantics survive: one shared output buffer that
 * a poll *drains*, a head/tail cap on what is retained, a yield deadline with a short
 * post-exit grace, and a session that outlives the call that created it.
 *
 * Two Windows adaptations, both about launching rather than about behaviour:
 *   - `cmd.exe` gets a verbatim command line. Node (like Rust) would otherwise escape inner
 *     quotes as `\"`, which cmd has never understood, and cmd exits 0 after failing to run
 *     it — a command that silently does nothing.
 *   - `interrupt()` on a pipe session sends SIGINT through Node, because a Windows console
 *     control event cannot be delivered to a child that owns no console.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { HeadTailBuffer } from './head-tail-buffer.js';
import {
  approxTokenCount,
  approxTokensFromByteCount,
  byteLength,
  formattedTruncateText,
  policyTokenBudget,
  truncateText,
  type TruncationPolicy
} from './truncate.js';
import {
  clampYieldTime,
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  formatOutputOmissionMarker,
  generateChunkId,
  INTERRUPT,
  MAX_UNIFIED_EXEC_PROCESSES,
  MAX_YIELD_TIME_MS,
  MIN_EMPTY_YIELD_TIME_MS,
  MIN_YIELD_TIME_MS,
  resolveMaxTokens,
  UNIFIED_EXEC_ENV
} from './unified-exec-constants.js';
import { terminateProcessTree } from '../exec.js';
import { prefixPowershellScriptWithUtf8, type ShellType } from './shell.js';

// --------------------------------------------------------------------------- errors

export type UnifiedExecErrorKind =
  | 'create_process'
  | 'process_failed'
  | 'unknown_process_id'
  | 'write_to_stdin'
  | 'stdin_closed'
  | 'missing_command_line';

/**
 * `UnifiedExecError`, with both of the Rust renderings it is shown through.
 *
 * `message` is the `Display` form, which is what `write_stdin failed: {err}` prints; `debug()`
 * is the derived `Debug` form, which is what `exec_command failed for ...: {err:?}` prints.
 * They differ, and both reach the model, so both are reproduced.
 */
export class UnifiedExecError extends Error {
  readonly kind: UnifiedExecErrorKind;
  readonly processId: number | null;
  readonly detail: string | null;

  private constructor(kind: UnifiedExecErrorKind, message: string, detail: string | null, processId: number | null) {
    super(message);
    this.name = 'UnifiedExecError';
    this.kind = kind;
    this.detail = detail;
    this.processId = processId;
  }

  static createProcess(message: string): UnifiedExecError {
    return new UnifiedExecError('create_process', `Failed to create unified exec process: ${message}`, message, null);
  }

  static processFailed(message: string): UnifiedExecError {
    return new UnifiedExecError('process_failed', `Unified exec process failed: ${message}`, message, null);
  }

  static unknownProcessId(processId: number): UnifiedExecError {
    return new UnifiedExecError('unknown_process_id', `Unknown process id ${processId}`, null, processId);
  }

  static writeToStdin(): UnifiedExecError {
    return new UnifiedExecError('write_to_stdin', 'failed to write to stdin', null, null);
  }

  static stdinClosed(): UnifiedExecError {
    return new UnifiedExecError(
      'stdin_closed',
      'stdin is closed for this session; rerun exec_command with tty=true to keep stdin open',
      null,
      null
    );
  }

  static missingCommandLine(): UnifiedExecError {
    return new UnifiedExecError('missing_command_line', 'missing command line for unified exec request', null, null);
  }

  /** The `{err:?}` rendering of the Rust enum. */
  debug(): string {
    switch (this.kind) {
      case 'create_process':
        return `CreateProcess { message: ${JSON.stringify(this.detail ?? '')} }`;
      case 'process_failed':
        return `ProcessFailed { message: ${JSON.stringify(this.detail ?? '')} }`;
      case 'unknown_process_id':
        return `UnknownProcessId { process_id: ${this.processId ?? 0} }`;
      case 'write_to_stdin':
        return 'WriteToStdin';
      case 'stdin_closed':
        return 'StdinClosed';
      case 'missing_command_line':
        return 'MissingCommandLine';
    }
  }
}

// --------------------------------------------------------------------------- notify

/** `tokio::sync::Notify`, minus the stored permit: waiters registered before the notify. */
class Notify {
  private waiters = new Set<() => void>();

  /** A one-shot wait that must be disposed, so a lost race does not leak its resolver. */
  notified(): { promise: Promise<void>; dispose: () => void } {
    let resolver: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      resolver = resolve;
      this.waiters.add(resolver);
    });
    return { promise, dispose: () => this.waiters.delete(resolver) };
  }

  notifyWaiters(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiters) resolve();
  }
}

/** An async mutex standing in for the per-process `interaction_lock`. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private locked = false;
  private queued = 0;

  async lock(): Promise<() => void> {
    // Count the request before the first await. A holder releases synchronously, while the next
    // queued lock only resumes in a microtask; without this bit of state tryLock() can barge into
    // that handoff gap even though a waiter is already entitled to the lock.
    this.queued += 1;
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      release = () => {
        this.locked = false;
        resolve();
      };
    });
    const previous = this.tail;
    this.tail = previous.then(() => next);
    await previous;
    this.queued -= 1;
    this.locked = true;
    return release;
  }

  /** `try_lock_owned`: null when someone else holds it, so pruning can skip busy sessions. */
  tryLock(): (() => void) | null {
    if (this.locked || this.queued > 0) return null;
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      release = () => {
        this.locked = false;
        resolve();
      };
    });
    this.tail = this.tail.then(() => next);
    this.locked = true;
    return release;
  }
}

// --------------------------------------------------------------------------- pty loading

/** The slice of node-pty this module uses, declared locally so an absent module is not a build edge. */
interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface PtyModule {
  spawn(
    file: string,
    args: readonly string[] | string,
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
  ): PtyProcess;
}

let ptyModule: Promise<PtyModule | null> | null = null;

async function loadPty(): Promise<PtyModule | null> {
  ptyModule ??= import('node-pty')
    .then((module) => ((module as { default?: PtyModule }).default ?? module) as PtyModule)
    .catch(() => null);
  return ptyModule;
}

// --------------------------------------------------------------------------- process

export interface SpawnParams {
  /** The derived argv; element 0 is the executable. */
  command: string[];
  shellType: ShellType;
  cwd: string;
  env: NodeJS.ProcessEnv;
  tty: boolean;
}

const EARLY_EXIT_GRACE_PERIOD_MS = 150;
const POST_EXIT_CLOSE_WAIT_CAP_MS = 50;

/** Applies `UNIFIED_EXEC_ENV` over the caller's environment, as `apply_unified_exec_env`. */
export function applyUnifiedExecEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of UNIFIED_EXEC_ENV) result[key] = value;
  return result;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
}

/** MSVCRT-style quoting for one argument, for the verbatim `cmd.exe` command line only. */
function quoteWindowsArgument(argument: string): string {
  if (argument !== '' && !/[\s"]/.test(argument)) return argument;
  return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
}

/**
 * One running unified exec session.
 *
 * The output buffer is *drained* by whoever polls it, which is the property the whole design
 * rests on: a chunk is delivered to exactly one call, so two consecutive `write_stdin` polls
 * never see the same bytes twice and never silently drop them either.
 */
class UnifiedExecProcess {
  private buffer = new HeadTailBuffer();
  readonly outputNotify = new Notify();
  readonly outputClosedNotify = new Notify();
  readonly cancelNotify = new Notify();
  readonly interactionLock = new Mutex();
  outputClosed = false;
  cancelled = false;
  private exited = false;
  private exitedAtMs: number | null = null;
  private exit: number | null = null;
  private failure: string | null = null;
  private openStreams = 0;
  private child: ChildProcess | null = null;
  private pty: PtyProcess | null = null;
  readonly tty: boolean;
  private readonly spawnPid: number;

  private constructor(tty: boolean, pid: number) {
    this.tty = tty;
    this.spawnPid = pid;
  }

  /**
   * The session leader's OS pid, read through to the live handle rather than snapshotted.
   *
   * node-pty's Windows ConPTY backend connects asynchronously: `pty.spawn()` hands back a
   * handle whose `pid` is still 0, and it is filled in later, when the conout pipe reports
   * `ready_datapipe` — comfortably after `EARLY_EXIT_GRACE_PERIOD_MS`. Recording it at
   * construction therefore stored 0 for every Windows tty session for the session's whole
   * life. That made `list_processes` advertise a pid nobody can act on, and, worse, made
   * `terminate()` fail its own `pid > 0` test and skip `terminateProcessTree` entirely — so
   * whenever node-pty had deferred its internal `kill()` (it queues the call until the pty is
   * ready), nothing ever killed the shell, and its console host outlived the app. Every
   * consumer reads this well after connect, so reading through is both correct and enough.
   */
  get pid(): number {
    const live = this.pty?.pid ?? 0;
    return live > 0 ? live : this.spawnPid;
  }

  static async spawn(params: SpawnParams): Promise<UnifiedExecProcess> {
    const file = params.command[0];
    if (file === undefined || params.command.length === 0) throw UnifiedExecError.missingCommandLine();
    const args = params.command.slice(1);

    if (params.tty) {
      const pty = await loadPty();
      if (!pty) {
        throw UnifiedExecError.createProcess('a pseudo-console is not available on this machine');
      }
      let handle: PtyProcess;
      try {
        handle = pty.spawn(
          file,
          // cmd.exe needs the command line it will actually parse; everything else is
          // quoted by node-pty from the argument list.
          params.shellType === 'cmd' && process.platform === 'win32'
            ? [quoteWindowsArgument(file), ...args].join(' ')
            : args,
          {
            name: 'dumb',
            cols: DEFAULT_TERMINAL_COLS,
            rows: DEFAULT_TERMINAL_ROWS,
            cwd: params.cwd,
            env: stringEnv(params.env)
          }
        );
      } catch (error) {
        throw UnifiedExecError.createProcess(error instanceof Error ? error.message : String(error));
      }
      const managed = new UnifiedExecProcess(true, handle.pid);
      managed.pty = handle;
      handle.onData((data) => managed.pushChunk(Buffer.from(data, 'utf8')));
      handle.onExit((event) => {
        managed.signalExit(event.exitCode);
        managed.closeOutput();
      });
      await managed.waitForEarlyExit();
      return managed;
    }

    let child: ChildProcess;
    try {
      const verbatim = params.shellType === 'cmd' && process.platform === 'win32';
      child = spawn(file, args, {
        cwd: params.cwd,
        env: params.env,
        windowsHide: true,
        shell: false,
        // Codex sessions must own descendants as well as the shell process. On POSIX a
        // detached child is a process-group leader, which lets interrupt/terminate signal
        // the whole session without changing Windows' existing taskkill semantics.
        detached: process.platform !== 'win32',
        // `stdin_open: tty` in Codex: a pipe session has no stdin, which is what makes
        // write_stdin answer StdinClosed rather than pretending the write landed.
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(verbatim ? { windowsVerbatimArguments: true } : {})
      });
    } catch (error) {
      throw UnifiedExecError.createProcess(error instanceof Error ? error.message : String(error));
    }

    const managed = new UnifiedExecProcess(false, child.pid ?? -1);
    managed.child = child;
    // stdout and stderr are combined into one stream, exactly as `combine_output_receivers`
    // does on the local Codex path, so interleaving is preserved in arrival order.
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      managed.openStreams += 1;
      stream.on('data', (chunk: Buffer) => managed.pushChunk(chunk));
      stream.on('end', () => managed.streamEnded());
      stream.on('error', () => managed.streamEnded());
    }
    if (managed.openStreams === 0) managed.closeOutput();

    const spawnFailure = new Promise<void>((resolve) => {
      child.once('error', (error: Error) => {
        managed.failure = error.message;
        managed.signalExit(null);
        managed.closeOutput();
        resolve();
      });
    });
    void spawnFailure;
    child.once('exit', (code, signal) => {
      managed.signalExit(code === null && signal ? null : code);
    });

    await managed.waitForEarlyExit();
    // Node reports an OS-level spawn failure (for example ENOENT for a missing
    // executable) through the ChildProcess `error` event instead of throwing
    // from spawn(). Codex's spawn_process returns that same failure from the
    // creation boundary, so it is a CreateProcess error rather than a later
    // ProcessFailed error. The event necessarily arrives before a successful
    // `spawn` event, well inside Codex's 150 ms early-exit grace window.
    if (managed.failure !== null && child.pid === undefined) {
      throw UnifiedExecError.createProcess(managed.failure);
    }
    return managed;
  }

  /** `EARLY_EXIT_GRACE_PERIOD`: a command that is already over must not be stored as live. */
  private async waitForEarlyExit(): Promise<void> {
    if (this.cancelled) return;
    const wait = this.cancelNotify.notified();
    try {
      await Promise.race([wait.promise, sleep(EARLY_EXIT_GRACE_PERIOD_MS)]);
    } finally {
      wait.dispose();
    }
  }

  private pushChunk(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.buffer.pushChunk(chunk);
    this.outputNotify.notifyWaiters();
  }

  private streamEnded(): void {
    this.openStreams -= 1;
    if (this.openStreams <= 0) this.closeOutput();
  }

  private closeOutput(): void {
    if (this.outputClosed) return;
    this.outputClosed = true;
    this.outputClosedNotify.notifyWaiters();
  }

  private signalExit(exitCode: number | null): void {
    if (!this.exited) {
      this.exited = true;
      this.exitedAtMs = Date.now();
      this.exit = exitCode;
    }
    if (!this.cancelled) {
      this.cancelled = true;
      this.cancelNotify.notifyWaiters();
    }
  }

  /** `std::mem::take` of the shared buffer. */
  takeBuffer(): HeadTailBuffer {
    const drained = this.buffer;
    this.buffer = new HeadTailBuffer();
    return drained;
  }

  hasExited(): boolean {
    return this.exited;
  }

  exitCode(): number | null {
    return this.exit;
  }

  exitedAt(): number | null {
    return this.exitedAtMs;
  }

  failureMessage(): string | null {
    return this.failure;
  }

  async write(data: string): Promise<void> {
    if (this.pty) {
      try {
        this.pty.write(data);
        return;
      } catch {
        throw UnifiedExecError.writeToStdin();
      }
    }
    // A pipe session was spawned without stdin, so there is nothing to write to. Codex
    // reaches the same answer through `StdinClosed` before ever calling write.
    throw UnifiedExecError.writeToStdin();
  }

  async interrupt(): Promise<void> {
    if (this.pty) {
      try {
        this.pty.write(INTERRUPT);
        return;
      } catch (error) {
        throw UnifiedExecError.processFailed(error instanceof Error ? error.message : String(error));
      }
    }
    const pid = this.child?.pid;
    if (pid === undefined) throw UnifiedExecError.processFailed('the process is no longer running');
    try {
      // Windows cannot deliver a console control event to a child with no console, so
      // Node's SIGINT is the closest available equivalent for a pipe session. POSIX pipe
      // sessions are process-group leaders, so Ctrl-C reaches their descendants too.
      process.kill(process.platform === 'win32' ? pid : -pid, 'SIGINT');
    } catch (error) {
      // The managed session can outlive the OS process for the tiny window before Node's
      // ChildProcess `exit` event reaches us. Ctrl+C in that window used to turn a successful
      // natural exit into `kill ESRCH`, while the next empty poll immediately returned DONE.
      // "Already gone" is exactly the terminal state the interrupt was trying to reach.
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw UnifiedExecError.processFailed(error instanceof Error ? error.message : String(error));
    }
  }

  async terminate(): Promise<void> {
    if (this.pty) {
      try {
        this.pty.kill();
      } catch {
        /* already gone */
      }
      // node-pty queues `kill()` until the pty reports ready and drops it silently if that
      // never happens, so the process tree is the authority here, not the handle. `pid` is a
      // live read for exactly this reason.
      if (this.pid > 0) await terminateProcessTree(this.pid, true);
    } else if (this.child?.pid !== undefined) {
      await terminateProcessTree(this.child.pid, true);
    }
    this.signalExit(this.exit);
    this.closeOutput();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    if (typeof timer.unref === 'function') timer.unref();
  });
}

// --------------------------------------------------------------------------- tool output

export interface ExecCommandToolOutput {
  chunkId: string;
  wallTimeMs: number;
  rawOutput: Buffer;
  truncationPolicy: TruncationPolicy;
  maxOutputTokens: number | undefined;
  /** The session id, present only while the process is still running. */
  processId: number | null;
  exitCode: number | null;
  originalTokenCount: number | null;
  /** Bytes the 1 MiB collection cap dropped, before model-facing truncation. */
  outputOmittedBytes: number | null;
}

function modelOutputMaxTokens(output: ExecCommandToolOutput): number {
  return Math.min(resolveMaxTokens(output.maxOutputTokens), policyTokenBudget(output.truncationPolicy));
}

/** `ExecCommandToolOutput::truncated_output`. */
export function truncatedOutput(output: ExecCommandToolOutput, maxTokens: number): string {
  const text = output.rawOutput.toString('utf8');
  const policy: TruncationPolicy = { kind: 'tokens', tokens: maxTokens };
  if (output.outputOmittedBytes === null || output.outputOmittedBytes === 0) {
    return formattedTruncateText(text, policy);
  }

  const marker = formatOutputOmissionMarker(output.outputOmittedBytes);
  if (byteLength(text) <= maxTokens * 4) {
    return text.includes(marker) ? text : `${marker}\n${text}`;
  }

  const originalTokenCount = output.originalTokenCount ?? approxTokenCount(text);
  const truncated = truncateText(text, policy);
  const omissionNotice = truncated.includes(marker) ? '' : `${marker}\n`;
  return `Warning: truncated output (original token count: ${originalTokenCount})\n${omissionNotice}\n${truncated}`;
}

/** `ExecCommandToolOutput::response_text` — exactly what the model is handed. */
export function execCommandResponseText(output: ExecCommandToolOutput): string {
  const sections: string[] = [];
  if (output.chunkId !== '') sections.push(`Chunk ID: ${output.chunkId}`);
  sections.push(`Wall time: ${(output.wallTimeMs / 1000).toFixed(4)} seconds`);
  if (output.exitCode !== null) sections.push(`Process exited with code ${output.exitCode}`);
  if (output.processId !== null) sections.push(`Process running with session ID ${output.processId}`);
  if (output.originalTokenCount !== null) sections.push(`Original token count: ${output.originalTokenCount}`);
  sections.push('Output:');
  sections.push(truncatedOutput(output, modelOutputMaxTokens(output)));
  return sections.join('\n');
}

/** `ExecCommandToolOutput::code_mode_result`, which is also the tool's declared output schema. */
export function execCommandStructuredOutput(output: ExecCommandToolOutput): Record<string, unknown> {
  return {
    ...(output.chunkId === '' ? {} : { chunk_id: output.chunkId }),
    wall_time_seconds: output.wallTimeMs / 1000,
    ...(output.exitCode === null ? {} : { exit_code: output.exitCode }),
    ...(output.processId === null ? {} : { session_id: output.processId }),
    ...(output.originalTokenCount === null ? {} : { original_token_count: output.originalTokenCount }),
    // This adapter emits structuredContent beside the text result, so both representations
    // must obey the same policy/default budget. Returning the retained raw buffer here made
    // the schema path bypass the model-visible truncation entirely.
    output: truncatedOutput(output, modelOutputMaxTokens(output))
  };
}

// --------------------------------------------------------------------------- manager

export interface ExecCommandRequest {
  command: string[];
  shellType: ShellType;
  hookCommand: string;
  processId: number;
  yieldTimeMs: number;
  maxOutputTokens: number | undefined;
  truncationPolicy: TruncationPolicy;
  cwd: string;
  /** The virtual path this ran in, kept only so `session status` can name it. */
  displayCwd: string;
  env: NodeJS.ProcessEnv;
  tty: boolean;
}

export interface WriteStdinRequest {
  processId: number;
  input: string;
  yieldTimeMs: number;
  maxOutputTokens: number | undefined;
  truncationPolicy: TruncationPolicy;
  maxWriteStdinYieldTimeMs?: number;
}

export interface BackgroundTerminalInfo {
  processId: number;
  command: string;
  cwd: string;
  pid: number;
  tty: boolean;
}

export interface BackgroundTerminalState {
  processId: number;
  running: boolean;
  exitedUnread: boolean;
  tty: boolean;
  startedAt: number;
  changedAt: number;
}

interface ProcessEntry {
  process: UnifiedExecProcess;
  processId: number;
  cwd: string;
  hookCommand: string;
  tty: boolean;
  initialExecCommandActive: boolean;
  startedAt: number;
  lastUsed: number;
}

export interface BackgroundExecState {
  running: number[];
  exitedUnread: Array<{ processId: number; exitCode: number | null }>;
}

export class UnifiedExecProcessManager {
  private readonly processes = new Map<number, ProcessEntry>();
  private readonly reservedProcessIds = new Set<number>();
  private readonly maxWriteStdinYieldTimeMs: number;

  constructor(maxWriteStdinYieldTimeMs: number) {
    this.maxWriteStdinYieldTimeMs = Math.max(maxWriteStdinYieldTimeMs, MIN_EMPTY_YIELD_TIME_MS);
  }

  /** `rand::rng().random_range(1_000..100_000)`, retried against the reservations. */
  allocateProcessId(): number {
    for (;;) {
      const processId = 1_000 + Math.floor(Math.random() * (100_000 - 1_000));
      if (this.reservedProcessIds.has(processId)) continue;
      this.reservedProcessIds.add(processId);
      return processId;
    }
  }

  releaseProcessId(processId: number): void {
    this.reservedProcessIds.delete(processId);
    this.processes.delete(processId);
  }

  async execCommand(request: ExecCommandRequest): Promise<ExecCommandToolOutput> {
    let process: UnifiedExecProcess;
    try {
      this.ensureProcessCapacity(request.processId);
    } catch (error) {
      this.releaseProcessId(request.processId);
      throw error;
    }
    try {
      // `UnifiedExecRuntime::run` prefixes every PowerShell script before it reaches the
      // process launcher so pipe-mode output is UTF-8 just like PTY output.
      const command =
        request.shellType === 'powershell' ? prefixPowershellScriptWithUtf8(request.command) : request.command;
      process = await UnifiedExecProcess.spawn({
        command,
        shellType: request.shellType,
        cwd: request.cwd,
        env: request.env,
        tty: request.tty
      });
    } catch (error) {
      this.releaseProcessId(request.processId);
      throw error instanceof UnifiedExecError
        ? error
        : UnifiedExecError.createProcess(error instanceof Error ? error.message : String(error));
    }

    const start = Date.now();
    const wallStart = performance.now();
    // Stored before the yield wait, so interrupting the call cannot drop the session.
    const processStartedAlive = !process.hasExited() && process.exitCode() === null;
    if (processStartedAlive) {
      this.processes.set(request.processId, {
        process,
        processId: request.processId,
        cwd: request.displayCwd,
        hookCommand: request.hookCommand,
        tty: request.tty,
        initialExecCommandActive: true,
        startedAt: start,
        lastUsed: start
      });
    }

    const deadline = start + clampYieldTime(request.yieldTimeMs);
    const collected = await collectOutputUntilDeadline(process, deadline);
    const wallTimeMs = Math.max(0, performance.now() - wallStart);

    const originalTokenCount = approxTokensFromByteCount(collected.totalBytes());
    const outputOmittedBytes = collected.omittedBytes() === 0 ? null : collected.omittedBytes();
    const rawOutput = collected.toBytesWithOmissionMarker();
    const chunkId = generateChunkId();

    const failure = process.failureMessage();
    if (failure !== null) {
      this.releaseProcessId(request.processId);
      throw UnifiedExecError.processFailed(failure);
    }

    let responseProcessId: number | null;
    let exitCode: number | null;
    if (processStartedAlive) {
      const status = this.refreshProcessState(request.processId);
      if (status.kind === 'alive') {
        responseProcessId = status.processId;
        exitCode = status.exitCode;
      } else if (status.kind === 'exited') {
        responseProcessId = null;
        exitCode = status.exitCode;
      } else {
        throw UnifiedExecError.unknownProcessId(request.processId);
      }
    } else {
      this.releaseProcessId(request.processId);
      responseProcessId = null;
      exitCode = process.exitCode();
    }

    const response = {
      chunkId,
      wallTimeMs,
      rawOutput,
      truncationPolicy: request.truncationPolicy,
      maxOutputTokens: request.maxOutputTokens,
      processId: responseProcessId,
      exitCode,
      originalTokenCount,
      outputOmittedBytes
    };
    if (responseProcessId !== null) {
      const entry = this.processes.get(request.processId);
      if (entry?.process === process) entry.initialExecCommandActive = false;
    }
    return response;
  }

  async writeStdin(request: WriteStdinRequest): Promise<ExecCommandToolOutput> {
    const entry = this.processes.get(request.processId);
    if (!entry) throw UnifiedExecError.unknownProcessId(request.processId);
    const locked = entry.process;

    // Reads and writes against one session must not overlap: they share a draining buffer.
    const release = await locked.interactionLock.lock();
    try {
      const current = this.processes.get(request.processId);
      if (!current || current.process !== locked) throw UnifiedExecError.unknownProcessId(request.processId);
      const { process, tty } = { process: current.process, tty: current.tty };

      let statusAfterWrite: ProcessStatus | null = null;
      if (request.input !== '') {
        if (!tty) {
          if (request.input === INTERRUPT) {
            await process.interrupt();
          } else {
            throw UnifiedExecError.stdinClosed();
          }
        } else {
          try {
            await process.write(request.input);
            // A brief window so the child's reaction is more likely to land in the poll below.
            await sleep(100);
          } catch (error) {
            const status = this.refreshProcessState(request.processId);
            if (status.kind === 'exited') {
              statusAfterWrite = status;
            } else if (error instanceof UnifiedExecError && error.kind === 'process_failed') {
              await process.terminate();
              this.releaseProcessId(request.processId);
              throw error;
            } else {
              throw error;
            }
          }
        }
      }

      const maxEmptyYield = Math.max(
        request.maxWriteStdinYieldTimeMs ?? this.maxWriteStdinYieldTimeMs,
        MIN_EMPTY_YIELD_TIME_MS
      );
      const base = Math.max(request.yieldTimeMs, MIN_YIELD_TIME_MS);
      const yieldTimeMs =
        request.input === ''
          ? Math.min(Math.max(base, MIN_EMPTY_YIELD_TIME_MS), maxEmptyYield)
          : Math.min(base, MAX_YIELD_TIME_MS);

      const start = Date.now();
      const wallStart = performance.now();
      // Empty calls are polls, not collection windows. Once the process produces anything,
      // returning it immediately saves the caller another multi-second connector round trip;
      // bytes that arrive later remain in the draining buffer for the next poll. Non-empty
      // writes keep Codex's collection-window behavior so one interactive response is gathered.
      const collected = await collectOutputUntilDeadline(process, start + yieldTimeMs, request.input === '');
      const wallTimeMs = Math.max(0, performance.now() - wallStart);

      const originalTokenCount = approxTokensFromByteCount(collected.totalBytes());
      const outputOmittedBytes = collected.omittedBytes() === 0 ? null : collected.omittedBytes();
      const rawOutput = collected.toBytesWithOmissionMarker();
      const chunkId = generateChunkId();

      const failure = process.failureMessage();
      if (failure !== null) {
        this.releaseProcessId(request.processId);
        throw UnifiedExecError.processFailed(failure);
      }

      const status = statusAfterWrite ?? this.refreshProcessState(request.processId);
      let responseProcessId: number | null;
      let exitCode: number | null;
      if (status.kind === 'alive') {
        responseProcessId = status.processId;
        exitCode = status.exitCode;
      } else if (status.kind === 'exited') {
        responseProcessId = null;
        exitCode = status.exitCode;
      } else if (process.hasExited()) {
        responseProcessId = null;
        exitCode = process.exitCode();
      } else {
        throw UnifiedExecError.unknownProcessId(request.processId);
      }

      return {
        chunkId,
        wallTimeMs,
        rawOutput,
        truncationPolicy: request.truncationPolicy,
        maxOutputTokens: request.maxOutputTokens,
        processId: responseProcessId,
        exitCode,
        originalTokenCount,
        outputOmittedBytes
      };
    } finally {
      release();
    }
  }

  /**
   * Non-destructive lifecycle projection for /activity. This never drains output and never
   * removes an exited process; write_stdin remains the only consumer of the pending result.
   */
  backgroundState(processId: number): BackgroundTerminalState | null;
  /** Non-destructive obligation view for a caller-owned set of retained sessions. */
  backgroundState(processIds: ReadonlySet<number>): BackgroundExecState;
  backgroundState(
    target: number | ReadonlySet<number>
  ): BackgroundTerminalState | null | BackgroundExecState {
    if (typeof target === 'number') {
      const entry = this.processes.get(target);
      if (!entry) return null;
      const exited = entry.process.hasExited();
      return {
        processId: target,
        running: !exited,
        exitedUnread: exited,
        tty: entry.tty,
        startedAt: entry.startedAt,
        changedAt: entry.process.exitedAt() ?? entry.startedAt
      };
    }
    const running: number[] = [];
    const exitedUnread: Array<{ processId: number; exitCode: number | null }> = [];
    for (const entry of this.processes.values()) {
      if (entry.initialExecCommandActive) continue;
      if (!target.has(entry.processId)) continue;
      if (entry.process.hasExited()) {
        exitedUnread.push({ processId: entry.processId, exitCode: entry.process.exitCode() });
      } else {
        running.push(entry.processId);
      }
    }
    return {
      running: running.sort((left, right) => left - right),
      exitedUnread: exitedUnread.sort((left, right) => left.processId - right.processId)
    };
  }

  /** Live sessions, oldest id first. */
  listProcesses(): BackgroundTerminalInfo[] {
    return [...this.processes.values()]
      .filter((entry) => !entry.process.hasExited())
      .sort((left, right) => left.processId - right.processId)
      .map((entry) => ({
        processId: entry.processId,
        command: entry.hookCommand,
        cwd: entry.cwd,
        pid: entry.process.pid,
        tty: entry.tty
      }));
  }

  /** Exited rows not handled by the starting exec; polling releases these rows. */
  exitedUnread(processIds: ReadonlySet<number>): Array<{ processId: number; exitCode: number | null }> {
    return this.backgroundState(processIds).exitedUnread;
  }

  async terminateProcess(processId: number): Promise<boolean> {
    const entry = this.processes.get(processId);
    if (!entry) return false;
    if (!entry.process.hasExited()) await entry.process.terminate();
    const current = this.processes.get(processId);
    if (current && current.process === entry.process) {
      // Match Codex's InitialExecCommandGuard: the initial exec response still
      // owns this entry until it has refreshed the process's terminal state.
      // Removing it here would turn a successful concurrent termination into
      // an UnknownProcessId error in that original exec_command call.
      if (current.initialExecCommandActive) return true;
      this.releaseProcessId(processId);
    }
    return true;
  }

  async terminateAllProcesses(): Promise<void> {
    const entries = [...this.processes.values()];
    this.processes.clear();
    this.reservedProcessIds.clear();
    // App shutdown is the caller that matters, so this has to behave like `terminateProcess`
    // does for one id: skip the sessions that are already gone rather than spending a taskkill
    // on each. Awaiting them one after another also made a quit cost the *sum* of every
    // termination, and let a single rejection abandon every session queued behind it.
    await Promise.allSettled(
      entries.filter((entry) => !entry.process.hasExited()).map((entry) => entry.process.terminate())
    );
  }

  private refreshProcessState(processId: number): ProcessStatus {
    const entry = this.processes.get(processId);
    if (!entry) return { kind: 'unknown' };
    const exitCode = entry.process.exitCode();
    if (entry.process.hasExited()) {
      this.releaseProcessId(processId);
      return { kind: 'exited', exitCode };
    }
    return { kind: 'alive', exitCode, processId: entry.processId };
  }

  /**
   * Hard cap on retained sessions without sacrificing completed output.
   *
   * An exited entry is still result-bearing until write_stdin consumes its terminal result.
   * Evicting one here would silently discard exactly the output issue #36 requires us to keep.
   * Reservations participate in the cap, so concurrent exec_command calls cannot race past it;
   * when full, refuse the new launch and leave every existing session available to drain.
   */
  private ensureProcessCapacity(requestProcessId: number): void {
    if (this.reservedProcessIds.size > MAX_UNIFIED_EXEC_PROCESSES) {
      throw UnifiedExecError.createProcess(
        `too many retained or active terminal sessions (limit ${MAX_UNIFIED_EXEC_PROCESSES}); drain completed results with write_stdin or terminate a running session before starting another`
      );
    }
    if (!this.reservedProcessIds.has(requestProcessId)) {
      throw UnifiedExecError.createProcess('terminal session reservation was lost before launch');
    }
  }
}

type ProcessStatus =
  | { kind: 'alive'; exitCode: number | null; processId: number }
  | { kind: 'exited'; exitCode: number | null }
  | { kind: 'unknown' };

/**
 * `collect_output_until_deadline`, port for port.
 *
 * The post-exit grace is the subtle part: once the process has signalled exit, the loop stops
 * waiting the full deadline and gives the output stream at most 50 ms more to close, so a
 * command that finished in 20 ms does not spend the whole 10 s yield window proving it.
 */
async function collectOutputUntilDeadline(
  process: UnifiedExecProcess,
  deadline: number,
  returnOnFirstOutput = false
): Promise<HeadTailBuffer> {
  const collected = new HeadTailBuffer();
  let exitSignalReceived = process.cancelled;
  let postExitDeadline: number | null = null;

  for (;;) {
    // Drained and re-armed in one synchronous step, so a chunk arriving between the two
    // cannot be missed by the wait that follows.
    const drained = process.takeBuffer();
    const hasDrainedOutput = drained.retainedBytes() > 0 || drained.omittedBytes() > 0;
    const waitForOutput = hasDrainedOutput ? null : process.outputNotify.notified();

    if (!hasDrainedOutput) {
      exitSignalReceived ||= process.cancelled;
      if (exitSignalReceived && process.outputClosed) {
        waitForOutput?.dispose();
        break;
      }
      const now = Date.now();
      const remaining = Math.max(0, deadline - now);
      if (remaining === 0) {
        waitForOutput?.dispose();
        break;
      }

      if (exitSignalReceived) {
        postExitDeadline ??= now + Math.min(remaining, POST_EXIT_CLOSE_WAIT_CAP_MS);
        const closeWaitRemaining = Math.max(0, postExitDeadline - now);
        if (closeWaitRemaining === 0) {
          waitForOutput?.dispose();
          break;
        }
        const closed = process.outputClosedNotify.notified();
        const timedOut = await raceWithTimeout([waitForOutput, closed], closeWaitRemaining);
        waitForOutput?.dispose();
        closed.dispose();
        if (timedOut) break;
        continue;
      }

      const exitNotified = process.cancelNotify.notified();
      const timedOut = await raceWithTimeout([waitForOutput, exitNotified], remaining);
      waitForOutput?.dispose();
      exitNotified.dispose();
      if (timedOut) break;
      exitSignalReceived ||= process.cancelled;
      continue;
    }

    collected.pushBuffer(drained);
    if (returnOnFirstOutput) break;
    exitSignalReceived ||= process.cancelled;
    if (Date.now() >= deadline) break;
  }

  return collected;
}

/** Resolves true when the timeout won the race. */
async function raceWithTimeout(
  waits: ReadonlyArray<{ promise: Promise<void> } | null>,
  timeoutMs: number
): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), Math.max(0, timeoutMs));
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    const races = waits.filter((wait): wait is { promise: Promise<void> } => wait !== null).map((wait) =>
      wait.promise.then(() => false)
    );
    return await Promise.race([...races, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
