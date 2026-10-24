/** The three sounds the app can play (#1802); see main/sound-cues.ts and renderer/sound-cues.ts. */
export const SOUND_CUES = ['needs-you', 'failed', 'finished'] as const;
export type SoundCue = typeof SOUND_CUES[number];
