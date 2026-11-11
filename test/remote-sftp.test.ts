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

/**
 * A tiny in-memory SFTP v3 server with no extensions (so the client takes its legacy rename path), and
 * faults to inject: refuse every RENAME that matches, or fail the CLOSE of a handle (#2145).
 */
function legacyServer(files: Map<string, Buffer>, faults: { rename?: (from: string, to: string) => boolean; close?: () => boolean } = {}): { input: PassThrough; output: PassThrough } {
  const fromServer = new PassThrough(), toServer = new PassThrough();
  const handles = new Map<string, string>(), staged = new Map<string, Buffer>();
  let nextHandle = 1, pending = Buffer.alloc(0);
  const reply = (type: number, id: number, ...parts: Buffer[]) => {
    const idPart = Buffer.alloc(4); idPart.writeUInt32BE(id);
    const body = Buffer.concat([idPart, ...parts]);
    const head = Buffer.alloc(5); head.writeUInt32BE(body.length + 1); head[4] = type;
    fromServer.write(Buffer.concat([head, body]));
  };
  const u32 = (value: number) => { const part = Buffer.alloc(4); part.writeUInt32BE(value); return part; };
  const str = (value: string | Buffer) => { const data = Buffer.from(value); return Buffer.concat([u32(data.length), data]); };
  const status = (id: number, code: number, message = '') => reply(101, id, u32(code), str(message), str(''));
  toServer.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 5) {
      const length = pending.readUInt32BE(0);
      if (pending.length < 4 + length) return;
      const type = pending[4]!, body = pending.subarray(5, 4 + length); pending = pending.subarray(4 + length);
      if (type === 1) { fromServer.write(Buffer.concat([u32(5), Buffer.from([2]), u32(3)])); continue; }
      const id = body.readUInt32BE(0); let at = 4;
      const readStr = () => { const n = body.readUInt32BE(at); const v = body.subarray(at + 4, at + 4 + n); at += 4 + n; return v; };
      if (type === 17 || type === 7) { // STAT
        const name = readStr().toString();
        const file = files.get(name);
        if (!file) status(id, 2, 'No such file'); else reply(105, id, u32(0x1 | 0x4), Buffer.concat([u32(0), u32(file.length)]), u32(0o100644));
      } else if (type === 3) { // OPEN
        const name = readStr().toString(); const handle = `h${nextHandle++}`;
        handles.set(handle, name); staged.set(handle, Buffer.alloc(0)); files.set(name, Buffer.alloc(0)); reply(102, id, str(handle));
      } else if (type === 6) { // WRITE
        const handle = readStr().toString(); at += 8; const data = readStr();
        files.set(handles.get(handle)!, Buffer.concat([files.get(handles.get(handle)!) ?? Buffer.alloc(0), data])); status(id, 0);
      } else if (type === 9) status(id, 0); // SETSTAT
      else if (type === 4) { handles.delete(readStr().toString()); if (faults.close?.()) status(id, 4, 'Failure'); else status(id, 0); }
      else if (type === 18) { // RENAME (legacy: refuses an existing target)
        const from = readStr().toString(), to = readStr().toString();
        if (faults.rename?.(from, to)) status(id, 3, 'Permission denied');
        else if (!files.has(from)) status(id, 2, 'No such file');
        else if (files.has(to)) status(id, 4, 'Failure');
        else { files.set(to, files.get(from)!); files.delete(from); status(id, 0); }
      } else if (type === 13) { const name = readStr().toString(); if (files.delete(name)) status(id, 0); else status(id, 2, 'No such file'); }
      else status(id, 8, 'Unsupported');
    }
  });
  return { input: fromServer, output: toServer };
}

describe('SFTP writes keep the original when they fail (#2145)', () => {
  it('moves the original aside on a legacy server and restores it when the replacement is refused', async () => {
    const files = new Map([['/p/document.txt', Buffer.from('ORIGINAL')]]);
    // Plain SFTP v3 refuses to rename over an existing file; here every rename of the staged file is refused too.
    const { input, output } = legacyServer(files, { rename: (from) => from.includes('.cos-') && !from.endsWith('.bak') });
    const sftp = await SftpClient.start(input, output);
    await expect(sftp.writeFile('/p/document.txt', Buffer.from('REPLACEMENT'))).rejects.toMatchObject({ code: 'EACCES' });
    expect(files.get('/p/document.txt')?.toString()).toBe('ORIGINAL');
    expect([...files.keys()]).toEqual(['/p/document.txt']);
  });

  it('keeps both copies and says where they are when the original cannot be put back either', async () => {
    const files = new Map([['/p/document.txt', Buffer.from('ORIGINAL')]]);
    let renames = 0;
    // First rename (staged over the original) is refused by the server's own rule; the move-aside works; then every later rename fails.
    const { input, output } = legacyServer(files, { rename: () => ++renames > 2 });
    const sftp = await SftpClient.start(input, output);
    await expect(sftp.writeFile('/p/document.txt', Buffer.from('REPLACEMENT'))).rejects.toThrow(/kept as .*\.bak/);
    const contents = [...files.values()].map(value => value.toString()).sort();
    expect(contents).toEqual(['ORIGINAL', 'REPLACEMENT']);
  });

  // CodeRabbit on #2148: only a refusal that means "the target exists" starts the move-aside.
  it('does not move the original aside when the first rename fails for another reason', async () => {
    const files = new Map([['/p/document.txt', Buffer.from('ORIGINAL')]]);
    const renames: string[] = [];
    // The staged file vanishes before the rename: the server answers "no such file", not "target exists".
    const { input, output } = legacyServer(files, { rename: (from, to) => { renames.push(`${from}>${to}`); for (const name of [...files.keys()]) if (name.includes('.cos-')) files.delete(name); return false; } });
    const sftp = await SftpClient.start(input, output);
    await expect(sftp.writeFile('/p/document.txt', Buffer.from('REPLACEMENT'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(renames).toHaveLength(1);
    expect(files.get('/p/document.txt')?.toString()).toBe('ORIGINAL');
    expect([...files.keys()]).toEqual(['/p/document.txt']);
  });

  it('still replaces an existing file on a legacy server, leaving no backup or temporary file', async () => {
    const files = new Map([['/p/document.txt', Buffer.from('ORIGINAL')]]);
    const { input, output } = legacyServer(files);
    const sftp = await SftpClient.start(input, output);
    await sftp.writeFile('/p/document.txt', Buffer.from('REPLACEMENT'));
    expect(files.get('/p/document.txt')?.toString()).toBe('REPLACEMENT');
    expect([...files.keys()]).toEqual(['/p/document.txt']);
  });

  it('does not publish a write whose handle could not be closed, and removes the staged file', async () => {
    const files = new Map([['/p/document.txt', Buffer.from('ORIGINAL')]]);
    let closes = 0;
    const { input, output } = legacyServer(files, { close: () => ++closes === 1 });
    const sftp = await SftpClient.start(input, output);
    await expect(sftp.writeFile('/p/document.txt', Buffer.from('REPLACEMENT'))).rejects.toMatchObject({ code: 'EIO' });
    expect(files.get('/p/document.txt')?.toString()).toBe('ORIGINAL');
    expect([...files.keys()]).toEqual(['/p/document.txt']);
  });
});
