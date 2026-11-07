import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTelegram, isTelegramToken, type TelegramLink, type TelegramReply } from '../src/main/telegram.js';
import { statusChatsFrom, telegramStatus } from '../src/main/telegram-status.js';

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
  // Phase 2: what /stop, /pause and /resume could act on, the action, and a reply sent to a chat.
  const targets = vi.fn(async (_action: 'stop' | 'pause' | 'resume') => [] as Array<{ sessionId: string }>);
  const act = vi.fn(async (_action: 'stop' | 'pause' | 'resume', _sessionId: string) => 'done' as 'done' | 'nothing' | 'failed');
  const steer = vi.fn(async (_sessionId: string, _text: string) => 'sent' as 'sent' | 'queued' | 'off' | 'refused' | 'failed');
  let messageId = 1000;
  let polls = 0;
  const now = options.now ?? (() => Date.now());
  const replies: Record<string, (params: Record<string, any>) => TelegramReply> = {
    getMe: () => ({ ok: true, result: { username: 'cos_test_bot', is_bot: true } }),
    sendMessage: () => ({ ok: true, result: { message_id: ++messageId } }),
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
    targets,
    act,
    steer,
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
    bot, calls, logs, changes, deny, replies, targets, act, steer,
    /** The id Telegram gave the last message the bot sent. */
    get lastMessageId() { return messageId; },
    get link() { return link; },
    setToken(next: string | null) { token = next; },
    queue(...updates: unknown[]) { deliver({ ok: true, result: updates }); },
    queueReply(reply: TelegramReply | Error) { deliver(reply); },
    message, button,
    get polls() { return polls; },
    sent: (method = 'sendMessage') => calls.filter(call => call.method === method).map(call => call.params),
    /** Until the bot waits on its next long poll, everything queued handled. */
    settled: () => vi.waitFor(() => { expect(batches).toHaveLength(0); expect(waiting).not.toBeNull(); }, { timeout: 10_000 })
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

  // Live test 2026-11-07: a plain /start (Telegram's Start button, or typed) got "This code is not valid
  // any more" although no code was sent. It says how to link instead; a wrong code still gets the old answer.
  it('answers a /start without a code with how to link, not with an invalid code', async () => {
    const telegram = current = fakeTelegram();
    await telegram.bot.connect();
    telegram.queue(telegram.message(ME, '/start'));
    await telegram.settled();
    expect(telegram.link).toBeNull();
    expect(telegram.sent()).toEqual([
      { chat_id: ME, text: 'Send /start with the code shown in Chat On Steroids: Settings → Phone notifications → Telegram.' }
    ]);
    telegram.queue(telegram.message(ME, '/start abcdefgh'));
    await telegram.settled();
    expect(telegram.link).toMatchObject({ userId: ME });
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
    await vi.waitFor(() => expect(telegram.bot.view().state).toBe('off'), { timeout: 10_000 });
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
      { chat_id: ME, text: 'Chat On Steroids notifications arrive here. Commands: /status, /stop, /pause, /resume. Reply to a notification to send that chat a message.' },
      { chat_id: ME, text: 'I know /status, /stop, /pause, /resume and /help. Reply to a notification to send that chat a message.' }
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
    await vi.waitFor(() => expect(telegram.polls).toBeGreaterThanOrEqual(3), { timeout: 10_000 });
    await telegram.settled();
    expect(telegram.bot.view().state).toBe('linked');
    expect(telegram.logs.filter(line => line.includes('another app is reading this bot'))).toHaveLength(1);
    expect(telegram.changes).toHaveBeenCalledTimes(2);
  });

  it('stops on a token Telegram refuses, and says so', async () => {
    const telegram = current = fakeTelegram({ link: linked() });
    telegram.queueReply({ ok: false, error_code: 401 });
    telegram.bot.start();
    await vi.waitFor(() => expect(telegram.bot.view().state).toBe('token-refused'), { timeout: 10_000 });
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

// Phase 2 (2026-10-31): act on a chat from the phone. /stop and /pause only ever make less happen;
// a reply that becomes a message for the chat waits for its own switch, off by default.
describe('acting on chats', () => {
  const answered = (telegram: ReturnType<typeof fakeTelegram>) => telegram.sent().at(-1)?.text;
  const notified = async (telegram: ReturnType<typeof fakeTelegram>, sessionId: string) => {
    expect(await telegram.bot.send('A chat finished.', { sessionId })).toBe(true);
    return telegram.lastMessageId;
  };

  it('stops the chat whose notification the reply answers', async () => {
    const telegram = current = fakeTelegram({ link: linked() });
    telegram.bot.start();
    const notice = await notified(telegram, 'chat-a');
    await notified(telegram, 'chat-b');
    telegram.queue(telegram.message(ME, '/stop', { reply_to_message: { message_id: notice } }));
    await telegram.settled();
    expect(telegram.act).toHaveBeenCalledWith('stop', 'chat-a');
    expect(telegram.targets).not.toHaveBeenCalled();
    expect(answered(telegram)).toBe('Stopped.');
    expect(telegram.logs).toContain('telegram: /stop for chat chat-a: done');
  });

  it.each([
    ['/stop', 'stop', 'Nothing is running.'],
    ['/pause', 'pause', 'No chat has Goal or Loop on.'],
    ['/resume', 'resume', 'No chat was paused from here.']
  ] as const)('acts on the only chat %s can mean, says when there is none, and asks when there are several', async (command, action, none) => {
    const telegram = current = fakeTelegram({ link: linked() });
    telegram.bot.start();
    telegram.queue(telegram.message(ME, command));
    await telegram.settled();
    expect(telegram.act).not.toHaveBeenCalled();
    expect(answered(telegram)).toBe(none);
    telegram.targets.mockResolvedValue([{ sessionId: 'only' }]);
    telegram.queue(telegram.message(ME, command));
    await telegram.settled();
    expect(telegram.act).toHaveBeenCalledWith(action, 'only');
    telegram.act.mockClear();
    telegram.targets.mockResolvedValue([{ sessionId: 'one' }, { sessionId: 'two' }]);
    telegram.queue(telegram.message(ME, command));
    await telegram.settled();
    expect(telegram.act).not.toHaveBeenCalled();
    expect(answered(telegram)).toBe(`Several chats could be meant. Reply to that chat's notification with ${command}.`);
  });

  it.each([['done', 'Paused. /resume starts it again.'], ['nothing', 'Goal and Loop are not on there.'], ['failed', 'Could not do that. Open the chat in Chat On Steroids.']] as const)(
    'says what /pause did: %s', async (result, said) => {
      const telegram = current = fakeTelegram({ link: linked() });
      telegram.bot.start();
      telegram.act.mockResolvedValue(result);
      const notice = await notified(telegram, 'chat-a');
      telegram.queue(telegram.message(ME, '/pause', { reply_to_message: { message_id: notice } }));
      await telegram.settled();
      expect(answered(telegram)).toBe(said);
    });

  it.each([['sent', 'On its way to the chat.'], ['queued', 'Queued: it goes to the chat after its current answer.'],
    ['off', 'Sending messages to chats from Telegram is off. Turn it on in Chat On Steroids: Settings → Phone notifications → Telegram.'],
    ['refused', 'That chat cannot take messages from here.'], ['failed', 'Could not do that. Open the chat in Chat On Steroids.']] as const)(
    'sends a reply to a notification to that chat, and says how it went: %s', async (result, said) => {
      const telegram = current = fakeTelegram({ link: linked() });
      telegram.bot.start();
      telegram.steer.mockResolvedValue(result);
      const notice = await notified(telegram, 'chat-a');
      telegram.queue(telegram.message(ME, '  please also update the README  ', { reply_to_message: { message_id: notice } }));
      await telegram.settled();
      expect(telegram.steer).toHaveBeenCalledWith('chat-a', 'please also update the README');
      expect(answered(telegram)).toBe(said);
      // The words themselves never reach the log.
      expect(telegram.logs.join('\n')).not.toContain('README');
    });

  it('sends nothing for a reply to a message it does not know, or from another account', async () => {
    const telegram = current = fakeTelegram({ link: linked() });
    telegram.bot.start();
    telegram.queue(telegram.message(ME, 'do this', { reply_to_message: { message_id: 1 } }));
    await telegram.settled();
    expect(answered(telegram)).toBe('That notification is too old to answer. Send /status to see your chats.');
    const notice = await notified(telegram, 'chat-a');
    telegram.queue(telegram.message(STRANGER, 'do this', { reply_to_message: { message_id: notice } }),
      telegram.message(STRANGER, '/stop', { reply_to_message: { message_id: notice } }));
    await telegram.settled();
    expect(telegram.steer).not.toHaveBeenCalled();
    expect(telegram.act).not.toHaveBeenCalled();
  });

  it('does not act on a command or reply that waited while the app could not answer', async () => {
    let clock = Date.now();
    const telegram = current = fakeTelegram({ link: linked(), now: () => clock });
    telegram.bot.start();
    const notice = await notified(telegram, 'chat-a');
    const late = telegram.message(ME, '/stop', { reply_to_message: { message_id: notice } });
    const lateText = telegram.message(ME, 'go on', { reply_to_message: { message_id: notice } });
    clock += 3 * 60_000;
    telegram.queue(late, lateText);
    await telegram.settled();
    expect(telegram.act).not.toHaveBeenCalled();
    expect(telegram.steer).not.toHaveBeenCalled();
  });

  it('remembers which chat an approval notification is about, for a reply too', async () => {
    const telegram = current = fakeTelegram({ link: linked() });
    telegram.bot.start();
    expect(await telegram.bot.send('A chat is waiting for you.', { sessionId: 'chat-a', cardId: 'card-1' })).toBe(true);
    const notice = telegram.lastMessageId;
    expect(telegram.sent().at(-1)?.reply_markup?.inline_keyboard?.[0]?.[0]?.text).toBe('Deny');
    telegram.queue(telegram.message(ME, '/stop', { reply_to_message: { message_id: notice } }));
    await telegram.settled();
    expect(telegram.act).toHaveBeenCalledWith('stop', 'chat-a');
  });

  it('names every command in its help', async () => {
    const telegram = current = fakeTelegram({ link: linked() });
    telegram.bot.start();
    telegram.queue(telegram.message(ME, '/help'), telegram.message(ME, 'hello'));
    await telegram.settled();
    expect(telegram.sent().at(-2)?.text).toBe('Chat On Steroids notifications arrive here. Commands: /status, /stop, /pause, /resume. Reply to a notification to send that chat a message.');
    expect(answered(telegram)).toBe('I know /status, /stop, /pause, /resume and /help. Reply to a notification to send that chat a message.');
  });
});

// Live test 2026-11-07: /status said "Working: 6" while the app showed none working. It counted every
// stored open turn, also a sub-agent's from five days earlier. It now counts as the sidebar does.
it('counts a chat as working only while it really works, as the sidebar does', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const base = { id: 's', title: 'Old worker', conversationId: 'c', origin: null, updatedAt: now - 5 * 86_400_000,
    lastToolCallAt: now - 5 * 86_400_000, lastTurnEndAt: null, activeTurnId: 'stale-turn' } as unknown as Parameters<typeof statusChatsFrom>[0][number];
  const none = { goal: () => null, card: () => null, activityExpiresAt: () => null };
  expect(statusChatsFrom([base], none, now)).toEqual([expect.objectContaining({ title: 'Old worker', working: false })]);
  // The same chat while the app counts it as active.
  const live = { ...none, activityExpiresAt: () => now + 60_000 };
  expect(statusChatsFrom([{ ...base, lastToolCallAt: now - 1_000 }], live, now)).toEqual([expect.objectContaining({ working: true })]);
});

// Live test 2026-11-07: /pause asked "Several chats could be meant" with one Loop chat running and
// seven idle old Goal/Loop chats. A bare command means the running chats first.
it('lets a bare /pause mean the running Goal or Loop chat, and idle ones only when none runs', async () => {
  const { telegramTargets } = await import('../src/main/telegram-app.js');
  const chat = (sessionId: string, working: boolean, automation: 'Goal' | 'Loop' | null) => ({ sessionId, title: sessionId, working, approval: false, automation });
  const chats = [chat('running-loop', true, 'Loop'), chat('idle-goal', false, 'Goal'), chat('idle-loop', false, 'Loop'), chat('plain', true, null)];
  expect(telegramTargets('pause', chats, new Set())).toEqual([{ sessionId: 'running-loop' }]);
  expect(telegramTargets('pause', chats.filter(row => row.sessionId !== 'running-loop'), new Set())).toEqual([{ sessionId: 'idle-goal' }, { sessionId: 'idle-loop' }]);
  expect(telegramTargets('stop', chats, new Set())).toEqual([{ sessionId: 'running-loop' }, { sessionId: 'plain' }]);
  expect(telegramTargets('resume', [chat('was-paused', false, null), chat('other', false, null)], new Set(['was-paused']))).toEqual([{ sessionId: 'was-paused' }]);
});

// CodeRabbit on #1990: the phone acts only on the person's own chats, and a held turn counts as running.
it('keeps workers and helpers out of every bare Telegram command, and counts a held turn as running for /stop', async () => {
  const { telegramTargets } = await import('../src/main/telegram-app.js');
  const chat = (sessionId: string, patch: Record<string, unknown> = {}) => ({ sessionId, title: sessionId, working: false, approval: false, automation: null, own: true, held: false, ...patch });
  const chats = [chat('mine', { working: true }), chat('worker', { working: true, own: false }), chat('held', { held: true }), chat('idle')];
  expect(telegramTargets('stop', chats as never, new Set())).toEqual([{ sessionId: 'mine' }, { sessionId: 'held' }]);
  const looped = [chat('loop', { automation: 'Loop', working: true }), chat('worker-loop', { automation: 'Loop', working: true, own: false })];
  expect(telegramTargets('pause', looped as never, new Set())).toEqual([{ sessionId: 'loop' }]);
  expect(telegramTargets('resume', [chat('w', { own: false }), chat('p')] as never, new Set(['w', 'p']))).toEqual([{ sessionId: 'p' }]);
});

it('says the chats of /status without a worker or helper, as the sidebar lists the person\'s chats', async () => {
  const { statusChatsFrom } = await import('../src/main/telegram-status.js');
  const now = Date.parse('2026-11-07T12:00:00Z');
  const base = { title: 'x', conversationId: 'c', updatedAt: now, lastToolCallAt: now - 1000, lastTurnEndAt: null, activeTurnId: 't' };
  const none = { goal: () => null, card: () => null, activityExpiresAt: () => now + 60_000, held: () => false };
  const rows = statusChatsFrom([{ ...base, id: 'a', origin: null }, { ...base, id: 'w', origin: { kind: 'worker' } }, { ...base, id: 'h', origin: { kind: 'helper' } }] as never, none, now);
  expect(rows.map(row => [row.sessionId, row.own])).toEqual([['a', true], ['w', false]]);
});

// CodeRabbit on #1990: a new bot token must not keep the notices of the old bot. Telegram numbers messages per
// chat, so a reply in the new chat could otherwise name a session of the old one.
it('forgets the notices of the old bot when a new token is accepted', async () => {
  const telegram = current = fakeTelegram({ link: linked() });
  telegram.bot.start();
  expect(await telegram.bot.send('A chat finished.', { sessionId: 'old-chat' })).toBe(true);
  const oldNotice = telegram.lastMessageId;
  await telegram.bot.connect();
  telegram.queue(telegram.message(ME, '/start abcdefgh'));
  await telegram.settled();
  telegram.queue(telegram.message(ME, '/stop', { reply_to_message: { message_id: oldNotice } }));
  await telegram.settled();
  expect(telegram.act).not.toHaveBeenCalled();
  expect(telegram.sent().at(-1)?.text).toBe('That notification is too old to answer. Send /status to see your chats.');
});
