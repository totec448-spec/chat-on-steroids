/** Normalized image bytes only. No local filesystem path crosses into the renderer. */
export interface InputImage { name: string; dataUrl: string; }
export type InputAutomation = 'off' | 'goal' | 'loop';
