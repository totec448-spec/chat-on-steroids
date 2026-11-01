import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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

function start(telegram: ReturnType<typeof fakeTelegram>, chats: Array<{ sessionId: string; automation: 'Goal' | 'Loop' | null; working?: boolean }>) {
  const setAutomation = vi.fn(async (sessionId: string, on: boolean) => {
    const chat = chats.find(row => row.sessionId === sessionId)!;
    chat.automation = on ? 'Goal' : null;
    return true;
  });
  const steer = vi.fn(async () => 'sent' as const);
  return startTelegram({
    fetch: telegram.fetch as never,
    log: () => undefined,
    mainText: source => source,
    chats: async () => chats.map(chat => ({ title: chat.sessionId, approval: false, working: chat.working ?? false, ...chat })),
    details: () => false,
    deny: async () => 'denied',
    stop: async () => 'done',
    setAutomation,
    steer
  }).then(() => ({ setAutomation, steer }));
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
