import { beforeEach, expect, it, vi } from 'vitest';

const logs: string[] = [];
vi.mock('../src/main/logger.js', () => ({ logInfo: (line: string) => logs.push(line), logWarn: (line: string) => logs.push(line) }));

import { createDesktopAsk, type DesktopAskDeps, type DesktopAskPrompt } from '../src/main/desktop-ask.js';
import { ASK_GRANT_MS } from '../src/shared/desktop-ask.js';

/**
 * #1804: the gate in front of every desktop step that takes the real mouse or keyboard. It asks
 * one question at a time, in the order the steps came; Go ahead runs the step and grants that
 * chat 2 minutes; Not now or no answer refuses only that step, with a sentence ChatGPT can act on,
 * and nothing retries by itself. One log line per decision, never what the step would type.
 */
let clock = 1_000_000;
let lastInputAt: number | null = clock - 2_000;
let answers: Array<'go' | 'not-now' | 'timeout'> = [];
let asked: DesktopAskPrompt[] = [];
beforeEach(() => { clock = 1_000_000; lastInputAt = clock - 2_000; answers = []; asked = []; logs.length = 0; });

function gate(mode: 'off' | 'active' | 'always' = 'active', over: Partial<DesktopAskDeps> = {}) {
  return createDesktopAsk({
    mode: () => mode,
    now: () => clock,
    idle: () => ({ lastInputAt, locked: false }),
    prompt: async request => { asked.push(request); return answers.shift() ?? 'timeout'; },
    chatName: async caller => caller.sessionId === 's-1' ? 'Fix the tests' : null,
    ...over
  });
}
const chat1 = { sessionId: 's-1', conversationId: 'c-1' };
const chat2 = { sessionId: 's-2', conversationId: 'c-2' };

it('runs without asking when off, or when the person is away', async () => {
  expect(await gate('off').admit({ words: 'click', app: null }, chat1)).toBeNull();
  lastInputAt = clock - 60_000;
  expect(await gate().admit({ words: 'click', app: null }, chat1)).toBeNull();
  expect(asked).toEqual([]);
  expect(logs).toEqual(['desktop ask: not asked (away) for a click']);
});

it('asks the person, and Go ahead runs the step and the chat\'s next ones for 2 minutes', async () => {
  const ask = gate();
  answers = ['go'];
  expect(await ask.admit({ words: 'click', app: 'Safari' }, chat1)).toBeNull();
  expect(asked).toEqual([expect.objectContaining({ words: 'click', app: 'Safari', chat: 'Fix the tests' })]);
  ask.stepEnded();
  // The app's own step reset the idle time; the person did nothing since.
  lastInputAt = clock;
  clock += 5_000;
  expect(await ask.admit({ words: 'type', app: null }, chat1)).toBeNull();
  expect(asked).toHaveLength(1);
  // Another chat has no grant of its own: the person is at the computer again, and it asks.
  lastInputAt = clock - 500;
  answers = ['not-now'];
  expect(await ask.admit({ words: 'keys', app: null }, { ...chat2 })).not.toBeNull();
  expect(asked).toHaveLength(2);
  // After 2 minutes the first chat asks again.
  clock += ASK_GRANT_MS;
  lastInputAt = clock - 1_000;
  answers = ['go'];
  await ask.admit({ words: 'scroll', app: null }, chat1);
  expect(asked).toHaveLength(3);
  expect(logs).toContain('desktop ask: allowed a click (active); this chat runs without asking for 2 min');
});

it('ends the grant early when the person uses the mouse or keyboard again', async () => {
  const ask = gate();
  answers = ['go'];
  await ask.admit({ words: 'click', app: null }, chat1);
  ask.stepEnded();
  clock += 10_000;
  lastInputAt = clock - 2_000;     // the person, after the app's step
  answers = ['not-now'];
  expect(await ask.admit({ words: 'click', app: null }, chat1)).not.toBeNull();
  expect(asked).toHaveLength(2);
});

it('refuses only the step on Not now or no answer, saying so plainly and without retrying', async () => {
  const ask = gate();
  answers = ['not-now'];
  const declined = await ask.admit({ words: 'drag', app: null }, chat1);
  expect(declined).toMatch(/^DECLINED_BY_USER: The person is using the computer and declined this step\. No input ran\./);
  expect(declined).toContain('Do not retry it by yourself');
  answers = ['timeout'];
  const unanswered = await ask.admit({ words: 'drag', app: null }, chat1);
  expect(unanswered).toMatch(/^DECLINED_BY_USER: The person did not answer within 60 seconds\. No input ran\./);
  expect(logs).toEqual(['desktop ask: declined a drag (active)', 'desktop ask: no answer for a drag in 60 s (active); refused']);
});

it('asks one question at a time, in order, and checks again after waiting', async () => {
  let release!: (answer: 'go') => void;
  const ask = gate('active', { prompt: request => { asked.push(request); return asked.length === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve('go'); } });
  const first = ask.admit({ words: 'click', app: null }, chat1);
  const second = ask.admit({ words: 'type', app: null }, chat1);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(asked).toHaveLength(1);
  release('go');
  expect(await first).toBeNull();
  // The second step of the same chat was waiting behind the first: Go ahead now covers it.
  expect(await second).toBeNull();
  expect(asked).toHaveLength(1);
});

it('asks when the system cannot say when it was last used, and in Always ask every time without a grant', async () => {
  lastInputAt = null;
  answers = ['not-now'];
  expect(await gate().admit({ words: 'click', app: null }, chat1)).not.toBeNull();
  lastInputAt = clock - 600_000;
  answers = ['go'];
  expect(await gate('always').admit({ words: 'focus', app: 'Notes' }, chat1)).toBeNull();
  expect(asked).toHaveLength(2);
  expect(logs).toEqual(['desktop ask: declined a click (unknown)', 'desktop ask: allowed a window switch (always); this chat runs without asking for 2 min']);
});

it('keys a chat without proof by its connection, so one chat\'s grant never covers another', async () => {
  const ask = gate();
  answers = ['go'];
  await ask.admit({ words: 'click', app: null }, { sessionId: null, conversationId: null, transportKey: 't-1' });
  answers = ['not-now'];
  expect(await ask.admit({ words: 'click', app: null }, { sessionId: null, conversationId: null, transportKey: 't-2' })).not.toBeNull();
  // A call with no identity at all never shares a grant.
  answers = ['go', 'not-now'];
  await ask.admit({ words: 'click', app: null }, { sessionId: null, conversationId: null });
  expect(await ask.admit({ words: 'click', app: null }, { sessionId: null, conversationId: null })).not.toBeNull();
});

it("words a Windows step and names its window's app, and asks nothing of steps that move no real input", async () => {
  const { windowsStep, macosStep } = await import('../src/main/desktop-ask.js');
  const window = { app: 'Notepad', id: 7 };
  expect(windowsStep('click', { window })).toEqual({ words: 'click', app: 'Notepad' });
  expect(windowsStep('click', { window, click_count: 2 })).toEqual({ words: 'double-click', app: 'Notepad' });
  expect(windowsStep('type_text', { window, text: 'secret' })).toEqual({ words: 'type', app: 'Notepad' });
  expect(windowsStep('set_value', { window, value: 'x' })).toEqual({ words: 'type', app: 'Notepad' });
  expect(windowsStep('press_key', { window, key: 'ctrl+s' })).toEqual({ words: 'keys', app: 'Notepad' });
  expect(windowsStep('activate_window', { window })).toEqual({ words: 'focus', app: 'Notepad' });
  expect(windowsStep('launch_app', { app: 'C:\\\\Program Files\\\\Calc\\\\calc.exe' })).toEqual({ words: 'launch', app: 'calc.exe' });
  expect(windowsStep('get_window_state', { window })).toBeNull();
  // macOS: the step kinds of one call; waiting and the clipboard move nothing.
  expect(macosStep([{ type: 'click' }])).toEqual({ words: 'click', app: null });
  expect(macosStep([{ type: 'click' }, { type: 'wait' }, { type: 'click_ref' }])).toEqual({ words: 'click', app: null });
  expect(macosStep([{ type: 'click' }, { type: 'type' }])).toEqual({ words: 'input', app: null });
  expect(macosStep([{ type: 'keypress' }])).toEqual({ words: 'keys', app: null });
  expect(macosStep([{ type: 'wait' }, { type: 'read_clipboard' }, { type: 'write_clipboard' }])).toBeNull();
});

it('says in the log that a call with no known chat asks again, since Go ahead has no chat to cover (live VM test)', async () => {
  // ChatGPT's connector is stateless (no MCP session id), so an unattributed call has no key at all.
  const ask = gate('always');
  answers = ['go', 'go'];
  const nobody = { sessionId: null, conversationId: null, transportKey: null };
  expect(await ask.admit({ words: 'launch', app: 'notepad.exe' }, nobody)).toBeNull();
  ask.stepEnded();
  clock += 1_000;
  expect(await ask.admit({ words: 'launch', app: 'notepad.exe' }, nobody)).toBeNull();
  expect(asked).toHaveLength(2);
  expect(logs).toEqual([
    'desktop ask: allowed an app launch (always); no chat is known for this call, so its next step asks again',
    'desktop ask: allowed an app launch (always); no chat is known for this call, so its next step asks again'
  ]);
});

it('words the step with its app: the app a step goes to, or the app it opens (live VM test)', async () => {
  const { stepLine } = await import('../src/main/desktop-ask.js');
  const same = (text: string) => text;
  expect(stepLine({ words: 'click', app: 'Notepad' }, same)).toBe('Click in Notepad');
  // Opening an app names that app as what opens, not as where the step happens.
  expect(stepLine({ words: 'launch', app: 'notepad.exe' }, same)).toBe('Open notepad.exe');
  expect(stepLine({ words: 'launch', app: null }, same)).toBe('Open an app');
  expect(stepLine({ words: 'type', app: 'x'.repeat(200) }, same)).toBe(`Type in ${'x'.repeat(80)}`);
});
