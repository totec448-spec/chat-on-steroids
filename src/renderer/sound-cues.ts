import type { SoundCue } from '../shared/sound-cues.js';

/**
 * The three sounds (#1802), made with Web Audio rather than shipped as files: short, soft sine
 * tones, about a third of a second each. Finished rises, needs-you is a two-note chime and failed
 * falls. The main process decides when one plays (main/sound-cues.ts).
 */
const NOTES: Record<SoundCue, ReadonlyArray<readonly [frequency: number, start: number, length: number]>> = {
  finished: [[660, 0, 0.12], [880, 0.1, 0.2]],
  'needs-you': [[880, 0, 0.14], [660, 0.16, 0.14], [880, 0.32, 0.2]],
  failed: [[440, 0, 0.16], [330, 0.15, 0.26]]
};
/** Well below full scale: a cue, not an alarm. */
const VOLUME = 0.12;

let context: AudioContext | null = null;

export function playSoundCue(kind: SoundCue): void {
  try {
    context ??= new AudioContext();
    // A context made before any click starts suspended in Chromium; resuming is allowed here
    // because the app's own window plays it (Electron grants autoplay to the app).
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    const at = context.currentTime + 0.02;
    for (const [frequency, start, length] of NOTES[kind]) {
      const tone = context.createOscillator(), gain = context.createGain();
      tone.type = 'sine';
      tone.frequency.value = frequency;
      // A short fade in and out, so no note clicks.
      gain.gain.setValueAtTime(0, at + start);
      gain.gain.linearRampToValueAtTime(VOLUME, at + start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + start + length);
      tone.connect(gain).connect(context.destination);
      tone.start(at + start);
      tone.stop(at + start + length + 0.02);
    }
  } catch {
    // No audio device, or audio disabled: a cue is never worth an error.
  }
}
