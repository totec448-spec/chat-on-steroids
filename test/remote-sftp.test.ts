import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SftpClient, SftpError } from '../src/main/remote/sftp.js';
import { makeTempDir, removeTempDir } from './helpers.js';

/**
 * Against OpenSSH's own sftp-server, run directly over stdio: the same program `ssh -s sftp`
 * reaches on a server, without needing an ssh daemon in the test.
 */
const SERVER = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server', '/usr/lib/sftp-server'].find(existsSync);
const real = describe.skipIf(!SERVER);

let dir: string;
let server: ChildProcessWithoutNullStreams | null = null;
let client: SftpClient | null = null;

async function connect(): Promise<SftpClient> {
  server = spawn(SERVER!, [], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  client = await SftpClient.start(server.stdout, server.stdin);
  return client;
}

beforeEach(async () => { dir = await fs.realpath(await makeTempDir('clf-sftp-')); });
afterEach(async () => {
  client?.close(); client = null;
  server?.kill(); server = null;
  await removeTempDir(dir);
});

real('SFTP against OpenSSH sftp-server', () => {
  it('reads, lists, stats and resolves paths', async () => {
    await fs.mkdir(path.join(dir, 'src'));
    await fs.writeFile(path.join(dir, 'src', 'a.txt'), 'hello\n');
    await fs.symlink('a.txt', path.join(dir, 'src', 'link'));
    const sftp = await connect();
    expect(await sftp.realpath(path.join(dir, 'src', '..', 'src'))).toBe(path.join(dir, 'src'));
    expect((await sftp.readFile(path.join(dir, 'src', 'a.txt'))).toString()).toBe('hello\n');
    const file = await sftp.stat(path.join(dir, 'src', 'a.txt'));
    expect(file).toMatchObject({ size: 6, isFile: true, isDirectory: false, isSymbolicLink: false });
    expect(file.mtimeMs).toBeGreaterThan(0);
    expect((await sftp.lstat(path.join(dir, 'src', 'link'))).isSymbolicLink).toBe(true);
    expect(await sftp.readlink(path.join(dir, 'src', 'link'))).toBe('a.txt');
    const names = (await sftp.readdir(path.join(dir, 'src'))).map(entry => [entry.name, entry.isDirectory, entry.isSymbolicLink]).sort();
    expect(names).toEqual([['a.txt', false, false], ['link', false, true]]);
  });

  it('reads a large file in pipelined chunks and stops at a byte limit', async () => {
    const big = Buffer.alloc(1_500_000, 7);
    big.write('end', big.length - 3);
    await fs.writeFile(path.join(dir, 'big.bin'), big);
    const sftp = await connect();
    expect((await sftp.readFile(path.join(dir, 'big.bin'))).equals(big)).toBe(true);
    const head = await sftp.readFile(path.join(dir, 'big.bin'), { maxBytes: 100_000 });
    expect(head.length).toBe(100_000);
  });

  it('writes atomically: the new content replaces the old one whole, and the mode is kept', async () => {
    await fs.writeFile(path.join(dir, 'run.sh'), 'old');
    await fs.chmod(path.join(dir, 'run.sh'), 0o755);
    const sftp = await connect();
    const content = Buffer.from('x'.repeat(300_000));
    await sftp.writeFile(path.join(dir, 'run.sh'), content);
    expect(await fs.readFile(path.join(dir, 'run.sh'), 'utf8')).toBe(content.toString());
    expect((await fs.stat(path.join(dir, 'run.sh'))).mode & 0o777).toBe(0o755);
    // No temporary file is left behind.
    expect(await fs.readdir(dir)).toEqual(['run.sh']);
    await sftp.writeFile(path.join(dir, 'new.txt'), Buffer.from('fresh'));
    expect(await fs.readFile(path.join(dir, 'new.txt'), 'utf8')).toBe('fresh');
  });

  it('creates, renames and removes, and reports errors with Node codes', async () => {
    const sftp = await connect();
    await sftp.mkdir(path.join(dir, 'made'));
    expect((await sftp.stat(path.join(dir, 'made'))).isDirectory).toBe(true);
    await sftp.writeFile(path.join(dir, 'made', 'f'), Buffer.from('1'));
    await sftp.rename(path.join(dir, 'made', 'f'), path.join(dir, 'made', 'g'));
    await sftp.remove(path.join(dir, 'made', 'g'));
    await sftp.rmdir(path.join(dir, 'made'));
    const missing = await sftp.stat(path.join(dir, 'nope')).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(SftpError);
    expect((missing as SftpError).code).toBe('ENOENT');
    await fs.writeFile(path.join(dir, 'locked'), 'x');
    await fs.chmod(path.join(dir, 'locked'), 0o000);
    if (process.getuid?.() !== 0) {
      expect(((await sftp.readFile(path.join(dir, 'locked')).catch((error: unknown) => error)) as SftpError).code).toBe('EACCES');
    }
  });

  it('runs many requests at once and answers each its own', async () => {
    for (let index = 0; index < 40; index++) await fs.writeFile(path.join(dir, `f${index}`), String(index));
    const sftp = await connect();
    const read = await Promise.all(Array.from({ length: 40 }, (_, index) => sftp.readFile(path.join(dir, `f${index}`))));
    expect(read.map(buffer => buffer.toString())).toEqual(Array.from({ length: 40 }, (_, index) => String(index)));
  });

  it('fails every pending and later request once the connection ends', async () => {
    const sftp = await connect();
    server!.kill();
    const error = await sftp.stat(dir).catch((failure: unknown) => failure) as SftpError;
    expect(error.code).toBe('ECONNRESET');
    expect(sftp.closed).toBe(true);
  });
});

describe('SFTP protocol guards', () => {
  it('refuses a server that does not answer the version handshake', async () => {
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    const started = SftpClient.start(fromServer, toServer, { handshakeMs: 50 });
    await expect(started).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  });

  it('refuses an oversized packet instead of buffering it', async () => {
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    const started = SftpClient.start(fromServer, toServer, { handshakeMs: 1000 });
    const header = Buffer.alloc(5); header.writeUInt32BE(64 * 1024 * 1024, 0); header[4] = 2;
    fromServer.write(header);
    await expect(started).rejects.toMatchObject({ code: 'EPROTO' });
  });
});
