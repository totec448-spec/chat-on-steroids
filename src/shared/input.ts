/** Normalized image bytes only. No local filesystem path crosses into the renderer. */
export interface InputImage { name: string; dataUrl: string; }
/** Immutable staged upload. Neither renderer nor browser receives a local path. */
export interface InputAttachment { id: string; name: string; size: number; mimeType: string; preview?: string; }
export type InputAutomation = 'off' | 'goal' | 'loop';
