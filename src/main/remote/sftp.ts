import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';

/**
 * A small SFTP version 3 client (draft-ietf-secsh-filexfer-02) for SSH projects (#1469).
 *
 * It speaks over any pair of streams: in the app, the stdio of `ssh -s <host> sftp`, so the
 * person's own OpenSSH, its config, agent and known hosts make the connection; in tests,
 * OpenSSH's `sftp-server` run directly. Version 3 is what every OpenSSH server offers. Requests
 * are pipelined and matched by id. Errors carry Node's codes (`ENOENT`, `EACCES`, …) so the
 * callers' existing handling of local filesystem errors applies unchanged.
 */

const enum Packet {
  Init = 1, Version = 2, Open = 3, Close = 4, Read = 5, Write = 6, Lstat = 7, Fstat = 8, Setstat = 9,
  Opendir = 11, Readdir = 12, Remove = 13, Mkdir = 14, Rmdir = 15, Realpath = 16, Stat = 17, Rename = 18,
  Readlink = 19, Extended = 200,
  Status = 101, Handle = 102, Data = 103, Name = 104, Attrs = 105, ExtendedReply = 201
}
const OPEN_READ = 0x1, OPEN_WRITE = 0x2, OPEN_CREAT = 0x8, OPEN_TRUNC = 0x10, OPEN_EXCL = 0x20;
const ATTR_SIZE = 0x1, ATTR_UIDGID = 0x2, ATTR_PERMISSIONS = 0x4, ATTR_ACMODTIME = 0x8, ATTR_EXTENDED = 0x80000000;
const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000;
/** Far above any reply this client asks for (64 KiB reads, ~100 names per READDIR). */
const MAX_PACKET = 4 * 1024 * 1024;
const CHUNK = 64 * 1024;
const IN_FLIGHT = 16;
/** A read with no limit still stops here: a model never needs 256 MiB of one file. */
const DEFAULT_MAX_READ = 256 * 1024 * 1024;

const STATUS_CODES: Record<number, string> = {
  1: 'EOF', 2: 'ENOENT', 3: 'EACCES', 4: 'EIO', 5: 'EPROTO', 6: 'ECONNRESET', 7: 'ECONNRESET', 8: 'ENOTSUP'
};

export class SftpError extends Error {
  constructor(readonly code: string, message: string, readonly path?: string) {
    super(path ? `${message}: ${path}` : message);
  }
}

export interface SftpStats {
  size: number;
  mode: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mtimeMs: number;
}
export interface SftpEntry extends SftpStats { name: string }

class Reader {
  private offset = 0;
  constructor(private readonly buffer: Buffer) {}
  u32(): number {
    if (this.offset + 4 > this.buffer.length) throw new SftpError('EPROTO', 'Short SFTP packet');
    const value = this.buffer.readUInt32BE(this.offset); this.offset += 4; return value;
  }
  u64(): number {
    const high = this.u32(), low = this.u32();
    return high * 2 ** 32 + low;
  }
  bytes(): Buffer {
    const length = this.u32();
    if (this.offset + length > this.buffer.length) throw new SftpError('EPROTO', 'Short SFTP packet');
    const value = this.buffer.subarray(this.offset, this.offset + length); this.offset += length; return value;
  }
  string(): string { return this.bytes().toString('utf8'); }
  attrs(): SftpStats {
    const flags = this.u32();
    const size = flags & ATTR_SIZE ? this.u64() : 0;
    if (flags & ATTR_UIDGID) { this.u32(); this.u32(); }
    const mode = flags & ATTR_PERMISSIONS ? this.u32() : 0;
    let mtime = 0;
    if (flags & ATTR_ACMODTIME) { this.u32(); mtime = this.u32(); }
    if (flags & ATTR_EXTENDED) for (let count = this.u32(); count > 0; count--) { this.bytes(); this.bytes(); }
    const type = mode & S_IFMT;
    return { size, mode, isFile: type === S_IFREG, isDirectory: type === S_IFDIR, isSymbolicLink: type === S_IFLNK, mtimeMs: mtime * 1000 };
  }
}

class Writer {
  private readonly parts: Buffer[] = [];
  u32(value: number): this { const part = Buffer.alloc(4); part.writeUInt32BE(value >>> 0, 0); this.parts.push(part); return this; }
  u64(value: number): this { return this.u32(Math.floor(value / 2 ** 32)).u32(value % 2 ** 32); }
  bytes(value: Buffer): this { this.u32(value.length); this.parts.push(value); return this; }
  string(value: string): this { return this.bytes(Buffer.from(value, 'utf8')); }
  /** Attributes with only a permission mode, or none. */
  attrs(mode?: number): this { return mode === undefined ? this.u32(0) : this.u32(ATTR_PERMISSIONS).u32(mode); }
  packet(type: number): Buffer {
    const body = Buffer.concat(this.parts);
    const header = Buffer.alloc(5); header.writeUInt32BE(body.length + 1, 0); header[4] = type;
    return Buffer.concat([header, body]);
  }
}

interface Pending { resolve(reply: { type: number; reader: Reader }): void; reject(error: SftpError): void }

export class SftpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffered: Buffer = Buffer.alloc(0);
  private failure: SftpError | null = null;
  private versionWaiter: Pending | null = null;
  private extensions = new Set<string>();

  private constructor(input: Readable, private readonly output: Writable) {
    input.on('data', (chunk: Buffer) => this.receive(chunk));
    const ended = () => this.fail(new SftpError('ECONNRESET', 'The SSH connection to the project closed'));
    input.once('end', ended); input.once('close', ended);
    input.once('error', ended); output.once('error', ended); output.once('close', ended);
  }

  /** Opens a session: sends INIT and waits for the server's VERSION. */
  static async start(input: Readable, output: Writable, options: { handshakeMs?: number } = {}): Promise<SftpClient> {
    const client = new SftpClient(input, output);
    const version = new Promise<{ type: number; reader: Reader }>((resolve, reject) => { client.versionWaiter = { resolve, reject }; });
    const timer = setTimeout(() => client.fail(new SftpError('ETIMEDOUT', 'The SSH server did not start SFTP')), options.handshakeMs ?? 20_000);
    try {
      client.output.write(new Writer().u32(3).packet(Packet.Init));
      const { reader } = await version;
      if (reader.u32() < 3) throw new SftpError('EPROTO', 'The SSH server offers an SFTP version older than 3');
      try { for (;;) { const name = reader.string(); reader.bytes(); client.extensions.add(name); } } catch { /* end of the extension list */ }
      return client;
    } catch (error) {
      client.close();
      throw error;
    } finally { clearTimeout(timer); }
  }

  get closed(): boolean { return this.failure !== null; }

  close(): void {
    this.fail(new SftpError('ECONNRESET', 'The SFTP session was closed'));
  }

  private fail(error: SftpError): void {
    if (this.failure) return;
    this.failure = error;
    this.versionWaiter?.reject(error); this.versionWaiter = null;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    try { this.output.end(); } catch { /* already gone */ }
  }

  private receive(chunk: Buffer): void {
    if (this.failure) return;
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
    while (this.buffered.length >= 5) {
      const length = this.buffered.readUInt32BE(0);
      if (length < 1 || length > MAX_PACKET) { this.fail(new SftpError('EPROTO', 'The SSH server sent an invalid SFTP packet')); return; }
      if (this.buffered.length < 4 + length) return;
      const type = this.buffered[4]!;
      const body = this.buffered.subarray(5, 4 + length);
      this.buffered = this.buffered.subarray(4 + length);
      if (type === Packet.Version) {
        const waiter = this.versionWaiter; this.versionWaiter = null;
        waiter?.resolve({ type, reader: new Reader(body) });
        continue;
      }
      const reader = new Reader(body);
      let id: number;
      try { id = reader.u32(); } catch { this.fail(new SftpError('EPROTO', 'The SSH server sent an invalid SFTP packet')); return; }
      const waiter = this.pending.get(id);
      if (!waiter) continue;
      this.pending.delete(id);
      waiter.resolve({ type, reader });
    }
  }

  private request(type: number, build: (writer: Writer) => Writer, target?: string): Promise<{ type: number; reader: Reader }> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId; this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1;
    return new Promise<{ type: number; reader: Reader }>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.output.write(build(new Writer().u32(id)).packet(type));
    }).then(reply => {
      if (reply.type !== Packet.Status) return reply;
      const code = reply.reader.u32();
      const message = (() => { try { return reply.reader.string(); } catch { return ''; } })();
      if (code === 0) return reply;
      throw new SftpError(STATUS_CODES[code] ?? 'EIO', message || 'SFTP request failed', target);
    });
  }

  private async expect(type: number, reply: Promise<{ type: number; reader: Reader }>): Promise<Reader> {
    const answer = await reply;
    if (answer.type !== type) throw new SftpError('EPROTO', 'The SSH server sent an unexpected SFTP reply');
    return answer.reader;
  }

  private async ok(reply: Promise<{ type: number; reader: Reader }>): Promise<void> {
    const answer = await reply;
    if (answer.type !== Packet.Status) throw new SftpError('EPROTO', 'The SSH server sent an unexpected SFTP reply');
  }

  async realpath(target: string): Promise<string> {
    const reader = await this.expect(Packet.Name, this.request(Packet.Realpath, w => w.string(target), target));
    if (reader.u32() < 1) throw new SftpError('EPROTO', 'Empty SFTP name reply', target);
    return reader.string();
  }

  async stat(target: string): Promise<SftpStats> {
    return (await this.expect(Packet.Attrs, this.request(Packet.Stat, w => w.string(target), target))).attrs();
  }

  async lstat(target: string): Promise<SftpStats> {
    return (await this.expect(Packet.Attrs, this.request(Packet.Lstat, w => w.string(target), target))).attrs();
  }

  async readlink(target: string): Promise<string> {
    const reader = await this.expect(Packet.Name, this.request(Packet.Readlink, w => w.string(target), target));
    if (reader.u32() < 1) throw new SftpError('EPROTO', 'Empty SFTP name reply', target);
    return reader.string();
  }

  async readdir(target: string): Promise<SftpEntry[]> {
    const handle = (await this.expect(Packet.Handle, this.request(Packet.Opendir, w => w.string(target), target))).bytes();
    const entries: SftpEntry[] = [];
    try {
      for (;;) {
        let reader: Reader;
        try { reader = await this.expect(Packet.Name, this.request(Packet.Readdir, w => w.bytes(handle), target)); }
        catch (error) { if ((error as SftpError).code === 'EOF') break; throw error; }
        for (let count = reader.u32(); count > 0; count--) {
          const name = reader.string(); reader.string();
          const attrs = reader.attrs();
          if (name !== '.' && name !== '..') entries.push({ name, ...attrs });
        }
      }
    } finally { await this.closeHandle(handle); }
    return entries;
  }

  private async closeHandle(handle: Buffer): Promise<void> {
    await this.ok(this.request(Packet.Close, w => w.bytes(handle))).catch(() => undefined);
  }

  private async readChunk(handle: Buffer, offset: number, length: number, target: string): Promise<Buffer | null> {
    try { return (await this.expect(Packet.Data, this.request(Packet.Read, w => w.bytes(handle).u64(offset).u32(length), target))).bytes(); }
    catch (error) { if ((error as SftpError).code === 'EOF') return null; throw error; }
  }

  /** Opens a regular file for reading; a folder, device or pipe is refused like a local read refuses it. */
  private async openRead(target: string): Promise<{ handle: Buffer; size: number }> {
    const handle = (await this.expect(Packet.Handle, this.request(Packet.Open, w => w.string(target).u32(OPEN_READ).attrs(), target))).bytes();
    try {
      const stats = (await this.expect(Packet.Attrs, this.request(Packet.Fstat, w => w.bytes(handle), target))).attrs();
      if (!stats.isFile) throw new SftpError('EINVAL', `path \`${target}\` is not a file`);
      return { handle, size: stats.size };
    } catch (error) {
      await this.closeHandle(handle);
      throw error;
    }
  }

  /** The file's bytes, up to `maxBytes`; a file still growing is read until its end at that moment. */
  async readFile(target: string, options: { maxBytes?: number } = {}): Promise<Buffer> {
    const limit = Math.max(0, options.maxBytes ?? DEFAULT_MAX_READ);
    const { handle, size } = await this.openRead(target);
    try {
      const known = Math.min(size, limit);
      const parts: Buffer[] = [];
      // The size known up front is read in parallel chunks; a short chunk is completed after.
      for (let start = 0; start < known; start += CHUNK * IN_FLIGHT) {
        const batch: Array<Promise<Buffer | null>> = [];
        for (let offset = start; offset < Math.min(known, start + CHUNK * IN_FLIGHT); offset += CHUNK) {
          batch.push(this.readChunk(handle, offset, Math.min(CHUNK, known - offset), target));
        }
        let offset = start;
        for (const data of await Promise.all(batch)) {
          const wanted = Math.min(CHUNK, known - offset);
          let piece = data ?? Buffer.alloc(0);
          while (piece.length < wanted) {
            const more = await this.readChunk(handle, offset + piece.length, wanted - piece.length, target);
            if (!more?.length) break;
            piece = Buffer.concat([piece, more]);
          }
          parts.push(piece);
          offset += wanted;
          if (piece.length < wanted) return Buffer.concat(parts);
        }
      }
      // Anything written since the size was read, still within the limit.
      let total = known;
      while (total < limit) {
        const more = await this.readChunk(handle, total, Math.min(CHUNK, limit - total), target);
        if (!more?.length) break;
        parts.push(more); total += more.length;
      }
      return Buffer.concat(parts);
    } finally { await this.closeHandle(handle); }
  }

  /** The file's bytes in pieces of up to 1 MiB, each read as parallel chunks; stops at the end. */
  async *readStream(target: string): AsyncGenerator<Buffer, void, undefined> {
    const { handle } = await this.openRead(target);
    try {
      for (let start = 0; ; start += CHUNK * IN_FLIGHT) {
        const batch: Array<Promise<Buffer | null>> = [];
        for (let index = 0; index < IN_FLIGHT; index++) batch.push(this.readChunk(handle, start + index * CHUNK, CHUNK, target));
        const parts: Buffer[] = [];
        let ended = false;
        let offset = start;
        for (const data of await Promise.all(batch)) {
          let piece = data ?? Buffer.alloc(0);
          while (piece.length < CHUNK) {
            const more = await this.readChunk(handle, offset + piece.length, CHUNK - piece.length, target);
            if (!more?.length) break;
            piece = Buffer.concat([piece, more]);
          }
          parts.push(piece);
          offset += CHUNK;
          if (piece.length < CHUNK) { ended = true; break; }
        }
        const bytes = Buffer.concat(parts);
        if (bytes.length) yield bytes;
        if (ended) return;
      }
    } finally { await this.closeHandle(handle); }
  }

  /**
   * Replaces the file whole: the bytes go to a temporary file beside it (with the old file's mode,
   * or 0644 for a new one), which then takes its place, so a reader never sees half a write and
   * a failed write leaves the old file as it was.
   */
  async writeFile(target: string, data: Buffer, options: { mode?: number } = {}): Promise<void> {
    const existing = await this.stat(target).catch((error: SftpError) => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing?.isDirectory) throw new SftpError('EISDIR', 'Is a directory', target);
    const mode = options.mode ?? (existing ? existing.mode & 0o7777 : 0o644);
    const temporary = path.posix.join(path.posix.dirname(target), `.${path.posix.basename(target)}.cos-${randomBytes(6).toString('hex')}.tmp`);
    const handle = (await this.expect(Packet.Handle, this.request(Packet.Open,
      w => w.string(temporary).u32(OPEN_WRITE | OPEN_CREAT | OPEN_EXCL | OPEN_TRUNC).attrs(mode), temporary))).bytes();
    let written = false;
    try {
      const writes: Array<Promise<void>> = [];
      for (let offset = 0; offset < data.length; offset += CHUNK) {
        const piece = data.subarray(offset, offset + CHUNK);
        writes.push(this.ok(this.request(Packet.Write, w => w.bytes(handle).u64(offset).bytes(piece), temporary)));
        if (writes.length >= IN_FLIGHT) await Promise.all(writes.splice(0));
      }
      await Promise.all(writes);
      // The server's umask may have narrowed the mode given at creation.
      await this.ok(this.request(Packet.Setstat, w => w.string(temporary).attrs(mode), temporary)).catch(() => undefined);
      written = true;
    } finally {
      await this.closeHandle(handle);
      if (!written) await this.remove(temporary).catch(() => undefined);
    }
    try { await this.replace(temporary, target); }
    catch (error) { await this.remove(temporary).catch(() => undefined); throw error; }
  }

  /** Rename over an existing file: atomic with OpenSSH's posix-rename, else remove-then-rename. */
  private async replace(from: string, to: string): Promise<void> {
    if (this.extensions.has('posix-rename@openssh.com')) {
      await this.ok(this.request(Packet.Extended, w => w.string('posix-rename@openssh.com').string(from).string(to), to));
      return;
    }
    try { await this.rename(from, to); }
    catch {
      await this.remove(to).catch((error: SftpError) => { if (error.code !== 'ENOENT') throw error; });
      await this.rename(from, to);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    await this.ok(this.request(Packet.Rename, w => w.string(from).string(to), from));
  }
  async remove(target: string): Promise<void> {
    await this.ok(this.request(Packet.Remove, w => w.string(target), target));
  }
  async mkdir(target: string, mode = 0o755): Promise<void> {
    await this.ok(this.request(Packet.Mkdir, w => w.string(target).attrs(mode), target));
  }
  async rmdir(target: string): Promise<void> {
    await this.ok(this.request(Packet.Rmdir, w => w.string(target), target));
  }
}
