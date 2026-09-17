/**
 * Provider-owned CLI session bridge.
 *
 * This is transport, not authority. It reads the local transcript stores already owned by
 * Claude Code / Codex and uses each CLI's own session surface to deliver a user message. No
 * watcher, daemon, polling loop or copy of provider state is introduced here.
 *
 * The local transcript roots intentionally sit outside the user's approved project roots:
 * `~/.claude/projects` and `~/.codex/sessions` are the providers' own per-user session stores,
 * analogous to this app's own recording store. The MCP tool that reaches this module is gated on
 * the existing Command permission, so disabling command execution disables both reading and
 * messaging CLI sessions in one place.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareCommand, runCommand } from './exec.js';

export type CliProvider = 'claude' | 'codex';

export interface CliSessionSummary {
  provider: CliProvider;
  sessionId: string;
  updatedAt: number;
  cwd: string | null;
  state: string | null;
  managed: boolean;
  writerLock: boolean | null;
  name: string | null;
}

export interface CliTranscriptEntry {
  at: string | null;
  kind: 'user' | 'assistant' | 'tool' | 'event';
  text: string;
}

export interface CliTranscriptPage {
  provider: CliProvider;
  sessionId: string;
  entries: CliTranscriptEntry[];
  cursor: string;
  caughtUp: boolean;
  earlierOmitted: boolean;
}

export interface CliSendResult {
  provider: CliProvider;
  sessionId: string;
  delivered: boolean;
  detail: string;
}

interface TranscriptFile {
  file: string;
  sessionId: string;
  updatedAt: number;
  size: number;
}

interface ClaudeAgentRow {
  id: string;
  sessionId: string;
  cwd?: string;
  kind?: string;
  state?: string;
  name?: string;
}

interface CliRoots {
  claude: string;
  codex: string;
  codexLocks: string;
}

interface PtyProcess {
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  kill(signal?: string): void;
}

interface PtyModule {
  spawn(
    file: string,
    args: readonly string[] | string,
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
  ): PtyProcess;
}

const MAX_DISCOVERY_FILES = 5_000;
const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
const MAX_RENDER_CHARS = 18_000;
const MAX_ENTRY_CHARS = 4_000;
const CLI_TIMEOUT_MS = 10_000;
const CLAUDE_ATTACH_READY_MS = 5_000;
const CLAUDE_ATTACH_QUIET_MS = 150;
const CLAUDE_ATTACH_MIN_READY_MS = 1_500;
const CLAUDE_DELIVERY_PROOF_MS = 5_000;
const CURSOR_CHECK_CHARS = 6;

function roots(home = os.homedir()): CliRoots {
  return {
    claude: path.join(home, '.claude', 'projects'),
    codex: path.join(home, '.codex', 'sessions'),
    codexLocks: path.join(home, '.codex', 'thread-writer-locks')
  };
}

function flat(text: string, max = MAX_ENTRY_CHARS): string {
  const value = text.replace(/\r\n/g, '\n').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/**
 * node-pty on Windows does not reliably perform the same PATH/PATHEXT resolution as
 * child_process.spawn. That matters for Claude's native installer: ordinary `claude agents`
 * can resolve successfully while `pty.spawn('claude', ...)` fails with "File not found".
 *
 * Resolve only the executable used as the attach client. The provider session id/message never
 * participates in this lookup. Claude's documented native Windows install lives under
 * `~/.local/bin`; PATH entries are accepted as the user's explicit alternative installation.
 */
export async function resolveClaudePtyCommand(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  platform = process.platform,
  fileExists: (file: string) => Promise<boolean> = exists
): Promise<string | null> {
  if (platform !== 'win32') return 'claude';
  const candidates = [path.join(home, '.local', 'bin', 'claude.exe')];
  const pathValue = env.Path ?? env.PATH ?? env.path ?? '';
  for (const entry of pathValue.split(path.delimiter)) {
    const cleaned = entry.trim().replace(/^"|"$/g, '');
    if (!cleaned) continue;
    candidates.push(path.join(cleaned, 'claude.exe'));
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = path.resolve(candidate).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

/**
 * Claude emits terminal setup bytes before the attached conversation is input-ready. A bare
 * "saw output" gate races that setup and can drop the first message. The interactive screen is
 * considered ready only after Claude's branded TUI and bracketed-paste mode have both appeared,
 * followed by a short quiet window so the final cursor-placement redraw can settle.
 */
export function claudeAttachLooksReady(output: string, quietForMs: number, elapsedMs = CLAUDE_ATTACH_MIN_READY_MS): boolean {
  return (
    output.includes('Claude Code') &&
    output.includes('\x1b[?2004h') &&
    quietForMs >= CLAUDE_ATTACH_QUIET_MS &&
    elapsedMs >= CLAUDE_ATTACH_MIN_READY_MS
  );
}

export interface ClaudeAttachSignals {
  brand: boolean;
  bracketedPaste: boolean;
  deviceHandshake: boolean;
}

export function observeClaudeAttachSignals(previous: ClaudeAttachSignals, output: string): ClaudeAttachSignals {
  return {
    brand: previous.brand || output.includes('Claude Code'),
    bracketedPaste: previous.bracketedPaste || output.includes('\x1b[?2004h'),
    deviceHandshake: previous.deviceHandshake || output.includes('\x1b[>0q')
  };
}

async function loadPty(): Promise<PtyModule | null> {
  try {
    const module = await import('node-pty');
    return ((module as { default?: PtyModule }).default ?? module) as PtyModule;
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function scanJsonl(root: string): Promise<TranscriptFile[]> {
  const files: TranscriptFile[] = [];
  const stack = [root];
  let inspected = 0;
  while (stack.length > 0 && inspected < MAX_DISCOVERY_FILES) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (inspected >= MAX_DISCOVERY_FILES) break;
      inspected += 1;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jsonl')) continue;
      try {
        const stat = await fs.stat(full);
        files.push({ file: full, sessionId: sessionIdFromFilename(entry.name), updatedAt: stat.mtimeMs, size: stat.size });
      } catch {
        /* file raced with provider cleanup */
      }
    }
  }
  return files;
}

function sessionIdFromFilename(name: string): string {
  const stem = name.replace(/\.jsonl$/i, '');
  const uuid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(stem);
  return uuid?.[1] ?? stem;
}

async function findTranscriptFile(provider: CliProvider, sessionId: string, customRoots = roots()): Promise<TranscriptFile> {
  const root = provider === 'claude' ? customRoots.claude : customRoots.codex;
  const files = await scanJsonl(root);
  const matches = files.filter((candidate) => candidate.sessionId.toLowerCase() === sessionId.toLowerCase());
  if (matches.length === 0) throw new Error(`${provider} session ${sessionId} was not found in the local transcript store.`);
  if (matches.length > 1) throw new Error(`${provider} session ${sessionId} is ambiguous across ${matches.length} local transcript files.`);
  return matches[0]!;
}

async function firstJsonObject(file: string): Promise<Record<string, unknown> | null> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  const parts: string[] = [];
  for (const item of value) {
    const row = object(item);
    if (!row) continue;
    const text = row.text ?? row.input_text ?? row.output_text;
    if (typeof text === 'string') parts.push(text);
  }
  return parts.join('\n');
}

function normalizeClaude(obj: Record<string, unknown>): CliTranscriptEntry[] {
  const type = typeof obj.type === 'string' ? obj.type : '';
  const at = typeof obj.timestamp === 'string' ? obj.timestamp : null;
  if (type !== 'user' && type !== 'assistant') return [];
  const message = object(obj.message);
  if (!message) return [];
  const role = message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : type;
  const content = message.content;
  const entries: CliTranscriptEntry[] = [];
  const text = textContent(content);
  if (text.trim()) entries.push({ at, kind: role === 'assistant' ? 'assistant' : 'user', text: flat(text) });
  if (Array.isArray(content)) {
    for (const item of content) {
      const row = object(item);
      if (!row || row.type !== 'tool_use') continue;
      const name = typeof row.name === 'string' ? row.name : 'tool';
      const input = row.input === undefined ? '' : ` ${flat(JSON.stringify(row.input), 500)}`;
      entries.push({ at, kind: 'tool', text: `${name}${input}` });
    }
  }
  return entries;
}

function normalizeCodex(obj: Record<string, unknown>): CliTranscriptEntry[] {
  const outerType = typeof obj.type === 'string' ? obj.type : '';
  const at = typeof obj.timestamp === 'string' ? obj.timestamp : null;
  const payload = object(obj.payload);
  if (!payload) return [];
  const payloadType = typeof payload.type === 'string' ? payload.type : '';
  if (outerType === 'response_item' && payloadType === 'message') {
    const role = payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : null;
    if (!role) return [];
    const text = textContent(payload.content);
    return text.trim() ? [{ at, kind: role, text: flat(text) }] : [];
  }
  if (outerType === 'response_item' && (payloadType === 'custom_tool_call' || payloadType === 'function_call')) {
    const name = typeof payload.name === 'string' ? payload.name : 'tool';
    const input = typeof payload.input === 'string' ? payload.input : typeof payload.arguments === 'string' ? payload.arguments : '';
    return [{ at, kind: 'tool', text: `${name}${input ? ` ${flat(input, 500)}` : ''}` }];
  }
  if (outerType === 'event_msg' && ['task_started', 'task_complete', 'task_completed', 'turn_aborted'].includes(payloadType)) {
    return [{ at, kind: 'event', text: payloadType }];
  }
  return [];
}

export function normalizeCliTranscriptLine(provider: CliProvider, line: string): CliTranscriptEntry[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  return provider === 'claude' ? normalizeClaude(parsed) : normalizeCodex(parsed);
}

function fileKey(provider: CliProvider, sessionId: string, file: string): string {
  return createHash('sha256')
    .update(`${provider}\n${sessionId.toLowerCase()}\n${path.resolve(file).toLowerCase()}`)
    .digest('hex')
    .slice(0, 10);
}

function cursorCheck(sessionId: string, body: string): string {
  return createHash('sha256').update(`${sessionId.toLowerCase()}\n${body}`).digest('hex').slice(0, CURSOR_CHECK_CHARS);
}

function encodeCursor(provider: CliProvider, sessionId: string, file: string, offset: number): string {
  const body = `c1_${provider[0]}_${offset}_${fileKey(provider, sessionId, file)}`;
  return `${body}_${cursorCheck(sessionId, body)}`;
}

function decodeCursor(provider: CliProvider, sessionId: string, file: string, cursor: string): number | null {
  const match = /^c1_([ck])_(\d{1,16})_([0-9a-f]{10})_([0-9a-f]{6})$/i.exec(cursor.trim());
  if (!match) return null;
  const expectedProvider = provider === 'claude' ? 'c' : 'k';
  if (match[1]!.toLowerCase() !== expectedProvider) return null;
  const body = `c1_${match[1]!.toLowerCase()}_${match[2]}_${match[3]!.toLowerCase()}`;
  if (match[3]!.toLowerCase() !== fileKey(provider, sessionId, file)) return null;
  if (match[4]!.toLowerCase() !== cursorCheck(sessionId, body)) return null;
  const offset = Number(match[2]);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : null;
}

async function readWindow(file: string, start: number, snapshot: number): Promise<{ text: string; next: number }> {
  const wanted = Math.min(MAX_TRANSCRIPT_BYTES, Math.max(0, snapshot - start));
  if (wanted === 0) return { text: '', next: start };
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(wanted);
    const { bytesRead } = await handle.read(buffer, 0, wanted, start);
    let usable = buffer.subarray(0, bytesRead);
    const reachesSnapshot = start + bytesRead >= snapshot;
    if (!reachesSnapshot || (usable.length > 0 && usable[usable.length - 1] !== 0x0a)) {
      const newline = usable.lastIndexOf(0x0a);
      if (newline < 0) {
        throw new Error(`A ${MAX_TRANSCRIPT_BYTES}-byte transcript window contained no complete JSONL entry.`);
      }
      usable = usable.subarray(0, newline + 1);
    }
    return { text: usable.toString('utf8'), next: start + usable.length };
  } finally {
    await handle.close();
  }
}

export async function readCliTranscriptFile(
  provider: CliProvider,
  sessionId: string,
  file: string,
  cursor?: string
): Promise<CliTranscriptPage> {
  const stat = await fs.stat(file);
  const snapshot = stat.size;
  let start: number;
  let earlierOmitted = false;
  let latestView = false;
  if (cursor === 'start') {
    start = 0;
  } else if (cursor) {
    const decoded = decodeCursor(provider, sessionId, file, cursor);
    if (decoded === null) throw new Error('CLI transcript cursor does not verify for this provider/session. Start a new read.');
    if (decoded > snapshot) throw new Error('CLI transcript cursor is stale because the provider transcript became shorter. Start a new read.');
    start = decoded;
  } else {
    latestView = true;
    start = Math.max(0, snapshot - MAX_TRANSCRIPT_BYTES);
    earlierOmitted = start > 0;
  }

  const window = await readWindow(file, start, snapshot);
  let text = window.text;
  let effectiveStart = start;
  // A tail view may begin in the middle of one JSONL object. Returned cursors always land on
  // newline boundaries, so only the implicit latest view needs this repair.
  if (latestView && start > 0) {
    const firstNewline = text.indexOf('\n');
    if (firstNewline >= 0) {
      effectiveStart += Buffer.byteLength(text.slice(0, firstNewline + 1), 'utf8');
      text = text.slice(firstNewline + 1);
    }
  }

  const normalized: Array<{ entry: CliTranscriptEntry; end: number }> = [];
  let byteCursor = effectiveStart;
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    byteCursor += Buffer.byteLength(raw, 'utf8') + 1;
    for (const entry of normalizeCliTranscriptLine(provider, raw)) normalized.push({ entry, end: byteCursor });
  }

  const selected: Array<{ entry: CliTranscriptEntry; end: number }> = [];
  let chars = 0;
  if (latestView) {
    for (let index = normalized.length - 1; index >= 0; index -= 1) {
      const row = normalized[index]!;
      const cost = row.entry.text.length + 80;
      if (selected.length > 0 && chars + cost > MAX_RENDER_CHARS) break;
      selected.unshift(row);
      chars += cost;
    }
    if (selected.length < normalized.length) earlierOmitted = true;
  } else {
    for (const row of normalized) {
      const cost = row.entry.text.length + 80;
      if (selected.length > 0 && chars + cost > MAX_RENDER_CHARS) break;
      selected.push(row);
      chars += cost;
    }
  }

  const nextOffset = latestView
    ? window.next
    : selected.length > 0
      ? selected[selected.length - 1]!.end
      : window.next;
  return {
    provider,
    sessionId,
    entries: selected.map((row) => row.entry),
    cursor: encodeCursor(provider, sessionId, file, nextOffset),
    caughtUp: nextOffset >= snapshot,
    earlierOmitted
  };
}

async function claudeAgents(): Promise<ClaudeAgentRow[]> {
  const result = await runCommand('claude', ['agents', '--json', '--all'], os.homedir(), CLI_TIMEOUT_MS);
  if (result.exitCode !== 0 || result.timedOut) return [];
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return Array.isArray(parsed) ? parsed.filter((row): row is ClaudeAgentRow => Boolean(object(row))) : [];
  } catch {
    return [];
  }
}

async function codexMetadata(file: string): Promise<{ cwd: string | null }> {
  const first = await firstJsonObject(file);
  const payload = object(first?.payload);
  return { cwd: typeof payload?.cwd === 'string' ? payload.cwd : null };
}

async function claudeMetadata(file: string): Promise<{ cwd: string | null }> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(128 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (typeof row.cwd === 'string') return { cwd: row.cwd };
      } catch {
        /* keep looking for the first usable provider row */
      }
    }
  } finally {
    await handle.close();
  }
  return { cwd: null };
}

export async function listCliSessions(provider?: CliProvider, limit = 10): Promise<CliSessionSummary[]> {
  const configured = roots();
  const wanted = Math.max(1, Math.min(30, Math.floor(limit)));
  const providers: CliProvider[] = provider ? [provider] : ['claude', 'codex'];
  const agentRows = providers.includes('claude') ? await claudeAgents() : [];
  const agentBySession = new Map(agentRows.map((row) => [row.sessionId.toLowerCase(), row]));
  const rows: CliSessionSummary[] = [];

  for (const current of providers) {
    const folder = current === 'claude' ? configured.claude : configured.codex;
    const files = (await scanJsonl(folder)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, wanted * 3);
    for (const transcript of files) {
      if (rows.filter((row) => row.provider === current).length >= wanted) break;
      if (!transcript.sessionId) continue;
      if (current === 'claude') {
        const agent = agentBySession.get(transcript.sessionId.toLowerCase()) ?? null;
        const meta = await claudeMetadata(transcript.file);
        rows.push({
          provider: current,
          sessionId: transcript.sessionId,
          updatedAt: transcript.updatedAt,
          cwd: agent?.cwd ?? meta.cwd,
          state: agent?.state ?? null,
          managed: agent?.kind === 'background',
          writerLock: null,
          name: agent?.name ?? null
        });
      } else {
        const meta = await codexMetadata(transcript.file);
        rows.push({
          provider: current,
          sessionId: transcript.sessionId,
          updatedAt: transcript.updatedAt,
          cwd: meta.cwd,
          state: null,
          managed: true,
          writerLock: await exists(path.join(configured.codexLocks, `${transcript.sessionId}.lock`)),
          name: null
        });
      }
    }
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function readCliSession(provider: CliProvider, sessionId: string, cursor?: string): Promise<CliTranscriptPage> {
  const transcript = await findTranscriptFile(provider, sessionId);
  return readCliTranscriptFile(provider, transcript.sessionId, transcript.file, cursor);
}

function validateMessage(message: string): string {
  const text = message.trim();
  if (!text) throw new Error('CLI session message must contain non-whitespace text.');
  if (text.length > 8_000) throw new Error('CLI session message exceeds the 8,000-character V1 limit.');
  if (/[^\t\n\x20-\x7E\u0080-\u{10FFFF}]/u.test(text)) {
    throw new Error('CLI session message contains terminal control characters and was refused.');
  }
  return text;
}

async function sendCodex(sessionId: string, message: string): Promise<CliSendResult> {
  await findTranscriptFile('codex', sessionId);
  const result = await runCommand('codex', ['queue', '--thread', sessionId, '--message', message], os.homedir(), CLI_TIMEOUT_MS);
  if (result.timedOut) throw new Error('Codex queue timed out; delivery is UNKNOWN. Do not retry automatically.');
  if (result.exitCode !== 0) {
    throw new Error(`Codex queue refused the message: ${flat(result.stderr || result.stdout || `exit ${result.exitCode}`, 1200)}`);
  }
  return {
    provider: 'codex',
    sessionId,
    delivered: true,
    detail: flat(result.stdout || 'Codex accepted the queued message.', 1200)
  };
}

async function transcriptContainsClaudeUserMessage(file: string, after: number, message: string): Promise<boolean> {
  const stat = await fs.stat(file);
  if (stat.size <= after) return false;
  const window = await readWindow(file, after, stat.size);
  for (const line of window.text.split('\n')) {
    for (const entry of normalizeCliTranscriptLine('claude', line)) {
      if (entry.kind === 'user' && entry.text === flat(message)) return true;
    }
  }
  return false;
}

async function sendClaude(sessionId: string, message: string): Promise<CliSendResult> {
  const transcript = await findTranscriptFile('claude', sessionId);
  const agents = await claudeAgents();
  const matches = agents.filter((row) => row.sessionId.toLowerCase() === sessionId.toLowerCase());
  if (matches.length !== 1 || matches[0]!.kind !== 'background') {
    throw new Error(
      'Claude V1 can send only to an exact managed background session returned by `claude agents --json --all`. ' +
        'This session remains readable, but arbitrary foreground Claude terminals are not silently keyboard-driven.'
    );
  }
  if (message.trimStart().startsWith('/')) {
    throw new Error('Claude V1 refuses leading slash commands; cli_sessions sends conversation messages, not Claude UI commands.');
  }
  const agent = matches[0]!;
  const pty = await loadPty();
  if (!pty) throw new Error('Claude attach needs a pseudo-terminal, but node-pty is unavailable in this build.');
  const cwd = agent.cwd && (await exists(agent.cwd)) ? agent.cwd : os.homedir();
  const claudeCommand = await resolveClaudePtyCommand();
  if (!claudeCommand) {
    throw new Error('Claude attach executable was not found in ~/.local/bin or PATH; no message was sent.');
  }
  const prepared = prepareCommand(claudeCommand, ['attach', agent.id], cwd);
  const before = (await fs.stat(transcript.file)).size;

  let handle: PtyProcess;
  try {
    handle = pty.spawn(prepared.file, prepared.args, {
      name: 'dumb',
      cols: 120,
      rows: 32,
      cwd,
      env: stringEnv(prepared.env)
    });
  } catch (error) {
    throw new Error(`Claude attach failed to start: ${error instanceof Error ? error.message : String(error)}`);
  }

  let outputTail = '';
  let lastOutputAt = 0;
  let signals: ClaudeAttachSignals = { brand: false, bracketedPaste: false, deviceHandshake: false };
  let exited = false;
  handle.onData((data) => {
    outputTail = `${outputTail}${data}`.slice(-32_768);
    signals = observeClaudeAttachSignals(signals, outputTail);
    lastOutputAt = Date.now();
  });
  handle.onExit(() => {
    exited = true;
  });
  const attachStartedAt = Date.now();
  const readyDeadline = attachStartedAt + CLAUDE_ATTACH_READY_MS;
  let ready = false;
  let maxQuietMs = 0;
  while (!ready && !exited && Date.now() < readyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const quietMs = lastOutputAt > 0 ? Date.now() - lastOutputAt : 0;
    maxQuietMs = Math.max(maxQuietMs, quietMs);
    ready =
      lastOutputAt > 0 &&
      signals.brand &&
      signals.bracketedPaste &&
      quietMs >= CLAUDE_ATTACH_QUIET_MS &&
      Date.now() - attachStartedAt >= CLAUDE_ATTACH_MIN_READY_MS;
  }
  if (exited || !ready) {
    if (!exited) {
      try {
        handle.write('\x1a');
      } catch {
        /* attach client already closed */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!exited) {
        try {
          handle.kill();
        } catch {
          /* attach client already exited */
        }
      }
    }
    throw new Error(
      'Claude attach did not reach a settled interactive session; no message was sent. ' +
        `readiness brand=${signals.brand} paste=${signals.bracketedPaste} device=${signals.deviceHandshake} ` +
        `max_quiet_ms=${maxQuietMs} tail_chars=${outputTail.length}.`
    );
  }

  // Bracketed paste keeps embedded newlines inside one composer submission. Control characters
  // were rejected above, so this cannot smuggle terminal escape sequences through the PTY.
  handle.write(`\x1b[200~${message.replace(/\r/g, '')}\x1b[201~`);
  handle.write('\r');

  let delivered = false;
  const proofDeadline = Date.now() + CLAUDE_DELIVERY_PROOF_MS;
  while (!delivered && Date.now() < proofDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    delivered = await transcriptContainsClaudeUserMessage(transcript.file, before, message).catch(() => false);
  }
  // Claude documents Ctrl+Z as "drop back to your shell; the session keeps running". Detach
  // regardless of proof outcome so one bridge call never takes terminal custody permanently.
  if (!exited) handle.write('\x1a');
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (!exited) {
    try {
      handle.kill();
    } catch {
      /* attach client already exited */
    }
  }
  if (!delivered) {
    throw new Error('Claude attach returned without transcript proof of the submitted message; delivery is UNKNOWN. Do not retry automatically.');
  }
  return {
    provider: 'claude',
    sessionId,
    delivered: true,
    detail: `Delivered through claude attach ${agent.id}; read this session with the returned transcript cursor to receive the reply.`
  };
}

export async function sendCliSessionMessage(provider: CliProvider, sessionId: string, rawMessage: string): Promise<CliSendResult> {
  const message = validateMessage(rawMessage);
  return provider === 'codex' ? sendCodex(sessionId, message) : sendClaude(sessionId, message);
}
