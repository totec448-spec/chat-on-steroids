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

  it('isolates file errors and saves forensic context on the narrow failure path', async () => {
    const file = await logFile();
    vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('disk failure'));
    expect(() => logInfo('before failure')).not.toThrow();
    await expect(flushLogFile()).rejects.toThrow('disk failure');
    expect(() => logInfo('UI still works')).not.toThrow();
    await flushLogBeforeExit();
    const crash = await fs.readFile(`${file}.crash`, 'utf8');
    expect(crash).toContain('before failure');
    expect(crash).toContain('UI still works');
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
