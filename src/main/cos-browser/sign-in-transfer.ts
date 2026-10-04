/** One explicit, process-local login handoff. Cookie values never enter durable app state. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ExternalChatBrowser } from '../browser.js';
import { CHATGPT_SESSION_COOKIE } from './sign-in.js';

const cookieSchema = z.object({
  name: z.string().regex(CHATGPT_SESSION_COOKIE), value: z.string().min(1).max(4096),
  domain: z.enum(['chatgpt.com', '.chatgpt.com']), path: z.literal('/'),
  secure: z.literal(true), httpOnly: z.literal(true), hostOnly: z.boolean(),
  sameSite: z.enum(['no_restriction', 'lax', 'strict', 'unspecified']),
  expirationDate: z.number().finite().positive().optional()
}).strict();
export type SignInCookie = z.infer<typeof cookieSchema>;
const cookieBatch = z.array(cookieSchema).min(1).max(16);
export type SignInTransferOffer = { id: string; browser: ExternalChatBrowser; expiresAt: number };
export class SignInTransferError extends Error {
  constructor(readonly reason: 'invalid_session' | 'transfer_expired' | 'transfer_busy' | 'transfer_failed') {
    super(reason);
  }
}

/** Reject mixed, truncated or ambiguous token chunks before touching either cookie jar. */
export function signInCookies(raw: unknown, now = Date.now()): SignInCookie[] {
  const result = cookieBatch.safeParse(raw);
  if (!result.success) throw new SignInTransferError('invalid_session');
  const cookies = result.data;
  const first = cookies[0]!;
  if (cookies.some(cookie => cookie.hostOnly !== (cookie.domain === 'chatgpt.com') ||
    cookie.domain !== first.domain || cookie.hostOnly !== first.hostOnly ||
    (cookie.expirationDate !== undefined && cookie.expirationDate * 1000 <= now))) {
    throw new SignInTransferError('invalid_session');
  }
  if (cookies.length === 1 && cookies[0]!.name === '__Secure-next-auth.session-token') return cookies;
  const sorted = [...cookies].sort((a, b) => Number(a.name.split('.').at(-1)) - Number(b.name.split('.').at(-1)));
  if (sorted.some((cookie, index) => cookie.name !== `__Secure-next-auth.session-token.${index}`)) {
    throw new SignInTransferError('invalid_session');
  }
  return sorted;
}

export class SignInTransfer {
  private active: (SignInTransferOffer & {
    current(): boolean; write(cookies: SignInCookie[], current: () => boolean): Promise<void>;
  }) | null = null;
  /** Cancellation revokes the grant, but an accepted cookie write still holds this exclusion. */
  private writing = false;
  private receipt: { id: string; browserId: string } | null = null;
  private readonly listeners = new Set<(change: { id: string; imported: boolean }) => void>();

  /** An offer ended: imported, or revoked before it was. Lazy expiry does not report here. */
  onChange(listener: (change: { id: string; imported: boolean }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private ended(id: string, imported: boolean): void {
    for (const listener of this.listeners) {
      try { listener({ id, imported }); } catch { /* One listener cannot keep the others from knowing. */ }
    }
  }

  begin(browser: ExternalChatBrowser, current: () => boolean,
    write: (cookies: SignInCookie[], current: () => boolean) => Promise<void>): SignInTransferOffer {
    if (this.writing) throw new SignInTransferError('transfer_busy');
    if (!current()) throw new SignInTransferError('transfer_expired');
    this.active = { id: randomUUID(), browser, expiresAt: Date.now() + 15 * 60_000, current, write };
    this.receipt = null;
    return this.pending()!;
  }

  pending(): SignInTransferOffer | null {
    const active = this.active;
    if (!active || !active.current() || Date.now() >= active.expiresAt) return null;
    return { id: active.id, browser: active.browser, expiresAt: active.expiresAt };
  }

  cancel(id?: string): void {
    const revoked = this.active && (id === undefined || this.active.id === id) ? this.active.id : null;
    if (revoked) this.active = null;
    if (id === undefined || this.receipt?.id === id) this.receipt = null;
    if (revoked) this.ended(revoked, false);
  }

  async accept(id: string, browserId: string, raw: unknown, ingressCurrent: () => boolean = () => true): Promise<void> {
    if (!ingressCurrent()) throw new SignInTransferError('transfer_expired');
    if (this.receipt?.id === id && this.receipt.browserId === browserId) return;
    const active = this.active;
    if (!active || active.id !== id || !this.pending()) throw new SignInTransferError('transfer_expired');
    if (this.writing) throw new SignInTransferError('transfer_busy');
    const cookies = signInCookies(raw);
    this.writing = true;
    const current = () => this.active === active && active.current() && ingressCurrent() && Date.now() < active.expiresAt;
    try {
      await active.write(cookies, current);
      if (!current()) throw new SignInTransferError('transfer_expired');
      this.receipt = { id, browserId };
      this.active = null;
      this.ended(id, true);
    } catch (error) {
      // Errors from cookie APIs can contain credentials. Only our fixed reason crosses HTTP.
      throw error instanceof SignInTransferError ? error : new SignInTransferError('transfer_failed');
    } finally { this.writing = false; }
  }
}

export const cosSignInTransfer = new SignInTransfer();
