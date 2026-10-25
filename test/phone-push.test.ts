import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPhonePush, DEFAULT_PHONE_PUSH, inQuietHours, isValidTopic, normalizeServer, type PhonePushSettings } from '../src/main/phone-push.js';

const settings = (over: Partial<PhonePushSettings> = {}): PhonePushSettings => ({ ...DEFAULT_PHONE_PUSH, enabled: true, topic: 'cos-k3j9x2m4q8w7e5r1', ...over });
// 2026-10-23 is a Friday; local time is pinned by building the date from parts.
const at = (hour: number, minute = 0) => new Date(2026, 9, 23, hour, minute).getTime();

function setUp(over: Partial<PhonePushSettings> = {}, idle: 'active' | 'idle' | 'locked' | 'unknown' = 'idle') {
  const sent: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const log = vi.fn();
  let now = at(14);
  let current = settings(over);
  let token: string | null = null;
  const push = createPhonePush({
    settings: () => current,
    token: async () => token,
    now: () => now,
    idleState: () => idle,
    post: async (url, body, headers) => { sent.push({ url, body: JSON.parse(body), headers }); return { ok: true, status: 200 }; },
    log
  });
  return { push, sent, log, advance: (ms: number) => { now += ms; }, setNow: (ms: number) => { now = ms; },
    set: (next: Partial<PhonePushSettings>) => { current = { ...current, ...next }; }, setToken: (value: string | null) => { token = value; } };
}

describe('what reaches the phone', () => {
  it('sends a chat that needs you as a high-priority message, without its name by default', async () => {
    const { push, sent, log } = setUp();
    expect(await push.notify({ kind: 'needs-you', sessionId: 's1', chatTitle: 'Payroll export', conversationId: 'c-1' })).toBe('sent');
    expect(sent).toEqual([{ url: 'https://ntfy.sh', headers: { 'Content-Type': 'application/json' },
      body: { topic: 'cos-k3j9x2m4q8w7e5r1', title: 'Chat On Steroids', message: 'A chat is waiting for you.', priority: 4, tags: ['raising_hand'] } }]);
    expect(JSON.stringify(sent)).not.toContain('Payroll');
    expect(log).toHaveBeenCalledWith('phone push: sent "needs you" to the phone');
  });

  it('names the chat, shows the answer and links the ChatGPT chat only when that is allowed', async () => {
    const { push, sent } = setUp({ includeDetails: true });
    await push.notify({ kind: 'finished', sessionId: 's1', chatTitle: 'Payroll export', conversationId: '68f9a1b2-1c2d-8e3f-9a0b-1c2d3e4f5a6b', workedMs: 12 * 60_000, detail: 'All 12 tests pass.' });
    expect(sent[0]!.body).toEqual({ topic: 'cos-k3j9x2m4q8w7e5r1', title: 'Payroll export', message: 'Finished after 12 min. All 12 tests pass.',
      priority: 3, tags: ['white_check_mark'], click: 'https://chatgpt.com/c/68f9a1b2-1c2d-8e3f-9a0b-1c2d3e4f5a6b' });
  });

  it('never cuts an emoji in half when a long title or answer is shortened', async () => {
    const { push, sent } = setUp({ includeDetails: true, finishedAfterMinutes: 0 });
    // The cut lands exactly between the two halves of the emoji.
    const title = 'a'.repeat(78) + '🚀 launch checklist';
    const answer = 'b'.repeat(198) + '✅🎉 all done and shipped';
    await push.notify({ kind: 'finished', sessionId: 's1', chatTitle: title, workedMs: 20_000, detail: answer });
    const body = sent[0]!.body as { title: string; message: string };
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(body.title).not.toMatch(lone);
    expect(body.message).not.toMatch(lone);
    expect(body.title.endsWith('…')).toBe(true);
    expect([...body.title].length).toBeLessThanOrEqual(80);
    // A family emoji is several code points joined; it stays whole or goes whole.
    const family = '👨\u200D👩\u200D👧';
    await push.notify({ kind: 'finished', sessionId: 's2', chatTitle: 'c'.repeat(77) + family + ' trip', workedMs: 20_000 });
    const second = sent[1]!.body as { title: string };
    expect(second.title.includes('\u200D') ? second.title.includes(family) : true).toBe(true);
    expect(second.title).toMatch(/…$/);
  });

  it('says only that a chat finished when it worked under a minute', async () => {
    const { push, sent } = setUp({ finishedAfterMinutes: 0 });
    await push.notify({ kind: 'finished', sessionId: 's1', workedMs: 20_000 });
    await push.notify({ kind: 'finished', sessionId: 's2', workedMs: 90_000 });
    expect(sent.map(row => row.body.message)).toEqual(['A chat finished.', 'Finished after 2 min.']);
  });

  it('says what failed, and sends the access token when one is saved', async () => {
    const { push, sent, setToken } = setUp({ server: 'https://ntfy.example.org/' });
    setToken('tk_secret');
    await push.notify({ kind: 'failed', detail: 'The tunnel disconnected unexpectedly.' });
    expect(sent[0]).toEqual({ url: 'https://ntfy.example.org', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tk_secret' },
      body: { topic: 'cos-k3j9x2m4q8w7e5r1', title: 'Chat On Steroids', message: 'The tunnel disconnected unexpectedly.', priority: 4, tags: ['warning'] } });
  });
});

describe('when nothing is sent', () => {
  // Each skip of a switched-on feature says why in the log. Switched off, it stays silent: that is
  // every install that never turned it on, and a line per chat event would say nothing.
  it.each([
    ['push is off', { enabled: false }, 'off', null],
    ['there is no topic', { topic: '' }, 'off', 'phone push: not sent "needs you": the topic is not valid'],
    ['this kind is off', { needsYou: false }, 'kind-off', 'phone push: not sent "needs you": this kind is switched off']
  ] as const)('%s', async (_name, over, reason, line) => {
    const { push, sent, log } = setUp(over);
    expect(await push.notify({ kind: 'needs-you', sessionId: 's1' })).toBe(reason);
    expect(sent).toEqual([]);
    if (line) expect(log).toHaveBeenCalledWith(line); else expect(log).not.toHaveBeenCalled();
  });

  it('skips while the person is at the computer, unless asked to send anyway', async () => {
    const { push, sent, log } = setUp({}, 'active');
    expect(await push.notify({ kind: 'needs-you', sessionId: 's1' })).toBe('at-computer');
    expect(log).toHaveBeenCalledWith('phone push: not sent "needs you": you are at the computer');
    const always = setUp({ onlyWhenAway: false }, 'active');
    expect(await always.push.notify({ kind: 'needs-you', sessionId: 's1' })).toBe('sent');
    expect(sent).toEqual([]);
  });

  it('counts a locked screen, and a system that cannot tell, as away', async () => {
    expect(await setUp({}, 'locked').push.notify({ kind: 'needs-you', sessionId: 's1' })).toBe('sent');
    expect(await setUp({}, 'unknown').push.notify({ kind: 'needs-you', sessionId: 's1' })).toBe('sent');
  });

  it('sends a finished chat only after it worked long enough', async () => {
    const { push } = setUp({ finishedAfterMinutes: 5 });
    expect(await push.notify({ kind: 'finished', sessionId: 's1', workedMs: 4 * 60_000 })).toBe('short-turn');
    expect(await push.notify({ kind: 'finished', sessionId: 's2', workedMs: 5 * 60_000 })).toBe('sent');
    // Unknown length (it started before the app did): it ran long enough to have been missed.
    expect(await push.notify({ kind: 'finished', sessionId: 's3' })).toBe('sent');
    expect(await setUp({ finishedAfterMinutes: null }).push.notify({ kind: 'finished', sessionId: 's1', workedMs: 60 * 60_000 })).toBe('kind-off');
    expect(await setUp({ finishedAfterMinutes: 0 }).push.notify({ kind: 'finished', sessionId: 's1', workedMs: 1000 })).toBe('sent');
  });

  it('stays quiet in quiet hours, across midnight too', async () => {
    const { push, setNow } = setUp({ quietHours: { from: '22:00', to: '07:00' } });
    setNow(at(23, 30));
    expect(await push.notify({ kind: 'needs-you', sessionId: 's1' })).toBe('quiet-hours');
    setNow(at(6, 59));
    expect(await push.notify({ kind: 'needs-you', sessionId: 's1' })).toBe('quiet-hours');
    setNow(at(7, 0));
    expect(await push.notify({ kind: 'needs-you', sessionId: 's1' })).toBe('sent');
  });

  it('sends the same chat and kind at most once in two minutes, and at most 20 an hour', async () => {
    const { push, sent, advance } = setUp();
    expect(await push.notify({ kind: 'needs-you', sessionId: 's1' })).toBe('sent');
    expect(await push.notify({ kind: 'needs-you', sessionId: 's1' })).toBe('repeat');
    expect(await push.notify({ kind: 'finished', sessionId: 's1' })).toBe('sent');
    advance(2 * 60_000);
    expect(await push.notify({ kind: 'needs-you', sessionId: 's1' })).toBe('sent');
    for (let i = 0; i < 17; i++) await push.notify({ kind: 'needs-you', sessionId: `x${i}` });
    expect(sent).toHaveLength(20);
    expect(await push.notify({ kind: 'needs-you', sessionId: 'y' })).toBe('hourly-limit');
    advance(60 * 60_000);
    expect(await push.notify({ kind: 'needs-you', sessionId: 'y' })).toBe('sent');
  });

  it('logs a server that refused or could not be reached, and never throws', async () => {
    const log = vi.fn();
    const push = createPhonePush({ settings: () => settings(), token: async () => null, now: () => at(14), idleState: () => 'idle', log,
      post: vi.fn().mockResolvedValueOnce({ ok: false, status: 403 }).mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND ntfy.sh')) });
    expect(await push.notify({ kind: 'failed', detail: 'x' })).toBe('error');
    expect(log).toHaveBeenLastCalledWith('phone push: the server refused "failure" (HTTP 403)');
    expect(await push.notify({ kind: 'failed', detail: 'y' })).toBe('error');
    expect(log).toHaveBeenLastCalledWith('phone push: could not reach the server for "failure": getaddrinfo ENOTFOUND ntfy.sh');
  });

  it('lets the next message try again after one that did not arrive', async () => {
    const post = vi.fn().mockResolvedValueOnce({ ok: false, status: 502 }).mockResolvedValue({ ok: true, status: 200 });
    const push = createPhonePush({ settings: () => settings(), token: async () => null, now: () => at(14), idleState: () => 'idle', log: vi.fn(), post });
    expect(await push.notify({ kind: 'needs-you', sessionId: 's1' })).toBe('error');
    expect(await push.notify({ kind: 'needs-you', sessionId: 's1' })).toBe('sent');
    expect(await push.notify({ kind: 'needs-you', sessionId: 's1' })).toBe('repeat');
  });
});

describe('the access token', () => {
  it('goes only over https or to this computer, and never silently stays behind', async () => {
    for (const [server, sent] of [['https://ntfy.example.org', true], ['http://localhost:8080', true], ['http://127.0.0.1', true], ['http://[::1]:80', true], ['http://192.168.1.5:8080', false], ['http://ntfy.example.org', false]] as const) {
      const { push, sent: posted, setToken, log } = setUp({ server });
      setToken('tk_secret');
      expect(await push.notify({ kind: 'failed', detail: 'x' }), server).toBe(sent ? 'sent' : 'error');
      expect(posted.length, server).toBe(sent ? 1 : 0);
      if (!sent) {
        expect(log).toHaveBeenLastCalledWith('phone push: not sent "failure": An access token is sent only over https, or to this computer. Use https:// for this server.');
        await expect(push.test()).rejects.toThrow('An access token is sent only over https, or to this computer. Use https:// for this server.');
      }
    }
    // Without a token, a plain-http server in the house is fine.
    const lan = setUp({ server: 'http://192.168.1.5:8080' });
    expect(await lan.push.notify({ kind: 'failed', detail: 'x' })).toBe('sent');
  });

  it('refuses to send when the saved token cannot be read, instead of sending without it', async () => {
    const log = vi.fn(), post = vi.fn(async () => ({ ok: true, status: 200 }));
    const push = createPhonePush({ settings: () => settings(), token: async () => { throw new Error('keychain locked'); }, now: () => at(14), idleState: () => 'idle', log, post });
    expect(await push.notify({ kind: 'needs-you', sessionId: 's1' })).toBe('error');
    expect(post).not.toHaveBeenCalled();
    expect(log).toHaveBeenLastCalledWith('phone push: not sent "needs you": The saved access token could not be read from secure storage. (keychain locked)');
    await expect(push.test()).rejects.toThrow('The saved access token could not be read from secure storage.');
  });

  it('says a bad server address is not valid, rather than that it could not be reached', async () => {
    const { push } = setUp({ server: '' });
    await expect(push.test()).rejects.toThrow('The ntfy server address is not valid.');
  });
});

describe('a test message', () => {
  it('is sent even while at the computer and in quiet hours, and reports a failure', async () => {
    const { push, sent, setNow } = setUp({ quietHours: { from: '00:00', to: '23:59' } }, 'active');
    setNow(at(12));
    await expect(push.test()).resolves.toBeUndefined();
    expect(sent[0]!.body).toMatchObject({ message: 'This is a test from Chat On Steroids. Phone notifications work.', priority: 3 });
    const failing = createPhonePush({ settings: () => settings(), token: async () => null, now: () => at(14), idleState: () => 'idle', log: vi.fn(),
      post: async () => ({ ok: false, status: 401 }) });
    await expect(failing.test()).rejects.toThrow('The ntfy server refused the message. Check the server, the topic and the access token.');
  });
});

describe('settings checks', () => {
  it.each([['cos-k3j9x2m4q8w7e5r1', true], ['abc', true], ['has space', false], ['a/b', false], ['x'.repeat(65), false], ['', false]])
  ('topic %s is valid: %s', (topic, valid) => expect(isValidTopic(topic)).toBe(valid));

  it.each([
    ['https://ntfy.sh', 'https://ntfy.sh'], ['https://ntfy.example.org/', 'https://ntfy.example.org'], ['http://192.168.1.5:8080', 'http://192.168.1.5:8080'],
    ['ftp://ntfy.sh', null], ['not a url', null], ['https://user:pw@ntfy.sh', null], ['https://ntfy.sh/topic?x=1', null]
  ])('server %s → %s', (input, expected) => expect(normalizeServer(input)).toBe(expected));

  it('reads quiet hours that wrap midnight and ones that do not', () => {
    expect(inQuietHours({ from: '22:00', to: '07:00' }, new Date(2026, 9, 23, 3, 0))).toBe(true);
    expect(inQuietHours({ from: '22:00', to: '07:00' }, new Date(2026, 9, 23, 12, 0))).toBe(false);
    expect(inQuietHours({ from: '13:00', to: '14:00' }, new Date(2026, 9, 23, 13, 30))).toBe(true);
    expect(inQuietHours({ from: '13:00', to: '13:00' }, new Date(2026, 9, 23, 13, 0))).toBe(false);
    expect(inQuietHours(null, new Date())).toBe(false);
  });
});

beforeEach(() => vi.clearAllMocks());
