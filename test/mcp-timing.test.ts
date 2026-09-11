import { afterEach, expect, it, vi } from 'vitest';
import { beginToolTiming, createInboundTiming, formatInboundTiming, inboundRequestId, withInboundRequestId } from '../src/main/mcp/inbound.js';

afterEach(() => vi.restoreAllMocks());

it('separates local ingress, dispatch phases, and HTTP completion without retaining identities', async () => {
  let now = 10;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const timing = createInboundTiming();
  now = 20;
  await withInboundRequestId('private-request', async () => {
    const mark = beginToolTiming();
    expect(inboundRequestId()).toBe('private-request');
    now = 23; mark('identity');
    await Promise.resolve();
    now = 38; mark('handler');
    now = 45; mark('delivery');
    now = 65; mark('recorder', true);
  }, timing);
  now = 70;
  expect(formatInboundTiming(timing)).toBe(' calls=1 ingress_ms=10 identity_ms=3 handler_ms=15 delivery_ms=7 recorder_ms=20 response_tail_ms=5');
  expect(JSON.stringify(timing)).not.toContain('private-request');
  expect(inboundRequestId()).toBeNull();
});

it('overlapping HTTP contexts keep independent timing and request identity', async () => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const a = createInboundTiming();
  const b = createInboundTiming();
  const slow = withInboundRequestId('a', async () => {
    const mark = beginToolTiming();
    await wait;
    expect(inboundRequestId()).toBe('a');
    mark('identity', true);
  }, a);
  now = 4;
  withInboundRequestId('b', () => {
    const mark = beginToolTiming();
    now = 7; mark('handler', true);
  }, b);
  now = 25; release(); await slow;
  expect(a.phases.identity).toBe(25);
  expect(a.phases.handler).toBe(0);
  expect(b.phases.handler).toBe(3);
  expect(b.phases.identity).toBe(0);
  expect(formatInboundTiming(createInboundTiming())).toBe('');
});
