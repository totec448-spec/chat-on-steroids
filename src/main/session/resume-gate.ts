/**
 * Whether a compaction is opening its replacement chat right at this moment.
 *
 * One boolean, in a module of its own, because the two sides of it must not import each
 * other: the continuation owns the transaction and says when a brief has been claimed, and
 * the recorder — which the continuation already depends on — has to be able to ask.
 *
 * The question exists because of what the answer prevents. When a resume opens chat B, two
 * things race to react to B appearing: the recorder, which invents a session for any
 * conversation it has never seen, and the commit, which moves the *existing* session onto B.
 * On 2026-08-23 the recorder won by 302 ms. The commit then found its own destination owned
 * by a session it had never heard of, refused to rebind — "the replacement chat already
 * belongs to another local session" — and the compaction lost its session while the swarm's
 * prime role moved to the new chat anyway. The replacement chat asked its own session for the
 * handoff history, was told it had no recorded events, and rebuilt the work off the
 * filesystem.
 *
 * The content script holds its own opening batch back for exactly this reason
 * (`commandJournalGate`), but that gate cannot cover events already journalled in the
 * extension's service worker, which is how they arrived early anyway. So the invariant is
 * kept here, where it is owned, instead of there, where it is merely usually observed.
 */

/**
 * How long after a claim a replacement chat is still expected to appear.
 *
 * Only has to outlast a browser opening a tab and ChatGPT minting a conversation id — the
 * bridge command that opened it is bounded by its own deadline. Kept short because the
 * window is not free: while it is open, a genuinely unrelated new conversation waits before
 * getting a session of its own.
 */
export const RESUME_CLAIM_WINDOW_MS = 60_000;

const claims = new Map<string, number>();
const waiters = new Set<() => void>();

function wakeWaiters(): void {
  const pending = [...waiters];
  waiters.clear();
  for (const wake of pending) wake();
}

/** Records that a replacement chat is expected to appear imminently. */
function noteExpectedResume(token: string): void {
  claims.set(token, Date.now());
}

/**
 * Arms the recorder gate before the browser is opened for a queued resume.
 *
 * This has to precede opening the replacement chat through the browser host, not merely the page's later redeem. ChatGPT can
 * expose the new conversation quickly enough for an already-journalled service-worker event to
 * reach the recorder before the content script has redeemed its marker. That observation must
 * wait for the A→B commit rather than inventing a shadow local session for B.
 */
export function noteResumeOpening(token: string): void {
  noteExpectedResume(token);
}

/** Records that a replacement chat has durably taken this continuation's brief and is opening. */
export function noteResumeClaim(token: string): void {
  noteExpectedResume(token);
}

/** Records that the move landed, or was given up on, so nothing waits on it any longer. */
export function endResumeClaim(token: string): void {
  if (claims.delete(token)) wakeWaiters();
}

/**
 * True while some replacement chat is expected to appear.
 *
 * Self-expiring, so a claim that is never resolved — a crash between the claim and the
 * commit, a browser that never opens the tab — costs a bounded window rather than a
 * permanent one. That is the safe direction: failing to wait creates a stub session, which
 * is recoverable and visible, while waiting forever would stop recording new chats.
 */
export function resumeOpeningChat(now: number = Date.now()): boolean {
  for (const [token, at] of claims) {
    if (now - at <= RESUME_CLAIM_WINDOW_MS) return true;
    claims.delete(token);
  }
  return false;
}

/**
 * Waits until the currently-open resume window has actually ended.
 *
 * Recorder callers used to impose their own five-second cutoff and could therefore outrun the
 * continuation that owned this gate. ChatGPT can expose the new conversation id before the
 * submitted bootstrap message becomes stable enough to ACK, so that shorter clock recreated the
 * shadow-session race. There is only one lifetime now: a commit/abort wakes this immediately;
 * otherwise the gate's own bounded claim window expires it. No polling loop is needed.
 */
export async function waitForResumeOpeningToSettle(): Promise<void> {
  while (resumeOpeningChat()) {
    const nextExpiry = Math.min(...[...claims.values()].map((at) => at + RESUME_CLAIM_WINDOW_MS));
    await new Promise<void>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const wake = (): void => {
        if (done) return;
        done = true;
        waiters.delete(wake);
        if (timer) clearTimeout(timer);
        resolve();
      };
      waiters.add(wake);
      timer = setTimeout(wake, Math.max(1, nextExpiry - Date.now() + 1));
      timer.unref?.();
    });
  }
}

/** Test seam. */
export function resetResumeGate(): void {
  claims.clear();
  wakeWaiters();
}
