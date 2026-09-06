import { randomUUID } from 'node:crypto';
import { wakeBrowserWork } from './browser-wake.js';
import { z } from 'zod';
import type { BrowserPreferences } from '../shared/browser-preferences.js';

const values = z.object({ overwrite: z.boolean(), durations: z.boolean() }).strict();
export const browserPreferencePatch = values.partial();
const acknowledgement = z.object({ nonce: z.string().uuid(), values: values.nullable(), error: z.string().max(160).optional() }).strict();
type Request = { nonce: string; expiresAt: number; patch: Partial<BrowserPreferences> };
let pending: { request: Request; resolve: (value: BrowserPreferences) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;

/** One explicit read/change, bounded to two normal browser-maintenance opportunities. */
export function requestBrowserPreferences(raw: unknown): Promise<BrowserPreferences> {
  const patch = browserPreferencePatch.parse(raw);
  if (pending) return Promise.reject(new Error('A browser preference request is already pending'));
  return new Promise((resolve, reject) => {
    const request = { nonce: randomUUID(), expiresAt: Date.now() + 65000, patch };
    const timer = setTimeout(() => {
      if (pending?.request !== request) return;
      pending = null;
      reject(new Error('Browser did not confirm its preferences. Connect the extension and refresh.'));
    }, 65000);
    timer.unref?.();
    pending = { request, resolve, reject, timer };
    wakeBrowserWork();
  });
}
export function pendingBrowserPreferenceRequest(): Request | null {
  return pending && pending.request.expiresAt > Date.now() ? structuredClone(pending.request) : null;
}
export function acknowledgeBrowserPreferences(raw: unknown): boolean {
  const parsed = acknowledgement.safeParse(raw);
  if (!parsed.success || !pending || parsed.data.nonce !== pending.request.nonce || Date.now() >= pending.request.expiresAt) return false;
  const current = pending; pending = null; clearTimeout(current.timer);
  if (parsed.data.values) current.resolve(parsed.data.values);
  else current.reject(new Error(parsed.data.error || 'The extension could not confirm this change. Refresh its preferences.'));
  return true;
}
export function resetBrowserPreferencesForTests(): void {
  if (pending) { clearTimeout(pending.timer); pending.reject(new Error('Preference request cancelled')); }
  pending = null;
}
