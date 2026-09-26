/** Dictation is an explicit draft action, separate from ChatGPT execution and tunnel credentials. */
export const DICTATION = {
  model: 'gpt-4o-mini-transcribe',
  maxAudioBytes: 8 * 1024 * 1024,
  maxRecordingMs: 5 * 60_000,
  requestTimeoutMs: 120_000,
  maxResponseBytes: 512 * 1024,
  maxTextChars: 24_000
} as const;

export type DictationStatus = { configured: boolean; model: string; maxRecordingMs: number };
export type DictationEvent = { id: string; text?: string; error?: string };
export type DictationAudio = { id: string; bytes: Uint8Array; mime: 'audio/webm'; language: string };
export type DictationReply<T> = { ok: true; data: T } | { ok: false; error: string };
export interface DictationApi {
  dictationStatus(): Promise<DictationReply<DictationStatus>>;
  dictationSetKey(value: string): Promise<DictationReply<DictationStatus>>;
  dictationBegin(id: string): Promise<DictationReply<void>>;
  dictationTranscribe(audio: DictationAudio): Promise<DictationReply<string>>;
  dictationCancel(id: string): Promise<DictationReply<void>>;
  onDictationEvent(listener: (event: DictationEvent) => void): () => void;
}
