/**
 * Constants and small helpers from `codex-rs/core/src/unified_exec/mod.rs`.
 *
 * Kept in their own module so `head-tail-buffer.ts` can use the omission marker without
 * importing the process manager, exactly as the Rust crate splits them.
 */

export const MIN_YIELD_TIME_MS = 250;
/** Minimum yield time for an empty `write_stdin`. */
export const MIN_EMPTY_YIELD_TIME_MS = 5_000;
export const MAX_YIELD_TIME_MS = 30_000;
export const DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
export const UNIFIED_EXEC_OUTPUT_MAX_BYTES = 1024 * 1024; // 1 MiB
export const UNIFIED_EXEC_OUTPUT_MAX_TOKENS = UNIFIED_EXEC_OUTPUT_MAX_BYTES / 4;
export const MAX_UNIFIED_EXEC_PROCESSES = 64;

export const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
export const DEFAULT_WRITE_STDIN_YIELD_TIME_MS = 250;
export const DEFAULT_TTY = false;

/** The Ctrl-C character (U+0003), the one input a pipe session will still accept. */
export const INTERRUPT = String.fromCharCode(3);

/**
 * Environment Codex forces on every unified exec child.
 *
 * `codex-rs/core/src/unified_exec/process_manager.rs`. It exists to make command output
 * deterministic and pager-free rather than to sandbox anything.
 */
export function unifiedExecEnvForPlatform(
  platform: NodeJS.Platform = process.platform
): ReadonlyArray<readonly [string, string]> {
  // Ubuntu provides C.UTF-8 and Codex uses it, but macOS' standard UTF-8 locale is
  // en_US.UTF-8. Forcing a locale name the host does not provide makes shells/native tools
  // emit setlocale warnings before the command's own output. Keep the deterministic UTF-8
  // contract while spelling it in the host's normal dialect.
  const utf8Locale = platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
  return [
  ['NO_COLOR', '1'],
  ['TERM', 'dumb'],
  ['LANG', utf8Locale],
  ['LC_CTYPE', utf8Locale],
  ['LC_ALL', utf8Locale],
  ['COLORTERM', ''],
  ['PAGER', 'cat'],
  ['GIT_PAGER', 'cat'],
  ['GH_PAGER', 'cat'],
  ['CODEX_CI', '1']
  ];
}

export const UNIFIED_EXEC_ENV = unifiedExecEnvForPlatform();

/** portable_pty's `TerminalSize::default()`. */
export const DEFAULT_TERMINAL_ROWS = 24;
export const DEFAULT_TERMINAL_COLS = 80;

export function clampYieldTime(yieldTimeMs: number): number {
  // Keep Codex's 10 s *default*, but honour an explicit shorter yield on Windows. The local
  // connector uses managed sessions specifically so a dev server/watcher can hand control back
  // to the model immediately; forcing every still-running first call to sit for ten seconds made
  // `yield_time_ms: 250` a lie and dominated normal coding latency for no local correctness gain.
  return Math.min(Math.max(yieldTimeMs, MIN_YIELD_TIME_MS), MAX_YIELD_TIME_MS);
}

export function resolveMaxTokens(maxTokens: number | undefined): number {
  return maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

export function formatOutputOmissionMarker(omittedBytes: number): string {
  return `... ${omittedBytes} bytes omitted ...`;
}

/** Six random lowercase hex characters, as `generate_chunk_id`. */
export function generateChunkId(): string {
  let out = '';
  for (let index = 0; index < 6; index++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}
