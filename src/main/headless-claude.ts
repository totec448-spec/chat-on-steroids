/**
 * One-shot headless Claude invocation through the user's own claude.ai subscription.
 *
 * The `session` tool's `invoke` action lets the ChatGPT side hand one bounded prompt to a
 * local `claude -p` process and get a structured answer back. Everything here is designed to
 * fail closed rather than guess:
 *
 *  - the model is an allowlisted alias, never free text, and the CLI's own resolution of that
 *    alias is reported back as the canonical model together with the model that actually
 *    answered — a provider-side substitution is a reported fact, and a refusal by default;
 *  - authentication is the stored claude.ai login and nothing else. Every API-key, provider
 *    routing and model-override variable is removed from the child environment before the
 *    subscription check runs, so there is no path on which an invocation silently bills a key
 *    or a cloud provider instead of the subscription the user chose;
 *  - the working directory is an approved root the caller named or the chat's proven
 *    workspace, resolved by the same authority as `exec_command`;
 *  - the default profile is reasoning only. The child gets no built-in tools, no MCP servers,
 *    no skills and no browser; a permission prompt has nobody to answer it. The coding profile
 *    is a separate operator switch and confines the child's file tools to that directory;
 *  - the child's output is a strict JSONL stream. A line that is not JSON, a missing init or
 *    result event, a truncated stream or a timeout all yield an error status, never a partial
 *    answer presented as a whole one.
 *
 * The process runner is injectable so the contract above is testable without a CLI.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { prepareCommand, terminateProcessTree } from './exec.js';
import { normalizeEnvironment, pathEntries, type MutableEnvironment } from './env.js';
import { logInfo, logWarn } from './logger.js';

export const HEADLESS_MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'] as const;
export type HeadlessModelAlias = (typeof HEADLESS_MODEL_ALIASES)[number];

export const HEADLESS_PROFILES = ['reasoning', 'coding'] as const;
export type HeadlessProfile = (typeof HEADLESS_PROFILES)[number];

export const HEADLESS_MIN_TIMEOUT_SECONDS = 10;
export const HEADLESS_MAX_TIMEOUT_SECONDS = 600;
export const HEADLESS_DEFAULT_TIMEOUT_SECONDS = 120;
export const HEADLESS_MAX_TURNS = 50;
export const HEADLESS_DEFAULT_CODING_TURNS = 25;
export const HEADLESS_MAX_PROMPT_CHARS = 60_000;
/** The model-visible answer keeps this many characters; the rest is reported as cut. */
export const HEADLESS_MAX_RESULT_CHARS = 40_000;
/** Whole child stdout; a stream past this is malformed rather than partially trusted. */
export const HEADLESS_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
export const HEADLESS_MAX_STDERR_BYTES = 64 * 1024;
const AUTH_STATUS_TIMEOUT_MS = 20_000;

/**
 * File tools the coding profile may use. No shell, no network, no MCP: a headless worker that
 * needs a build run reports back and the caller runs it through `exec_command`, where the
 * app's own permission model and recording apply.
 */
export const HEADLESS_CODING_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit'] as const;

export type HeadlessStatus =
  | 'completed'
  | 'model_fallback'
  | 'auth_required'
  | 'launch_failed'
  | 'timeout'
  | 'malformed_output'
  | 'error';

export interface HeadlessInvocationRequest {
  prompt: string;
  model: HeadlessModelAlias;
  profile: HeadlessProfile;
  /** Canonical directory on disk, already validated against the approved roots. */
  cwd: string;
  maxTurns: number;
  timeoutMs: number;
  allowModelFallback: boolean;
}

export interface HeadlessUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_cost_usd: number | null;
  api_duration_ms: number | null;
}

export interface HeadlessModelReport {
  /** The allowlisted alias the caller asked for. */
  requested: HeadlessModelAlias;
  /** The CLI's own resolution of that alias, from its init event. */
  canonical: string | null;
  /** The model that produced the last assistant message. */
  resolved: string | null;
  fallback: { from: string; to: string; reason: string | null } | null;
}

export interface HeadlessInvocation {
  status: HeadlessStatus;
  ok: boolean;
  provider: 'claude';
  profile: HeadlessProfile;
  binary: string | null;
  auth: { method: 'claude.ai'; subscription: string } | null;
  model: HeadlessModelReport;
  session_id: string | null;
  turns: number | null;
  usage: HeadlessUsage | null;
  result: string | null;
  result_truncated: boolean;
  permission_denials: number | null;
  exit_code: number | null;
  duration_ms: number;
  error: string | null;
}

// ------------------------------------------------------------------ command line

/**
 * The exact argument vector for one invocation. Pure, so the contract is testable.
 *
 * The prompt travels on stdin rather than argv: Windows caps a command line at 32 K
 * characters and quoting a model-authored prompt for two shells is the kind of escaping this
 * app refuses to do anywhere else.
 */
export function headlessClaudeArgs(request: Pick<HeadlessInvocationRequest, 'model' | 'profile' | 'maxTurns'>): string[] {
  const common = [
    '-p',
    '--model', request.model,
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--permission-prompts', 'none',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-chrome',
    '--max-turns', String(request.maxTurns)
  ];
  if (request.profile === 'reasoning') {
    return [...common, '--tools', '', '--permission-mode', 'dontAsk'];
  }
  // `--restricted` removes every command-running tool and confines the file tools to the
  // working directory; the explicit tool list keeps it to reading and editing there.
  return [...common, '--restricted', '--tools', HEADLESS_CODING_TOOLS.join(','), '--permission-mode', 'acceptEdits'];
}

export function defaultMaxTurns(profile: HeadlessProfile): number {
  return profile === 'reasoning' ? 1 : HEADLESS_DEFAULT_CODING_TURNS;
}

// ------------------------------------------------------------------ environment

/**
 * Removes every variable that could redirect authentication, billing or model choice.
 *
 * `ANTHROPIC_*` covers the API key, an auth token, a base URL and the model override family;
 * `CLAUDE_CODE_*` covers Bedrock/Vertex/Foundry routing, an injected OAuth token and the
 * markers of a parent Claude Code session, which the CLI treats as nesting. The config
 * directory stays: it is where the stored subscription login lives.
 */
export function scrubHeadlessEnv(env: MutableEnvironment): string[] {
  const removed: string[] = [];
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    const doomed =
      upper.startsWith('ANTHROPIC_') ||
      upper === 'CLAUDECODE' ||
      upper === 'AWS_BEARER_TOKEN_BEDROCK' ||
      (upper.startsWith('CLAUDE_') && upper !== 'CLAUDE_CONFIG_DIR');
    if (!doomed) continue;
    delete env[key];
    removed.push(key);
  }
  return removed.sort();
}

/** The CLI binary, from PATH first and then the native installer's default location. */
export function locateClaudeBinary(env: MutableEnvironment, home = homedir()): string | null {
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const dirs = [...pathEntries(env), path.join(home, '.local', 'bin')];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// ------------------------------------------------------------------ auth

export type SubscriptionCheck = { ok: true; subscription: string } | { ok: false; reason: string };

/**
 * Whether `claude auth status` describes the stored claude.ai login and nothing else.
 *
 * `apiKeySource` is the tell: with a key in the environment the CLI still reports the
 * stored login as its auth method, and would bill the key. The environment is scrubbed
 * before this runs, so a key showing up here means one the CLI found somewhere this app
 * does not control — refused rather than reasoned about.
 */
export function subscriptionAuth(status: unknown): SubscriptionCheck {
  if (!status || typeof status !== 'object') return { ok: false, reason: 'auth status was not a JSON object' };
  const record = status as Record<string, unknown>;
  if (record['loggedIn'] !== true) {
    return { ok: false, reason: 'no claude.ai login is stored on this machine; run `claude login` as the app user' };
  }
  if (record['authMethod'] !== 'claude.ai') {
    return { ok: false, reason: `auth method is ${String(record['authMethod'])}, not the claude.ai subscription login` };
  }
  const keySource = record['apiKeySource'];
  if (keySource !== undefined && keySource !== null && keySource !== 'none') {
    return { ok: false, reason: `an API key from ${String(keySource)} would be used instead of the subscription` };
  }
  const subscription = record['subscriptionType'];
  if (typeof subscription !== 'string' || subscription.length === 0) {
    return { ok: false, reason: 'the stored login carries no claude.ai subscription' };
  }
  return { ok: true, subscription };
}

// ------------------------------------------------------------------ stream parsing

export interface ParsedHeadlessStream {
  init: { model: string | null; sessionId: string | null; tools: string[]; apiKeySource: string | null } | null;
  lastAssistantModel: string | null;
  fallback: { from: string; to: string; reason: string | null } | null;
  result: {
    subtype: string;
    isError: boolean;
    text: string | null;
    sessionId: string | null;
    turns: number | null;
    usage: HeadlessUsage | null;
    permissionDenials: number | null;
    errors: string[];
  } | null;
}

export type StreamParse = { ok: true; stream: ParsedHeadlessStream } | { ok: false; reason: string };

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * Reads the CLI's stream-json output strictly.
 *
 * Every non-empty line must be a JSON object with a string `type`. Events this reader does not
 * know are skipped by name, never by shape — hook events and rate-limit notices are ordinary
 * there — but a line that is not JSON at all is evidence that something other than the
 * expected process wrote to stdout, and the whole answer is refused on it.
 */
export function parseHeadlessStream(stdout: string): StreamParse {
  const stream: ParsedHeadlessStream = { init: null, lastAssistantModel: null, fallback: null, result: null };
  const lines = stdout.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    let event: Record<string, unknown> | null;
    try {
      event = asRecord(JSON.parse(line));
    } catch {
      return { ok: false, reason: `line ${index + 1} of the CLI output is not JSON` };
    }
    const type = event ? asString(event['type']) : null;
    if (!event || !type) return { ok: false, reason: `line ${index + 1} of the CLI output has no event type` };

    if (type === 'system') {
      const subtype = asString(event['subtype']);
      if (subtype === 'init') {
        const tools = Array.isArray(event['tools']) ? event['tools'].filter((tool): tool is string => typeof tool === 'string') : [];
        stream.init = {
          model: asString(event['model']),
          sessionId: asString(event['session_id']),
          tools,
          apiKeySource: asString(event['apiKeySource'])
        };
      } else if (subtype === 'model_refusal_fallback') {
        const from = asString(event['original_model']);
        const to = asString(event['fallback_model']);
        if (from && to) stream.fallback = { from, to, reason: asString(event['api_refusal_category']) };
      }
      continue;
    }

    if (type === 'assistant') {
      const message = asRecord(event['message']);
      if (!message) return { ok: false, reason: `line ${index + 1} is an assistant event without a message` };
      const model = asString(message['model']);
      if (model) stream.lastAssistantModel = model;
      const content = Array.isArray(message['content']) ? message['content'] : [];
      for (const block of content) {
        const record = asRecord(block);
        if (record?.['type'] !== 'fallback') continue;
        const from = asString(asRecord(record['from'])?.['model']);
        const to = asString(asRecord(record['to'])?.['model']);
        if (from && to && !stream.fallback) stream.fallback = { from, to, reason: null };
      }
      continue;
    }

    if (type === 'result') {
      const subtype = asString(event['subtype']);
      if (!subtype) return { ok: false, reason: `line ${index + 1} is a result event without a subtype` };
      const usage = asRecord(event['usage']);
      const denials = event['permission_denials'];
      const errors = Array.isArray(event['errors']) ? event['errors'].filter((item): item is string => typeof item === 'string') : [];
      stream.result = {
        subtype,
        isError: event['is_error'] === true,
        text: asString(event['result']),
        sessionId: asString(event['session_id']),
        turns: asNumber(event['num_turns']),
        usage: usage
          ? {
              input_tokens: asNumber(usage['input_tokens']) ?? 0,
              output_tokens: asNumber(usage['output_tokens']) ?? 0,
              cache_read_input_tokens: asNumber(usage['cache_read_input_tokens']) ?? 0,
              cache_creation_input_tokens: asNumber(usage['cache_creation_input_tokens']) ?? 0,
              total_cost_usd: asNumber(event['total_cost_usd']),
              api_duration_ms: asNumber(event['duration_api_ms'])
            }
          : null,
        permissionDenials: Array.isArray(denials) ? denials.length : null,
        errors
      };
    }
  }
  if (!stream.init) return { ok: false, reason: 'the CLI never reported its init event' };
  if (!stream.result) return { ok: false, reason: 'the CLI never reported a result event' };
  return { ok: true, stream };
}

// ------------------------------------------------------------------ process runner

export interface HeadlessProcessSpec {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  stdin: string | null;
  timeoutMs: number;
}

export interface HeadlessProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** stdout exceeded its ceiling; the stream cannot be trusted whole. */
  truncated: boolean;
  launchError: string | null;
  durationMs: number;
}

export type HeadlessProcessRunner = (spec: HeadlessProcessSpec) => Promise<HeadlessProcessResult>;

/** Spawns directly, feeds stdin, bounds both pipes and owns the whole tree on timeout. */
export const runHeadlessProcess: HeadlessProcessRunner = (spec) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const collect = (chunks: Buffer[], chunk: Buffer, current: number, ceiling: number, fatal: boolean): number => {
      const room = ceiling - current;
      if (room <= 0) {
        if (fatal) truncated = true;
        return current;
      }
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        if (fatal) truncated = true;
        return ceiling;
      }
      chunks.push(chunk);
      return current + chunk.length;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes = collect(out, chunk, outBytes, HEADLESS_MAX_STDOUT_BYTES, true);
      if (truncated && child.pid !== undefined) void terminateProcessTree(child.pid);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errBytes = collect(err, chunk, errBytes, HEADLESS_MAX_STDERR_BYTES, false);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) void terminateProcessTree(child.pid);
    }, spec.timeoutMs);

    const finish = (exitCode: number | null, launchError: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        truncated,
        launchError,
        durationMs: Date.now() - started
      });
    };
    child.on('error', (error) => finish(null, error.message));
    child.on('close', (code) => finish(code, null));
    child.stdin.on('error', () => {
      /* the child closed its input early; its exit status says what happened */
    });
    if (spec.stdin !== null) child.stdin.end(spec.stdin);
    else child.stdin.end();
  });

// ------------------------------------------------------------------ invocation

export interface HeadlessDeps {
  runner?: HeadlessProcessRunner;
  /** Overrides binary discovery, for tests and for a future explicit setting. */
  binary?: string | null;
}

function emptyInvocation(request: HeadlessInvocationRequest): HeadlessInvocation {
  return {
    status: 'error',
    ok: false,
    provider: 'claude',
    profile: request.profile,
    binary: null,
    auth: null,
    model: { requested: request.model, canonical: null, resolved: null, fallback: null },
    session_id: null,
    turns: null,
    usage: null,
    result: null,
    result_truncated: false,
    permission_denials: null,
    exit_code: null,
    duration_ms: 0,
    error: null
  };
}

function refused(invocation: HeadlessInvocation, status: HeadlessStatus, error: string): HeadlessInvocation {
  return { ...invocation, status, ok: false, error };
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0]?.slice(0, 300) ?? '';
}

/**
 * Runs one invocation end to end. Never throws: every failure is a status with a reason, so
 * the tool result and the recording say the same thing about what happened.
 */
export async function invokeHeadlessClaude(
  request: HeadlessInvocationRequest,
  deps: HeadlessDeps = {}
): Promise<HeadlessInvocation> {
  const runner = deps.runner ?? runHeadlessProcess;
  const started = Date.now();
  let invocation = emptyInvocation(request);
  const done = (value: HeadlessInvocation): HeadlessInvocation => ({ ...value, duration_ms: Date.now() - started });

  // The binary is located in the same scrubbed environment the child will run in, so a PATH
  // entry an API-key wrapper script added cannot be the thing that answers.
  const binary = deps.binary !== undefined ? deps.binary : locateClaudeBinary(scrubbedParentEnv());
  if (!binary) {
    return done(refused(invocation, 'launch_failed', 'the claude CLI is not installed on this machine or not on PATH'));
  }
  const prepare = (args: string[]) => {
    const prepared = prepareCommand(binary, args, request.cwd);
    scrubHeadlessEnv(prepared.env as MutableEnvironment);
    return { ...prepared, cwd: request.cwd };
  };
  invocation = { ...invocation, binary };

  // 1. Subscription auth, checked in the child's own environment.
  let authPrepared: ReturnType<typeof prepare>;
  try {
    authPrepared = prepare(['auth', 'status']);
  } catch (error) {
    return done(refused(invocation, 'launch_failed', error instanceof Error ? error.message : String(error)));
  }
  const auth = await runner({ ...authPrepared, stdin: null, timeoutMs: AUTH_STATUS_TIMEOUT_MS });
  if (auth.launchError) return done(refused(invocation, 'launch_failed', `claude auth status did not start: ${auth.launchError}`));
  if (auth.timedOut) return done(refused(invocation, 'auth_required', 'claude auth status did not answer in time'));
  let status: unknown;
  try {
    status = JSON.parse(auth.stdout.trim());
  } catch {
    const hint = firstLine(auth.stderr) || firstLine(auth.stdout);
    return done(refused(invocation, 'auth_required', `claude auth status did not return JSON${hint ? `: ${hint}` : ''}`));
  }
  const subscription = subscriptionAuth(status);
  if (!subscription.ok) return done(refused(invocation, 'auth_required', subscription.reason));
  invocation = { ...invocation, auth: { method: 'claude.ai', subscription: subscription.subscription } };

  // 2. The invocation itself.
  let prepared: ReturnType<typeof prepare>;
  try {
    prepared = prepare(headlessClaudeArgs(request));
  } catch (error) {
    return done(refused(invocation, 'launch_failed', error instanceof Error ? error.message : String(error)));
  }
  logInfo(`headless claude: ${request.model} ${request.profile} in ${request.cwd} (${request.timeoutMs} ms budget)`);
  const run = await runner({ ...prepared, stdin: request.prompt, timeoutMs: request.timeoutMs });
  invocation = { ...invocation, exit_code: run.exitCode };
  if (run.launchError) return done(refused(invocation, 'launch_failed', `claude did not start: ${run.launchError}`));

  // Whatever the process managed to say is still read: a timed-out run has usually reported
  // its session id already, and that is worth having in the refusal.
  const parsed = parseHeadlessStream(run.stdout);
  if (parsed.ok) invocation = withStream(invocation, parsed.stream);

  if (run.timedOut) {
    return done(refused(invocation, 'timeout', `claude did not finish within ${Math.round(request.timeoutMs / 1000)} s`));
  }
  if (run.truncated) {
    return done(refused(invocation, 'malformed_output', `claude wrote more than ${HEADLESS_MAX_STDOUT_BYTES} bytes to stdout`));
  }
  if (!parsed.ok) {
    const hint = firstLine(run.stderr);
    logWarn(`headless claude: malformed output (${parsed.reason})${hint ? `: ${hint}` : ''}`);
    return done(refused(invocation, 'malformed_output', `${parsed.reason}${hint ? ` (stderr: ${hint})` : ''}`));
  }
  const stream = parsed.stream;
  const init = stream.init!;
  const result = stream.result!;
  if (init.apiKeySource && init.apiKeySource !== 'none') {
    return done(refused(invocation, 'auth_required', `the CLI started with an API key from ${init.apiKeySource}`));
  }
  if (request.profile === 'reasoning' && init.tools.length > 0) {
    return done(refused(invocation, 'error', `the reasoning profile started with tools enabled: ${init.tools.join(', ')}`));
  }
  if (result.isError || result.subtype !== 'success' || (run.exitCode !== 0 && run.exitCode !== null)) {
    const detail = result.errors[0] ?? result.text ?? firstLine(run.stderr);
    return done(
      refused(invocation, 'error', `claude reported ${result.subtype}${run.exitCode ? ` (exit ${run.exitCode})` : ''}${detail ? `: ${firstLine(detail)}` : ''}`)
    );
  }
  if (invocation.model.fallback && !request.allowModelFallback) {
    const { from, to, reason } = invocation.model.fallback;
    return done(
      refused(
        invocation,
        'model_fallback',
        `${from} did not answer; the provider substituted ${to}${reason ? ` (${reason})` : ''}. Pass allow_model_fallback=true to accept a substitute.`
      )
    );
  }
  return done({ ...invocation, status: 'completed', ok: true, error: null });
}

function scrubbedParentEnv(): MutableEnvironment {
  const env = normalizeEnvironment(process.env);
  scrubHeadlessEnv(env);
  return env;
}

function withStream(invocation: HeadlessInvocation, stream: ParsedHeadlessStream): HeadlessInvocation {
  const canonical = stream.init?.model ?? null;
  const resolved = stream.lastAssistantModel;
  let fallback = stream.fallback;
  // A substitution the CLI did not announce still shows in the answering model.
  if (!fallback && canonical && resolved && canonical !== resolved) fallback = { from: canonical, to: resolved, reason: null };
  const text = stream.result?.text ?? null;
  const truncated = text !== null && text.length > HEADLESS_MAX_RESULT_CHARS;
  return {
    ...invocation,
    model: { ...invocation.model, canonical, resolved, fallback },
    session_id: stream.result?.sessionId ?? stream.init?.sessionId ?? null,
    turns: stream.result?.turns ?? null,
    usage: stream.result?.usage ?? null,
    result: truncated ? text.slice(0, HEADLESS_MAX_RESULT_CHARS) : text,
    result_truncated: truncated,
    permission_denials: stream.result?.permissionDenials ?? null
  };
}

// ------------------------------------------------------------------ presentation

/** The model-visible text: one `key: value` line per fact, then the answer verbatim. */
export function formatHeadlessInvocation(invocation: HeadlessInvocation, cwd: string): string {
  const lines = [
    `status: ${invocation.status}`,
    `provider: ${invocation.provider}`,
    `profile: ${invocation.profile}`,
    `cwd: ${cwd}`,
    `model_requested: ${invocation.model.requested}`,
    `model_canonical: ${invocation.model.canonical ?? 'unknown'}`,
    `model_resolved: ${invocation.model.resolved ?? 'unknown'}`,
    `model_fallback: ${
      invocation.model.fallback
        ? `${invocation.model.fallback.from} -> ${invocation.model.fallback.to}${invocation.model.fallback.reason ? ` (${invocation.model.fallback.reason})` : ''}`
        : 'none'
    }`,
    `session_id: ${invocation.session_id ?? 'none'}`,
    `auth: ${invocation.auth ? `claude.ai subscription (${invocation.auth.subscription})` : 'unverified'}`,
    `turns: ${invocation.turns ?? 'unknown'}`,
    `usage: ${
      invocation.usage
        ? `input=${invocation.usage.input_tokens} output=${invocation.usage.output_tokens} cache_read=${invocation.usage.cache_read_input_tokens} cache_write=${invocation.usage.cache_creation_input_tokens}` +
          `${invocation.usage.total_cost_usd === null ? '' : ` list_cost_usd=${invocation.usage.total_cost_usd.toFixed(4)}`}`
        : 'unknown'
    }`,
    `permission_denials: ${invocation.permission_denials ?? 'unknown'}`,
    `duration_ms: ${invocation.duration_ms}`
  ];
  if (invocation.error) lines.push(`error: ${invocation.error}`);
  if (invocation.result !== null) {
    lines.push(`result_truncated: ${invocation.result_truncated}`, 'result:', invocation.result);
  }
  return lines.join('\n');
}
