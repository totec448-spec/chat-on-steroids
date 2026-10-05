import { expect, it, vi } from 'vitest';
import { isGoogleSignIn } from '../src/main/cos-browser/sign-in.js';
import { SignInTransfer, SignInTransferError, signInCookies } from '../src/main/cos-browser/sign-in-transfer.js';

const cookie = { name: '__Secure-next-auth.session-token', value: 'synthetic-test-session',
  domain: '.chatgpt.com', path: '/', secure: true, httpOnly: true, hostOnly: false, sameSite: 'lax' };

it('routes only HTTPS Google sign-in out of the embedded browser', () => {
  expect(isGoogleSignIn('https://accounts.google.com/v3/signin/identifier')).toBe(true);
  for (const url of ['https://chatgpt.com/', 'https://auth.openai.com/', 'http://accounts.google.com/',
    'https://accounts.google.com.evil.test/', 'https://notaccounts.google.com/', 'not a URL']) {
    expect(isGoogleSignIn(url)).toBe(false);
  }
});

it('accepts complete session tokens only, including out-of-order chunks', () => {
  expect(signInCookies([cookie])).toEqual([cookie]);
  const chunk = (index: number) => ({ ...cookie, name: `${cookie.name}.${index}` });
  expect(signInCookies([chunk(1), chunk(0)]).map(cookie => cookie.name)).toEqual([chunk(0).name, chunk(1).name]);
  for (const batch of [[], [chunk(1)], [chunk(0), chunk(0)], [chunk(0), chunk(2)], [cookie, chunk(0)],
    [{ ...cookie, domain: '.google.com' }], [{ ...cookie, httpOnly: false }], [{ ...cookie, path: '/other' }],
    [{ ...cookie, expirationDate: 1 }], [{ ...cookie, value: 'x'.repeat(4097) }],
    [chunk(0), { ...chunk(1), domain: 'chatgpt.com', hostOnly: true }]]) {
    expect(() => signInCookies(batch)).toThrow('invalid_session');
  }
});

it('requires an explicit offer and deduplicates only the same browser receipt', async () => {
  const transfer = new SignInTransfer();
  const write = vi.fn(async () => {});
  expect(transfer.pending()).toBeNull();
  await expect(transfer.accept('missing', 'browser-a', [cookie])).rejects.toThrow('transfer_expired');
  const offer = transfer.begin('brave', () => true, write);
  expect(transfer.pending()).toEqual(offer);
  await expect(transfer.accept('foreign', 'browser-a', [cookie])).rejects.toThrow('transfer_expired');
  await transfer.accept(offer.id, 'browser-a', [cookie]);
  await transfer.accept(offer.id, 'browser-a', [cookie]);
  await expect(transfer.accept(offer.id, 'browser-b', [cookie])).rejects.toThrow('transfer_expired');
  expect(write).toHaveBeenCalledTimes(1);
  expect(transfer.pending()).toBeNull();
});

it('blocks concurrent imports and cannot publish a late result after revocation', async () => {
  const transfer = new SignInTransfer();
  let finish!: () => void;
  let owns!: () => boolean;
  const offer = transfer.begin('edge', () => true, async (_cookies, current) => {
    owns = current;
    await new Promise<void>(resolve => { finish = resolve; });
  });
  const importing = transfer.accept(offer.id, 'browser-a', [cookie]);
  await expect(transfer.accept(offer.id, 'browser-b', [cookie])).rejects.toThrow('transfer_busy');
  expect(() => transfer.begin('chrome', () => true, async () => {})).toThrow('transfer_busy');
  transfer.cancel();
  expect(owns()).toBe(false);
  finish();
  await expect(importing).rejects.toThrow('transfer_expired');
  expect(transfer.pending()).toBeNull();
});

it('expires without a timer and never echoes a cookie API exception', async () => {
  const transfer = new SignInTransfer();
  let now = 1000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const offer = transfer.begin('chrome', () => true, async () => { throw new Error(cookie.value); });
    await expect(transfer.accept(offer.id, 'browser-a', [cookie])).rejects.toEqual(new SignInTransferError('transfer_failed'));
    now = offer.expiresAt;
    expect(transfer.pending()).toBeNull();
    await expect(transfer.accept(offer.id, 'browser-a', [cookie])).rejects.toThrow('transfer_expired');
  } finally { clock.mockRestore(); }
});
