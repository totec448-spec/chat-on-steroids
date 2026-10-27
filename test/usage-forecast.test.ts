import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usageLimitForecast, usageLimitSegment } from '../src/shared/usage.js';

const minute = 60000;
const start = 1_800_000_000_000;
const at = (minutes: number, value: number, resetMinutes: number | null = null) =>
  ({ at: start + minutes * minute, value, resetAt: resetMinutes === null ? null : start + resetMinutes * minute });

describe('limit pace estimate', () => {
  // The clock sits at the first reading, so the estimates below do not depend on today's date.
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
  afterEach(() => { vi.useRealTimers(); });

  it('starts a limit\'s trend again when it goes up, after a reset or a refill', () => {
    expect(usageLimitSegment([at(0, 50), at(10, 40), at(20, 90), at(30, 90), at(40, 80)])).toEqual([at(20, 90), at(30, 90), at(40, 80)]);
    expect(usageLimitSegment([])).toEqual([]);
  });

  it('starts again after the reported reset passed, even when the new window reads lower', () => {
    // The window reset at minute 30; by the first reading after it, more had been used than before.
    expect(usageLimitSegment([at(0, 50, 30), at(20, 40, 30), at(40, 35, 330), at(50, 30, 330)])).toEqual([at(40, 35, 330), at(50, 30, 330)]);
    // A reset time that moves later while still ahead is the same window.
    expect(usageLimitSegment([at(0, 50, 100), at(20, 40, 120), at(40, 35, 140)])).toHaveLength(3);
  });

  it('says when a limit runs out at the pace of about the last hour', () => {
    // 60 → 40 over the last hour: 20 an hour, so 40 more lasts two hours.
    const readings = [at(0, 90), at(60, 60), at(90, 50), at(120, 40)];
    expect(usageLimitForecast(readings, null)).toEqual({ runsOutAt: at(240, 0).at, beforeReset: true });
    expect(usageLimitForecast(readings, at(200, 0).at)).toEqual({ runsOutAt: at(240, 0).at, beforeReset: false });
  });

  it('gives no estimate once the run-out time has passed', () => {
    // 30 → 20 over twenty minutes runs out at minute 60, but the newest reading is from minute 20.
    const readings = [at(0, 30), at(20, 20)];
    vi.setSystemTime(at(59, 0).at);
    expect(usageLimitForecast(readings, null)?.runsOutAt).toBe(at(60, 0).at);
    vi.setSystemTime(at(60, 0).at);
    expect(usageLimitForecast(readings, null)).toBeNull();
    vi.setSystemTime(at(75, 0).at);
    expect(usageLimitForecast(readings, null)).toBeNull();
  });

  it('measures a young window from its start', () => {
    expect(usageLimitForecast([at(0, 30), at(20, 20)], null)?.runsOutAt).toBe(at(60, 0).at);
  });

  it('measures inside the last hour when the reading before it is from long before', () => {
    // The app reported nothing for five hours; 50 → 40 in the last ten minutes is the pace.
    expect(usageLimitForecast([at(0, 60), at(300, 50), at(310, 40)], null)?.runsOutAt).toBe(at(350, 0).at);
  });

  it('gives no estimate with too little history, no use, or nothing left', () => {
    expect(usageLimitForecast([at(0, 30)], null)).toBeNull();
    expect(usageLimitForecast([at(0, 30), at(5, 20)], null)).toBeNull();
    expect(usageLimitForecast([at(0, 30), at(60, 30)], null)).toBeNull();
    expect(usageLimitForecast([at(0, 30), at(60, 0)], null)).toBeNull();
    // A refill twenty minutes ago leaves only the new window, which is too short to judge.
    expect(usageLimitForecast([at(0, 50), at(40, 20), at(100, 90), at(105, 80)], null)).toBeNull();
  });
});
