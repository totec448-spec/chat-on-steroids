import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { testLinuxScreenshotConsent } from '../src/main/computer/linux-screenshot-consent.js';
import { logInfo } from '../src/main/logger.js';

vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn() }));

const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
function context() {
  let focused = true;
  let enabled = true;
  let screenAllowed = true;
  const checkVersion = vi.fn(async () => undefined);
  const run = vi.fn(async () => ({ ok: true, command: 'screenshot',
    data: { data: tinyPng, format: 'png', width: 1, height: 1, scale_factor: 1 } }));
  return {
    focused: () => focused,
    enabled: () => enabled,
    screenAllowed: () => screenAllowed,
    checkVersion, run,
    setFocused: (value: boolean) => { focused = value; },
    setEnabled: (value: boolean) => { enabled = value; },
    setScreen: (value: boolean) => { screenAllowed = value; }
  };
}

describe.skipIf(process.platform !== 'linux')('manual GNOME screenshot permission probe', () => {
  beforeEach(() => vi.mocked(logInfo).mockClear());

  it('translates the generic permission failure instead of exposing unknown backend error text', () => {
    const key = 'GNOME screenshot permission could not be confirmed.';
    for (const locale of ['de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW']) {
      const catalog = JSON.parse(readFileSync(`src/renderer/locales/${locale}.json`, 'utf8')) as Record<string, string>;
      expect(catalog[key], locale).toBeTruthy();
      expect(catalog[key], locale).not.toBe(key);
    }
  });
  it('logs a fixed platform refusal before invoking the backend', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    expect(descriptor?.configurable).toBe(true);
    const deps = context();
    // The synchronous platform guard runs before the first await; restore the
    // process setting immediately so other tests keep the real Linux platform.
    const pending = (() => {
      Object.defineProperty(process, 'platform', { ...descriptor, value: 'darwin' });
      try { return testLinuxScreenshotConsent(deps); }
      finally { Object.defineProperty(process, 'platform', descriptor!); }
    })();
    await expect(pending).rejects.toThrow('only on Linux');
    expect(deps.checkVersion).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledExactlyOnceWith('linux screenshot consent: refused because the platform is not Linux');
  });
  it('requires native opt-in, screen permission and an already active window', async () => {
    const cases = [
      ['setEnabled', 'linux screenshot consent: refused because native Linux Desktop or Screen access is disabled'],
      ['setScreen', 'linux screenshot consent: refused because native Linux Desktop or Screen access is disabled'],
      ['setFocused', 'linux screenshot consent: refused because the main window is not focused']
    ] as const;
    for (const [index, [revoke, reason]] of cases.entries()) {
      const deps = context();
      deps[revoke](false);
      await expect(testLinuxScreenshotConsent(deps)).rejects.toThrow();
      expect(deps.checkVersion).not.toHaveBeenCalled();
      expect(deps.run).not.toHaveBeenCalled();
      expect(logInfo).toHaveBeenNthCalledWith(index + 1, reason);
    }
    expect(logInfo).toHaveBeenCalledTimes(cases.length);
  });
  it('rechecks focus after its version-check wait and never starts an unfocused screenshot', async () => {
    const deps = context();
    deps.checkVersion.mockImplementation(async () => { deps.setFocused(false); });
    await expect(testLinuxScreenshotConsent(deps)).rejects.toThrow('lost focus');
    expect(deps.run).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledExactlyOnceWith('linux screenshot consent: refused because the main window lost focus during the version check');
  });
  it('rechecks both native opt-in and screen permission after its version-check wait', async () => {
    for (const revoke of ['setEnabled', 'setScreen'] as const) {
      const deps = context();
      deps.checkVersion.mockImplementation(async () => { deps[revoke](false); });
      await expect(testLinuxScreenshotConsent(deps)).rejects.toThrow('disabled');
      expect(deps.run).not.toHaveBeenCalled();
    }
    expect(logInfo).toHaveBeenCalledTimes(2);
    expect(vi.mocked(logInfo).mock.calls).toEqual(Array.from({ length: 2 }, () => [
      'linux screenshot consent: refused because native Linux Desktop or Screen access was disabled before the screenshot request'
    ]));
  });
  it('returns only PNG length, never image bytes or base64', async () => {
    const deps = context();
    const response = await testLinuxScreenshotConsent(deps);
    expect(response).toEqual({ pngBytes: Buffer.from(tinyPng, 'base64').byteLength });
    expect(JSON.stringify(response)).not.toContain('iVBOR');
    expect(deps.run).toHaveBeenCalledExactlyOnceWith({ kind: 'screenshot', display: 0 });
    expect(logInfo).not.toHaveBeenCalled();
  });
  it('rejects a consent result if Screen or native opt-in was revoked during capture', async () => {
    for (const revoke of ['setEnabled', 'setScreen'] as const) {
      const deps = context();
      deps.run.mockImplementationOnce(async () => {
        deps[revoke](false);
        return { ok: true, command: 'screenshot',
          data: { data: tinyPng, format: 'png', width: 1, height: 1, scale_factor: 1 } };
      });
      await expect(testLinuxScreenshotConsent(deps)).rejects.toThrow('disabled during the screenshot request');
      expect(deps.run).toHaveBeenCalledTimes(1);
    }
    expect(logInfo).toHaveBeenCalledTimes(2);
    for (const [message] of vi.mocked(logInfo).mock.calls) {
      expect(message).toContain('discarded the capture');
      expect(message).not.toContain(tinyPng);
    }
  });
  it('does not retry a portal refusal or return application error details', async () => {
    const deps = context();
    deps.run.mockResolvedValueOnce({ ok: false, command: 'screenshot', error: {
      code: 'PERM_DENIED', message: 'secret application title', details: 'private screen text'
    } } as never);
    await expect(testLinuxScreenshotConsent(deps)).rejects.toThrow('PERM_DENIED');
    expect(deps.run).toHaveBeenCalledTimes(1);
    // The log keeps the code for diagnosis (CodeRabbit on #2065), never the backend's text.
    expect(logInfo).toHaveBeenCalledExactlyOnceWith('linux screenshot consent: refused because the screenshot backend returned PERM_DENIED');
    expect(JSON.stringify(vi.mocked(logInfo).mock.calls)).not.toMatch(/secret application title|private screen text/);
  });
  it('keeps a backend code out of the log and the error unless it looks like a code', async () => {
    const deps = context();
    deps.run.mockResolvedValueOnce({ ok: false, command: 'screenshot', error: { code: 'Payroll – Q3 report.xlsx' } } as never);
    await expect(testLinuxScreenshotConsent(deps)).rejects.toThrow('returned UNKNOWN');
    expect(logInfo).toHaveBeenCalledExactlyOnceWith('linux screenshot consent: refused because the screenshot backend returned UNKNOWN');
  });
  it('rejects malformed PNG results without exposing their content', async () => {
    const deps = context();
    deps.run.mockResolvedValueOnce({ ok: true, command: 'screenshot',
      data: { data: Buffer.from('not PNG', 'utf8').toString('base64'), format: 'png', width: 1, height: 1, scale_factor: 1 } });
    await expect(testLinuxScreenshotConsent(deps)).rejects.toThrow('INVALID_PNG');
  });
});
