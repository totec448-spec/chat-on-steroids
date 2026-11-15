import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Script } from 'node:vm';
import { expect, it, vi } from 'vitest';

function loadHandler(name: string, context: Record<string, unknown>) {
  const filename = `scripts/verify-${name}.cjs`;
  const source = readFileSync(new URL(`../${filename}`, import.meta.url), 'utf8');
  const start = source.lastIndexOf('}).catch(');
  expect(start, `${filename}: final failure handler was not found`).toBeGreaterThan(0);
  const handlerSource = source.slice(start + '}).catch('.length).trim().replace(/\);$/, '');
  let script: Script;
  try { script = new Script(`(${handlerSource})`, { filename: `${filename}:failure-handler` }); }
  catch (cause) { throw new Error(`${filename}: could not parse the final failure handler; update this loader if its structure changed`, { cause }); }
  return script.runInNewContext(context) as (error: Error) => Promise<void>;
}

// Exercise each verifier's actual final error handler without starting Electron,
// touching user data, or needing a real screenshot failure to trigger cleanup.
it.each(['feedback-dialog', 'share-page'])('%s always retires its failure handler', async name => {
  for (const failure of ['directory', 'capture', 'write', 'no-window', 'no-server', 'close']) {
    const originalError = new Error('original UI assertion failed');
    const screenshotError = Object.assign(new Error(`fixture ${failure} unavailable`), { code: 'EACCES' });
    const log = vi.fn();
    const close = vi.fn(async () => { if (failure === 'close') throw screenshotError; });
    const exit = vi.fn();
    const capturePage = vi.fn(async () => {
      if (failure === 'capture') throw screenshotError;
      return { toPNG: () => new Uint8Array() };
    });
    const handler = loadHandler(name, {
      fs: {
        mkdirSync() { if (failure === 'directory') throw screenshotError; },
        writeFileSync() { if (failure === 'write') throw screenshotError; },
      },
      path, output: '/fixture/output',
      win: failure === 'no-window' ? undefined : { isDestroyed: () => false, webContents: { capturePage } },
      server: failure === 'no-server' ? undefined : { close },
      app: { exit }, console: { error: log },
      // Server closure is immediately resolved; leave no real deadline timer behind.
      setTimeout: () => 0,
    });
    await expect(handler(originalError), failure).resolves.toBeUndefined();
    expect(log.mock.calls[0]).toEqual([originalError]);
    expect(exit, failure).toHaveBeenCalledWith(1);
    expect(close, failure).toHaveBeenCalledTimes(failure === 'no-server' ? 0 : 1);
    if (['directory', 'capture', 'write'].includes(failure)) expect(log).toHaveBeenLastCalledWith(
      expect.stringContaining('failure screenshot unavailable'), screenshotError
    );
    if (failure === 'close') expect(log).toHaveBeenLastCalledWith(expect.stringContaining('server cleanup failed'), screenshotError);
    if (failure === 'no-window') expect(capturePage).not.toHaveBeenCalled();
  }
});

it.each(['feedback-dialog', 'share-page'])('%s bounds a server that never closes', async name => {
  let reachedClose!: () => void;
  const closing = new Promise<void>(resolve => { reachedClose = resolve; });
  const close = vi.fn(() => { reachedClose(); return new Promise<void>(() => {}); });
  const exit = vi.fn();
  const timer = vi.fn((_callback: () => void, _delay: number) => 0);
  const originalError = new Error('original UI assertion failed');
  const log = vi.fn();
  const handler = loadHandler(name, {
    fs: { mkdirSync() {}, writeFileSync() {} }, path, output: '/fixture/output',
    win: undefined, server: { close }, app: { exit }, console: { error: log },
    setTimeout: timer,
  });
  const pending = handler(originalError);
  await closing; // Readiness, not elapsed wall-clock time, starts the deadline probe.
  expect(exit).not.toHaveBeenCalled();
  expect(timer).toHaveBeenCalledWith(expect.any(Function), 2000);
  timer.mock.calls[0]![0]();
  await expect(pending).resolves.toBeUndefined();
  expect(log.mock.calls[0]).toEqual([originalError]);
  expect(close).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledWith(1);
});
