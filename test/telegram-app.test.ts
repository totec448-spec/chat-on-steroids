import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// A gate on the pause marker's write, to meet two changes at an exact moment (CodeRabbit on #1990).
const gate = vi.hoisted(() => ({ hold: null as Promise<void> | null, blocked: 0 }));
vi.mock('../src/main/durable.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/main/durable.js')>();
  return { ...real, writeDurableNow: async (name: string, value: unknown) => {
    if (name === 'telegram-paused' && gate.hold) { gate.blocked += 1; await gate.hold; }
    return real.writeDurableNow(name, value);
  } };
});
vi.mock('../src/main/secrets.js', () => ({
  getSecret: vi.fn(async () => '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ1'),
  setSecret: vi.fn(async () => undefined),
  clearSecret: vi.fn(async () => undefined)
}));

const { flushDurable, initDurableStore, readDurable, resetDurableForTests, writeDurableNow } = await import('../src/main/durable.js');
const { resetTelegramForTests, startTelegram, telegramDestination } = await import('../src/main/telegram-app.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

const ME = 4242;
let directory = '';

beforeEach(async () => {
  directory = await makeTempDir('cos-telegram-app-');
  resetDurableForTests();
  initDurableStore(directory);
  await writeDurableNow('telegram-link', { userId: ME, chatId: ME, userName: '@me', botName: '@cos_test_bot', linkedAt: 1 });
});
afterEach(async () => {
  resetTelegramForTests();
  await flushDurable();
  resetDurableForTests();
  await removeTempDir(directory);
});

/** Telegram over `fetch`: queued updates go out on the next long poll; sent messages are kept. */
function fakeTelegram() {
  const sent: Array<{ text: string; reply_markup?: unknown }> = [];
  const pending: unknown[][] = [];
  let release: (() => void) | null = null;
  let update = 1, messageId = 500;
  const fetch = vi.fn(async (url: string, init: { body: string; signal?: AbortSignal }) => {
    const method = url.split('/').at(-1)!;
    const params = JSON.parse(init.body) as Record<string, any>;
    const reply = (body: unknown) => ({ status: 200, json: async () => body });
    if (method === 'getUpdates') {
      if (!pending.length) await new Promise<void>((resolve, reject) => {
        release = resolve;
        init.signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
      });
      return reply({ ok: true, result: pending.shift() ?? [] });
    }
    if (method === 'sendMessage') { sent.push({ text: params.text, reply_markup: params.reply_markup }); return reply({ ok: true, result: { message_id: ++messageId } }); }
    return reply({ ok: true });
  });
  return {
    fetch, sent,
    get lastMessageId() { return messageId; },
    say(text: string, replyTo?: number) {
      pending.push([{ update_id: update++, message: { message_id: 9000 + update, date: Math.floor(Date.now() / 1000), text,
        chat: { id: ME, type: 'private' }, from: { id: ME, username: 'me' }, ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) } }]);
      const go = release; release = null; go?.();
    }
  };
}

function start(telegram: ReturnType<typeof fakeTelegram>, chats: Array<{ sessionId: string; automation: 'Goal' | 'Loop' | null; working?: boolean; own?: boolean }>,
  options: { setAutomation?: (sessionId: string, on: boolean) => Promise<boolean> } = {}) {
  const setAutomation = vi.fn(options.setAutomation ?? (async (sessionId: string, on: boolean) => {
    const chat = chats.find(row => row.sessionId === sessionId)!;
    chat.automation = on ? 'Goal' : null;
    return true;
  }));
  const steer = vi.fn(async () => 'sent' as const);
  const stop = vi.fn(async () => 'done' as const);
  return startTelegram({
    fetch: telegram.fetch as never,
    log: () => undefined,
    mainText: source => source,
    chats: async () => chats.map(chat => ({ title: chat.sessionId, approval: false, working: chat.working ?? false, ...chat })),
    details: () => false,
    deny: async () => 'denied',
    stop,
    setAutomation,
    steer
  }).then(() => ({ setAutomation, steer, stop }));
}

// Phase 2 (2026-10-31): /resume brings back only what /pause turned off from Telegram, also after a restart.
it('resumes only a chat paused from Telegram, after a restart too, and never one turned back on in the app', async () => {
  const chats: Array<{ sessionId: string; automation: 'Goal' | 'Loop' | null }> = [
    { sessionId: 'chat-a', automation: 'Loop' }, { sessionId: 'chat-b', automation: null }];
  let telegram = fakeTelegram();
  let app = await start(telegram, chats);
  expect(await telegramDestination()!.send('A chat finished.', { sessionId: 'chat-a' })).toBe(true);
  telegram.say('/pause', telegram.lastMessageId);
  await vi.waitFor(() => expect(telegram.sent.at(-1)?.text).toBe('Paused. /resume starts it again.'), { timeout: 5_000, interval: 10 });
  expect(app.setAutomation).toHaveBeenCalledWith('chat-a', false);
  expect(await readDurable('telegram-paused')).toEqual(['chat-a']);
  // chat-b never had Goal or Loop on, and was not paused from here: /resume has exactly one chat to mean.
  resetTelegramForTests();
  telegram = fakeTelegram();
  app = await start(telegram, chats);
  telegram.say('/resume');
  await vi.waitFor(() => expect(telegram.sent.at(-1)?.text).toBe('Resumed.'), { timeout: 5_000, interval: 10 });
  expect(app.setAutomation).toHaveBeenCalledWith('chat-a', true);
  expect(await readDurable('telegram-paused')).toEqual([]);
  telegram.say('/resume');
  await vi.waitFor(() => expect(telegram.sent.at(-1)?.text).toBe('No chat was paused from here.'), { timeout: 5_000, interval: 10 });
  // Paused from here, then turned back on in the app: /resume leaves it alone and forgets it.
  telegram.say('/pause');
  await vi.waitFor(() => expect(telegram.sent.at(-1)?.text).toBe('Paused. /resume starts it again.'), { timeout: 5_000, interval: 10 });
  chats[0]!.automation = 'Goal';
  app.setAutomation.mockClear();
  expect(await telegramDestination()!.send('A chat finished.', { sessionId: 'chat-a' })).toBe(true);
  telegram.say('/resume', telegram.lastMessageId);
  await vi.waitFor(() => expect(telegram.sent.at(-1)?.text).toBe('It was not paused from here.'), { timeout: 5_000, interval: 10 });
  expect(app.setAutomation).not.toHaveBeenCalled();
  expect(await readDurable('telegram-paused')).toEqual([]);
});

it('passes a reply to a notification to the app, which decides whether it may go', async () => {
  const telegram = fakeTelegram();
  const app = await start(telegram, [{ sessionId: 'chat-a', automation: null }]);
  expect(await telegramDestination()!.send('A chat finished.', { sessionId: 'chat-a' })).toBe(true);
  telegram.say('Also run the tests', telegram.lastMessageId);
  await vi.waitFor(() => expect(telegram.sent.at(-1)?.text).toBe('On its way to the chat.'), { timeout: 5_000, interval: 10 });
  expect(app.steer).toHaveBeenCalledWith('chat-a', 'Also run the tests');
});

// CodeRabbit on #1990: a notification of a worker chat never lets the phone act on it.
it('refuses a Stop, a pause and a reply for a worker chat even when its notification is replied to', async () => {
  const telegram = fakeTelegram();
  const app = await start(telegram, [{ sessionId: 'worker-1', automation: 'Loop', working: true, own: false }]);
  expect(await telegramDestination()!.send('A chat finished.', { sessionId: 'worker-1' })).toBe(true);
  const notice = telegram.lastMessageId;
  for (const command of ['/stop', '/pause', 'please continue']) {
    telegram.say(command, notice);
    await vi.waitFor(() => expect(telegram.sent.at(-1)?.text).toBe('That chat cannot take messages from here.'), { timeout: 5_000, interval: 10 });
    telegram.sent.length = 0;
  }
  expect(app.stop).not.toHaveBeenCalled();
  expect(app.setAutomation).not.toHaveBeenCalled();
  expect(app.steer).not.toHaveBeenCalled();
});

// CodeRabbit on #1990: Telegram owns a pause only if its switch-off really took effect.
it('forgets the pause marker when the switch could not be turned off, and keeps it when it did', async () => {
  const chats: Array<{ sessionId: string; automation: 'Goal' | 'Loop' | null }> = [{ sessionId: 'chat-a', automation: 'Loop' }];
  const telegram = fakeTelegram();
  await start(telegram, chats, { setAutomation: async () => false });
  telegram.say('/pause');
  await vi.waitFor(() => expect(telegram.sent.at(-1)?.text).toBe('Could not do that. Open the chat in Chat On Steroids.'), { timeout: 5_000, interval: 10 });
  expect(await readDurable('telegram-paused')).toEqual([]);
});

it('forgets a pause the person undid and redid in the app, so /resume never turns it back on against their last choice', async () => {
  const chats: Array<{ sessionId: string; automation: 'Goal' | 'Loop' | null }> = [{ sessionId: 'chat-a', automation: 'Loop' }];
  const telegram = fakeTelegram();
  const app = await start(telegram, chats);
  telegram.say('/pause');
  await vi.waitFor(() => expect(telegram.sent.at(-1)?.text).toBe('Paused. /resume starts it again.'), { timeout: 5_000, interval: 10 });
  const { noteAutomationChanged } = await import('../src/main/telegram-app.js');
  // The person turns it on in the app, then off again.
  chats[0]!.automation = 'Loop'; noteAutomationChanged('chat-a', true);
  chats[0]!.automation = null; noteAutomationChanged('chat-a', false);
  app.setAutomation.mockClear();
  telegram.say('/resume');
  await vi.waitFor(() => expect(telegram.sent.at(-1)?.text).toBe('No chat was paused from here.'), { timeout: 5_000, interval: 10 });
  expect(app.setAutomation).not.toHaveBeenCalled();
  // The marker is dropped in memory at once and its file follows (fire and forget), so the file is waited for:
  // a slow disk (Windows CI) read it still holding the old marker.
  await vi.waitFor(async () => expect(await readDurable('telegram-paused')).toEqual([]), { timeout: 5_000, interval: 10 });
});

// CodeRabbit on #1990: an unknown chat is refused for Stop too, as it already was for pause and resume.
it('does not stop a chat that is no longer in the chat list, such as a worker that left it', async () => {
  const telegram = fakeTelegram();
  const app = await start(telegram, [{ sessionId: 'chat-a', automation: null }]);
  expect(await telegramDestination()!.send('A chat finished.', { sessionId: 'gone-worker' })).toBe(true);
  telegram.say('/stop', telegram.lastMessageId);
  await vi.waitFor(() => expect(telegram.sent.at(-1)?.text).toBe('Nothing is running there.'), { timeout: 5_000, interval: 10 });
  expect(app.stop).not.toHaveBeenCalled();
});

// CodeRabbit on #1990: a change by the person's own control, made while /pause is still writing, must not be undone.
it('keeps the pause marker the person ended in the app while another pause was still being written', async () => {
  const chats: Array<{ sessionId: string; automation: 'Goal' | 'Loop' | null }> = [{ sessionId: 'chat-a', automation: 'Loop' }, { sessionId: 'chat-b', automation: null }];
  await writeDurableNow('telegram-paused', ['chat-b']);
  const telegram = fakeTelegram();
  const app = await start(telegram, chats);
  const { noteAutomationChanged } = await import('../src/main/telegram-app.js');
  let release: () => void = () => undefined;
  gate.hold = new Promise<void>(resolve => { release = resolve; });
  try {
    gate.blocked = 0;
    telegram.say('/pause');
    // Waits until /pause's own write of the marker is really held.
    await vi.waitFor(() => expect(gate.blocked).toBe(1), { timeout: 5_000, interval: 5 });
    // While chat-a's marker is being written, the person turns chat-b on in the app: its marker ends at once.
    noteAutomationChanged('chat-b', true);
    chats[1]!.automation = null;
    release();
  } finally { release(); gate.hold = null; }
  await vi.waitFor(() => expect(telegram.sent.at(-1)?.text).toBe('Paused. /resume starts it again.'), { timeout: 5_000, interval: 10 });
  await flushDurable();
  expect(await readDurable('telegram-paused')).toEqual(['chat-a']);
  app.setAutomation.mockClear();
  telegram.say('/resume');
  await vi.waitFor(() => expect(telegram.sent.at(-1)?.text).toBe('Resumed.'), { timeout: 5_000, interval: 10 });
  expect(app.setAutomation).toHaveBeenCalledTimes(1);
  expect(app.setAutomation).toHaveBeenCalledWith('chat-a', true);
});
