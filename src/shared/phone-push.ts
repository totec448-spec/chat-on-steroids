/** Phone notifications through ntfy; see main/phone-push.ts. */
export interface QuietHours { from: string; to: string }

export interface PhonePushSettings {
  enabled: boolean;
  server: string;
  topic: string;
  needsYou: boolean;
  failures: boolean;
  /** null: never; 0: every finished chat; n: only after n minutes of work. */
  finishedAfterMinutes: number | null;
  onlyWhenAway: boolean;
  quietHours: QuietHours | null;
  /** The chat's name, the start of its answer and a link to it. */
  includeDetails: boolean;
}

export const DEFAULT_PHONE_PUSH: PhonePushSettings = {
  enabled: false, server: 'https://ntfy.sh', topic: '', needsYou: true, failures: true, finishedAfterMinutes: 5,
  onlyWhenAway: true, quietHours: null, includeDetails: false
};

/** The choices Settings offers for a finished chat, in minutes of work; null is never. */
export const PHONE_PUSH_FINISHED_AFTER = [null, 0, 5, 15, 30, 60] as const;
