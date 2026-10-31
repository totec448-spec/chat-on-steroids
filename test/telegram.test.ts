import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTelegram, isTelegramToken, type TelegramLink, type TelegramReply } from '../src/main/telegram.js';
import { telegramStatus } from '../src/main/telegram-status.js';

const TOKEN = '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ1';
const ME = 4242, STRANGER = 777;

/** A scripted Telegram: getUpdates hands out what tests queue, then waits like a long poll. */
function fakeTelegram(options: { token?: string | null; link?: TelegramLink | null; now?: () => number } = {}) {
  const calls: Array<{ method: string; params: Record<string, any> }> = [];
  const batches: Array<TelegramReply | Error> = [];
  let waiting: ((reply: TelegramReply | Error) => void) | null = null;
  let link = options.link ?? null;
  let token = options.token === undefined ? TOKEN : options.token;
  let update = 100;
  const logs: string[] = [];
  const changes = vi.fn();
  const deny = vi.fn(async () => 'denied' as 'denied' | 'already' | 'failed');
  let polls = 0;
  const now = options.now ?? (() => Date.now());
  const replies: Record<string, (params: Record<string, any>) => TelegramReply> = {
    getMe: () => ({ ok: true, result: { username: 'cos_test_bot', is_bot: true } }),
    sendMessage: () => ({ ok: true, result: { message_id: 1 } }),
    answerCallbackQuery: () => ({ ok: true }),
    editMessageText: () => ({ ok: true })
  };
  const bot = createTelegram({
    token: async () => token,
    link: () => link,
    saveLink: async next => { link = next; },
    api: async (_token, method, params, signal) => {
      calls.push({ method, params });
      if (method === 'getUpdates' && params.timeout === 0) return { ok: true, result: [{ update_id: 99 }] };
      if (method === 'getUpdates') {
        polls++;
        const next = batches.shift();
        if (next instanceof Error) throw next;
        if (next) return next;
        // A long poll: it answers when something arrives, as Telegram does.
        return new Promise<TelegramReply>((resolve, reject) => {
          waiting = reply => { waiting = null; if (reply instanceof Error) reject(reply); else resolve(reply); };
          signal?.addEventListener('abort', () => { waiting = null; reject(new Error('aborted')); }, { once: true });
        });
      }
      return replies[method]?.(params) ?? { ok: true };
    },
    now,
    log: line => logs.push(line),
    status: async details => details ? 'status with names' : 'status counts',
    details: () => false,
    deny,
    text: (source, values = []) => values.reduce<string>((out, value, index) => out.replace(`{${index}}`, String(value)), source),
    changed: changes,
    sleep: async () => undefined,
    random: count => Array.from({ length: count }, (_, index) => index)
  });
  const deliver = (reply: TelegramReply | Error) => { if (waiting && !batches.length) waiting(reply); else batches.push(reply); };
  const message = (from: number, text: string, extra: Record<string, unknown> = {}) => ({ update_id: update++, message: {
    message_id: update, date: Math.floor(now() / 1000), text, chat: { id: from, type: 'private' }, from: { id: from, username: from === ME ? 'me' : 'other' }, ...extra } });
  const button = (from: number, data: string) => ({ update_id: update++, callback_query: { id: `q${update}`, data, from: { id: from },
    message: { message_id: 55, chat: { id: ME }, text: 'A chat is waiting for you.' } } });
  return {
    bot, calls, logs, changes, deny, replies,
    get link() { return link; },
    setToken(next: string | null) { token = next; },
    queue(...updates: unknown[]) { deliver({ ok: true, result: updates }); },
    queueReply(reply: TelegramReply | Error) { deliver(reply); },
    message, button,
    get polls() { return polls; },
    sent: (method = 'sendMessage') => calls.filter(call => call.method === method).map(call => call.params),
    /** Until the bot waits on its next long poll, everything queued handled. */
    settled: () => vi.waitFor(() => { expect(batches).toHaveLength(0); expect(waiting).not.toBeNull(); })
  };
}

let current: ReturnType<typeof fakeTelegram> | null = null;
afterEach(() => { current?.bot.stop(); current = null; });

const linked = (): TelegramLink => ({ userId: ME, chatId: ME, userName: '@me', botName: '@cos_test_bot', linkedAt: 1 });

it('knows a bot token from @BotFather when it sees one', () => {
  expect(isTelegramToken(TOKEN)).toBe(true);
  expect(isTelegramToken(` ${TOKEN} `)).toBe(true);
  for (const bad of ['', 'abc', '123:short', `${TOKEN} extra`, 'bot123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ1']) expect(isTelegramToken(bad)).toBe(false);
});

describe('linking', () => {
  it('links exactly the account that sends the code shown, and answers it there', async () => {
    const telegram = current = fakeTelegram();
    const view = await telegram.bot.connect();
    expect(view).toMatchObject({ state: 'pairing', botName: '@cos_test_bot', code: 'ABCDEFGH' });
    // Messages from before the code was shown are skipped: the first poll starts after them.
    expect(telegram.calls.find(call => call.method === 'getUpdates' && call.params.timeout !== 0)?.params.offset).toBe(100);
    telegram.queue(telegram.message(STRANGER, '/start WRONGCOD'), telegram.message(ME, '/start abcdefgh'));
    await telegram.settled();
    expect(telegram.link).toMatchObject({ userId: ME, chatId: ME, userName: '@me', botName: '@cos_test_bot' });
    expect(telegram.bot.view()).toMatchObject({ state: 'linked', userName: '@me' });
    expect(telegram.sent()).toEqual([
      { chat_id: STRANGER, text: expect.stringContaining('This code is not valid any more') },
      { chat_id: ME, text: 'Connected to Chat On Steroids. Its notifications arrive here.' }
    ]);
    expect(telegram.logs).toContain('telegram: linked to the Telegram account that sent the code');
    // The token never reaches a log line.
    expect(telegram.logs.join('\n')).not.toContain(TOKEN);
  });

  it('refuses a token Telegram does not accept, with a sentence for the window', async () => {
    const telegram = current = fakeTelegram();
    telegram.replies.getMe = () => ({ ok: false, error_code: 401, description: 'Unauthorized' });
    await expect(telegram.bot.connect()).rejects.toThrow('Telegram does not accept this bot token. Copy it again from @BotFather.');
    expect(telegram.bot.view().state).toBe('off');
  });

  it('gives up the code after ten minutes and stops listening', async () => {
    let now = 1_800_000_000_000;
    const telegram = current = fakeTelegram({ now: () => now });
    await telegram.bot.connect();
    now += 11 * 60_000;
    telegram.queue(telegram.message(ME, '/start ABCDEFGH'));
    await vi.waitFor(() => expect(telegram.bot.view().state).toBe('off'));
    expect(telegram.link).toBeNull();
    expect(telegram.logs).toContain('telegram: the linking code ran out; the bot is not linked');
  });

  it('forgets the link when disconnected', async () => {
    const telegram = current = fakeTelegram({ link: linked() });
    telegram.bot.start();
    await telegram.settled();
    await telegram.bot.disconnect();
    expect(telegram.link).toBeNull();
    expect(telegram.bot.view()).toEqual({ state: 'off', botName: null, userName: null });
  });
});

describe('a linked bot', () => {
  it('answers /status and /help to its account only, and nothing sent while the app could not answer', async () => {
    let now = 1_800_000_000_000;
    const telegram = current = fakeTelegram({ link: linked(), now: () => now });
    telegram.bot.start();
    const old = telegram.message(ME, '/status');
    old.message.date -= 3 * 60;
    telegram.queue(old, telegram.message(STRANGER, '/status'), telegram.message(STRANGER, '/help'), telegram.message(ME, '/status'),
      telegram.message(ME, '/help@cos_test_bot'), telegram.message(ME, 'hello'));
    await telegram.settled();
    expect(telegram.sent()).toEqual([
      { chat_id: ME, text: 'status counts' },
      { chat_id: ME, text: 'Chat On Steroids sends its notifications here. /status shows what your chats are doing.' },
      { chat_id: ME, text: 'I know /status and /help.' }
    ]);
    // A stranger is ignored and said once a minute, not per message.
    expect(telegram.logs.filter(line => line.includes('not the linked one'))).toHaveLength(1);
    expect(telegram.logs).toContain('telegram: did not answer /status sent while the app could not answer');
    // A group chat is not the person's private chat with the bot.
    telegram.queue({ update_id: 500, message: { message_id: 1, date: Math.floor(now / 1000), text: '/status', chat: { id: -1, type: 'group' }, from: { id: ME } } });
    await telegram.settled();
    expect(telegram.sent()).toHaveLength(3);
  });

  it('puts Deny under an approval, answers it once, and marks the message', async () => {
    const telegram = current = fakeTelegram({ link: linked() });
    telegram.bot.start();
    expect(await telegram.bot.send('A chat is waiting for you.', { sessionId: 's1', cardId: 'card-1' })).toBe(true);
    const [sent] = telegram.sent();
    expect(sent).toMatchObject({ chat_id: ME, reply_markup: { inline_keyboard: [[{ text: 'Deny', callback_data: 'deny:1' }]] } });
    // Never an Allow button: that waits for its own security review (#1934).
    expect(JSON.stringify(sent)).not.toMatch(/allow/i);
    telegram.queue(telegram.button(STRANGER, 'deny:1'), telegram.button(ME, 'deny:1'), telegram.button(ME, 'deny:1'));
    await telegram.settled();
    expect(telegram.deny).toHaveBeenCalledOnce();
    expect(telegram.deny).toHaveBeenCalledWith('s1', 'card-1');
    expect(telegram.sent('answerCallbackQuery').map(call => call.text)).toEqual([expect.stringMatching(/^Denied from Telegram at /), 'Already answered.']);
    expect(telegram.sent('editMessageText')[0]).toMatchObject({ chat_id: ME, message_id: 55, reply_markup: { inline_keyboard: [] },
      text: expect.stringMatching(/^A chat is waiting for you\.\n\nDenied from Telegram at /) });
    expect(telegram.logs).toContain('telegram: ignored a button pressed by a Telegram account that is not the linked one');
  });

  it('says when the card was answered at the computer first', async () => {
    const telegram = current = fakeTelegram({ link: linked() });
    telegram.deny.mockResolvedValueOnce('already');
    telegram.bot.start();
    await telegram.bot.send('A chat is waiting for you.', { sessionId: 's1', cardId: 'card-1' });
    telegram.queue(telegram.button(ME, 'deny:1'));
    await telegram.settled();
    expect(telegram.sent('answerCallbackQuery').map(call => call.text)).toEqual(['Already answered.']);
  });

  it('sends nothing, and offers no button, without a link', async () => {
    const telegram = current = fakeTelegram();
    expect(await telegram.bot.send('A chat is waiting for you.', { sessionId: 's1', cardId: 'card-1' })).toBe(false);
    expect(telegram.sent()).toEqual([]);
  });
});

describe('when Telegram is in the way', () => {
  it('says another app reads the bot, and comes back when it stops', async () => {
    const telegram = current = fakeTelegram({ link: linked() });
    telegram.queueReply({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' });
    telegram.queueReply({ ok: false, error_code: 409 });
    // The other app stopped: the next long poll ends normally, with nothing new.
    telegram.queue();
    telegram.bot.start();
    await vi.waitFor(() => expect(telegram.polls).toBeGreaterThanOrEqual(3));
    await telegram.settled();
    expect(telegram.bot.view().state).toBe('linked');
    expect(telegram.logs.filter(line => line.includes('another app is reading this bot'))).toHaveLength(1);
    expect(telegram.changes).toHaveBeenCalledTimes(2);
  });

  it('stops on a token Telegram refuses, and says so', async () => {
    const telegram = current = fakeTelegram({ link: linked() });
    telegram.queueReply({ ok: false, error_code: 401 });
    telegram.bot.start();
    await vi.waitFor(() => expect(telegram.bot.view().state).toBe('token-refused'));
    expect(telegram.polls).toBe(1);
  });

  it('keeps trying when Telegram cannot be reached, saying it once', async () => {
    const telegram = current = fakeTelegram({ link: linked() });
    telegram.queueReply(new Error('getaddrinfo ENOTFOUND api.telegram.org'));
    telegram.queueReply(new Error('getaddrinfo ENOTFOUND api.telegram.org'));
    telegram.queue();
    telegram.bot.start();
    await telegram.settled();
    expect(telegram.logs.filter(line => line.startsWith('telegram: could not reach Telegram'))).toHaveLength(1);
    expect(telegram.logs).toContain('telegram: reached Telegram again');
  });
});

describe('/status', () => {
  const text = (source: string, values: readonly (string | number)[] = []) => values.reduce<string>((out, value, index) => out.replace(`{${index}}`, String(value)), source);
  const chat = (title: string, over: Partial<{ approval: boolean; working: boolean; automation: 'Goal' | 'Loop' | null }> = {}) =>
    ({ title, approval: false, working: false, automation: null, ...over });

  it('counts without names, and names the chats that wait first with them', () => {
    const chats = [chat('Idle'), chat('Build', { working: true, automation: 'Goal' }), chat('Deploy', { approval: true, working: true })];
    expect(telegramStatus(chats, false, text)).toBe('Waiting for your approval: 1\nWorking: 1');
    expect(telegramStatus(chats, true, text)).toBe('Waiting for your approval: 1\nWorking: 1\n\n• Deploy — waits for your approval\n• Build — working · Goal');
    expect(telegramStatus([chat('Idle')], true, text)).toBe('Nothing is running and nothing waits for you.');
  });

  it('keeps a long list short', () => {
    const chats = Array.from({ length: 11 }, (_, index) => chat(`Chat ${index}`, { working: true }));
    const answer = telegramStatus(chats, true, text);
    expect(answer.split('\n').filter(line => line.startsWith('•'))).toHaveLength(8);
    expect(answer.endsWith('3 more')).toBe(true);
  });
});
