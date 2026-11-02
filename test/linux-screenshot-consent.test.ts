import { describe, expect, it, vi } from 'vitest';
import { testLinuxScreenshotConsent } from '../src/main/computer/linux-screenshot-consent.js';

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
  it('requires native opt-in, screen permission and an already active window', async () => {
    for (const revoke of ['setEnabled', 'setScreen', 'setFocused'] as const) {
      const deps = context();
      deps[revoke](false);
      await expect(testLinuxScreenshotConsent(deps)).rejects.toThrow();
      expect(deps.checkVersion).not.toHaveBeenCalled();
      expect(deps.run).not.toHaveBeenCalled();
    }
  });
  it('rechecks focus after its version-check wait and never starts an unfocused screenshot', async () => {
    const deps = context();
    deps.checkVersion.mockImplementation(async () => { deps.setFocused(false); });
    await expect(testLinuxScreenshotConsent(deps)).rejects.toThrow('lost focus');
    expect(deps.run).not.toHaveBeenCalled();
  });
  it('rechecks both native opt-in and screen permission after its version-check wait', async () => {
    for (const revoke of ['setEnabled', 'setScreen'] as const) {
      const deps = context();
      deps.checkVersion.mockImplementation(async () => { deps[revoke](false); });
      await expect(testLinuxScreenshotConsent(deps)).rejects.toThrow('disabled');
      expect(deps.run).not.toHaveBeenCalled();
    }
  });
  it('returns only PNG length, never image bytes or base64', async () => {
    const deps = context();
    const response = await testLinuxScreenshotConsent(deps);
    expect(response).toEqual({ pngBytes: Buffer.from(tinyPng, 'base64').byteLength });
    expect(JSON.stringify(response)).not.toContain('iVBOR');
    expect(deps.run).toHaveBeenCalledExactlyOnceWith({ kind: 'screenshot', display: 0 });
  });
  it('does not retry a portal refusal or return application error details', async () => {
    const deps = context();
    deps.run.mockResolvedValueOnce({ ok: false, command: 'screenshot', error: {
      code: 'PERM_DENIED', message: 'secret application title', details: 'private screen text'
    } } as never);
    await expect(testLinuxScreenshotConsent(deps)).rejects.toThrow('PERM_DENIED');
    expect(deps.run).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed PNG results without exposing their content', async () => {
    const deps = context();
    deps.run.mockResolvedValueOnce({ ok: true, command: 'screenshot',
      data: { data: Buffer.from('not PNG', 'utf8').toString('base64'), format: 'png', width: 1, height: 1, scale_factor: 1 } });
    await expect(testLinuxScreenshotConsent(deps)).rejects.toThrow('INVALID_PNG');
  });
});
