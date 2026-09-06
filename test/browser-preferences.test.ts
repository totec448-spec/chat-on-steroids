import { afterEach, expect, it, vi } from 'vitest';
import { requestBrowserPreferences, pendingBrowserPreferenceRequest, acknowledgeBrowserPreferences, resetBrowserPreferencesForTests } from '../src/main/browser-preferences.js';
afterEach(() => { resetBrowserPreferencesForTests(); vi.useRealTimers(); });
it('accepts only the exact bounded preference acknowledgement', async () => {
  const promise = requestBrowserPreferences({ durations: true });
  const request = pendingBrowserPreferenceRequest()!;
  expect(request.patch).toEqual({ durations: true });
  expect(acknowledgeBrowserPreferences({ nonce: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', values: { overwrite: true, durations: true } })).toBe(false);
  expect(acknowledgeBrowserPreferences({ nonce: request.nonce, values: { overwrite: true, durations: 'true' } })).toBe(false);
  expect(acknowledgeBrowserPreferences({ nonce: request.nonce, values: { overwrite: false, durations: true } })).toBe(true);
  await expect(promise).resolves.toEqual({ overwrite: false, durations: true });
  expect(pendingBrowserPreferenceRequest()).toBeNull();
  expect(() => requestBrowserPreferences({ arbitrarySetting: true })).toThrow();
});
it('bounds missing browsers and refuses concurrent or late commands', async () => {
  vi.useFakeTimers();
  const pending = requestBrowserPreferences({});
  const rejected = expect(pending).rejects.toThrow('Browser did not confirm');
  const request = pendingBrowserPreferenceRequest()!;
  await expect(requestBrowserPreferences({ overwrite: false })).rejects.toThrow('already pending');
  await vi.advanceTimersByTimeAsync(65000); await rejected;
  expect(acknowledgeBrowserPreferences({ nonce: request.nonce, values: { overwrite: true, durations: false } })).toBe(false);
});
