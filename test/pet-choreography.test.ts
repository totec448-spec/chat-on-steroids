import { it, expect } from 'vitest';
import { carriedText, thrownText, THROW_RELEASE } from '../src/renderer/pet-choreography.js';

it('places carried text beyond the face and next to the hands in every gait pose', () => {
  for (let time = 0; time < 880; time += 10) {
    const point = carriedText('carry', time, 70);
    expect(point.x - 35).toBeGreaterThan(90);
    expect(point.y).toBeGreaterThan(70);
  }
});

it('releases at the attached position in both directions without a discontinuity', () => {
  const hand = carriedText('throw', THROW_RELEASE - .001, 70);
  for (const facing of [1, -1] as const) {
    const start = thrownText({ x: 100, y: 100 }, facing, THROW_RELEASE, 70, { x: 400, y: 237 });
    expect(start.x).toBeCloseTo(180 + facing * (hand.x - 80));
    expect(start.y).toBeCloseTo(100 + hand.y);
    expect(start.progress).toBe(0);
    const contact = thrownText({ x: 100, y: 100 }, facing, THROW_RELEASE + 600, 70, { x: 400, y: 237 });
    expect(contact).toEqual({ x: 400, y: 219, progress: 1 });
  }
});
