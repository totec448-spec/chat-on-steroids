import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import http from 'node:http';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import type { ToolContext } from '../src/main/mcp/tools.js';
import { initSessionStore, resetSessionStoreForTests, unsetSessionRootForTests } from '../src/main/session/store.js';
import { closeRemoteSessions, remoteCommand, setSftpOpenerForTests, setSshProgramForTests } from '../src/main/remote/ssh.js';
import { SftpClient } from '../src/main/remote/sftp.js';
import { resetWorkspaces } from '../src/main/workspace.js';
import { unifiedExecManager } from '../src/main/codex/manager.js';
import { DEFAULT_CAPABILITIES, type Root } from '../src/shared/types.js';

/**
 * #1469 part 2: a command in a server folder runs there through the person's own ssh, one
 * connection per command. A stand-in `ssh` records its arguments and runs the remote part with
 * this computer's shell, which is exactly what the server's sshd would hand to the login shell.
 */
const SERVER = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server', '/usr/lib/sftp-server'].find(existsSync);
const real = describe.skipIf(!SERVER || process.platform === 'win32');

let directory: string, app: string, argvLog: string, endpoint: McpEndpoint, ctx: ToolContext;
const servers: ChildProcessWithoutNullStreams[] = [];
let nextId = 1;

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
  const url = new URL(endpoint.urls.core);
  const raw = await new Promise<string>((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body) }
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    request.on('error', reject);
    request.end(body);
  });
  const text = raw.trim();
  const json = JSON.parse(text.startsWith('{') ? text : [...text.matchAll(/^data:\s*(.*)$/gm)].at(-1)![1]!);
  const content = (json.result?.content ?? []) as Array<{ text?: string }>;
  return { text: content.map(item => item.text ?? '').join('\n'), isError: json.result?.isError === true || json.error !== undefined };
}

/** Every ssh invocation so far, as its argument list. */
async function sshCalls(): Promise<string[][]> {
  const text = await fs.readFile(argvLog, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);
}

beforeAll(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cos-remote-exec-')));
  initSessionStore(path.join(directory, 'sessions'));
  argvLog = path.join(directory, 'ssh-argv.jsonl');
  const fake = path.join(directory, 'ssh');
  // Records argv, then runs what follows the host the way sshd would: one string, one shell.
  await fs.writeFile(fake, [
    '#!/usr/bin/env node',
    "const { appendFileSync } = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    `appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    "const args = process.argv.slice(2); const at = args.indexOf('--');",
    "const remote = args.slice(at + 2).join(' ');",
    "const result = spawnSync('/bin/sh', ['-c', remote], { stdio: 'inherit' });",
    'process.exit(result.status ?? 255);'
  ].join('\n'));
  await fs.chmod(fake, 0o755);
  setSshProgramForTests(fake);
});
afterAll(async () => {
  setSshProgramForTests(null);
  await unifiedExecManager.terminateAllProcesses();
  // The recorder may still be writing the last call's session; stop it before removing its folder.
  resetSessionStoreForTests();
  unsetSessionRootForTests();
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

beforeEach(async () => {
  app = path.join(directory, `my app ü ${nextId}`);
  await fs.mkdir(app, { recursive: true });
  await fs.writeFile(path.join(app, 'a.txt'), 'one\n');
  await fs.rm(argvLog, { force: true });
  setSftpOpenerForTests(async () => {
    const server = spawn(SERVER!, [], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
    servers.push(server);
    return SftpClient.start(server.stdout, server.stdin);
  });
  resetWorkspaces();
  ctx = {
    roots: [{ name: 'app', path: `me@devbox:${app}`, remote: { host: 'me@devbox', port: 2222, path: app } }] as Root[],
    caps: { ...DEFAULT_CAPABILITIES, create: true, edit: true, command: true },
    readOnly: false,
    sessionTools: false,
    agentTools: false
  };
  endpoint = await startMcpServer(() => ctx);
});
afterEach(async () => {
  await endpoint.stop();
  closeRemoteSessions();
  setSftpOpenerForTests(null);
  for (const server of servers.splice(0)) server.kill();
});

real('commands in a folder on a server', () => {
  it('runs in the folder through ssh, one connection per command, and passes the exit code through', async () => {
    const reply = await call('exec_command', { cmd: 'pwd; cat a.txt; exit 3', workdir: '/app' });
    expect(reply.text).toContain(app);
    expect(reply.text).toContain('one');
    expect(reply.text).toContain('Process exited with code 3');
    const [argv] = await sshCalls();
    expect(argv).toEqual([
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-p', '2222', '-T', '--', 'me@devbox', remoteCommand(app, 'pwd; cat a.txt; exit 3')
    ]);
    await call('exec_command', { cmd: 'true', workdir: '/app' });
    const calls = await sshCalls();
    expect(calls).toHaveLength(2);
    for (const each of calls) expect(each.join(' ')).not.toMatch(/ControlMaster|ControlPath/);
  });

  // A chat outside a project learns where it works from absolute paths, here as on this
  // computer: the next command without a workdir runs in that project folder on the server, not
  // in the first approved folder (which here is on this computer).
  it('remembers the server folder a chat worked in for the next command', async () => {
    const local = path.join(directory, `local ${nextId}`);
    await fs.mkdir(local, { recursive: true });
    ctx = { ...ctx, roots: [{ name: 'local', path: local }, ...ctx.roots] };
    await fs.mkdir(path.join(app, 'svc', 'src'), { recursive: true });
    await fs.writeFile(path.join(app, 'svc', 'package.json'), '{}');
    await fs.writeFile(path.join(app, 'svc', 'src', 'main.ts'), 'x');
    expect((await call('read', { paths: ['/app/svc/src/main.ts'] })).isError).toBe(false);
    const reply = await call('exec_command', { cmd: 'pwd' });
    expect(reply.text).toContain(path.join(app, 'svc'));
    expect(reply.text).not.toContain(local);
  });

  it('runs a tty command that write_stdin can answer', async () => {
    const started = await call('exec_command', { cmd: 'read line; echo "got:$line"', workdir: '/app', tty: true, yield_time_ms: 500 });
    const sessionId = started.text.match(/Process running with session ID (\d+)/)?.[1];
    expect(sessionId, started.text).toBeDefined();
    expect((await sshCalls())[0]).toContain('-tt');
    const answered = await call('write_stdin', { session_id: Number(sessionId), chars: 'abc\r', yield_time_ms: 5_000 });
    expect(answered.text).toContain('got:abc');
  });

  it('reports a connection that dies mid-command like any ended process', async () => {
    const reply = await call('exec_command', { cmd: 'echo before; kill -9 $$', workdir: '/app' });
    expect(reply.text).toContain('before');
    expect(reply.text).toMatch(/Process exited with code (137|255)/);
  });

  it('applies an apply_patch command in the server folder instead of starting ssh', async () => {
    const reply = await call('exec_command', {
      cmd: "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+two\n*** End Patch\nEOF",
      workdir: '/app'
    });
    expect(reply.isError, reply.text).toBe(false);
    expect(await fs.readFile(path.join(app, 'a.txt'), 'utf8')).toBe('two\n');
    expect(await sshCalls()).toEqual([]);
  });
});
