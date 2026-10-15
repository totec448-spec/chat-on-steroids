import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeRemoteSessions, setSftpOpenerForTests } from '../src/main/remote/ssh.js';
import { SftpClient } from '../src/main/remote/sftp.js';
import { fsForRoot, localFs, sftpFs, type ProjectFs } from '../src/main/remote/project-fs.js';
import type { Root } from '../src/shared/types.js';

/**
 * #1469 part 2: the tools reach a server folder through the same file system interface as a
 * local one. Every case runs against OpenSSH's own sftp-server, and where the local backend
 * defines the behaviour (metadata, opaque links, walk order and limits) both must agree.
 */
const SERVER = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server', '/usr/lib/sftp-server'].find(existsSync);
const real = describe.skipIf(!SERVER || process.platform === 'win32');

let directory: string, app: string, remote: ProjectFs, opens: number;
const servers: ChildProcessWithoutNullStreams[] = [];
const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: NodeJS.ErrnoException) => error.code);

beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cos-remote-fs-')));
  app = path.join(directory, 'app');
  await fs.mkdir(path.join(app, 'src', 'deep'), { recursive: true });
  await fs.mkdir(path.join(directory, 'outside'));
  await fs.writeFile(path.join(directory, 'outside', 'keep.txt'), 'keep');
  await fs.writeFile(path.join(app, 'src', 'a.ts'), 'export const a = 1;\n');
  await fs.writeFile(path.join(app, 'src', 'deep', 'b.ts'), 'b');
  await fs.writeFile(path.join(app, '.env'), 'x');
  await fs.symlink(path.join(directory, 'outside'), path.join(app, 'escape'));
  await fs.symlink(path.join(app, 'src', 'a.ts'), path.join(app, 'a-link.ts'));
  opens = 0;
  setSftpOpenerForTests(async () => {
    opens += 1;
    const server = spawn(SERVER!, [], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
    servers.push(server);
    return SftpClient.start(server.stdout, server.stdin);
  });
  remote = sftpFs({ host: 'me@devbox', path: app });
});
afterEach(async () => {
  closeRemoteSessions();
  setSftpOpenerForTests(null);
  for (const server of servers.splice(0)) server.kill();
  await fs.rm(directory, { recursive: true, force: true });
});

real('the file system of a server folder', () => {
  it('picks the backend by the root', () => {
    expect(fsForRoot({ name: 'local', path: app })).toBe(localFs);
    const root: Root = { name: 'app', path: `me@devbox:${app}`, remote: { host: 'me@devbox', path: app } };
    expect(fsForRoot(root)).not.toBe(localFs);
  });

  it('reports metadata and lists folders like the local backend, links kept opaque', async () => {
    for (const name of ['src', 'src/a.ts', 'a-link.ts', 'escape']) {
      const [local, server] = await Promise.all([localFs.getMetadata(path.join(app, name)), remote.getMetadata(path.join(app, name))]);
      expect({ ...server, createdAtMs: 0, modifiedAtMs: 0 }).toEqual({ ...local, createdAtMs: 0, modifiedAtMs: 0 });
      expect(Math.abs(server.modifiedAtMs - local.modifiedAtMs)).toBeLessThan(1000);
    }
    expect(await code(remote.getMetadata(path.join(app, 'missing')))).toBe('ENOENT');
    const sorted = (entries: Array<{ fileName: string }>) => [...entries].sort((a, b) => a.fileName.localeCompare(b.fileName));
    expect(sorted(await remote.readDirectory(app))).toEqual(sorted(await localFs.readDirectory(app)));
  });

  it('reads whole files, in a stream, within a limit, and refuses a folder', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    await fs.writeFile(path.join(app, 'big.bin'), big);
    expect((await remote.readFile(path.join(app, 'src', 'a.ts'))).toString()).toBe('export const a = 1;\n');
    expect((await remote.readFile(path.join(app, 'big.bin'))).equals(big)).toBe(true);
    const chunks: Buffer[] = [];
    for await (const chunk of remote.readFileStream(path.join(app, 'big.bin'))) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(big)).toBe(true);
    expect(chunks.length).toBeGreaterThan(1);
    await expect(remote.readFile(path.join(app, 'big.bin'), 1024)).rejects.toThrow(/too large to read: limit is 1024 bytes/);
    expect(await code(remote.readFile(path.join(app, 'src')))).toBe('EINVAL');
    expect(await code((async () => { for await (const _ of remote.readFileStream(path.join(app, 'src'))) break; })())).toBe('EINVAL');
  });

  it('writes whole files, keeps the mode, writes through a link and leaves no temporary file', async () => {
    const script = path.join(app, 'run.sh');
    await fs.writeFile(script, 'old'); await fs.chmod(script, 0o755);
    await remote.writeFile(script, 'new');
    expect(await fs.readFile(script, 'utf8')).toBe('new');
    expect((await fs.stat(script)).mode & 0o777).toBe(0o755);
    await remote.writeFile(path.join(app, 'src', 'new.ts'), Buffer.from('fresh'));
    expect(await fs.readFile(path.join(app, 'src', 'new.ts'), 'utf8')).toBe('fresh');
    await remote.writeFile(path.join(app, 'a-link.ts'), 'through');
    expect((await fs.lstat(path.join(app, 'a-link.ts'))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(app, 'src', 'a.ts'), 'utf8')).toBe('through');
    expect(await code(remote.writeFile(path.join(app, 'nope', 'x.ts'), 'x'))).toBe('ENOENT');
    expect((await fs.readdir(app)).filter(name => name.includes('.cos-'))).toEqual([]);
  });

  it('creates folders like mkdir and mkdir -p', async () => {
    await remote.createDirectory(path.join(app, 'x', 'y', 'z'), { recursive: true });
    await remote.createDirectory(path.join(app, 'x', 'y', 'z'), { recursive: true });
    expect((await fs.stat(path.join(app, 'x', 'y', 'z'))).isDirectory()).toBe(true);
    expect(await code(remote.createDirectory(path.join(app, 'src'), { recursive: false }))).toBe('EEXIST');
    expect(await code(remote.createDirectory(path.join(app, 'q', 'r'), { recursive: false }))).toBe('ENOENT');
    expect(await code(remote.createDirectory(path.join(app, 'src', 'a.ts', 'sub'), { recursive: true }))).toBe('ENOTDIR');
  });

  it('removes files, links and trees without following a link out of the folder', async () => {
    await remote.remove(path.join(app, 'escape'), { recursive: true, force: false });
    expect(await fs.readFile(path.join(directory, 'outside', 'keep.txt'), 'utf8')).toBe('keep');
    await fs.symlink(path.join(directory, 'outside'), path.join(app, 'src', 'deep', 'escape'));
    expect(await code(remote.remove(path.join(app, 'src'), { recursive: false, force: false }))).not.toBe('ok');
    await remote.remove(path.join(app, 'src'), { recursive: true, force: false });
    expect(existsSync(path.join(app, 'src'))).toBe(false);
    expect(await fs.readFile(path.join(directory, 'outside', 'keep.txt'), 'utf8')).toBe('keep');
    await remote.remove(path.join(app, 'missing'), { recursive: false, force: true });
    expect(await code(remote.remove(path.join(app, 'missing'), { recursive: false, force: false }))).toBe('ENOENT');
  });

  it('walks in the same order with the same limits as the local backend', async () => {
    const options = { maxDepth: 8, maxDirectories: 100, maxEntries: 100, followDirectorySymlinks: false, pruneHiddenDirectories: true };
    expect(await remote.walk(app, options)).toEqual(await localFs.walk(app, options));
    const limited = { ...options, maxEntries: 3 };
    const outcome = await remote.walk(app, limited);
    expect(outcome).toEqual(await localFs.walk(app, limited));
    expect(outcome.truncated).toBe(true);
  });

  it('opens a new session once when the connection dropped under a request', async () => {
    expect((await remote.getMetadata(app)).isDirectory).toBe(true);
    servers[0]!.kill('SIGKILL');
    expect((await remote.getMetadata(path.join(app, 'src'))).isDirectory).toBe(true);
    expect(opens).toBe(2);
  });
});
