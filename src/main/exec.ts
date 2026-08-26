/**
 * Optional command execution. Disabled by default; enabled only by an explicit
 * checkbox in the app.
 *
 * Three deliberate choices here:
 *  - PowerShell scripts are passed with -EncodedCommand, so no quoting or escaping
 *    of model-supplied text ever reaches a command line parser.
 *  - run_command spawns without a shell, so there is no metacharacter injection.
 *  - Execution policy is not bypassed and no elevation is ever requested. Commands
 *    run as the ordinary user, under whatever policy that user already has.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  applyEnvOverrides,
  deleteEnvValue,
  ensureUsablePath,
  envValue,
  normalizeEnvironment,
  pathEntries,
  prependPath
} from './env.js';
import { locateRipgrep } from './ripgrep.js';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 300_000;
export const MAX_OUTPUT_BYTES = 100_000;
export const MAX_SCRIPT_CHARS = 8_000;
export const MAX_SHELL_COMMAND_CHARS = 32_000;
export const MAX_ENV_VARS = 64;
export const MAX_ENV_KEY_CHARS = 128;
export const MAX_ENV_VALUE_CHARS = 8_192;

/**
 * Makes a PowerShell child write UTF-8, which it otherwise only does at a real console.
 *
 * With no console attached, `[Console]::OutputEncoding` comes up as the machine's OEM code
 * page — IBM437 on this one — and `$OutputEncoding` as US-ASCII. Every non-ASCII character
 * a script printed was therefore encoded to a byte or two of code page 437 and read back
 * here as UTF-8, so `ä → — …` arrived as mojibake and control characters. Nothing was wrong
 * with the data: file bytes and environment values came through intact all along, and the
 * same command run in a terminal was fine, which is what made it look like corruption
 * rather than a mismatched encoding. Both variables are needed — one is what the console
 * writes, the other is what the pipeline encodes with — and both are set without a BOM,
 * since a byte-order mark at the head of every captured stdout is its own small corruption.
 */
const CONSOLE_UTF8 =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
  '$OutputEncoding = [System.Text.UTF8Encoding]::new($false); ';

export class ExecError extends Error {}
export type CommandEnvironment = Record<string, string>;

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

/** Environment variables we never hand to a child process. */
const SECRET_ENV_KEYS = [
  'CONTROL_PLANE_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_ADMIN_KEY',
  'CLOUDFLARED_TOKEN',
  'CLOUDFLARED_TUNNEL_TOKEN'
];

function validateEnvironment(overrides: CommandEnvironment | undefined): void {
  if (!overrides) return;
  const entries = Object.entries(overrides);
  if (entries.length > MAX_ENV_VARS) throw new ExecError(`Too many environment variables (limit ${MAX_ENV_VARS})`);
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > MAX_ENV_KEY_CHARS || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new ExecError(`Invalid environment variable name: ${key.slice(0, MAX_ENV_KEY_CHARS) || '(empty)'}`);
    }
    if (key.toUpperCase().startsWith('CLF_')) {
      throw new ExecError('Environment variable names beginning with CLF_ are reserved by Chat On Steroids');
    }
    if (typeof value !== 'string') throw new ExecError(`Environment variable ${key} must be a string`);
    if (value.includes('\0')) throw new ExecError(`Environment variable ${key} contains a null byte`);
    if (value.length > MAX_ENV_VALUE_CHARS) {
      throw new ExecError(`Environment variable ${key} is too long (limit ${MAX_ENV_VALUE_CHARS} characters)`);
    }
  }
}

/**
 * The environment a child process inherits.
 *
 * Every read and write goes through the case-insensitive helpers in ./env.js. Assigning
 * `env.PATH` on a spread of `process.env` is what produced the crippled child path
 * described there, and it looked entirely correct while doing it.
 */
export function childEnv(overrides?: CommandEnvironment): NodeJS.ProcessEnv {
  validateEnvironment(overrides);
  const env = normalizeEnvironment(process.env);
  const ripgrep = locateRipgrep();
  if (ripgrep) prependPath(env, path.dirname(ripgrep));
  // Windows environment keys are case-insensitive. Remove every inherited spelling of
  // connector/control-plane secrets before applying values explicitly supplied by the caller.
  for (const secret of SECRET_ENV_KEYS) deleteEnvValue(env, secret);
  if (overrides) applyEnvOverrides(env, overrides);
  ensureUsablePath(env);
  return env as NodeJS.ProcessEnv;
}

export interface PreparedCommand {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /**
   * Hand the arguments to Windows as written instead of letting Node quote them.
   *
   * Only ever set for `cmd.exe`, and it is not a preference — see prepareShellCommand.
   */
  windowsVerbatimArguments?: boolean;
}

let cachedPowerShell: string | null | undefined;

/** Where Windows keeps itself, read the way the OS reads variable names. */
function windowsRoot(): string {
  return envValue(process.env, 'SystemRoot') || envValue(process.env, 'windir') || 'C:\\Windows';
}

/** Prefers PowerShell 7 when installed, falling back to Windows PowerShell 5.1. */
export function findPowerShell(): string | null {
  if (cachedPowerShell !== undefined) return cachedPowerShell;
  const candidates = [
    path.join(envValue(process.env, 'ProgramFiles') ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    windowsPowerShellPath()
  ];
  cachedPowerShell = candidates.find((c) => existsSync(c)) ?? null;
  return cachedPowerShell;
}

function windowsPowerShellPath(): string {
  return path.join(windowsRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

let cachedWindowsPowerShell: string | null | undefined;

/**
 * Windows PowerShell 5.1 specifically, by absolute path.
 *
 * Two reasons it is not simply `findPowerShell()`. The computer helper is written against
 * 5.1 — it loads System.Drawing and the UIAutomation assemblies, which PowerShell 7 does
 * not offer on the same terms — and it must not be located by searching PATH. That helper
 * is one of the things the app uses to explain failures, and a broken PATH was the failure
 * it was most often asked about while being unable to start for exactly that reason.
 */
export function findWindowsPowerShell(): string | null {
  if (cachedWindowsPowerShell !== undefined) return cachedWindowsPowerShell;
  const candidate = windowsPowerShellPath();
  cachedWindowsPowerShell = existsSync(candidate) ? candidate : null;
  return cachedWindowsPowerShell;
}

/**
 * `env` is the environment the child will actually receive, not this process's own.
 *
 * Resolving a command against one path and then running it with another is how a shim ends
 * up discoverable here and missing inside the spawned process.
 */
function findWindowsCommandShim(command: string, cwd: string, env: NodeJS.ProcessEnv): string | null {
  if (process.platform !== 'win32') return null;
  const ext = path.extname(command).toLowerCase();
  const scriptExts = ext === '.cmd' || ext === '.bat' ? [''] : ['.cmd', '.bat'];
  const hasSeparator = command.includes('\\') || command.includes('/');
  const bases = hasSeparator
    ? [path.isAbsolute(command) ? command : path.resolve(cwd, command)]
    : pathEntries(env).map((dir) => path.join(dir, command));
  for (const base of bases) {
    for (const suffix of scriptExts) {
      const candidate = `${base}${suffix}`;
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * taskkill.exe by absolute path, or null if it is not where Windows keeps it.
 *
 * Not found through PATH, and this is the lesson of the bug that motivated all of this:
 * a bare `spawn('taskkill')` inherits whatever path the parent had, and when that path was
 * damaged the kill silently failed to *start*. Its error handler then resolved the
 * promise, which reads exactly like a successful kill — while the runaway child carried on
 * running, held its temp directory open, and made every timeout in the app a hang.
 */
function findTaskkill(): string | null {
  const candidate = path.join(windowsRoot(), 'System32', 'taskkill.exe');
  return existsSync(candidate) ? candidate : null;
}

export async function terminateProcessTree(
  pid: number,
  force = true,
  helperTimeoutMs = force ? 1_000 : 500
): Promise<void> {
  // child.kill() leaves grandchildren running on Windows; taskkill /T handles the tree.
  // taskkill itself can block while waiting on an uncooperative console process, so
  // bound the helper too. The caller owns the larger graceful/forced deadline.
  if (process.platform === 'win32') {
    const killed = await new Promise<boolean>((resolve) => {
      const taskkill = findTaskkill();
      if (!taskkill) {
        resolve(false);
        return;
      }
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(ok);
      };
      try {
        const args = ['/pid', String(pid), '/T'];
        if (force) args.push('/F');
        const killer = spawn(taskkill, args, {
          windowsHide: true,
          stdio: 'ignore',
          env: childEnv()
        });
        killer.once('error', () => finish(false));
        // Exit code 128 is "no such process", which is the outcome asked for. Anything
        // else non-zero means the tree may still be standing and the fallback should run.
        killer.once('close', (code) => finish(code === 0 || code === 128));
        timer = setTimeout(() => {
          try {
            killer.kill();
          } catch {
            /* already gone */
          }
          finish(false);
        }, Math.max(50, helperTimeoutMs));
      } catch {
        finish(false);
      }
    });
    if (killed) return;
    // The helper could not do it. Killing the process directly leaves grandchildren behind
    // — which is why taskkill is tried first — but it does end the child the caller is
    // waiting on, and a caller that gets its close event and a partial result is strictly
    // better than one that waits forever on a process nothing ever signalled.
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      /* already gone */
    }
    return;
  }
  // POSIX has a first-class process-group primitive. Every child this module owns is
  // started as its own group leader below, so signalling -pid reaches descendants too.
  // Fall back to the leader itself for a process that predates that launch contract or
  // has already changed session/group state.
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    /* group is gone or was not created */
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

function killTree(pid: number): void {
  void terminateProcessTree(pid);
}

interface RunOptions {
  file: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

function run(opts: RunOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(opts.file, opts.args, {
      cwd: opts.cwd,
      env: opts.env ?? childEnv(),
      windowsHide: true,
      shell: false,
      // A POSIX process group is the only race-free way to make a timeout own all
      // descendants. Windows keeps its existing taskkill /T tree semantics instead.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const collect = (chunks: Buffer[], chunk: Buffer, current: number): number => {
      const room = MAX_OUTPUT_BYTES - current;
      if (room <= 0) {
        truncated = true;
        return current;
      }
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        truncated = true;
        return MAX_OUTPUT_BYTES;
      }
      chunks.push(chunk);
      return current + chunk.length;
    };

    child.stdout.on('data', (chunk: Buffer) => {
      outBytes = collect(out, chunk, outBytes);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errBytes = collect(err, chunk, errBytes);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
    }, opts.timeoutMs);

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        truncated,
        timedOut,
        durationMs: Date.now() - started
      });
    };

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        stdout: '',
        stderr: `Failed to start: ${error.message}`,
        truncated: false,
        timedOut: false,
        durationMs: Date.now() - started
      });
    });
    child.on('close', (code) => finish(code));
  });
}

export function normaliseTimeout(input: number | undefined): number {
  if (input === undefined || !Number.isFinite(input)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.floor(input)));
}

function decodePowerShellXmlText(text: string): string {
  return text
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Turns Windows PowerShell's serialized error stream into compact plain text.
 *
 * Exported because the managed-session path renders its own output and was handing the raw
 * `#< CLIXML` payload — `_x000D__x000A_` escapes and all — to the model, which buries a
 * one-line parser message in transport noise. Text with no CLIXML marker passes through
 * untouched, so a partial chunk is never mangled.
 */
export function cleanPowerShellStderr(stderr: string): string {
  const marker = stderr.indexOf('#< CLIXML');
  if (marker === -1) return stderr.trim();
  const plainPrefix = stderr.slice(0, marker).trim();
  const xml = stderr.slice(marker);
  const records = [...xml.matchAll(/<S S="(?:Error|Warning)">([\s\S]*?)<\/S>/g)]
    .map((match) => decodePowerShellXmlText(match[1] ?? '').trim())
    .filter(Boolean);
  return [plainPrefix, ...records].filter(Boolean).join('\n').trim();
}

export type AgentShell = 'powershell' | 'cmd';

/** Build a shell command for a managed Codex-style exec session without using Node's shell=true. */
export function prepareShellCommand(
  script: string,
  shellKind: AgentShell,
  envOverrides?: CommandEnvironment
): PreparedCommand {
  if (typeof script !== 'string' || script.trim() === '') throw new ExecError('cmd must be a non-empty string');
  if (script.includes('\0')) throw new ExecError('cmd contains a null byte');
  if (script.length > MAX_SHELL_COMMAND_CHARS) {
    throw new ExecError(`cmd is too long (limit ${MAX_SHELL_COMMAND_CHARS} characters)`);
  }
  const env = childEnv(envOverrides);
  if (shellKind === 'cmd') {
    return {
      file: process.env.ComSpec || 'cmd.exe',
      // The script is wrapped and passed verbatim, and the two go together.
      //
      // Node quotes arguments for a normal Windows program, which escapes an inner `"` as
      // `\"`. cmd.exe has never used that convention: it saw the backslashes as part of the
      // text, so `node -e "console.log(123)"` reached it as something it could not run —
      // and cmd exits 0 in that case, so the call came back *successful* with no output and
      // no side effect. A command that silently does not run is worse than one that fails.
      //
      // Verbatim alone is not enough: without the wrapping quotes a script containing `&`
      // or `|` would be split by cmd's own parser. `/s` is the switch that makes cmd strip
      // exactly the outer pair and treat everything between as the command, which is why
      // the wrapping is safe for scripts that contain quotes of their own.
      args: ['/d', '/s', '/c', `"${script}"`],
      env,
      windowsVerbatimArguments: true
    };
  }
  const shell = findPowerShell();
  if (!shell) throw new ExecError('PowerShell was not found on this system');
  const cleanScript = `${CONSOLE_UTF8}$ProgressPreference='SilentlyContinue'; ${script}`;
  const encoded = Buffer.from(cleanScript, 'utf16le').toString('base64');
  return {
    file: shell,
    args: ['-NoProfile', '-NonInteractive', '-NoLogo', '-OutputFormat', 'Text', '-EncodedCommand', encoded],
    env
  };
}

/** Runs a PowerShell script in an approved working directory. */
export async function runPowerShell(
  script: string,
  cwd: string,
  timeoutMs: number
): Promise<ExecResult> {
  if (typeof script !== 'string' || script.trim() === '') {
    throw new ExecError('script must be a non-empty string');
  }
  if (script.length > MAX_SCRIPT_CHARS) {
    throw new ExecError(`script is too long (limit ${MAX_SCRIPT_CHARS} characters)`);
  }
  const shell = findPowerShell();
  if (!shell) throw new ExecError('PowerShell was not found on this system');

  // UTF-16LE base64 is exactly what -EncodedCommand expects, and it removes the
  // command line as a place where model-supplied text could be misparsed. The encoding
  // preamble is the other half: what goes *in* has been unambiguous all along, and this is
  // what makes what comes back out unambiguous too. See CONSOLE_UTF8.
  const cleanScript = `${CONSOLE_UTF8}$ProgressPreference='SilentlyContinue'; ${script}`;
  const encoded = Buffer.from(cleanScript, 'utf16le').toString('base64');
  const result = await run({
    file: shell,
    args: ['-NoProfile', '-NonInteractive', '-NoLogo', '-OutputFormat', 'Text', '-EncodedCommand', encoded],
    cwd,
    timeoutMs
  });
  const stderr = cleanPowerShellStderr(result.stderr);
  return {
    ...result,
    stderr:
      stderr && result.exitCode === 0
        ? `PowerShell error stream (process exited 0):\n${stderr}`
        : stderr
  };
}

function validateCommand(command: string, args: readonly string[]): void {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new ExecError('command must be a non-empty string');
  }
  if (command.includes('\0')) throw new ExecError('command contains a null byte');
  if (args.length > 128) throw new ExecError('Too many arguments');
  for (const arg of args) {
    if (typeof arg !== 'string') throw new ExecError('Every argument must be a string');
    if (arg.includes('\0')) throw new ExecError('An argument contains a null byte');
  }
}

/**
 * Resolves a command into a shell-free spawn target. Windows .cmd/.bat shims such as
 * npm cannot be passed to CreateProcess directly, so they use a fixed PowerShell
 * launcher whose command and argv arrive only through environment variables.
 */
export function prepareCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  envOverrides?: CommandEnvironment
): PreparedCommand {
  validateCommand(command, args);
  const env = childEnv(envOverrides);
  const shim = findWindowsCommandShim(command, cwd, env);
  if (!shim) return { file: command, args: [...args], env };

  const shell = findPowerShell();
  if (!shell) return { file: command, args: [...args], env };
  const launcher = [
    `$ErrorActionPreference='Stop'`,
    `$ProgressPreference='SilentlyContinue'`,
    `$cmd=$env:CLF_COMMAND`,
    `$argv=@()`,
    `if($env:CLF_ARGUMENTS){$argv=@(ConvertFrom-Json $env:CLF_ARGUMENTS)}`,
    `& $cmd @argv`,
    `if($null -ne $LASTEXITCODE){exit $LASTEXITCODE}`
  ].join('; ');
  env['CLF_COMMAND'] = shim;
  env['CLF_ARGUMENTS'] = JSON.stringify(args);
  return {
    file: shell,
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-NoLogo',
      '-OutputFormat',
      'Text',
      '-EncodedCommand',
      Buffer.from(launcher, 'utf16le').toString('base64')
    ],
    env
  };
}

/** Starts an executable and returns as soon as the operating system accepts the spawn. */
export async function launchCommand(
  command: string,
  args: readonly string[],
  cwd: string
): Promise<{ pid: number }> {
  const prepared = prepareCommand(command, args, cwd);
  return new Promise((resolve, reject) => {
    const child = spawn(prepared.file, prepared.args, {
      cwd,
      env: prepared.env,
      windowsHide: false,
      shell: false,
      // On Windows, detached:true can report a successful spawn yet cause
      // powershell.exe to exit 0 without executing its -File payload. Electron itself
      // is long-lived, so unref() is sufficient there and preserves literal argv. POSIX
      // launchers get their own process group so callers can later terminate their tree.
      detached: process.platform !== 'win32',
      stdio: 'ignore'
    });
    child.once('error', (error) => reject(new ExecError(`Failed to start: ${error.message}`)));
    child.once('spawn', () => {
      const pid = child.pid;
      child.unref();
      if (pid === undefined) reject(new ExecError('Program started without a process id'));
      else resolve({ pid });
    });
  });
}

/** Runs an executable directly. No model-supplied text is parsed as shell syntax. */
export async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  env?: CommandEnvironment
): Promise<ExecResult> {
  const prepared = prepareCommand(command, args, cwd, env);
  return run({
    file: prepared.file,
    args: prepared.args,
    cwd,
    timeoutMs,
    env: prepared.env
  });
}
