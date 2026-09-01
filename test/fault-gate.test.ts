import { describe, expect, it } from 'vitest';
import { faultGate } from './helpers.js';

describe('deterministic recovery fault gate', () => {
  it('proves the fault boundary was reached before releasing it', async () => {
    const gate = faultGate();
    const order: string[] = [];
    const work = (async () => {
      order.push('before');
      await gate.hold();
      order.push('after');
    })();

    await gate.reached;
    expect(order).toEqual(['before']);
    expect(gate.isReleased()).toBe(false);

    gate.release();
    gate.release(); // idempotent cleanup is important in finally blocks.
    await work;
    expect(order).toEqual(['before', 'after']);
    expect(gate.isReleased()).toBe(true);
  });
});