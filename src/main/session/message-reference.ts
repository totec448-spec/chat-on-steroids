import { messagePresentation } from '../../shared/message-presentation.js';
import { effectiveCapabilities, getConfig } from '../config.js';
import { browserControl } from '../browser-control.js';
import { getSession, readRecordedAssistantMessage } from './store.js';
import { logInfo, logWarn } from '../logger.js';

/** User clicks a recorded file. Resolve authority from storage, not a renderer-supplied URL/path. */
export async function openRecordedReference(sessionId: string, messageId: string, index: number): Promise<boolean> {
  const resolve = async () => {
    const caps = effectiveCapabilities(getConfig());
    if (!caps.screen || !caps.control) throw new Error('Enable browser observation and control to open the native file preview.');
    const session = await getSession(sessionId);
    const message = session && await readRecordedAssistantMessage(sessionId, messageId);
    const presentation = messagePresentation(message?.presentation);
    if (!message?.providerMessageId || !presentation || !session ||
        ![session.conversationId, ...session.chatIds].includes(presentation.conversationId))
      throw new Error('This recording has no verified native file reference. Open its original ChatGPT conversation to refresh it.');
    const reference = presentation.references.find(ref => ref.index === index && ref.type === 'file');
    if (!reference || reference.type !== 'file') throw new Error('The recorded file reference is unavailable.');
    return { conversationId: presentation.conversationId, messageId: message.providerMessageId, reference };
  };
  const selected = await resolve();
  const signature = JSON.stringify(selected);
  const started = Date.now();
  logInfo(`native file preview requested index=${index}`);
  const result = await browserControl.execute('open_recorded_reference', selected, `ui-reference:${sessionId}`, selected.conversationId,
    async () => JSON.stringify(await resolve()) === signature);
  if (result.error) { logWarn(`native file preview RPC failed elapsed_ms=${Date.now() - started}`); throw new Error(result.error); }
  const value = result.value as { requested?: boolean; error?: string } | undefined;
  if (!value?.requested) {
    logWarn(`native file preview unconfirmed elapsed_ms=${Date.now() - started}`);
    throw new Error(value?.error || 'The native file preview request could not be confirmed.');
  }
  logInfo(`native file preview dispatched elapsed_ms=${Date.now() - started}`);
  return true;
}
