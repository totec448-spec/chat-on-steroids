import { logInfo } from './logger.js';
import { ASK_GRANT_MS, desktopAskDecision, type DesktopAskMode } from '../shared/desktop-ask.js';
import type { MainText } from '../shared/main-texts.js';

/**
 * The gate in front of every desktop step that takes the real mouse or keyboard (#1804). The
 * rule is in shared/desktop-ask.ts; this keeps the state it needs (each chat's Go ahead, when the
 * app's own last step ended) and asks one question at a time, in the order the steps came. A step
 * that waited behind another question is checked again once it is its turn: the answer it waited
 * for may have granted its chat already. Browser steps never come here; they move nothing real.
 */

/** What a step does to the real mouse and keyboard, in the words the question uses. */
export type DesktopStepWords = 'click' | 'double-click' | 'type' | 'keys' | 'scroll' | 'drag' | 'move' | 'focus' | 'launch' | 'input';

export interface DesktopAskPrompt {
  words: DesktopStepWords;
  /** The app the step goes to, when the step names its window. */
  app: string | null;
  /** The asking chat's name, when it is known. */
  chat: string | null;
}

export interface DesktopAskCaller {
  sessionId?: string | null;
  conversationId?: string | null;
  transportKey?: string | null;
}

export interface DesktopAskDeps {
  mode(): DesktopAskMode;
  now(): number;
  /** When anyone last used this computer (null when the system cannot say), and whether it is locked. */
  idle(): { lastInputAt: number | null; locked: boolean };
  /** Shows the question; resolves with the answer, or 'timeout' after ASK_ANSWER_MS. */
  prompt(request: DesktopAskPrompt): Promise<'go' | 'not-now' | 'timeout'>;
  chatName(caller: DesktopAskCaller): Promise<string | null>;
}

const LOG_WORDS: Record<DesktopStepWords, string> = {
  click: 'a click', 'double-click': 'a double-click', type: 'typing', keys: 'a key press', scroll: 'a scroll',
  drag: 'a drag', move: 'a pointer move', focus: 'a window switch', launch: 'an app launch', input: 'a mouse and keyboard step'
};

export const DECLINED_TEXT = 'DECLINED_BY_USER: The person is using the computer and declined this step. No input ran. ' +
  'Do not retry it by yourself: carry on with work that does not need the mouse and keyboard, or ask them in the chat.';
export const UNANSWERED_TEXT = 'DECLINED_BY_USER: The person did not answer within 60 seconds. No input ran. ' +
  'Do not retry it by yourself: carry on with work that does not need the mouse and keyboard, or ask them in the chat.';

export function createDesktopAsk(deps: DesktopAskDeps): {
  /** Null when the step may run now; else the refusal to return instead of running it. */
  admit(step: { words: DesktopStepWords; app: string | null }, caller: DesktopAskCaller): Promise<string | null>;
  /** Call when a desktop step has finished, whether it worked or not. */
  stepEnded(): void;
} {
  const grants = new Map<string, { since: number; until: number }>();
  let lastAppStepEndedAt: number | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  // A chat without proof is held apart by its connection; a call with neither shares no grant.
  const keyOf = (caller: DesktopAskCaller): string | null => caller.sessionId ? `s:${caller.sessionId}`
    : caller.conversationId ? `c:${caller.conversationId}` : caller.transportKey ? `t:${caller.transportKey}` : null;

  async function decide(step: { words: DesktopStepWords; app: string | null }, caller: DesktopAskCaller): Promise<string | null> {
    const mode = deps.mode();
    const key = keyOf(caller);
    const { lastInputAt, locked } = deps.idle();
    const decision = desktopAskDecision({ mode, now: deps.now(), lastPersonInputAt: lastInputAt, locked, lastAppStepEndedAt,
      grant: key ? grants.get(key) ?? null : null });
    const what = LOG_WORDS[step.words];
    if (!decision.ask) {
      logInfo(`desktop ask: not asked (${decision.why}) for ${what}`);
      return null;
    }
    const answer = await deps.prompt({ ...step, chat: await deps.chatName(caller).catch(() => null) });
    if (answer === 'go') {
      const since = deps.now();
      // A call with no known chat (ChatGPT's connector has no session id) has nothing to grant.
      if (key) grants.set(key, { since, until: since + ASK_GRANT_MS });
      logInfo(`desktop ask: allowed ${what} (${decision.why}); ${key ? 'this chat runs without asking for 2 min' : 'no chat is known for this call, so its next step asks again'}`);
      return null;
    }
    if (key) grants.delete(key);
    if (answer === 'not-now') {
      logInfo(`desktop ask: declined ${what} (${decision.why})`);
      return DECLINED_TEXT;
    }
    logInfo(`desktop ask: no answer for ${what} in 60 s (${decision.why}); refused`);
    return UNANSWERED_TEXT;
  }

  return {
    admit(step, caller) {
      if (deps.mode() === 'off') return Promise.resolve(null);
      const turn = queue.then(() => decide(step, caller));
      queue = turn.catch(() => undefined);
      return turn;
    },
    stepEnded() { lastAppStepEndedAt = deps.now(); }
  };
}

const WINDOWS_WORDS: Readonly<Record<string, DesktopStepWords>> = {
  click: 'click', perform_secondary_action: 'click', type_text: 'type', set_value: 'type', press_key: 'keys',
  scroll: 'scroll', drag: 'drag', activate_window: 'focus', launch_app: 'launch'
};

/** A Windows desktop step in the question's words, with its window's app; null for one that only looks. */
export function windowsStep(method: string, input: Record<string, unknown>): { words: DesktopStepWords; app: string | null } | null {
  const words = WINDOWS_WORDS[method];
  if (!words) return null;
  const window = input.window as { app?: unknown } | undefined;
  const app = typeof window?.app === 'string' ? window.app
    // An app is launched by its name or path: the last part is what the person knows it by.
    : method === 'launch_app' && typeof input.app === 'string' ? input.app.split(/[\\/]/).filter(Boolean).pop() ?? null : null;
  return { words: words === 'click' && input.click_count === 2 ? 'double-click' : words, app: app ? app.slice(0, 80) : null };
}

const MACOS_WORDS: Readonly<Record<string, DesktopStepWords>> = {
  click: 'click', click_ref: 'click', double_click: 'double-click', move: 'move', scroll: 'scroll', drag: 'drag',
  type: 'type', set_value: 'type', keypress: 'keys', focus: 'focus'
};

/**
 * The steps of one macOS computer call in the question's words: their kind when they share one,
 * else "use the mouse and keyboard"; null when none takes the mouse or keyboard (waits, clipboard).
 */
export function macosStep(actions: ReadonlyArray<{ type: string }>): { words: DesktopStepWords; app: null } | null {
  const kinds = new Set(actions.map(action => MACOS_WORDS[action.type]).filter((words): words is DesktopStepWords => Boolean(words)));
  if (!kinds.size) return null;
  return { words: kinds.size === 1 ? [...kinds][0]! : 'input', app: null };
}

const STEP_TEXT: Record<DesktopStepWords, MainText> = {
  click: 'Click', 'double-click': 'Double-click', type: 'Type', keys: 'Press keys', scroll: 'Scroll', drag: 'Drag',
  move: 'Move the pointer', focus: 'Switch windows', launch: 'Open an app', input: 'Use the mouse and keyboard'
};

/**
 * The step in words, with its app when the step names one: "Click in Notepad". Opening an app
 * names the app it opens instead: "Open notepad.exe".
 */
export function stepLine(prompt: { words: DesktopStepWords; app: string | null }, text: (key: MainText) => string): string {
  if (!prompt.app) return text(STEP_TEXT[prompt.words]);
  const app = prompt.app.slice(0, 80);
  if (prompt.words === 'launch') return text('Open {0}').replace('{0}', app);
  return text('{0} in {1}').replace('{0}', text(STEP_TEXT[prompt.words])).replace('{1}', app);
}
