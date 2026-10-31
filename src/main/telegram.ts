/**
 * Phone notifications through a Telegram bot of the person's own (#1934), beside ntfy.
 *
 * The person makes a bot with Telegram's @BotFather and gives the app its token, which stays in
 * secure storage and never appears in the window or the log. The app then shows a one-time code;
 * `/start <code>` sent to the bot from their own Telegram account links the bot to exactly that
 * account. From then on the bot sends the phone notifications there, answers `/status` and
 * `/help`, and offers **Deny** under an approval: never Allow, which waits for its own security
 * review (Haz on #1934). Messages from any other account are ignored and logged.
 *
 * The app talks to Telegram itself, outgoing only: it asks for new messages with Telegram's long
 * polling, so there is no server of ours and no open port. With the app closed or the computer
 * asleep nothing is answered, and the bot does not pretend otherwise. Two apps polling one bot
 * collide (Telegram answers 409); the app says so instead of fighting over it.
 */

/** The Telegram account the bot is linked to. Kept in the durable store, never with the token. */
export interface TelegramLink {
  userId: number;
  chatId: number;
  /** For the window only: the account's @name, or its first name. */
  userName: string;
  botName: string;
  linkedAt: number;
}

export type TelegramState = 'off' | 'pairing' | 'linked' | 'conflict' | 'token-refused';

export interface TelegramView {
  state: TelegramState;
  botName: string | null;
  userName: string | null;
  /** While pairing: the code to send, and until when it works. */
  code?: string;
  codeUntil?: number;
}

export interface TelegramReply { ok: boolean; result?: unknown; error_code?: number; description?: string }

export interface TelegramDeps {
  token(): Promise<string | null>;
  link(): TelegramLink | null;
  saveLink(link: TelegramLink | null): Promise<void>;
  /** One Bot API call. Throws only when Telegram could not be reached. */
  api(token: string, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<TelegramReply>;
  now(): number;
  log(line: string): void;
  /** The answer to `/status`, already in the app's language; `details` adds chat names. */
  status(details: boolean): Promise<string>;
  details(): boolean;
  /** Presses Deny on that exact approval card, as the app's own Deny does. */
  deny(sessionId: string, cardId: string): Promise<'denied' | 'already' | 'failed'>;
  text(source: TelegramText, values?: readonly (string | number)[]): string;
  changed(): void;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  random(count: number): number[];
}

/** The texts the bot writes, translated by the app's main-text catalogs. */
export type TelegramText =
  | 'Connected to Chat On Steroids. Its notifications arrive here.'
  | 'This code is not valid any more. Get a new one in Chat On Steroids: Settings → Phone notifications → Telegram.'
  | 'Chat On Steroids sends its notifications here. /status shows what your chats are doing.'
  | 'I know /status and /help.'
  | 'Deny'
  | 'Denied from Telegram at {0}.'
  | 'Already answered.'
  | 'Could not deny it. Open the chat in Chat On Steroids.';

const POLL_SECONDS = 50;
/** A command older than this, sent while the app was closed, is not answered late. */
const STALE_MS = 2 * 60_000;
const PAIRING_MS = 10 * 60_000;
const RETRY_MS = [5_000, 15_000, 30_000, 60_000] as const;
const CONFLICT_RETRY_MS = 60_000;
/** Deny buttons remembered for their messages; older buttons say they are from an older message. */
const MAX_BUTTONS = 200;
const TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const isTelegramToken = (token: string): boolean => TOKEN.test(token.trim());

type Update = {
  update_id: number;
  message?: { message_id: number; date: number; text?: string; chat: { id: number; type: string }; from?: { id: number; is_bot?: boolean; username?: string; first_name?: string } };
  callback_query?: { id: string; data?: string; from: { id: number }; message?: { message_id: number; chat: { id: number }; text?: string } };
};

export function createTelegram(deps: TelegramDeps) {
  let state: TelegramState = deps.link() ? 'linked' : 'off';
  let botName: string | null = deps.link()?.botName ?? null;
  let pairing: { code: string; until: number } | null = null;
  let loop: AbortController | null = null;
  let offset = 0;
  let strangersLoggedAt = -Infinity;
  const buttons = new Map<string, { sessionId: string; cardId: string }>();
  let nextButton = 1;

  const setState = (next: TelegramState) => { if (state !== next) { state = next; deps.changed(); } };
  const newCode = () => deps.random(8).map(byte => CODE_ALPHABET[(byte & 0xff) % CODE_ALPHABET.length]).join('');

  async function call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<TelegramReply> {
    const token = await deps.token();
    if (!token) return { ok: false, description: 'no token' };
    return deps.api(token, method, params, signal);
  }

  async function reply(chatId: number, text: string, extra: Record<string, unknown> = {}): Promise<TelegramReply | null> {
    try {
      const answer = await call('sendMessage', { chat_id: chatId, text, ...extra });
      if (!answer.ok) deps.log(`telegram: Telegram refused a message (${answer.error_code ?? 'no code'})`);
      return answer;
    } catch (error) {
      deps.log(`telegram: could not reach Telegram to send a message: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async function handleMessage(message: NonNullable<Update['message']>): Promise<void> {
    const link = deps.link();
    const from = message.from;
    if (message.chat.type !== 'private' || !from || from.is_bot) {
      deps.log('telegram: ignored a message that is not a private message from a person');
      return;
    }
    const text = (message.text ?? '').trim();
    const [command = '', argument = ''] = text.split(/\s+/, 2);
    const name = command.replace(/@\w+$/, '').toLowerCase();
    if (!link || link.userId !== from.id) {
      // Only `/start <code>` while a code is on screen links an account; anything else from an
      // account that is not the linked one gets no answer at all.
      if (name === '/start' && pairing && !link) {
        if (argument.toUpperCase() !== pairing.code || deps.now() > pairing.until) {
          deps.log('telegram: a /start came with a code that is not the one on screen, or came too late');
          await reply(message.chat.id, deps.text('This code is not valid any more. Get a new one in Chat On Steroids: Settings → Phone notifications → Telegram.'));
          return;
        }
        const linked: TelegramLink = { userId: from.id, chatId: message.chat.id, userName: from.username ? `@${from.username}` : (from.first_name ?? '').slice(0, 64),
          botName: botName ?? '', linkedAt: deps.now() };
        await deps.saveLink(linked);
        pairing = null;
        deps.log('telegram: linked to the Telegram account that sent the code');
        setState('linked');
        await reply(message.chat.id, deps.text('Connected to Chat On Steroids. Its notifications arrive here.'));
        return;
      }
      if (deps.now() - strangersLoggedAt >= 60_000) {
        strangersLoggedAt = deps.now();
        deps.log('telegram: ignored a message from a Telegram account that is not the linked one');
      }
      return;
    }
    if (deps.now() - message.date * 1000 > STALE_MS) {
      deps.log(`telegram: did not answer ${name.startsWith('/') ? name : 'a message'} sent while the app could not answer`);
      return;
    }
    if (name === '/status') {
      deps.log('telegram: answered /status');
      await reply(message.chat.id, await deps.status(deps.details()));
    } else if (name === '/help' || name === '/start') {
      deps.log(`telegram: answered ${name}`);
      await reply(message.chat.id, deps.text('Chat On Steroids sends its notifications here. /status shows what your chats are doing.'));
    } else {
      deps.log('telegram: answered a message that is no command it knows');
      await reply(message.chat.id, deps.text('I know /status and /help.'));
    }
  }

  async function handleButton(query: NonNullable<Update['callback_query']>): Promise<void> {
    const link = deps.link();
    const answer = (text: string) => call('answerCallbackQuery', { callback_query_id: query.id, text }).catch(() => null);
    if (!link || query.from.id !== link.userId) {
      deps.log('telegram: ignored a button pressed by a Telegram account that is not the linked one');
      return;
    }
    const target = query.data?.startsWith('deny:') ? buttons.get(query.data.slice(5)) : undefined;
    if (!target) {
      deps.log('telegram: a Deny button from an older message was pressed; nothing was answered');
      await answer(deps.text('Already answered.'));
      return;
    }
    const result = await deps.deny(target.sessionId, target.cardId).catch(() => 'failed' as const);
    buttons.delete(query.data!.slice(5));
    deps.log(`telegram: Deny pressed for an approval in chat ${target.sessionId}: ${result}`);
    const said = result === 'denied' ? deps.text('Denied from Telegram at {0}.', [clock(deps.now())])
      : result === 'already' ? deps.text('Already answered.') : deps.text('Could not deny it. Open the chat in Chat On Steroids.');
    await answer(said);
    if (query.message) {
      await call('editMessageText', { chat_id: query.message.chat.id, message_id: query.message.message_id,
        text: `${query.message.text ?? ''}\n\n${said}`.trim(), reply_markup: { inline_keyboard: [] } }).catch(() => null);
    }
  }

  async function poll(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      let answer: TelegramReply;
      try {
        answer = await call('getUpdates', { offset, timeout: POLL_SECONDS, allowed_updates: ['message', 'callback_query'] }, signal);
      } catch (error) {
        if (signal.aborted) return;
        const wait = RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]!;
        if (failures === 1) deps.log(`telegram: could not reach Telegram (${error instanceof Error ? error.message : String(error)}); trying again`);
        await deps.sleep(wait, signal).catch(() => undefined);
        continue;
      }
      if (!answer.ok) {
        if (answer.error_code === 401 || answer.error_code === 404) {
          deps.log('telegram: Telegram refused the bot token; the bot stops until a new token is given');
          setState('token-refused');
          return;
        }
        if (answer.error_code === 409) {
          if (state !== 'conflict') deps.log('telegram: another app is reading this bot\'s messages (another computer?); trying again in a minute');
          setState('conflict');
          await deps.sleep(CONFLICT_RETRY_MS, signal).catch(() => undefined);
          continue;
        }
        const wait = RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]!;
        deps.log(`telegram: Telegram answered an error (${answer.error_code ?? 'no code'}); trying again`);
        await deps.sleep(wait, signal).catch(() => undefined);
        continue;
      }
      if (failures > 0) deps.log('telegram: reached Telegram again');
      failures = 0;
      if (state === 'conflict') setState(deps.link() ? 'linked' : pairing ? 'pairing' : 'off');
      const updates = Array.isArray(answer.result) ? answer.result as Update[] : [];
      for (const update of updates) {
        if (signal.aborted) return;
        offset = Math.max(offset, update.update_id + 1);
        try {
          if (update.message) await handleMessage(update.message);
          else if (update.callback_query) await handleButton(update.callback_query);
        } catch (error) {
          deps.log(`telegram: could not handle a message: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // Pairing ends with its code: polling then runs only for a linked bot.
      if (!deps.link() && pairing && deps.now() > pairing.until) {
        pairing = null;
        deps.log('telegram: the linking code ran out; the bot is not linked');
        setState('off');
        return;
      }
    }
  }

  function startLoop(): void {
    if (loop) return;
    const controller = new AbortController();
    loop = controller;
    void poll(controller.signal).finally(() => { if (loop === controller) loop = null; });
  }

  function stopLoop(): void {
    loop?.abort();
    loop = null;
  }

  return {
    view(): TelegramView {
      const link = deps.link();
      return { state, botName: link?.botName ?? botName, userName: link?.userName ?? null,
        ...(state === 'pairing' && pairing ? { code: pairing.code, codeUntil: pairing.until } : {}) };
    },
    /** At app start: a linked bot listens again. */
    start(): void {
      if (deps.link()) { state = 'linked'; startLoop(); }
    },
    stop: stopLoop,
    /**
     * Checks a new token with Telegram and shows a code to link the account with. The caller has
     * saved the token; a token Telegram refuses throws a sentence for the window.
     */
    async connect(): Promise<TelegramView> {
      let me: TelegramReply;
      try { me = await call('getMe', {}); } catch {
        throw new Error('Telegram could not be reached. Check the connection and try again.');
      }
      const bot = me.result as { username?: string; is_bot?: boolean } | undefined;
      if (!me.ok || !bot?.username) {
        deps.log('telegram: Telegram refused the bot token');
        throw new Error('Telegram does not accept this bot token. Copy it again from @BotFather.');
      }
      stopLoop();
      await deps.saveLink(null);
      botName = `@${bot.username}`;
      // Messages the bot got before this code was shown are not for it.
      try {
        const pending = await call('getUpdates', { offset: -1, timeout: 0 });
        const last = Array.isArray(pending.result) ? (pending.result as Update[]).at(-1) : undefined;
        offset = last ? last.update_id + 1 : 0;
      } catch { offset = 0; }
      pairing = { code: newCode(), until: deps.now() + PAIRING_MS };
      deps.log('telegram: the bot token works; waiting for /start with the code shown in Settings');
      state = 'pairing';
      deps.changed();
      startLoop();
      return this.view();
    },
    /** Forgets the link (the caller removes the token) and stops listening. */
    async disconnect(): Promise<void> {
      stopLoop();
      pairing = null;
      buttons.clear();
      await deps.saveLink(null);
      botName = null;
      deps.log('telegram: disconnected');
      setState('off');
    },
    /** One notification, with Deny under it for an approval. False when it did not go out. */
    async send(text: string, approval?: { sessionId: string; cardId: string }): Promise<boolean> {
      const link = deps.link();
      if (!link) return false;
      let markup: Record<string, unknown> = {};
      let id: string | null = null;
      if (approval) {
        id = String(nextButton++);
        buttons.set(id, approval);
        while (buttons.size > MAX_BUTTONS) buttons.delete(buttons.keys().next().value!);
        markup = { reply_markup: { inline_keyboard: [[{ text: deps.text('Deny'), callback_data: `deny:${id}` }]] } };
      }
      const answer = await reply(link.chatId, text, markup);
      if (!answer?.ok && id) buttons.delete(id);
      return !!answer?.ok;
    }
  };
}

const clock = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
