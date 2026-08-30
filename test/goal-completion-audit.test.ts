import { describe, expect, it } from 'vitest';
import { GOAL_OBJECTIVE_TRAILER, GOAL_SYSTEM_TRAILER } from '../src/shared/goal.js';

describe('Goal completion audit trailers', () => {
  it('does not accept computer-use completion language without transcript evidence', () => {
    for (const trailer of [GOAL_SYSTEM_TRAILER, GOAL_OBJECTIVE_TRAILER]) {
      expect(trailer).toContain('computer-use');
      expect(trailer).toContain('planned');
      expect(trailer).toContain('promised');
      expect(trailer).toContain('failed');
      expect(trailer).toContain('verification');
    }
  });

  it('keeps the user request as the ceiling instead of inventing acceptance criteria', () => {
    expect(GOAL_SYSTEM_TRAILER).toContain('do not add');
    expect(GOAL_OBJECTIVE_TRAILER).toContain('Never widen the goal');
  });

  it('has an explicit repeated-blocker escape hatch', () => {
    for (const trailer of [GOAL_SYSTEM_TRAILER, GOAL_OBJECTIVE_TRAILER]) {
      expect(trailer).toContain('three consecutive assistant turns');
      expect(trailer).toContain('user-only');
      expect(trailer).toContain('further autonomous progress impossible');
    }
  });

  it('still preserves the two-move NO_REPLY protocol', () => {
    expect(GOAL_SYSTEM_TRAILER).toContain('NO_REPLY');
    expect(GOAL_OBJECTIVE_TRAILER).toContain('NO_REPLY');
  });
});
