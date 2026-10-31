import { beforeEach, expect, it, vi } from 'vitest';

// CodeRabbit on #1954: the fresh-turn Stop waits until its fence is on disk, and does not go out
// when the fence cannot be saved (a restart could then lose the continue).
const durable = vi.hoisted(() => ({ rows: null as unknown, fail: false, writes: [] as unknown[] }));
const warned = vi.hoisted(() => [] as string[]);
vi.mock('../src/main/durable.js', () => ({
  readDurable: async () => structuredClone(durable.rows),
  writeDurableNow: async (_name: string, value: unknown) => {
    await new Promise(resolve => setTimeout(resolve, 5));
    if (durable.fail) throw new Error('disk full');
    durable.rows = structuredClone(value); durable.writes.push(value);
  }
}));
vi.mock('../src/main/logger.js', () => ({ logWarn: (line: string) => { warned.push(line); }, logInfo: () => undefined }));
const fence = await import('../src/main/rotation-fence.js');

beforeEach(() => { fence.resetRotationFencesForTests(); durable.rows = null; durable.fail = false; durable.writes.length = 0; warned.length = 0; });

it('resolves once the fence is saved, with what a restart needs', async () => {
  const now = Date.now();
  const saved = fence.armRotationFence('chat-a', 'turn-a', 60_000);
  expect(fence.rotationFenced('chat-a')).toBe(true);
  expect(durable.rows).toBeNull();
  expect(await saved).toBe(true);
  expect(durable.rows).toEqual([{ conversationId: 'chat-a', turnId: 'turn-a', until: expect.any(Number) }]);
  expect((durable.rows as Array<{ until: number }>)[0]!.until).toBeGreaterThanOrEqual(now + 60_000);
  // A restart brings it back for what is left of it; one that ran out stays gone.
  fence.resetRotationFencesForTests();
  expect(await fence.restoreRotationFences(now + 30_000)).toBe(1);
  expect(fence.rotationFenceTurn('chat-a')).toBe('turn-a');
  fence.resetRotationFencesForTests();
  expect(await fence.restoreRotationFences(now + 61_000)).toBe(0);
});

it('says when the fence could not be saved, so the Stop does not go out', async () => {
  durable.fail = true;
  expect(await fence.armRotationFence('chat-b', 'turn-b')).toBe(false);
  expect(warned).toContain('turn rotation: could not save the fresh-turn fences — Error: disk full');
});

it('never keeps a fence longer than a Stop\'s budget, and ignores damaged rows', async () => {
  durable.rows = [{ conversationId: 'chat-c', turnId: 'turn-c', until: Date.now() + 10 * fence.FENCE_MS },
    { conversationId: 7, turnId: 'x', until: Date.now() + 1000 }, null, { conversationId: 'chat-d', turnId: 'turn-d', until: 'soon' }];
  expect(await fence.restoreRotationFences()).toBe(1);
  expect(fence.rotationFenced('chat-c')).toBe(true);
  expect(fence.rotationFenced('chat-d')).toBe(false);
});

it('resolves a cleared fence once the clearing is saved, and says when it could not be', async () => {
  expect(await fence.clearRotationFence('no-fence')).toBe(true);
  await fence.armRotationFence('chat-e', 'turn-e');
  expect(await fence.clearRotationFence('chat-e')).toBe(true);
  expect(durable.rows).toEqual([]);
  await fence.armRotationFence('chat-f', 'turn-f');
  durable.fail = true;
  expect(await fence.clearRotationFence('chat-f')).toBe(false);
  expect(fence.rotationFenced('chat-f')).toBe(false);
});
