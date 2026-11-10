import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

// Exercise each verifier's actual final error handler without starting Electron,
// touching user data, or needing a real screenshot failure to trigger cleanup.
it.each(['feedback-dialog', 'share-page'])('%s always retires its failure handler', async name => {
  const source = readFileSync(new URL(`../scripts/verify-${name}.cjs`, import.meta.url), 'utf8');
  const start = source.lastIndexOf('}).catch(');
  expect(start).toBeGreaterThan(0);
  const handlerSource = source.slice(start + '}).catch('.length).trim().replace(/\);$/, '');
  for (const failure of ['directory', 'capture', 'write', 'no-window', 'no-server']) {
    const originalError = new Error('original UI assertion failed');
    const screenshotError = Object.assign(new Error(`fixture ${failure} unavailable`), { code: 'EACCES' });
    const log = vi.fn();
    const close = vi.fn(async () => undefined);
    const exit = vi.fn();
    const capturePage = vi.fn(async () => {
      if (failure === 'capture') throw screenshotError;
      return { toPNG: () => new Uint8Array() };
    });
    const handler = runInNewContext(`(${handlerSource})`, {
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
    }) as (error: Error) => Promise<void>;
    await expect(handler(originalError), failure).resolves.toBeUndefined();
    expect(log.mock.calls[0]).toEqual([originalError]);
    expect(exit, failure).toHaveBeenCalledWith(1);
    expect(close, failure).toHaveBeenCalledTimes(failure === 'no-server' ? 0 : 1);
    if (['directory', 'capture', 'write'].includes(failure)) expect(log).toHaveBeenLastCalledWith(
      expect.stringContaining('failure screenshot unavailable'), screenshotError
    );
    if (failure === 'no-window') expect(capturePage).not.toHaveBeenCalled();
  }
});
