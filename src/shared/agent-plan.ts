import { z } from 'zod';

/** Codex's update_plan contract, with optional per-step detail for the desktop view. */
export const agentPlanUpdateSchema = z.object({
  explanation: z.string().trim().max(1000).optional().describe('Brief explanation of a changed plan.'),
  plan: z.array(z.object({
    step: z.string().trim().min(1).max(160).describe('Short headline shown to the user.'),
    status: z.enum(['pending', 'in_progress', 'completed']),
    details: z.string().trim().max(2000).optional().describe('Concrete approach, checks or remaining work beneath this headline. Keep useful detail when updating status.')
  }).strict()).max(12)
    .refine(steps => steps.filter(step => step.status === 'in_progress').length <= 1, 'At most one step may be in_progress.')
    .refine(steps => steps.reduce((size, step) => size + step.step.length + (step.details?.length ?? 0), 0) <= 12000, 'Keep the complete plan below 12,000 characters.')
    .describe('The complete updated plan. Send an empty array to clear it.')
}).strict();

export const agentPlanSchema = agentPlanUpdateSchema.extend({ updatedAt: z.number().finite().nonnegative() });
export type AgentPlanUpdate = z.infer<typeof agentPlanUpdateSchema>;
export type AgentPlan = z.infer<typeof agentPlanSchema>;

/** UTF-8, including JSON escapes and the server timestamp; also the bounded disk-read size. */
export const MAX_AGENT_PLAN_BYTES = 96 * 1024;
