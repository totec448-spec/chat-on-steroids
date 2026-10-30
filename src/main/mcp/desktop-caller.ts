/**
 * Desktop control — the screen, the mouse and the keyboard — runs only for a call the app can tie
 * to one of its chats.
 *
 * "Allow unattributed calls" exists for tools whose worst case is a call filed under the wrong
 * heading. Desktop control's worst case is someone else's chat operating this computer: with one
 * ChatGPT account on two computers, ChatGPT can send a chat's call to the other computer's
 * Desktop connector (#1097), and on 2026-10-30 a chat on the Windows test machine took a
 * screenshot of this Mac and moved its pointer that way. So the desktop tools ignore that setting
 * and have their own, `ui.desktopUnattributed`, off unless the person turns it on.
 *
 * A call whose request the page has not proved yet is not refused on arrival: proof routinely
 * lands a moment after the call, so the call waits for it as long as the recorder does.
 */
import { getConfig } from '../config.js';
import { logInfo } from '../logger.js';
import { awaitRequestCorrelation } from '../session/correlation.js';
import { currentCaller } from './call-context.js';
import { failIdentity, type SurfaceRegistrar, type ToolResult } from './kernel.js';
import { liveConnectorName } from './surfaces.js';

/** The recorder's own wait for a request's page evidence (REQUEST_ID_GRACE_MS). */
export const DESKTOP_CALLER_WAIT_MS = 20_000;

/** Null when the call may run, else the refusal to return instead. */
export async function desktopCallerRefusal(tool: string, waitMs = DESKTOP_CALLER_WAIT_MS): Promise<ToolResult | null> {
  const caller = currentCaller();
  if (caller.sessionId || caller.conversationId) return null;
  if (getConfig().ui.desktopUnattributed === true) return null;
  const startedAt = Date.now();
  if ((await awaitRequestCorrelation(caller.requestId, waitMs))?.conversationId) {
    const waited = Date.now() - startedAt;
    // A call proved at once needs no line; one that waited says so (CodeRabbit on #1938).
    if (waited >= 100) logInfo(`desktop: ${tool} waited ${waited} ms for its request ${caller.requestId} to be tied to a chat, then ran`);
    return null;
  }
  logInfo(`desktop: refused ${tool} — the call could not be tied to a chat${caller.requestId ? ` (request ${caller.requestId})` : ''}; ` +
    'the screen, mouse and keyboard were not touched');
  return failIdentity(`DESKTOP_IDENTITY_REQUIRED: ${liveConnectorName('desktop')} could not tell which chat this ${tool} call came from, ` +
    'so it did not look at the screen or use the mouse or keyboard. If the chat belongs to another computer, call that ' +
    `computer's Chat On Steroids Desktop instead. Otherwise call ${tool} directly as its own tool call, not from inside a ` +
    'JavaScript or exec step, and try again.');
}

/** The same registrar, with every tool it registers behind desktopCallerRefusal. */
export function guardDesktopTools(reg: SurfaceRegistrar): SurfaceRegistrar {
  return {
    ...reg,
    register(name, config, handler) {
      reg.register(name, config, async args => (await desktopCallerRefusal(name)) ?? handler(args));
    }
  };
}
