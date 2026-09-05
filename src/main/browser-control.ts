/**
 * The app's side of browser control.
 *
 * The driver that does the work lives in the extension's service worker, because only an
 * extension can hold a DevTools session and only a DevTools session produces trusted input.
 * This is the other end: a place to park one command per conversation, hand it to the browser
 * that asks, and wake the caller when the answer comes back.
 *
 * ## Why it rides on `/activity`
 *
 * The alternatives were a WebSocket the bridge does not speak, or a native messaging host that
 * would need an installer change on every platform. Neither is necessary. A browser command is
 * always issued *by* a ChatGPT conversation, so the tab that will carry it is open by
 * definition, and its content script is already polling `/activity` several times a second
 * while work is live. Riding that poll costs one field in a reply that is already in flight,
 * inherits the ownership model that decides which conversation a request belongs to, and
 * cannot outlive the page it belongs to.
 *
 * ## One at a time
 *
 * A conversation may have exactly one command outstanding. Browser actions are ordered — a
 * click after a scroll means something different from the reverse — and a queue that could
 * reorder or interleave them would be a queue that occasionally does the wrong thing on a page
 * nobody is watching.
 */

/**
 * How long a command may wait to be collected and answered before the caller gives up.
 *
 * Has to outlast the driver, not merely match it. The extension allows a navigate or a reload 30
 * seconds and a screenshot the same, an observe walks up to a dozen frames before it captures,
 * and none of that starts until the page collects the command on its next activity poll — up to
 * two seconds later. Sharing the driver's own number meant a slow navigate reported
 * BROWSER_TIMEOUT for an action that had in fact succeeded, and abandoned the rest of the batch
 * on the strength of it.
 */
const BROWSER_COMMAND_TIMEOUT_MS = 45_000;

export interface BrowserCommandResult {
  ok: boolean;
  /** Whatever the driver returned; shape depends on the action. */
  data?: Record<string, unknown>;
  error?: string;
  detail?: string;
}

interface PendingCommand {
  id: string;
  conversationId: string;
  action: Record<string, unknown>;
  /** Set once a browser has actually taken the command, so a re-poll does not run it twice. */
  collectedAt: number | null;
  settle: (result: BrowserCommandResult) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingCommand>();

let counter = 0;
const nextId = (): string => `bc-${Date.now().toString(36)}-${(++counter).toString(36)}`;

function finish(command: PendingCommand, result: BrowserCommandResult): void {
  clearTimeout(command.timer);
  if (pending.get(command.conversationId) === command) pending.delete(command.conversationId);
  command.settle(result);
}

/**
 * Queues one action for the browser showing this conversation and waits for its answer.
 *
 * Rejects rather than queues when something is already outstanding: the caller is a tool call
 * that is itself waiting, so a second one arriving means the model issued two actions at once,
 * and running them in an order nobody chose is worse than refusing the second.
 */
export function runBrowserCommand(
  conversationId: string,
  action: Record<string, unknown>
): Promise<BrowserCommandResult> {
  const existing = pending.get(conversationId);
  if (existing) {
    return Promise.resolve({
      ok: false,
      error: 'BROWSER_BUSY',
      detail: 'another browser action for this conversation is still running'
    });
  }

  return new Promise<BrowserCommandResult>((resolve) => {
    const command: PendingCommand = {
      id: nextId(),
      conversationId,
      action,
      collectedAt: null,
      settle: resolve,
      timer: setTimeout(() => {
        finish(command, {
          ok: false,
          error: 'BROWSER_TIMEOUT',
          // The two cases differ in what the caller may safely do next, and only one of them is
          // safe to retry. QA hit the second: the click landed, the page changed, and the reply
          // was a failure — a blind retry would have clicked twice. So the message says what to
          // do rather than only what went wrong.
          detail: command.collectedAt === null
            ? 'no browser tab collected the action, so it did not run; is the ChatGPT tab still open and paired? Safe to retry.'
            : 'the browser took the action and did not report back, so it may well have happened. Do NOT retry it — observe first and decide from what the page now shows.'
        });
      }, BROWSER_COMMAND_TIMEOUT_MS)
    };
    pending.set(conversationId, command);
  });
}

/**
 * The command this conversation should carry, if any, marked as collected.
 *
 * Handed out once. A second poll before the result arrives gets nothing, so two tabs showing
 * the same conversation cannot both perform the same click.
 */
export function collectBrowserCommand(
  conversationId: string
): { id: string; action: Record<string, unknown> } | null {
  const command = pending.get(conversationId);
  if (!command || command.collectedAt !== null) return null;
  command.collectedAt = Date.now();
  return { id: command.id, action: command.action };
}

/**
 * Delivers a browser's answer.
 *
 * Returns false for an id this conversation does not have outstanding — a late result from a
 * command that already timed out, or a report aimed at another chat. Neither is trusted.
 */
export function settleBrowserCommand(
  conversationId: string,
  id: string,
  result: BrowserCommandResult
): boolean {
  const command = pending.get(conversationId);
  if (!command || command.id !== id) return false;
  finish(command, result);
  return true;
}

/** Gives up anything outstanding for a conversation whose page has gone. */
export function abandonBrowserCommands(conversationId: string): void {
  const command = pending.get(conversationId);
  if (!command) return;
  finish(command, {
    ok: false,
    error: 'BROWSER_GONE',
    // Same distinction as the timeout, for the same reason: whether it was collected decides
    // whether it may have run, and that decides whether a retry is safe.
    detail:
      command.collectedAt === null
        ? 'the ChatGPT page closed before any tab collected the action, so it did not run. Safe to retry once a page is back.'
        : 'the ChatGPT page closed after a tab took the action, so it may well have happened. Do NOT retry it — observe first.'
  });
}

/** Tests only: no command may survive from one case into the next. */
export function resetBrowserControlForTests(): void {
  for (const command of [...pending.values()]) {
    clearTimeout(command.timer);
    command.settle({ ok: false, error: 'BROWSER_GONE', detail: 'reset' });
  }
  pending.clear();
}
