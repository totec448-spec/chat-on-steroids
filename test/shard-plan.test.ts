import { describe, expect, it } from 'vitest';
import { byWeight, parseShard, planShards, readWeights } from '../scripts/shard-plan.mjs';

// CI shards (2026-10-31): every item in exactly one shard, close loads, the same plan in every job.
describe('shard plan', () => {
  const weights = new Map([['a', 200], ['b', 150], ['c', 100], ['d', 90], ['e', 60], ['f', 10]]);

  it('places every item in exactly one shard and keeps the loads close', () => {
    const items = ['f', 'e', 'd', 'c', 'b', 'a', 'new'];
    const plan = planShards(items, weights, 3);
    expect([...plan.keys()].sort()).toEqual([...items].sort());
    const loads = [0, 0, 0];
    for (const [item, shard] of plan) loads[shard]! += weights.get(item) ?? 90; // `new` weighs the median
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(200);
    expect(new Set(plan.values())).toEqual(new Set([0, 1, 2]));
  });

  it('gives the same plan whatever order the items arrive in', () => {
    const one = planShards(['a', 'b', 'c', 'd', 'e', 'f'], weights, 2);
    const two = planShards(['f', 'd', 'b', 'e', 'c', 'a', 'a'], weights, 2);
    expect([...two].sort()).toEqual([...one].sort());
  });

  it('orders longest first, equal weights by name', () => {
    expect(byWeight(['f', 'x', 'a', 'w'], new Map([['a', 5], ['f', 1], ['w', 3], ['x', 3]]))).toEqual(['a', 'w', 'x', 'f']);
  });

  it('puts everything in one shard when asked for one', () => {
    expect(new Set(planShards(['a', 'b'], weights, 1).values())).toEqual(new Set([0]));
  });

  it.each([['1/3', { index: 1, count: 3 }], ['3/3', { index: 3, count: 3 }], ['0/3', null], ['4/3', null], ['x', null], [undefined, null]])(
    'reads shard %s', (value, expected) => expect(parseShard(value as string | undefined)).toEqual(expected));

  it('keeps only usable weights from a damaged file', () => {
    expect([...readWeights('{"a": 1.5, "b": -1, "c": "x", "d": 0}')]).toEqual([['a', 1.5], ['d', 0]]);
    expect(readWeights('not json').size).toBe(0);
  });
});
