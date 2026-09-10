import { currentCaller, currentCall } from './call-context.js';
import { fail, guard, ok, type SurfaceRegistrar } from './kernel.js';
import { toolDeclaration } from './tool-declarations.js';
import { updateSessionPlan } from '../session/store.js';
import { agentPlanUpdateSchema } from '../../shared/agent-plan.js';

/**
 * Adapted from OpenAI Codex's update_plan (Apache-2.0), revision
 * 1a4096e273e80da30947e57fdfa45be92858ca91. CoS adds bounded step details and
 * stores the plan under the proven durable session instead of an outer Codex turn.
 */
export function registerPlanTool(reg: SurfaceRegistrar): void {
  reg.register('update_plan', toolDeclaration('update_plan', () => ({
    title: 'Update plan',
    description: 'Updates your task plan in the user’s app. Use for work with several meaningful steps; skip simple tasks. Send the complete plan with short step headlines, useful details and current statuses. Keep at most one step in_progress. Update after completing a step or changing approach. This only displays a plan; it does not execute steps or advance queued stages.',
    inputSchema: agentPlanUpdateSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  })), update => guard('update_plan', async () => {
    if (!reg.sessionToolsLive) return reg.featureDisabled('Session recording', 'Settings → Chat');
    const caller = currentCaller();
    if (!caller.sessionId || !caller.conversationId) {
      return fail('Exact chat identity is required to update its plan. No plan was changed; retry after the companion reconnects.');
    }
    const accepted = await updateSessionPlan(caller.sessionId, caller.conversationId, update, currentCall()!.startedAt);
    return accepted ? ok('Plan updated') : fail('This plan update is stale or its chat was replaced. The current plan was preserved.');
  }));
}
