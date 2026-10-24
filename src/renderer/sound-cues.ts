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

/** Schedules one cue's notes into `audio`, starting at `at` seconds; also used to render a cue offline in the UI check. */
export function scheduleSoundCue(audio: BaseAudioContext, kind: SoundCue, at: number): void {
  for (const [frequency, start, length] of NOTES[kind]) {
    const tone = audio.createOscillator(), gain = audio.createGain();
    tone.type = 'sine';
    tone.frequency.value = frequency;
    // A short fade in and out, so no note clicks.
    gain.gain.setValueAtTime(0, at + start);
    gain.gain.linearRampToValueAtTime(VOLUME, at + start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + start + length);
    tone.connect(gain).connect(audio.destination);
    tone.start(at + start);
    tone.stop(at + start + length + 0.02);
  }
}

export function playSoundCue(kind: SoundCue): void {
  try {
    context ??= new AudioContext();
    // Electron's default autoplay policy needs no click first; a context that starts suspended
    // anyway (an OS audio hiccup) is resumed.
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    scheduleSoundCue(context, kind, context.currentTime + 0.02);
  } catch {
    // No audio device, or audio disabled: a cue is never worth an error.
  }
}
