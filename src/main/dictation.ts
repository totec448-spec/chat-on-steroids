import { DICTATION } from '../shared/dictation.js';

/** Fixed provider, bounded in-memory audio, no file paths, transcript persistence or automatic retries. */
export async function transcribeDictation(args: {
  bytes: Uint8Array; language: string; key: string; signal: AbortSignal;
  progress: (text: string) => void; fetch?: typeof fetch;
}): Promise<string> {
  if (args.bytes.byteLength < 4 || args.bytes.byteLength > DICTATION.maxAudioBytes ||
      ![0x1a, 0x45, 0xdf, 0xa3].every((byte, index) => args.bytes[index] === byte))
    throw new Error('The recording is empty, too large, or not supported WebM audio.');
  if (!/^(?:[a-z]{2})?$/.test(args.language)) throw new Error('Invalid transcription language.');
  if (!args.key || args.key.length > 4096 || /[\r\n]/.test(args.key)) throw new Error('Configure a separate OpenAI API key for dictation.');
  args.signal.throwIfAborted();
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(args.bytes)], { type: 'audio/webm' }), 'dictation.webm');
  form.set('model', DICTATION.model); form.set('stream', 'true');
  form.set('response_format', 'json');
  if (args.language) form.set('language', args.language);
  let response: Response;
  try {
    response = await (args.fetch ?? fetch)('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${args.key}` }, body: form,
      signal: args.signal, redirect: 'error'
    });
  } catch {
    if (args.signal.aborted) throw new Error('Dictation cancelled or timed out.');
    throw new Error('Could not reach the transcription service. No automatic retry was made.');
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(response.status === 401 || response.status === 403 ? 'The dictation API key was rejected. Check its access and billing.'
      : response.status === 429 ? 'The transcription service is rate-limited or has insufficient API credit. Try again later.'
      : 'The transcription service refused the recording. No automatic retry was made.');
  }
  const contentType = response.headers.get('content-type') ?? '';
  const streaming = contentType.includes('text/event-stream');
  if (!streaming && !contentType.includes('application/json')) {
    void response.body?.cancel().catch(() => {}); throw new Error('Unsupported transcription response.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The transcription response was empty.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, pending = '', text = '', final: string | null = null, lastProgress = 0;
  const boundedText = (value: unknown): string => {
    if (typeof value !== 'string' || value.length > DICTATION.maxTextChars) throw new Error('The transcription response exceeded its text limit.');
    return value;
  };
  const frame = (raw: string): void => {
    const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let value: { type?: string; delta?: unknown; text?: unknown };
    try { value = JSON.parse(data); } catch { throw new Error('The transcription stream was incomplete.'); }
    if (!value || typeof value !== 'object') throw new Error('Invalid transcription response.');
    if (value.type === 'error' || value.type === 'transcript.error') throw new Error('The transcription service could not finish this recording.');
    if (value.type === 'transcript.text.delta') {
      if (final !== null) throw new Error('The transcription stream changed after completion.');
      text = boundedText(text + boundedText(value.delta));
      // Send replaceable previews at most 12.5 times/second; completion always publishes below.
      if (Date.now() - lastProgress >= 80) { lastProgress = Date.now(); args.progress(text); }
    } else if (value.type === 'transcript.text.done') {
      const complete = boundedText(value.text);
      if (final !== null && final !== complete) throw new Error('The transcription stream returned contradictory results.');
      final = complete;
    }
  };
  try {
    for (;;) {
      args.signal.throwIfAborted();
      const read = await reader.read();
      if (read.done) break;
      size += read.value.byteLength;
      if (size > DICTATION.maxResponseBytes) throw new Error('The transcription response exceeded its size limit.');
      pending += decoder.decode(read.value, { stream: true });
      if (streaming) for (;;) {
        const split = /\r?\n\r?\n/.exec(pending); if (!split) break;
        frame(pending.slice(0, split.index)); pending = pending.slice(split.index + split[0].length);
      }
    }
    pending += decoder.decode();
    if (streaming) { if (pending.trim()) frame(pending); }
    else {
      let value: { text?: unknown };
      try { value = JSON.parse(pending); } catch { throw new Error('Invalid transcription response.'); }
      final = boundedText(value?.text);
    }
    args.signal.throwIfAborted();
    if (final === null) throw new Error('The transcription ended without a complete result.');
    const result = final.trim();
    if (!result) throw new Error('No speech was recognized. Try speaking closer to the microphone.');
    args.progress(result);
    return result;
  } catch (error) {
    if (args.signal.aborted) throw new Error('Dictation cancelled or timed out.');
    if (error instanceof TypeError) throw new Error('The transcription stream was interrupted. No automatic retry was made.');
    throw error;
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
