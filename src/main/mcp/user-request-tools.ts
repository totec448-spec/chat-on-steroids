import { currentCaller } from './call-context.js';
import { fail, failIdentity, guard, ok, resolveCwd, type SurfaceRegistrar } from './kernel.js';
import { toolDeclaration } from './tool-declarations.js';
import { fileUserRequest, readSessionUserRequests } from '../session/store.js';
import { userRequestFound } from '../user-request-files.js';
import { getConfig } from '../config.js';
import { logInfo } from '../logger.js';
import { resolvePath, SandboxError } from '../sandbox.js';
import {
  USER_REQUEST_LIMITS, userRequestInputSchema, userRequestStatusInputSchema, type UserRequest, type UserRequestFound
} from '../../shared/user-requests.js';

/**
 * A step ChatGPT hands to the person (#1695, design approved with Haz's boundary points): the
 * app records it and shows it; the person runs it in their own terminal and says when it is done.
 * Nothing here runs a command, retries one or routes it anywhere else. The boundary between a
 * step that needs a person and an action ChatGPT declined is stated to the model; the app cannot
 * enforce it, so nothing claims that it does.
 */
export const ASK_USER_TO_RUN_DESCRIPTION =
  'Hands one step to the person when it needs them: a sign-in, hardware, an administrator prompt, an app you cannot operate, ' +
  'or a command they must run in their own terminal. Records the exact command, folder, purpose and expected files in the user’s app ' +
  'and returns an id at once; it runs nothing, and the app never runs it. Never use it for an action you declined, ' +
  'or that was refused or blocked for safety reasons. Continue with work that does not depend on the step, ' +
  'then check with user_request_status. Only the person marks it done.';

export const USER_REQUEST_STATUS_DESCRIPTION =
  'Says whether the person marked a step from ask_user_to_run done or skipped, and which of its expected files exist now ' +
  '(size and time only; nothing is read). A skipped step did not happen: do not assume its result.';

function foundLine(found: UserRequestFound[]): string {
  if (!found.length) return '';
  return '\nExpected files: ' + found.map(file => file.state === 'found'
    ? `${file.path} found (${file.size} bytes, modified ${new Date(file.modifiedAt!).toISOString()})`
    : file.state === 'missing' ? `${file.path} not found` : `${file.path} not checked (outside the approved folders or on a server)`).join('; ');
}

function statusText(request: UserRequest, found: UserRequestFound[]): string {
  const state = request.state === 'open'
    ? 'OPEN: the person has not marked it done yet. Do not assume its result; continue with other work or wait.'
    : request.state === 'done'
      ? 'DONE: the person marked it done. Check its results with your usual read tools before relying on them.'
      : 'SKIPPED: the person skipped it. It did not happen; do not assume its result.';
  return `Step ${request.id}: ${state}${foundLine(found)}`;
}

export function registerUserRequestTools(reg: SurfaceRegistrar): void {
  // Offered with the command tools: a step for the person is a command they run instead of you.
  // Read-only mode keeps it, since it runs nothing; the person's terminal is theirs.
  const available = (): ReturnType<typeof ok> | null => {
    if (!reg.sessionToolsLive) return reg.featureDisabled('Session recording', 'Settings → Chat');
    // Run programs, or Read-only over a Run programs that is switched on underneath it.
    if (!reg.caps.command && !(reg.ctx.readOnly && getConfig().capabilities.command)) {
      return fail('TOOL_DISABLED: ask_user_to_run is offered with "Run programs". Ask the user to enable "Run programs" in the app, then retry.');
    }
    return null;
  };

  reg.register('ask_user_to_run', toolDeclaration('ask_user_to_run', () => ({
    title: 'Ask the user to run a step',
    description: ASK_USER_TO_RUN_DESCRIPTION,
    inputSchema: userRequestInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  })), input => guard('ask_user_to_run', async () => {
    const refusal = available();
    if (refusal) return refusal;
    const caller = currentCaller();
    if (!caller.sessionId || !caller.conversationId) {
      return failIdentity('Exact chat identity is required to hand a step to the user: it is shown in that chat. No step was recorded.');
    }
    if (Buffer.byteLength(input.command, 'utf8') > USER_REQUEST_LIMITS.commandBytes) {
      return fail(`INVALID_ARGUMENTS: the command is longer than ${USER_REQUEST_LIMITS.commandBytes / 1024} KB. Put long scripts in a file in the folder and ask the person to run that file. No step was recorded.`);
    }
    let folder: string, remote: boolean, base: string;
    try {
      const cwd = await resolveCwd(reg.ctx, input.workdir);
      remote = cwd.remote !== undefined;
      folder = cwd.remote ? `${cwd.remote.host}:${cwd.real}` : cwd.real;
      base = cwd.virtual;
    } catch (error) {
      if (error instanceof SandboxError) return fail(`${error.message}. The folder must be an approved folder or inside one. No step was recorded.`);
      throw error;
    }
    const expected = await Promise.all((input.expected ?? []).map(async file => {
      if (remote) return { path: file };
      try {
        // resolvePath, not resolveIn: an expected file only names a place, so it must not
        // become the folder later commands run in.
        return { path: file, real: (await resolvePath(reg.ctx.roots, file, { allowMissing: true, base })).real };
      } catch (error) {
        if (error instanceof SandboxError) return { path: file };
        throw error;
      }
    }));
    const filed = await fileUserRequest(caller.sessionId, {
      command: input.command,
      folder,
      remote,
      purpose: input.purpose,
      expected,
      ...(input.constraints ? { constraints: input.constraints } : {}),
      conversationId: caller.conversationId
    });
    if ('refused' in filed) {
      logInfo(`user request refused for session ${caller.sessionId}: ${USER_REQUEST_LIMITS.open} steps already open`);
      return fail(`TOO_MANY_OPEN_STEPS: ${USER_REQUEST_LIMITS.open} steps already wait for the person in this chat. Wait for them, or check them with user_request_status. No step was recorded.`);
    }
    const { request, existing } = filed;
    logInfo(`user request ${request.id} ${existing ? 'asked again (same open step)' : 'recorded'} for session ${caller.sessionId}`);
    return ok(
      `${existing ? 'This step was already waiting for the person' : 'Step recorded for the person'}: ${request.id}. ` +
      'It is shown in their app with the command, the folder and its purpose. The app does not run it. ' +
      'Continue with work that does not depend on it, and check it later with user_request_status.'
    );
  }));

  reg.register('user_request_status', toolDeclaration('user_request_status', () => ({
    title: 'Check a step for the user',
    description: USER_REQUEST_STATUS_DESCRIPTION,
    inputSchema: userRequestStatusInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  })), ({ id }) => guard('user_request_status', async () => {
    const refusal = available();
    if (refusal) return refusal;
    const caller = currentCaller();
    if (!caller.sessionId) return failIdentity('Exact chat identity is required to check a step. Nothing was read.');
    const request = (await readSessionUserRequests(caller.sessionId)).find(row => row.id === id);
    if (!request) return fail(`UNKNOWN_STEP: ${id} is not a step of this chat.`);
    return ok(statusText(request, await userRequestFound(request)));
  }));
}
