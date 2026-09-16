/** Safe catalog metadata. Skill bodies remain main-process data until prompt preparation. */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  /** Stable model-facing path inside the managed Skills library. */
  path: string;
}

export const MAX_SKILLS = 64;
export const MAX_SKILL_BYTES = 128_000;
export const MAX_SKILL_CHARS = 96_000;
export const MAX_SKILL_NAME_CHARS = 80;
export const MAX_SKILL_DESCRIPTION_CHARS = 240;
export const SKILL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

