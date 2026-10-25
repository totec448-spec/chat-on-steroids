/**
 * Phone notifications through ntfy (https://ntfy.sh, or a server of one's own).
 *
 * The desktop notices tell someone at the computer. This tells them on their phone when they are
 * not: a chat that waits for them (an approval, a finished Goal step asking what next), something
 * that failed (the connection to ChatGPT), and a chat that finished after working a while.
 *
 * Messages pass through the ntfy server, and anyone who knows a topic can read it. So by default a
 * message says only what happened, never the chat's name or words; "include details" adds the
 * chat's name, the start of its answer and a link that opens the chat in ChatGPT. Topics are long
 * and random. Every decision (sent, or why not) writes one log line, without the message itself.
 */

import { mainText } from './main-texts.js';
import { DEFAULT_PHONE_PUSH, type PhonePushSettings, type QuietHours } from '../shared/phone-push.js';

export { DEFAULT_PHONE_PUSH, type PhonePushSettings };

export type PhonePushKind = 'needs-you' | 'failed' | 'finished';

export interface PhonePushEvent {
  kind: PhonePushKind;
  sessionId?: string;
  chatTitle?: string;
  conversationId?: string | null;
  /** How long the finished turn worked; unknown when it began before the app started. */
  workedMs?: number;
  /** For a failure, what failed (shown always); for a finished chat, the start of its answer (shown only with details). */
  detail?: string;
}

export type PhonePushResult = 'sent' | 'off' | 'kind-off' | 'at-computer' | 'short-turn' | 'quiet-hours' | 'repeat' | 'hourly-limit' | 'error';

export interface PhonePushDeps {
  settings(): PhonePushSettings;
  token(): Promise<string | null>;
  now(): number;
  /** The system's own idle state over the away threshold (Electron's powerMonitor). */
  idleState(): 'active' | 'idle' | 'locked' | 'unknown';
  post(url: string, body: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number }>;
  log(line: string): void;
}

const TOPIC = /^[-_A-Za-z0-9]{1,64}$/;
const REPEAT_MS = 2 * 60_000;
const HOUR_MS = 60 * 60_000;
const PER_HOUR = 20;
const KIND_NAME: Record<PhonePushKind, string> = { 'needs-you': 'needs you', failed: 'failure', finished: 'finished' };
const PRIORITY: Record<PhonePushKind, number> = { 'needs-you': 4, failed: 4, finished: 3 };
const TAGS: Record<PhonePushKind, string> = { 'needs-you': 'raising_hand', failed: 'warning', finished: 'white_check_mark' };

export const isValidTopic = (topic: string): boolean => TOPIC.test(topic);

/** The server's base URL without a trailing slash, or null when it is not a plain http(s) address. */
/** A refusal before anything went out, in words the person can act on. */
class SendRefused extends Error {
  constructor(message: string, readonly reason?: string) { super(message); }
}
/** Hosts on this computer, where plain http never leaves the machine. */
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

export function normalizeServer(input: string): string | null {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return null; }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) return null;
  const path = url.pathname.replace(/\/+$/, '');
  // A path is a topic someone pasted into the server field, not a server.
  if (path) return null;
  return `${url.protocol}//${url.host}`;
}

const minutesOf = (clock: string): number | null => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(clock);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

/** Whether `date` (local time) falls in the quiet hours; they may wrap midnight. Equal ends mean none. */
export function inQuietHours(quiet: QuietHours | null, date: Date): boolean {
  if (!quiet) return false;
  const from = minutesOf(quiet.from), to = minutesOf(quiet.to);
  if (from === null || to === null || from === to) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return from < to ? now >= from && now < to : now >= from || now < to;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** One line of at most `max` visible characters: an emoji (a family, a flag) is never cut apart. */
const oneLine = (text: string, max: number): string => {
  const chars = Array.from(graphemes.segment(text.replace(/\s+/g, ' ').trim()), part => part.segment);
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
};

export function createPhonePush(deps: PhonePushDeps) {
  const lastSent = new Map<string, number>();
  const sentTimes: number[] = [];

  const message = (event: PhonePushEvent, details: boolean): { title: string; message: string; click?: string } => {
    const title = details && event.chatTitle ? oneLine(event.chatTitle, 80) : 'Chat On Steroids';
    let text: string;
    if (event.kind === 'needs-you') text = mainText('A chat is waiting for you.');
    else if (event.kind === 'failed') text = oneLine(event.detail ?? mainText('Something failed in Chat On Steroids.'), 240);
    else {
      // Under a minute says no length: "after 1 min" for 20 seconds would not be true.
      const minutes = event.workedMs === undefined || event.workedMs < 60_000 ? null : Math.round(event.workedMs / 60_000);
      text = minutes === null ? mainText('A chat finished.') : mainText('Finished after {0} min.').replace('{0}', String(minutes));
      if (details && event.detail) text += ` ${oneLine(event.detail, 200)}`;
    }
    const click = details && event.conversationId && /^[0-9a-z-]{8,64}$/i.test(event.conversationId) && event.kind !== 'failed'
      ? `https://chatgpt.com/c/${event.conversationId}` : undefined;
    return { title, message: text, ...(click ? { click } : {}) };
  };

  const send = async (settings: PhonePushSettings, body: Record<string, unknown>): Promise<{ ok: boolean; status: number }> => {
    const server = normalizeServer(settings.server);
    if (!server) throw new SendRefused('The ntfy server address is not valid.');
    // A token that cannot be read is not "no token": a protected server would refuse the message,
    // and the log would blame the server.
    let token: string | null;
    try { token = await deps.token(); } catch (error) {
      throw new SendRefused('The saved access token could not be read from secure storage.', error instanceof Error ? error.message : String(error));
    }
    // A Bearer token over plain http is readable on the way; only this computer is exempt.
    if (token && !server.startsWith('https:') && !LOOPBACK.test(new URL(server).hostname)) {
      throw new SendRefused('An access token is sent only over https, or to this computer. Use https:// for this server.');
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    return deps.post(server, JSON.stringify({ topic: settings.topic, ...body }), headers);
  };

  return {
    async notify(event: PhonePushEvent): Promise<PhonePushResult> {
      const settings = deps.settings();
      const name = KIND_NAME[event.kind];
      const skip = (result: PhonePushResult, why: string): PhonePushResult => { deps.log(`phone push: not sent "${name}": ${why}`); return result; };
      // Switched off is no decision to report: a line per chat event for every install that never turned it on.
      if (!settings.enabled) return 'off';
      if (!isValidTopic(settings.topic)) return skip('off', 'the topic is not valid');
      if ((event.kind === 'needs-you' && !settings.needsYou) || (event.kind === 'failed' && !settings.failures) ||
          (event.kind === 'finished' && settings.finishedAfterMinutes === null)) return skip('kind-off', 'this kind is switched off');
      if (event.kind === 'finished' && event.workedMs !== undefined && event.workedMs < (settings.finishedAfterMinutes ?? 0) * 60_000) {
        return skip('short-turn', `the chat worked under ${settings.finishedAfterMinutes} min`);
      }
      const now = deps.now();
      if (inQuietHours(settings.quietHours, new Date(now))) return skip('quiet-hours', 'quiet hours');
      if (settings.onlyWhenAway && deps.idleState() === 'active') return skip('at-computer', 'you are at the computer');
      const key = `${event.kind}\0${event.sessionId ?? ''}`;
      if (now - (lastSent.get(key) ?? -Infinity) < REPEAT_MS) return skip('repeat', 'the same was sent under 2 min ago');
      while (sentTimes.length && sentTimes[0]! <= now - HOUR_MS) sentTimes.shift();
      if (sentTimes.length >= PER_HOUR) return skip('hourly-limit', `${PER_HOUR} messages in the last hour already`);
      const previous = lastSent.get(key);
      lastSent.set(key, now);
      sentTimes.push(now);
      // A message that did not arrive does not count: the next one may try again.
      const forget = () => {
        if (previous === undefined) lastSent.delete(key); else lastSent.set(key, previous);
        const index = sentTimes.lastIndexOf(now);
        if (index >= 0) sentTimes.splice(index, 1);
      };
      try {
        const reply = await send(settings, { ...message(event, settings.includeDetails), priority: PRIORITY[event.kind], tags: [TAGS[event.kind]] });
        if (!reply.ok) { forget(); deps.log(`phone push: the server refused "${name}" (HTTP ${reply.status})`); return 'error'; }
      } catch (error) {
        forget();
        if (error instanceof SendRefused) deps.log(`phone push: not sent "${name}": ${error.message}${error.reason ? ` (${error.reason})` : ''}`);
        else deps.log(`phone push: could not reach the server for "${name}": ${error instanceof Error ? error.message : String(error)}`);
        return 'error';
      }
      deps.log(`phone push: sent "${name}" to the phone`);
      return 'sent';
    },
    /** A test message, now, whatever the rules say; it throws a sentence when it did not arrive. */
    async test(): Promise<void> {
      const settings = deps.settings();
      if (!isValidTopic(settings.topic)) throw new Error('Choose a topic of letters, digits, - and _ (up to 64).');
      let reply: { ok: boolean; status: number };
      try {
        reply = await send(settings, { title: 'Chat On Steroids', message: mainText('This is a test from Chat On Steroids. Phone notifications work.'), priority: 3, tags: ['bell'] });
      } catch (error) {
        if (error instanceof SendRefused) {
          deps.log(`phone push: test not sent: ${error.message}${error.reason ? ` (${error.reason})` : ''}`);
          throw new Error(error.message);
        }
        deps.log(`phone push: test could not reach the server: ${error instanceof Error ? error.message : String(error)}`);
        throw new Error('The ntfy server could not be reached. Check the address and the connection.');
      }
      if (!reply.ok) {
        deps.log(`phone push: the server refused the test (HTTP ${reply.status})`);
        throw new Error('The ntfy server refused the message. Check the server, the topic and the access token.');
      }
      deps.log('phone push: test sent');
    }
  };
}

let installed: ReturnType<typeof createPhonePush> | null = null;
/** The app's one sender, installed at startup with Electron's network and idle state. */
export function installPhonePush(deps: PhonePushDeps): void { installed = createPhonePush(deps); }
/** Sends what the rules allow; before startup installs the sender, nothing. Never throws. */
export function pushToPhone(event: PhonePushEvent): Promise<PhonePushResult> {
  return installed ? installed.notify(event).catch(() => 'error' as const) : Promise.resolve('off' as const);
}
export function testPhonePush(): Promise<void> {
  if (!installed) return Promise.reject(new Error('Phone notifications are not ready yet. Try again in a moment.'));
  return installed.test();
}
