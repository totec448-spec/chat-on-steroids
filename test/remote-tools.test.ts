import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import http from 'node:http';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import type { ToolContext } from '../src/main/mcp/tools.js';
import { initSessionStore, resetSessionStoreForTests, unsetSessionRootForTests } from '../src/main/session/store.js';
import { closeRemoteSessions, setSftpOpenerForTests } from '../src/main/remote/ssh.js';
import { SftpClient } from '../src/main/remote/sftp.js';
import { resetWorkspaces } from '../src/main/workspace.js';
import { unifiedExecManager } from '../src/main/codex/manager.js';
import { DEFAULT_CAPABILITIES, type Root } from '../src/shared/types.js';

/**
 * #1469 part 2: read, view_image and apply_patch work in a folder on a server exactly as in a
 * local one, through the real MCP endpoint. OpenSSH's sftp-server stands in for the server, so
 * every byte goes over SFTP; the folder it serves happens to sit on this disk, which is how the
 * test checks the result.
 */
const SERVER = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server', '/usr/lib/sftp-server'].find(existsSync);
const real = describe.skipIf(!SERVER || process.platform === 'win32');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

let directory: string, app: string, local: string, endpoint: McpEndpoint, ctx: ToolContext;
const servers: ChildProcessWithoutNullStreams[] = [];
let nextId = 1;

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; content: Array<Record<string, unknown>> }> {
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
  const content = (json.result?.content ?? []) as Array<Record<string, unknown>>;
  return { text: content.map(item => String(item.text ?? '')).join('\n'), isError: json.result?.isError === true || json.error !== undefined, content };
}

const patch = (...lines: string[]) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');

beforeAll(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cos-remote-tools-')));
  initSessionStore(path.join(directory, 'sessions'));
});
afterAll(async () => {
  await unifiedExecManager.terminateAllProcesses();
  // The recorder may still be writing the last call's session; stop it before removing its folder.
  resetSessionStoreForTests();
  unsetSessionRootForTests();
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

beforeEach(async () => {
  app = path.join(directory, `app-${nextId}`);
  local = path.join(directory, `local-${nextId}`);
  await fs.mkdir(path.join(app, 'src'), { recursive: true });
  await fs.mkdir(local);
  await fs.writeFile(path.join(app, 'notes.txt'), Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n') + '\n');
  await fs.writeFile(path.join(app, 'src', 'a.ts'), 'export const a = 1;\n');
  await fs.writeFile(path.join(app, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0, 3]));
  await fs.writeFile(path.join(app, 'pixel.png'), PNG);
  setSftpOpenerForTests(async () => {
    const server = spawn(SERVER!, [], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
    servers.push(server);
    return SftpClient.start(server.stdout, server.stdin);
  });
  resetWorkspaces();
  ctx = {
    roots: [
      { name: 'app', path: `me@devbox:${app}`, remote: { host: 'me@devbox', path: app } },
      { name: 'local', path: local }
    ] as Root[],
    caps: { ...DEFAULT_CAPABILITIES, create: true, edit: true, move: true, deleteFile: true },
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

real('tools in a folder on a server', () => {
  it('reads a line range, a folder, a glob, and says a binary file is binary', async () => {
    const range = await call('read', { paths: ['/app/notes.txt'], start_line: 3, end_line: 5 });
    expect(range.isError, range.text).toBe(false);
    expect(range.text).toContain('line 3');
    expect(range.text).toContain('line 5');
    expect(range.text).not.toContain('line 6\n');
    const folder = await call('read', { paths: ['/app/src'] });
    expect(folder.text).toContain('a.ts');
    const glob = await call('read', { paths: ['/app/**/*.ts'] });
    expect(glob.text).toContain('export const a = 1;');
    const binary = await call('read', { paths: ['/app/blob.bin'] });
    expect(binary.text).toMatch(/Binary file, so its bytes are not returned/);
  });

  it('views an image from the server', async () => {
    const reply = await call('view_image', { path: '/app/pixel.png' });
    expect(reply.isError, reply.text).toBe(false);
    const image = reply.content.find(item => item.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    expect(Buffer.from(String(image?.data), 'base64').equals(PNG)).toBe(true);
  });

  it('adds, updates, moves and deletes files on the server with one patch', async () => {
    await fs.writeFile(path.join(app, 'gone.txt'), 'old\n');
    const reply = await call('apply_patch', {
      patch: patch(
        '*** Add File: /app/src/new/b.ts', '+export const b = 2;',
        '*** Update File: /app/src/a.ts', '@@', '-export const a = 1;', '+export const a = 10;',
        '*** Update File: /app/notes.txt', '*** Move to: /app/docs/notes.md', '@@', ' line 1',
        '*** Delete File: /app/gone.txt'
      )
    });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.text).toContain('Success. Updated the following files:');
    expect(await fs.readFile(path.join(app, 'src', 'new', 'b.ts'), 'utf8')).toBe('export const b = 2;\n');
    expect(await fs.readFile(path.join(app, 'src', 'a.ts'), 'utf8')).toBe('export const a = 10;\n');
    expect(await fs.readFile(path.join(app, 'docs', 'notes.md'), 'utf8')).toContain('line 30');
    expect(existsSync(path.join(app, 'notes.txt'))).toBe(false);
    expect(existsSync(path.join(app, 'gone.txt'))).toBe(false);
  });

  it('refuses a patch whose later hunk does not apply, before writing anything', async () => {
    const reply = await call('apply_patch', {
      patch: patch(
        '*** Add File: /app/first.ts', '+first',
        '*** Update File: /app/src/a.ts', '@@', '-not in the file', '+x'
      )
    });
    expect(reply.isError).toBe(true);
    expect(existsSync(path.join(app, 'first.ts'))).toBe(false);
    expect(await fs.readFile(path.join(app, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  // Verification cannot see that a parent is a file; the write finds out, and the earlier hunk's
  // file is taken back over the same SFTP session.
  it('rolls back the files a failed patch already wrote on the server', async () => {
    const reply = await call('apply_patch', {
      patch: patch(
        '*** Update File: /app/src/a.ts', '@@', '-export const a = 1;', '+export const a = 2;',
        '*** Add File: /app/notes.txt/inside.ts', '+x'
      )
    });
    expect(reply.isError, reply.text).toBe(true);
    expect(reply.text).toContain('All file changes from this failed patch were rolled back.');
    expect(await fs.readFile(path.join(app, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  it('refuses one patch across a server folder and a folder on this computer', async () => {
    const reply = await call('apply_patch', {
      patch: patch('*** Add File: /app/one.ts', '+1', '*** Add File: /local/two.ts', '+2')
    });
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/one server folder/);
    expect(existsSync(path.join(app, 'one.ts'))).toBe(false);
    expect(existsSync(path.join(local, 'two.ts'))).toBe(false);
  });

  it('finds files by name in every folder, the server folder included', async () => {
    await fs.writeFile(path.join(local, 'a-local.ts'), 'x');
    const reply = await call('find', { query: 'a', mode: 'name', include: '*.ts' });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.text).toContain('/app/src/a.ts');
    expect(reply.text).toContain('/local/a-local.ts');
  });

  it('searches contents on the server, skipping excluded folders, with plain text and a regex', async () => {
    await fs.mkdir(path.join(app, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(app, 'node_modules', 'pkg', 'index.js'), 'export const a = 1;\n');
    const plain = await call('find', { query: 'const a', mode: 'content', path: '/app' });
    expect(plain.isError, plain.text).toBe(false);
    expect(plain.text).toContain('/app/src/a.ts:1: export const a = 1;');
    expect(plain.text).not.toContain('node_modules');
    const pattern = await call('find', { query: 'line [12]0$', mode: 'content', path: '/app', regex: true });
    expect(pattern.text).toContain('/app/notes.txt:10: line 10');
    expect(pattern.text).toContain('/app/notes.txt:20: line 20');
    expect(pattern.text).not.toContain('line 30');
    const one = await call('find', { query: 'line 7', mode: 'content', path: '/app/notes.txt' });
    expect(one.text).toContain('/app/notes.txt:7: line 7');
    const limited = await call('find', { query: 'line', mode: 'content', path: '/app', max_results: 3 });
    expect(limited.text).toContain('3 matches');
    expect(limited.text).toContain('truncated: limit');
  });

  it('still searches the other folders when the server cannot be reached, and says which was not searched', async () => {
    await fs.writeFile(path.join(local, 'a-local.ts'), 'x');
    closeRemoteSessions();
    setSftpOpenerForTests(async () => { throw new Error('The server did not answer in time.'); });
    const reply = await call('find', { query: 'a', mode: 'name' });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.text).toContain('/local/a-local.ts');
    expect(reply.text).toMatch(/not_searched: \/app \(.*did not answer in time/);
  });
});
