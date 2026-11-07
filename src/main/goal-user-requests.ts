import { readSessionUserRequests } from './session/store.js';

/**
 * What Goal and Loop are told about steps waiting for the person (#1695): one system line, only
 * while any is open. A step the person has not marked done is not done, whatever the chat says.
 */
export async function goalUserRequestsContext(sessionId: string): Promise<string[]> {
  const open = (await readSessionUserRequests(sessionId).catch(() => [])).filter(request => request.state === 'open');
  if (!open.length) return [];
  const listed = open.slice(0, 10).map(request => `- ${request.purpose} (${request.id})`).join('\n');
  return [
    'Steps the chat handed to the person are still waiting; only the person runs them and marks them done:\n' + listed +
    (open.length > 10 ? `\n- and ${open.length - 10} more` : '') +
    '\nDo not treat these steps or anything depending on them as complete, and do not ask the chat to run them itself. ' +
    'Continue with work that does not depend on them, or wait for the person.'
  ];
}
