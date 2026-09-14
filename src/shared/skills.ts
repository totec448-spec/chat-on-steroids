/** One installed prompt skill exposed to the renderer/prompt composer. */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
}

/** Fresh on-disk projection. Per-skill failures stay visible instead of hiding entries silently. */
export interface SkillLibrary {
  directory: string;
  skills: SkillSummary[];
  errors: string[];
}
