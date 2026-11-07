/**
 * The app's one Telegram bot (#1934): the bot (telegram.ts) wired to secure storage for its token,
 * the durable store for the linked account, Electron's network and the window's state.
 */
import { readDurable, writeDurableNow } from './durable.js';
import { clearSecret, getSecret, setSecret } from './secrets.js';
import { createTelegram, isTelegramToken, type ChatAction, type TelegramLink, type TelegramText, type TelegramView } from './telegram.js';
import { telegramStatus, type StatusChat, type StatusText } from './telegram-status.js';
import type { MainText } from '../shared/main-texts.js';

const LINK_STATE = 'telegram-link';
/** Chats whose Goal or Loop `/pause` turned off: only these may `/resume` (2026-10-31). */
const PAUSED_STATE = 'telegram-paused';

export interface TelegramAppDeps {
  fetch(url: string, init: { method: string; body: string; headers: Record<string, string>; signal?: AbortSignal }): Promise<{ status: number; json(): Promise<unknown> }>;
  log(line: string): void;
  mainText(source: MainText): string;
  /** What the person's chats are doing, for `/status` and for what `/stop`, `/pause`, `/resume` can mean. */
  chats(): Promise<Array<StatusChat & { sessionId: string }>>;
  details(): boolean;
  deny(sessionId: string, cardId: string): Promise<'denied' | 'already' | 'failed'>;
  /** The app's Stop on the chat's running turn; `nothing` when none runs. */
  stop(sessionId: string): Promise<'done' | 'nothing' | 'failed'>;
  /** Goal or Loop off (keeping which), or back on as it was. False when the chat has no ChatGPT chat. */
  setAutomation(sessionId: string, on: boolean): Promise<boolean>;
  steer(sessionId: string, text: string): Promise<'sent' | 'queued' | 'off' | 'refused' | 'failed'>;
}

let bot: ReturnType<typeof createTelegram> | null = null;
let link: TelegramLink | null = null;
let paused = new Set<string>();
let appDeps: TelegramAppDeps | null = null;
const listeners = new Set<() => void>();

const fill = (text: string, values: readonly (string | number)[] = []) => values.reduce<string>((out, value, index) => out.replace(`{${index}}`, String(value)), text);

function validLink(raw: unknown): TelegramLink | null {
  const row = raw as Partial<TelegramLink> | null;
  return row && Number.isSafeInteger(row.userId) && Number.isSafeInteger(row.chatId) && typeof row.userName === 'string' &&
    typeof row.botName === 'string' && Number.isFinite(row.linkedAt)
    ? { userId: row.userId!, chatId: row.chatId!, userName: row.userName.slice(0, 64), botName: row.botName.slice(0, 64), linkedAt: row.linkedAt! }
    : null;
}

/**
 * Which chats a bare /stop, /pause or /resume can mean. /pause means the running Goal or Loop chats
 * first, and idle ones only when none runs: one running Loop beside seven idle old Goal and Loop
 * chats asked "Several chats could be meant" (live test, 2026-11-07).
 */
export function telegramTargets(action: ChatAction, chats: ReadonlyArray<StatusChat & { sessionId: string }>, pausedHere: ReadonlySet<string>): Array<{ sessionId: string }> {
  // The phone acts only on the person's own chats: never a worker, whose Stop or pause would take
  // work from the chat that started it (CodeRabbit on #1990).
  const own = chats.filter(chat => chat.own !== false);
  const pick = (rows: ReadonlyArray<StatusChat & { sessionId: string }>) => rows.map(chat => ({ sessionId: chat.sessionId }));
  // A held turn is running as far as Stop goes: the stop callback ends it too.
  if (action === 'stop') return pick(own.filter(chat => chat.working || chat.held === true));
  if (action === 'resume') return pick(own.filter(chat => pausedHere.has(chat.sessionId) && chat.automation === null));
  const automated = own.filter(chat => chat.automation !== null);
  const running = automated.filter(chat => chat.working);
  return pick(running.length ? running : automated);
}

/**
 * Changes one chat's pause marker. The change counts in memory at once and the write follows, so a
 * change from the person's own control while the write is still running can never be undone by it
 * (CodeRabbit on #1990). When the write fails, only this chat's marker goes back.
 */
async function updatePaused(sessionId: string, add: boolean): Promise<void> {
  const had = paused.has(sessionId);
  const next = new Set(paused);
  if (add) next.add(sessionId); else next.delete(sessionId);
  paused = next;
  try {
    await writeDurableNow(PAUSED_STATE, [...next]);
  } catch (error) {
    const undo = new Set(paused);
    if (had) undo.add(sessionId); else undo.delete(sessionId);
    paused = undo;
    throw error;
  }
}

/**
 * The person's own control turned a chat's Goal or Loop on or off. A pause Telegram made no longer
 * stands then: /resume must never turn it back on against what they did last (CodeRabbit on #1990).
 */
export function noteAutomationChanged(sessionId: string, on: boolean): void {
  if (!paused.has(sessionId) || !on) return;
  void updatePaused(sessionId, false).catch(() => undefined);
}

/** At startup: reads the linked account and, when there is one, starts listening. */
export async function startTelegram(deps: TelegramAppDeps): Promise<void> {
  appDeps = deps;
  link = validLink(await readDurable<unknown>(LINK_STATE).catch(() => null));
  const savedPaused = await readDurable<unknown>(PAUSED_STATE).catch(() => null);
  paused = new Set(Array.isArray(savedPaused) ? savedPaused.filter((id): id is string => typeof id === 'string' && id.length <= 200).slice(-200) : []);
  bot = createTelegram({
    token: () => getSecret('telegramBotToken'),
    link: () => link,
    saveLink: async next => { await writeDurableNow(LINK_STATE, next); link = next; },
    api: async (token, method, params, signal) => {
      // The token is part of Telegram's address: an error that quotes the address loses it here.
      const reply = await deps.fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', body: JSON.stringify(params), headers: { 'Content-Type': 'application/json' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(70_000)]) : AbortSignal.timeout(15_000)
      }).catch((error: unknown) => {
        throw new Error((error instanceof Error ? error.message : String(error)).split(token).join('<token>'));
      });
      const body = await reply.json().catch(() => null) as { ok?: boolean } | null;
      return body && typeof body === 'object' ? body as { ok: boolean } : { ok: false, error_code: reply.status };
    },
    now: () => Date.now(),
    log: deps.log,
    status: async details => telegramStatus(await deps.chats(), details, (source: StatusText, values) => fill(deps.mainText(source), values)),
    details: deps.details,
    deny: deps.deny,
    targets: async (action: ChatAction) => telegramTargets(action, await deps.chats(), paused),
    act: async (action: ChatAction, sessionId: string): Promise<'done' | 'nothing' | 'failed' | 'refused'> => {
      // Looked up now, not when the notification was sent: a reply to a worker's notification is
      // refused here, and so is a chat that was a worker meanwhile (CodeRabbit on #1990).
      const chat = (await deps.chats()).find(row => row.sessionId === sessionId);
      if (chat && chat.own === false) { deps.log(`telegram: /${action} refused: that chat is a worker`); return 'refused'; }
      // One rule for all three: a chat that is not in the list (a worker that left it) is left alone.
      if (!chat) return 'nothing';
      if (action === 'stop') return deps.stop(sessionId);
      if (action === 'pause') {
        if (chat.automation === null) return 'nothing';
        // Saved first: a pause /resume cannot find again would leave the chat off for good. Kept
        // only if the switch really went off, so a failed pause is never resumed later.
        await updatePaused(sessionId, true);
        if (await deps.setAutomation(sessionId, false)) return 'done';
        const now = (await deps.chats()).find(row => row.sessionId === sessionId);
        if (now && now.automation !== null) await updatePaused(sessionId, false);
        return 'failed';
      }
      // Turned back on in the app meanwhile, or never paused from here: nothing to resume.
      if (!paused.has(sessionId) || chat.automation !== null) {
        if (paused.has(sessionId)) await updatePaused(sessionId, false);
        return 'nothing';
      }
      if (!await deps.setAutomation(sessionId, true)) return 'failed';
      await updatePaused(sessionId, false);
      return 'done';
    },
    steer: async (sessionId, text) => {
      const chat = (await deps.chats()).find(row => row.sessionId === sessionId);
      if (chat && chat.own === false) { deps.log('telegram: a reply was refused: that chat is a worker'); return 'refused'; }
      return deps.steer(sessionId, text);
    },
    text: (source: TelegramText, values) => fill(deps.mainText(source), values),
    changed: () => { for (const listener of listeners) listener(); },
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('stopped')); }, { once: true });
    }),
    random: count => [...crypto.getRandomValues(new Uint8Array(count))]
  });
  bot.start();
}

export function stopTelegram(): void { bot?.stop(); }

export function onTelegramChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function telegramView(): TelegramView {
  return bot?.view() ?? { state: 'off', botName: null, userName: null };
}

/** Saves a new bot token and shows the code that links the person's account. */
export async function connectTelegram(token: string): Promise<TelegramView> {
  if (!bot) throw new Error('Telegram is not ready yet. Try again in a moment.');
  const trimmed = token.trim();
  if (!isTelegramToken(trimmed)) {
    appDeps?.log('telegram: a bot token was refused before saving: it does not look like a token from @BotFather');
    throw new Error('This does not look like a bot token. Copy it again from @BotFather: digits, a colon, then letters and digits.');
  }
  await setSecret('telegramBotToken', trimmed);
  try {
    return await bot.connect();
  } catch (error) {
    await clearSecret('telegramBotToken').catch(() => undefined);
    throw error;
  }
}

/** Unlinks the account and forgets the token. */
export async function disconnectTelegram(): Promise<void> {
  await bot?.disconnect();
  await clearSecret('telegramBotToken');
}

/** The linked bot as a phone notification destination, or null. */
export function telegramDestination(): { send(text: string, about?: { sessionId?: string; cardId?: string }): Promise<boolean> } | null {
  return bot && link ? bot : null;
}

/** A test message to the linked account; throws a sentence when it did not arrive. */
export async function testTelegram(): Promise<void> {
  if (!bot || !link || !appDeps) throw new Error('Link a Telegram bot first.');
  if (!await bot.send(appDeps.mainText('This is a test from Chat On Steroids. Telegram notifications work.'))) {
    throw new Error('Telegram did not take the message. Check the connection, or link the bot again.');
  }
  appDeps.log('telegram: test sent');
}

export function resetTelegramForTests(): void { bot?.stop(); bot = null; link = null; paused = new Set(); appDeps = null; listeners.clear(); }
