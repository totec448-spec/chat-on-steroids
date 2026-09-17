import manifest from './pet-assets/animations.json';
import type { Point, PetAnimation } from './pet-machine.js';

const hands = manifest.hands as Record<string, number[]>;
export const THROW_RELEASE = manifest.animations.throw.ms.slice(0, 4).reduce((a, b) => a + b, 0);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
function anchor(frame: number, textWidth: number): Point {
  const [x, y, side] = hands[String(frame)] ?? hands['79']!;
  return { x: x! + side! * (textWidth / 2 - 3), y: y! - 8 };
}

/** Interpolate hand anchors, not the character's body or its sprite scale. */
export function carriedText(animation: PetAnimation, elapsed: number, textWidth: number): Point {
  const clip = manifest.animations[animation];
  const total = clip.ms.reduce((a, b) => a + b, 0);
  let time = clip.loop ? elapsed % total : Math.min(elapsed, total - 1);
  let index = 0;
  while (index < clip.frames.length - 1 && time >= clip.ms[index]!) time -= clip.ms[index++]!;
  const frame = clip.frames[index]!;
  const previous = index ? clip.frames[index - 1]! : animation === 'throw' ? 79 : animation === 'carry' ? 71 : frame;
  const from = anchor(previous, textWidth), to = anchor(frame, textWidth);
  const t = Math.min(1, time / Math.min(70, clip.ms[index]!));
  return { x: lerp(from.x, to.x, t), y: lerp(from.y, to.y, t) };
}

export function thrownText(position: Point, facing: 1 | -1, elapsed: number, textWidth: number, bin: Point): Point & { progress: number } {
  // The release begins exactly where the preceding attached text ends.
  const hand = carriedText('throw', THROW_RELEASE - .001, textWidth);
  const start = { x: position.x + 80 + facing * (hand.x - 80), y: position.y + hand.y };
  const progress = Math.max(0, Math.min(1, (elapsed - THROW_RELEASE) / 600));
  return {
    x: lerp(start.x, bin.x, progress),
    y: lerp(start.y, bin.y - 18, progress) - Math.sin(progress * Math.PI) * Math.min(70, Math.max(0, start.y - 18)),
    progress
  };
}
