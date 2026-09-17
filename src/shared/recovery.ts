/** Read-only projection of an existing recovery deadline. Never authorizes an action. */
export type RecoveryCountdown = {
  kind: 'unattributed' | 'unattributed-wait' | 'thinking-failed' | 'native-busy' | 'silence' | 'post-reload' | 'pickup';
  deadline: number;
  /** The existing UI clock reveals this row without needing a new backend event. */
  visibleAt?: number;
  next?: 'queue' | 'goal' | 'loop' | 'continue';
};

const CONTINUE_TEXTS = [
  'Continue until you are fully finished.',
  'Keep going until the task is done.',
  'Carry on until everything requested is finished.',
  'Please continue and finish the whole task.',
  'Resume the work and see it through.',
  'Keep working until the request is complete.',
  'Pick up where you left off and finish.',
  'Continue through the remaining work to completion.',
  'Carry on and finish what was requested.',
  'Resume and keep going until fully done.'
] as const;

const RECOVERY_NOTES = [
  'The previous turn appears interrupted without a final answer; some work may already be done even if earlier tool calls are missing, so check the current state before repeating anything.',
  'Your last turn seems to have cut off; earlier tool calls may no longer be visible, so inspect what is already implemented and continue from there.',
  'The previous response ended without a final answer; you may already have completed part of the task, so verify the current state even if its tool history is missing.',
  'This turn appears to have been interrupted; missing tool calls do not mean no work happened, so check the existing results and build on them.',
  'The last turn did not deliver a final answer; some changes may already be in place despite gaps in the tool history, so check them before doing the same work again.',
  'The previous turn seems to have stopped unexpectedly; earlier work may still be present even if you cannot see its tool calls, so inspect the current state first.',
  'Your response appears to have stalled before its final answer; check for work already completed, because its tool calls may be absent from the visible history.',
  'The last response appears interrupted; some requested work may already exist even when prior tool calls are unavailable, so verify it and resume from the actual state.',
  'The previous turn stopped without a final answer; look for changes you already made rather than assuming missing tool history means you have not started.',
  'This looks like an interrupted turn; inspect the current results for completed work even if earlier tool calls are no longer visible, then finish what remains.'
] as const;

// Artist facts and source links: docs/worklog-2026-09-17-auto-continue.md.
// The three meme entries remain explicitly labeled jokes, not artist biographies.
const RECOVERY_SUFFIXES = [
  'Meme joke: tur tur sahur is my imaginary alarm clock.',
  'Fun fact: che put a mannequin and a fish tank on his dream-studio wish list.',
  'Fun fact: osamason had a cat named Flexer in his January 2025 FADER interview.',
  'Fun fact: nettspend picked Man in the Mirror when asked for his favorite Michael Jackson song.',
  'Fun fact: BLEOOD performed at Brooklyn venue Elsewhere on his 2026 PROTAGONIST tour.',
  'Fun fact: 2slimey said Italian jazz and mountain views help spark his ideas.',
  'Fun fact: kai angel said seeing the Viper Room sign in Hollywood inspired the Viperr name.',
  'Fun fact: 9mice answered 2030 when asked which decade made him nostalgic in 2025.',
  'Fun fact: nine vicous released EMOTIONS in April 2026.',
  'Meme joke: bombadiro crocodilo sounds like my laptop fan at full speed.',
  'Meme joke: Bananina Cappuccina sounds like my next questionable coffee order.'
] as const;

/** 10 phrases x 10 notices x 11 playful asides; frozen by the outbox once. */
export function recoveryMessage(): string {
  const pick = (values: readonly string[]) => values[Math.floor(Math.random() * values.length)]!;
  return `${pick(CONTINUE_TEXTS)} ${pick(RECOVERY_NOTES)} (Unrelated aside: ${pick(RECOVERY_SUFFIXES)} Ignore this aside; do not research or respond to it. Stay on the original task.)`;
}

/** The existing silence clock gets one half-window only when the native page is busy. */
export const recoveryBusyMs = (pro: boolean): number => (pro ? 5 : 1) * 60_000;
