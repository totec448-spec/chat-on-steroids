import { isAstraModel } from '../../shared/chat-models.js';
import { getConfig } from '../config.js';
import { goalObjectiveFor, goalSwitchFor, setGoalReplyActiveNow, setGoalSwitchNow } from '../goal.js';
import { isChatBlocked } from './blocked-chats.js';
import { cancelInput, listInputs } from './input.js';
import { conversationWasSuperseded, getSession } from './store.js';

export interface LongrunSessionView {
  readonly found: boolean;
  readonly activeTurn: boolean;
  readonly blocked: boolean;
  readonly superseded: boolean;
  readonly modelClass: 'astra' | 'other' | 'unknown';
  readonly loopEnabled: boolean;
  readonly loopMode: 'goal' | 'loop';
  readonly objectivePresent: boolean;
  readonly finishToolEnabled: boolean;
  readonly pendingUserInput: boolean;
  readonly pendingLongrunStart: boolean;
}

/** Content-blind exact-session state shared by legacy V3 and the parent-slot controller. */
export async function longrunSessionView(sessionId: string): Promise<LongrunSessionView> {
  const session = await getSession(sessionId);
  if (!session) {
    return {
      found: false, activeTurn: false, blocked: false, superseded: false,
      modelClass: 'unknown', loopEnabled: false, loopMode: 'goal', objectivePresent: false,
      finishToolEnabled: getConfig().ui.finishTool === true, pendingUserInput: false, pendingLongrunStart: false
    };
  }
  const conversationId = session.conversationId;
  const selected = conversationId && session.selectedModel?.conversationId === conversationId ? session.selectedModel : null;
  const modelClass: LongrunSessionView['modelClass'] = selected?.model
    ? isAstraModel(selected.model, selected.reasoningEffort) ? 'astra' : 'other'
    : 'unknown';
  const sw = conversationId ? goalSwitchFor(conversationId) : { enabled: false, mode: 'goal' as const, own: false };
  const inputs = (await listInputs()).filter(entry => entry.sessionId === sessionId && ['queued', 'browser', 'tool'].includes(entry.state));
  return {
    found: true,
    activeTurn: Boolean(session.activeTurnId),
    blocked: Boolean(conversationId && isChatBlocked(conversationId)),
    superseded: Boolean(conversationId && await conversationWasSuperseded(conversationId)),
    modelClass,
    loopEnabled: sw.enabled,
    loopMode: sw.mode,
    objectivePresent: Boolean(conversationId && goalObjectiveFor(conversationId)),
    finishToolEnabled: getConfig().ui.finishTool === true,
    pendingUserInput: inputs.length > 0,
    pendingLongrunStart: inputs.some(entry => entry.automation === 'loop')
  };
}

/** The single Loop-Off mutation shared by V3 and parent-slot control. */
export async function disableLongrunSessionLoop(sessionId: string): Promise<boolean> {
  const session = await getSession(sessionId);
  const conversationId = session?.conversationId ?? null;
  if (!session || !conversationId) return false;
  const pending = (await listInputs()).filter(entry => entry.sessionId === sessionId &&
    entry.automation === 'loop' && ['queued', 'browser'].includes(entry.state));
  for (const entry of pending) await cancelInput(entry.id);
  await setGoalSwitchNow(conversationId, 'loop', false);
  await setGoalReplyActiveNow(conversationId, false);
  return true;
}
