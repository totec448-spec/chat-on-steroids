/**
 * High-level host operations for issue #2, intentionally kept behind one MCP schema.
 *
 * `exec_command` already grants the Run commands permission authority to execute arbitrary
 * host commands, including outside approved filesystem roots. The power tool does not widen
 * that authority: it provides bounded, structured versions of common host operations while
 * reusing the same live `command` capability gate on every call.
 *
 * System-wide filesystem actions below are therefore deliberately NOT guarded by the normal
 * read/create/edit root sandbox. Their names say so and the tool description calls it out.
 * A user who does not grant Run commands never sees this schema at all.
 */

import os from 'node:os';
import nodePath from 'node:path';
import { z } from 'zod';
import { rawPromises as fs } from '../rawfs.js';
import {
  launchCommand,
  runCommand,
  runPowerShell,
  terminateProcessTree,
  type ExecResult
} from '../exec.js';
import { noteCount, noteDetail, noteExec } from './call-context.js';
import { fail, type SurfaceRegistrar, type ToolResult } from './kernel.js';

const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const MAX_FETCH_CHARS = 100_000;
const DEFAULT_FETCH_CHARS = 40_000;
const MAX_SYSTEM_FILE_BYTES = 4 * 1024 * 1024;
const MAX_WRITE_CHARS = 2 * 1024 * 1024;
const MAX_DIR_ENTRIES = 200;
const MAX_PROCESSES = 100;
const MAX_EXEC_SCRIPT_CHARS = 4_000;

const browser = z.enum(['default', 'chrome', 'msedge', 'firefox', 'brave']);

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('system_info') }).strict(),
  z
    .object({
      type: z.literal('open_url'),
      url: z.string().min(1).max(4096),
      browser: browser.optional().default('default')
    })
    .strict(),
  z
    .object({
      type: z.literal('web_fetch'),
      url: z.string().min(1).max(4096),
      max_chars: z.number().int().min(1_000).max(MAX_FETCH_CHARS).optional().default(DEFAULT_FETCH_CHARS),
      timeout_seconds: z.number().int().min(1).max(30).optional().default(15)
    })
    .strict(),
  z
    .object({
      type: z.literal('launch_app'),
      app: z.string().min(1).max(4096),
      args: z.array(z.string().max(4096)).max(64).optional().default([]),
      cwd: z.string().max(4096).optional()
    })
    .strict(),
  z
    .object({
      type: z.literal('process_list'),
      query: z.string().max(120).optional(),
      limit: z.number().int().min(1).max(MAX_PROCESSES).optional().default(25)
    })
    .strict(),
  z
    .object({
      type: z.literal('process_kill'),
      pid: z.number().int().min(2).optional(),
      name: z.string().min(1).max(160).optional(),
      all: z.boolean().optional().default(false),
      force: z.boolean().optional().default(true)
    })
    .strict(),
  z
    .object({
      type: z.literal('system_exec'),
      script: z.string().min(1).max(MAX_EXEC_SCRIPT_CHARS),
      shell: z.enum(['powershell', 'cmd', 'sh']).optional(),
      cwd: z.string().max(4096).optional(),
      timeout_seconds: z.number().int().min(1).max(300).optional().default(30)
    })
    .strict(),
  z
    .object({
      type: z.literal('fs_system_list'),
      path: z.string().min(1).max(4096),
      limit: z.number().int().min(1).max(MAX_DIR_ENTRIES).optional().default(100)
    })
    .strict(),
  z
    .object({
      type: z.literal('fs_system_read'),
      path: z.string().min(1).max(4096),
      max_chars: z.number().int().min(1).max(MAX_FETCH_CHARS).optional().default(MAX_FETCH_CHARS)
    })
    .strict(),
  z
    .object({
      type: z.literal('fs_system_write'),
      path: z.string().min(1).max(4096),
      content: z.string().max(MAX_WRITE_CHARS),
      mode: z.enum(['create', 'overwrite', 'append']).optional().default('overwrite'),
      create_parents: z.boolean().optional().default(false)
    })
    .strict()
]);

type PowerAction = z.output<typeof actionSchema>;

interface ProcessRow {
  pid: number;
  name: string;
  window_title: string;
  memory_bytes: number;
}

function result(structuredContent: Record<string, unknown>, summary?: string): ToolResult {
  return {
    content: [{ type: 'text', text: summary ?? JSON.stringify(structuredContent, null, 2) }],
    structuredContent
  };
}

function noteExecution(execution: ExecResult): void {
  noteExec({
    running: false,
    exitCode: execution.exitCode,
    timedOut: execution.timedOut,
    durationMs: execution.durationMs
  });
}

function requireHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('URL_INVALID: expected a valid absolute http:// or https:// URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('URL_PROTOCOL_REFUSED: only http:// and https:// URLs are accepted.');
  }
  if (url.username || url.password) {
    throw new Error('URL_CREDENTIALS_REFUSED: credentials embedded in URLs are not accepted.');
  }
  return url;
}

function requireAbsoluteSystemPath(value: string): string {
  if (!nodePath.isAbsolute(value)) {
    throw new Error('ABSOLUTE_PATH_REQUIRED: system-wide filesystem actions require an absolute host path.');
  }
  if (value.includes('\0')) throw new Error('PATH_INVALID: path contains a null byte.');
  return nodePath.normalize(value);
}

async function systemCwd(value?: string): Promise<string> {
  if (!value) return process.cwd();
  const cwd = requireAbsoluteSystemPath(value);
  const stat = await fs.stat(cwd);
  if (!stat.isDirectory()) throw new Error('CWD_NOT_DIRECTORY: cwd must name a directory.');
  return cwd;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(Number.parseInt(n, 16)));
}

/** Lightweight readable-text extraction: bounded and dependency-free, not a DOM emulator. */
export function htmlToCleanMarkdown(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*href=(['"])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q, href, label) =>
      `[${String(label).replace(/<[^>]+>/g, '').trim()}](${href})`
    )
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n')
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n')
    .replace(/<h[3-6]\b[^>]*>([\s\S]*?)<\/h[3-6]>/gi, '\n\n### $1\n\n')
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|tr|table|ul|ol)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readBoundedResponse(response: Response): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = MAX_FETCH_BYTES - bytes;
      if (room <= 0) {
        truncated = true;
        break;
      }
      const chunk = Buffer.from(value);
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        bytes += room;
        truncated = true;
        break;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

async function webFetch(action: Extract<PowerAction, { type: 'web_fetch' }>): Promise<ToolResult> {
  let current = requireHttpUrl(action.url);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), action.timeout_seconds * 1000);
  try {
    let response: Response | null = null;
    for (let redirect = 0; redirect <= 5; redirect++) {
      response = await fetch(current, {
        redirect: 'manual',
        signal: abort.signal,
        headers: {
          accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.1',
          'user-agent': 'Chat-On-Steroids/Power-Agent'
        }
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      if (!location) break;
      if (redirect === 5) return fail('TOO_MANY_REDIRECTS: web_fetch followed 5 redirects and stopped.');
      current = requireHttpUrl(new URL(location, current).toString());
    }
    if (!response) return fail('FETCH_FAILED: no HTTP response was received.');
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    const textual =
      contentType === '' ||
      contentType.includes('text/') ||
      contentType.includes('html') ||
      contentType.includes('json') ||
      contentType.includes('xml');
    if (!textual) return fail(`UNSUPPORTED_CONTENT_TYPE: ${contentType || 'unknown'}`);
    const body = await readBoundedResponse(response);
    const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body.text);
    const title = titleMatch ? decodeEntities(titleMatch[1]!.replace(/<[^>]+>/g, '').trim()).slice(0, 300) : '';
    let readable = contentType.includes('html') || /<html\b|<!doctype\s+html/i.test(body.text)
      ? htmlToCleanMarkdown(body.text)
      : body.text.trim();
    let truncated = body.truncated;
    if (readable.length > action.max_chars) {
      readable = readable.slice(0, action.max_chars);
      truncated = true;
    }
    noteDetail(`HTTP ${response.status} ${current.hostname}`);
    return result({
      action: 'web_fetch',
      url: action.url,
      final_url: current.toString(),
      status: response.status,
      content_type: contentType,
      title,
      markdown: readable,
      truncated
    });
  } catch (error) {
    if (abort.signal.aborted) return fail(`FETCH_TIMEOUT: web_fetch exceeded ${action.timeout_seconds}s.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function openUrl(action: Extract<PowerAction, { type: 'open_url' }>): Promise<ToolResult> {
  const url = requireHttpUrl(action.url).toString();
  const selected = action.browser;
  if (selected === 'default') {
    if (process.platform === 'win32') {
      const encoded = Buffer.from(url, 'utf8').toString('base64');
      const script =
        `$u=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); ` +
        `Start-Process -FilePath $u`;
      const execution = await runPowerShell(script, process.cwd(), 10_000);
      noteExecution(execution);
      if (execution.timedOut || execution.exitCode !== 0) {
        return fail(`OPEN_URL_FAILED: ${execution.stderr || `exit ${execution.exitCode ?? 'unknown'}`}`);
      }
    } else {
      const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
      await launchCommand(command, [url], process.cwd());
    }
    noteDetail(`opened ${new URL(url).hostname}`);
    return result({ action: 'open_url', url, browser: 'default', opened: true });
  }

  const maps = {
    win32: { chrome: 'chrome.exe', msedge: 'msedge.exe', firefox: 'firefox.exe', brave: 'brave.exe' },
    darwin: { chrome: 'Google Chrome', msedge: 'Microsoft Edge', firefox: 'Firefox', brave: 'Brave Browser' },
    linux: { chrome: 'google-chrome', msedge: 'microsoft-edge', firefox: 'firefox', brave: 'brave-browser' }
  } as const;
  const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  if (platform === 'darwin') {
    const launched = await launchCommand('open', ['-a', maps.darwin[selected], url], process.cwd());
    noteDetail(`opened ${selected} PID ${launched.pid}`);
    return result({ action: 'open_url', url, browser: selected, opened: true, pid: launched.pid });
  }
  const launched = await launchCommand(maps[platform][selected], [url], process.cwd());
  noteDetail(`opened ${selected} PID ${launched.pid}`);
  return result({ action: 'open_url', url, browser: selected, opened: true, pid: launched.pid });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseWindowsProcesses(stdout: string): ProcessRow[] {
  const decoded = JSON.parse(stdout.trim() || '[]') as unknown;
  const values = Array.isArray(decoded) ? decoded : decoded && typeof decoded === 'object' ? [decoded] : [];
  return values.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    const pid = Number(row.pid);
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!Number.isSafeInteger(pid) || pid <= 0 || !name) return [];
    return [{
      pid,
      name: name.slice(0, 160),
      window_title: typeof row.window_title === 'string' ? row.window_title.trim().slice(0, 300) : '',
      memory_bytes: Math.max(0, Math.trunc(Number(row.memory_bytes) || 0))
    }];
  });
}

async function processRows(): Promise<ProcessRow[]> {
  if (process.platform === 'win32') {
    const script =
      `$rows=@(Get-Process -ErrorAction SilentlyContinue | Sort-Object Id | Select-Object -First ${MAX_PROCESSES + 1} ` +
      `@{Name='pid';Expression={$_.Id}},@{Name='name';Expression={$_.ProcessName}},` +
      `@{Name='window_title';Expression={$_.MainWindowTitle}},@{Name='memory_bytes';Expression={$_.WorkingSet64}}); ` +
      `ConvertTo-Json -Compress -InputObject $rows`;
    const execution = await runPowerShell(script, process.cwd(), 10_000);
    noteExecution(execution);
    if (execution.timedOut) throw new Error('PROCESS_LIST_TIMEOUT: Windows did not return a process snapshot in time.');
    if (execution.exitCode !== 0) throw new Error(`PROCESS_LIST_FAILED: ${execution.stderr || execution.exitCode}`);
    return parseWindowsProcesses(execution.stdout);
  }

  const execution = await runCommand('ps', ['-eo', 'pid=,comm=,rss='], process.cwd(), 10_000);
  noteExecution(execution);
  if (execution.exitCode !== 0) throw new Error(`PROCESS_LIST_FAILED: ${execution.stderr || execution.exitCode}`);
  return execution.stdout
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\S+)\s+(\d+)\s*$/.exec(line);
      if (!match) return [];
      return [{
        pid: Number(match[1]),
        name: match[2]!.slice(0, 160),
        window_title: '',
        memory_bytes: Number(match[3]) * 1024
      } satisfies ProcessRow];
    })
    .slice(0, MAX_PROCESSES + 1);
}

async function processList(action: Extract<PowerAction, { type: 'process_list' }>): Promise<ToolResult> {
  const rows = await processRows();
  const needle = action.query?.trim().toLocaleLowerCase('en-US') ?? '';
  const matching = rows.filter((row) =>
    !needle || row.name.toLocaleLowerCase('en-US').includes(needle) || row.window_title.toLocaleLowerCase('en-US').includes(needle)
  );
  const processes = matching.slice(0, action.limit);
  noteCount(processes.length);
  noteDetail(`${processes.length} process${processes.length === 1 ? '' : 'es'}`);
  return result({
    action: 'process_list',
    processes,
    returned: processes.length,
    truncated: matching.length > processes.length || rows.length > MAX_PROCESSES
  });
}

async function waitForExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processExists(pid);
}

async function processKill(action: Extract<PowerAction, { type: 'process_kill' }>): Promise<ToolResult> {
  if ((action.pid === undefined) === (action.name === undefined)) {
    return fail('PROCESS_TARGET_REQUIRED: provide exactly one of pid or name.');
  }
  let targets: ProcessRow[];
  if (action.pid !== undefined) {
    targets = [{ pid: action.pid, name: '', window_title: '', memory_bytes: 0 }];
  } else {
    const wanted = action.name!.trim().replace(/\.exe$/i, '').toLocaleLowerCase('en-US');
    targets = (await processRows()).filter((row) => row.name.replace(/\.exe$/i, '').toLocaleLowerCase('en-US') === wanted);
    if (targets.length === 0) return fail(`PROCESS_NOT_FOUND: no process named ${action.name}.`);
    if (targets.length > 1 && !action.all) {
      return fail(`PROCESS_AMBIGUOUS: ${targets.length} processes match ${action.name}; specify a PID or set all=true.`);
    }
    if (!action.all) targets = targets.slice(0, 1);
  }

  const protectedPids = new Set([process.pid, process.ppid]);
  if (targets.some((target) => protectedPids.has(target.pid))) {
    return fail('PROTECTED_PROCESS: Chat On Steroids refuses to terminate itself or its direct parent.');
  }
  const terminated: number[] = [];
  for (const target of targets) {
    if (!processExists(target.pid)) continue;
    await terminateProcessTree(target.pid, action.force);
    if (!(await waitForExit(target.pid))) {
      return fail(`PROCESS_TERMINATION_UNCONFIRMED: PID ${target.pid} still appears to be running.`);
    }
    terminated.push(target.pid);
  }
  if (terminated.length === 0) return fail('PROCESS_NOT_FOUND_OR_DENIED: no matching live process could be terminated.');
  noteCount(terminated.length);
  noteDetail(`terminated ${terminated.join(', ')}`);
  return result({ action: 'process_kill', terminated_pids: terminated, force: action.force });
}

async function systemExec(action: Extract<PowerAction, { type: 'system_exec' }>): Promise<ToolResult> {
  const cwd = await systemCwd(action.cwd);
  const timeoutMs = action.timeout_seconds * 1000;
  let execution: ExecResult;
  if (process.platform === 'win32') {
    const shell = action.shell ?? 'powershell';
    if (shell === 'sh') return fail('SHELL_UNAVAILABLE: shell=sh is not supported on Windows by this action.');
    if (shell === 'powershell') {
      execution = await runPowerShell(action.script, cwd, timeoutMs);
    } else {
      const encoded = Buffer.from(action.script, 'utf8').toString('base64');
      const wrapper =
        `$c=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); ` +
        `& $env:ComSpec /d /s /c $c; if($null -ne $LASTEXITCODE){exit $LASTEXITCODE}`;
      execution = await runPowerShell(wrapper, cwd, timeoutMs);
    }
  } else {
    const shell = action.shell ?? 'sh';
    if (shell !== 'sh') return fail(`SHELL_UNAVAILABLE: shell=${shell} is Windows-only; use sh on this platform.`);
    execution = await runCommand('/bin/sh', ['-lc', action.script], cwd, timeoutMs);
  }
  noteExecution(execution);
  noteDetail(`exit ${execution.exitCode ?? 'unknown'}`);
  return result({
    action: 'system_exec',
    shell: action.shell ?? (process.platform === 'win32' ? 'powershell' : 'sh'),
    cwd,
    exit_code: execution.exitCode,
    stdout: execution.stdout,
    stderr: execution.stderr,
    truncated: execution.truncated,
    timed_out: execution.timedOut,
    duration_ms: execution.durationMs
  });
}

async function systemList(action: Extract<PowerAction, { type: 'fs_system_list' }>): Promise<ToolResult> {
  const target = requireAbsoluteSystemPath(action.path);
  const entries = await fs.readdir(target, { withFileTypes: true });
  const selected = entries.slice(0, action.limit);
  const rows: Array<Record<string, unknown>> = [];
  for (const entry of selected) {
    const full = nodePath.join(target, entry.name);
    let size: number | null = null;
    let modified_ms: number | null = null;
    try {
      const stat = await fs.stat(full);
      size = stat.size;
      modified_ms = stat.mtimeMs;
    } catch {
      // The item may disappear between readdir and stat. The directory entry is still useful.
    }
    rows.push({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
      size,
      modified_ms
    });
  }
  noteCount(rows.length);
  noteDetail(`system list ${target}`);
  return result({ action: 'fs_system_list', path: target, entries: rows, truncated: entries.length > selected.length });
}

async function systemRead(action: Extract<PowerAction, { type: 'fs_system_read' }>): Promise<ToolResult> {
  const target = requireAbsoluteSystemPath(action.path);
  const stat = await fs.stat(target);
  if (!stat.isFile()) return fail('NOT_A_FILE: fs_system_read requires a regular file.');
  if (stat.size > MAX_SYSTEM_FILE_BYTES) {
    return fail(`FILE_TOO_LARGE: system reads are capped at ${MAX_SYSTEM_FILE_BYTES} bytes.`);
  }
  const buffer = await fs.readFile(target);
  if (buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0)) {
    return fail('BINARY_FILE_REFUSED: fs_system_read returns text only.');
  }
  const decoded = buffer.toString('utf8');
  const text = decoded.slice(0, action.max_chars);
  noteDetail(`system read ${target}`);
  return result({
    action: 'fs_system_read',
    path: target,
    size_bytes: stat.size,
    text,
    truncated: decoded.length > text.length
  });
}

async function systemWrite(action: Extract<PowerAction, { type: 'fs_system_write' }>): Promise<ToolResult> {
  const target = requireAbsoluteSystemPath(action.path);
  if (action.create_parents) await fs.mkdir(nodePath.dirname(target), { recursive: true });
  const bytes = Buffer.byteLength(action.content, 'utf8');
  if (action.mode === 'append') await fs.appendFile(target, action.content, 'utf8');
  else await fs.writeFile(target, action.content, { encoding: 'utf8', flag: action.mode === 'create' ? 'wx' : 'w' });
  noteDetail(`system ${action.mode} ${target}`);
  return result({ action: 'fs_system_write', path: target, mode: action.mode, bytes_written: bytes });
}

async function launchApp(action: Extract<PowerAction, { type: 'launch_app' }>): Promise<ToolResult> {
  const cwd = await systemCwd(action.cwd);
  const launched = await launchCommand(action.app, action.args, cwd);
  noteDetail(`launched PID ${launched.pid}`);
  return result({ action: 'launch_app', app: action.app, pid: launched.pid, cwd });
}

async function dispatchPower(action: PowerAction): Promise<ToolResult> {
  switch (action.type) {
    case 'system_info': {
      const structured = {
        action: 'system_info',
        platform: process.platform,
        architecture: process.arch,
        release: os.release(),
        cpu_count: os.cpus().length,
        total_memory_bytes: os.totalmem(),
        free_memory_bytes: os.freemem(),
        uptime_seconds: Math.floor(os.uptime()),
        node_version: process.version
      };
      noteDetail(`${structured.platform} ${structured.architecture}`);
      return result(structured);
    }
    case 'open_url':
      return openUrl(action);
    case 'web_fetch':
      return webFetch(action);
    case 'launch_app':
      return launchApp(action);
    case 'process_list':
      return processList(action);
    case 'process_kill':
      return processKill(action);
    case 'system_exec':
      return systemExec(action);
    case 'fs_system_list':
      return systemList(action);
    case 'fs_system_read':
      return systemRead(action);
    case 'fs_system_write':
      return systemWrite(action);
  }
}

export function registerPowerTool(reg: SurfaceRegistrar): void {
  if (!reg.exposedCaps.command) return;
  reg.register(
    'power',
    {
      title: 'Power Agent host operations',
      description:
        'Structured host operations behind the existing Run commands permission. Actions: system_info; open_url; web_fetch (bounded HTTP(S) to readable text, no cookies/credentials); launch_app; process_list/process_kill; system_exec; and fs_system_list/fs_system_read/fs_system_write. ' +
        'The fs_system_* actions intentionally address absolute host paths OUTSIDE the approved-root sandbox because Run commands already has that host authority. Disable Run commands to remove this tool. Use exec_command instead for long-running or interactive terminal sessions.',
      inputSchema: z.object({ action: actionSchema }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async ({ action }) => reg.guarded('command', 'power', () => dispatchPower(action))
  );
}
