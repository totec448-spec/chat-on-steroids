/** Speech-to-text events from the opt-in Windows recognizer. Raw audio never crosses IPC. */
export type DictationEvent =
  | { type: 'status'; status: 'starting' | 'listening' | 'stopped' }
  | { type: 'partial' | 'final'; text: string }
  | { type: 'error'; message: string };

/** Ignore untrusted child stdout, malformed JSON and implausibly large transcripts. */
export function parseDictationEvent(line: string): DictationEvent | null {
  if (!line || line.length > 16_384) return null;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  if (event.type === 'status' && ['starting', 'listening', 'stopped'].includes(String(event.status))) {
    return { type: 'status', status: event.status as 'starting' | 'listening' | 'stopped' };
  }
  if ((event.type === 'partial' || event.type === 'final') && typeof event.text === 'string') {
    const text = event.text.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, 4_000).trim();
    return text ? { type: event.type, text } : null;
  }
  if (event.type === 'error' && typeof event.message === 'string') {
    const message = event.message.replace(/[\u0000-\u001f]/g, ' ').slice(0, 240).trim();
    return { type: 'error', message: message || 'Speech recognition failed' };
  }
  return null;
}
