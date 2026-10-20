import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  flushLogBeforeExit, flushLogFile, getLog, initLogFile, logInfo,
  onLog, resetLoggerForTests, snapshotLogOnCrash
} from '../src/main/logger.js';
import { runShutdownSequence } from '../src/main/shutdown.js';

const cleanup: string[] = [];
afterEach(async () => {
  await flushLogFile().catch(() => undefined);
  vi.restoreAllMocks();
  resetLoggerForTests();
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function logFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-logger-'));
  cleanup.push(dir);
  const file = path.join(dir, 'app.log');
  initLogFile(file);
  return file;
}

describe('bounded asynchronous diagnostic mirror', () => {
  it('returns immediately during slow IO, preserving file order and listeners', async () => {
    const file = await logFile();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const realAppend = fs.appendFile.bind(fs);
    const append = vi.spyOn(fs, 'appendFile').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return realAppend(...args);
    });
    const messages: string[] = [];
    onLog(entry => messages.push(entry.message));
    logInfo('first');
    await blocked;
    logInfo('second');
    logInfo('third');
    expect(messages).toEqual(['first', 'second', 'third']);
    expect(append).toHaveBeenCalledTimes(1);
    release();
    await flushLogFile();
    const text = await fs.readFile(file, 'utf8');
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'));
    expect(text.indexOf('second')).toBeLessThan(text.indexOf('third'));
    expect(append).toHaveBeenCalledTimes(2);
  });

  it('rotates serially and keeps both files bounded', async () => {
    const file = await logFile();
    await fs.writeFile(file, 'x'.repeat(4 * 1024 * 1024));
    initLogFile(file);
    logInfo('after rotation');
    await flushLogFile();
    expect((await fs.stat(`${file}.1`)).size).toBe(4 * 1024 * 1024);
    expect(await fs.readFile(file, 'utf8')).toContain('after rotation');
  });

  it('bounds queued bytes and individual ring entries and records overload', async () => {
    const file = await logFile();
    // All calls happen in one turn, before the writer can consume its first batch.
    for (let i = 0; i < 600; i++) logInfo(`${i}: ${'🙂 '.repeat(20_000)}`);
    expect(getLog()).toHaveLength(500);
    expect(getLog().every(entry => Buffer.byteLength(entry.message) <= 16 * 1024)).toBe(true);
    await flushLogFile();
    const text = await fs.readFile(file, 'utf8');
    expect(Buffer.byteLength(text)).toBeLessThan(257 * 1024);
    expect(text).toContain('log line(s) omitted');
    expect(text).toContain('[log text truncated]');
  });

  it('redacts the normal and synchronous fatal snapshots without touching the writer', async () => {
    const file = await logFile();
    logInfo('credential sk-secret123456789');
    snapshotLogOnCrash('uncaught: sk-secret123456789');
    await flushLogFile();
    for (const target of [file, `${file}.crash`]) {
      const text = await fs.readFile(target, 'utf8');
      expect(text).not.toContain('secret123456789');
      expect(text).toContain('sk-***');
    }
  });

  it('isolates file errors, saves forensic context, and keeps writing once the disk recovers (#1682)', async () => {
    const file = await logFile();
    vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('disk failure'));
    expect(() => logInfo('before failure')).not.toThrow();
    await vi.waitFor(async () => expect(await fs.readFile(`${file}.crash`, 'utf8')).toContain('disk failure'));
    expect(await fs.readFile(`${file}.crash`, 'utf8')).toContain('before failure');
    expect(() => logInfo('UI still works')).not.toThrow();
    // Nothing reached the file, so the batch is written once the next attempt succeeds, in order.
    await flushLogFile();
    const text = await fs.readFile(file, 'utf8');
    expect(text.indexOf('before failure')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('UI still works')).toBeGreaterThan(text.indexOf('before failure'));
    expect(text.split('before failure').length).toBe(2);
  });

  it('retries a failed write by itself after a short delay, without a flush (#1682)', async () => {
    const file = await logFile();
    vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('busy'));
    logInfo('written by the retry');
    await vi.waitFor(async () => expect(await fs.readFile(file, 'utf8').catch(() => '')).toContain('written by the retry'), { timeout: 3000, interval: 50 });
  });

  it('keeps every line when rotation cannot rename the full log, and rotates once it can (#1682)', async () => {
    const file = await logFile();
    await fs.writeFile(file, 'x'.repeat(4 * 1024 * 1024));
    // A real rename failure on every platform: a directory sits where the old log would go.
    await fs.mkdir(`${file}.1`);
    initLogFile(file);
    logInfo('while the old log is in the way');
    await flushLogFile();
    // The file grows past its limit for now instead of losing the line or going silent, and says why once.
    expect(await fs.readFile(file, 'utf8')).toContain('while the old log is in the way');
    expect((await fs.readFile(file, 'utf8')).split('log rotation failed').length).toBe(2);
    logInfo('still writing');
    await flushLogFile();
    expect(await fs.readFile(file, 'utf8')).toContain('still writing');
    expect((await fs.readFile(file, 'utf8')).split('log rotation failed').length).toBe(2);
    await fs.rmdir(`${file}.1`);
    logInfo('rotated at last');
    await flushLogFile();
    expect(await fs.readFile(`${file}.1`, 'utf8')).toContain('still writing');
    expect(await fs.readFile(file, 'utf8')).toContain('rotated at last');
  });

  it('holds lines in order while a log far past its limit cannot rotate, then writes them once (#1682)', async () => {
    const file = await logFile();
    await fs.writeFile(file, 'x'.repeat(8 * 1024 * 1024));
    await fs.mkdir(`${file}.1`);
    initLogFile(file);
    logInfo('first held'); logInfo('second held');
    await expect(flushLogFile()).rejects.toThrow();
    expect((await fs.stat(file)).size).toBe(8 * 1024 * 1024);
    await fs.rmdir(`${file}.1`);
    logInfo('third');
    await flushLogFile();
    const text = await fs.readFile(file, 'utf8');
    expect(text.indexOf('first held')).toBeLessThan(text.indexOf('second held'));
    expect(text.indexOf('second held')).toBeLessThan(text.indexOf('third'));
    expect(text.split('first held').length).toBe(2);
  });

  it('writes a line an append cut off again in full, after a note, and repeats no complete line (#1682)', async () => {
    const file = await logFile();
    const realAppend = fs.appendFile.bind(fs);
    logInfo('reached the file before the cut');
    await flushLogFile();
    vi.spyOn(fs, 'appendFile').mockImplementationOnce(async (target: any, data: any) => {
      const text = String(data);
      // The first line of the batch lands whole, the second only in part.
      await realAppend(target, text.slice(0, text.indexOf('\n') + 1 + 20));
      throw new Error('short write');
    });
    logInfo('first in the batch'); logInfo('cut off part-way'); logInfo('never started');
    await vi.waitFor(async () => expect(await fs.readFile(`${file}.crash`, 'utf8').catch(() => '')).toContain('short write'));
    await flushLogFile();
    const text = await fs.readFile(file, 'utf8');
    for (const line of ['reached the file before the cut', 'first in the batch', 'cut off part-way', 'never started']) {
      expect(text.split(line).length, line).toBe(2);
    }
    expect(text).toContain('failed part-way: the cut-off line above follows again in full');
    expect(text.indexOf('first in the batch')).toBeLessThan(text.indexOf('failed part-way'));
    expect(text.indexOf('failed part-way')).toBeLessThan(text.indexOf('cut off part-way'));
    expect(text.indexOf('cut off part-way')).toBeLessThan(text.indexOf('never started'));
    // Each line starts on its own line, the note included.
    expect(text.split('\n').filter(l => l.includes('warn') && l.includes('failed part-way'))[0]).toMatch(/^\d{4}-/);
  });

  it('includes the final shutdown line before completing the exit barrier', async () => {
    const file = await logFile();
    let finalFlush: Promise<void> | undefined;
    await runShutdownSequence([], {
      info: logInfo, warn: logInfo, error: logInfo,
      exit: () => { finalFlush = flushLogBeforeExit(); }
    });
    await finalFlush;
    expect(await fs.readFile(file, 'utf8')).toContain('shutdown sequence complete');
  });

  it('bounds exit waiting and snapshots recent lines when the asynchronous writer is stuck', async () => {
    const file = await logFile();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const realAppend = fs.appendFile.bind(fs);
    vi.spyOn(fs, 'appendFile').mockImplementationOnce(async (...args) => {
      await gate;
      return realAppend(...args);
    });
    logInfo('last forensic line');
    try {
      await flushLogBeforeExit(10);
      const crash = await fs.readFile(`${file}.crash`, 'utf8');
      expect(crash).toContain('last forensic line');
      expect(crash).toContain('deadline exceeded');
      expect(Buffer.byteLength(crash)).toBeLessThanOrEqual(256 * 1024);
    } finally { release(); }
    await flushLogFile();
  });
});
