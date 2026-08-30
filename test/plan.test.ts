import { describe, expect, it } from 'vitest';
import { parsePlanDirective, planAllowsTool } from '../src/main/plan.js';

describe('/plan command semantics', () => {
  it('recognizes plan start, approval and cancellation only at the start of a user message', () => {
    expect(parsePlanDirective('/plan refactor the recorder')).toEqual({
      phase: 'planning',
      objective: 'refactor the recorder'
    });
    expect(parsePlanDirective('/plan')).toEqual({ phase: 'planning', objective: '' });
    expect(parsePlanDirective('/plan run')).toEqual({ phase: 'approved', objective: '' });
    expect(parsePlanDirective('/plan clear')).toEqual({ phase: 'off', objective: '' });
    expect(parsePlanDirective('please mention /plan run in the docs')).toBeNull();
  });

  it('hard-blocks every mutating surface while planning', () => {
    for (const tool of ['apply_patch', 'exec_command', 'write_stdin', 'agents', 'computer']) {
      expect(planAllowsTool('planning', tool), tool).toBe(false);
    }
  });

  it('keeps inspection tools available while planning', () => {
    for (const tool of ['read', 'view_image', 'find', 'session', 'observe']) {
      expect(planAllowsTool('planning', tool), tool).toBe(true);
    }
  });

  it('lifts the fence after /plan run or /plan clear', () => {
    for (const phase of ['approved', 'off'] as const) {
      expect(planAllowsTool(phase, 'apply_patch')).toBe(true);
      expect(planAllowsTool(phase, 'exec_command')).toBe(true);
      expect(planAllowsTool(phase, 'computer')).toBe(true);
    }
  });
});
