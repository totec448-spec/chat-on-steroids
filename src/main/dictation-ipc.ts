import { app, dialog, ipcMain, session, systemPreferences, type BrowserWindow, type WebContents } from 'electron';
import { z } from 'zod';
import { DICTATION, type DictationEvent, type DictationStatus } from '../shared/dictation.js';
import { getSecret, hasSecret, setSecret } from './secrets.js';
import { transcribeDictation } from './dictation.js';

/** One foreground document owns one explicitly approved recording and its optional upload. */
export function registerDictationIpc(getWindow: () => BrowserWindow | null): void {
  type Active = { id: string; owner: WebContents; url: string; phase: 'permission' | 'recording' | 'transcribing';
    abort: AbortController; timer?: ReturnType<typeof setTimeout>; dispose: () => void };
  let active: Active | null = null;
  let consentOwner: WebContents | null = null;
  const idSchema = z.object({ id: z.string().uuid() }).strict();
  const emit = (job: Active, value: Omit<DictationEvent, 'id'>): void => {
    if (active === job && !job.owner.isDestroyed()) job.owner.send('dictation:event', { id: job.id, ...value });
  };
  const retire = (job: Active | null, error?: string): void => {
    if (!job || active !== job) return;
    if (error) emit(job, { error });
    active = null; clearTimeout(job.timer); job.abort.abort(); job.dispose();
  };
  const currentWindow = (): BrowserWindow => {
    const target = getWindow();
    if (!target || target.isDestroyed() || target.webContents.isDestroyed()) throw new Error('Dictation window is unavailable.');
    return target;
  };
  const ownsPermission = (owner: WebContents | null, details: { isMainFrame: boolean; requestingUrl?: string }): boolean => {
    const job = active, target = getWindow();
    return !!(job?.phase === 'recording' && target && !target.isDestroyed() && !job.abort.signal.aborted &&
      owner === job.owner && owner === target.webContents && !owner.isDestroyed() && target.isVisible() && target.isFocused() &&
      details.isMainFrame && details.requestingUrl === job.url && owner.mainFrame.url === job.url);
  };
  // Both handlers are required: a generic `media` grant would also authorize a camera.
  session.defaultSession.setPermissionCheckHandler((owner, permission, _origin, details) =>
    permission === 'media' && details.mediaType === 'audio' && ownsPermission(owner, details));
  session.defaultSession.setPermissionRequestHandler((owner, permission, callback, details) => {
    const types = 'mediaTypes' in details ? details.mediaTypes : undefined;
    callback(permission === 'media' && Array.isArray(types) && types.length === 1 && types[0] === 'audio' && ownsPermission(owner, details));
  });
  app.on('before-quit', () => retire(active, 'Dictation cancelled.'));
  const status = async (): Promise<DictationStatus> => ({ configured: await hasSecret('dictationApiKey'), model: DICTATION.model, maxRecordingMs: DICTATION.maxRecordingMs });
  ipcMain.handle('dictation:request', async (event, raw: unknown) => {
    try {
      const target = currentWindow();
      if (event.sender !== target.webContents || event.senderFrame !== target.webContents.mainFrame) throw new Error('Dictation requires the application main window.');
      const action = z.object({ action: z.enum(['status', 'key', 'begin', 'cancel', 'transcribe']) }).passthrough().parse(raw).action;
      if (action === 'status') { z.object({ action: z.literal('status') }).strict().parse(raw); return { ok: true, data: await status() }; }
      if (action === 'key') {
        const { value } = z.object({ action: z.literal('key'), value: z.string().max(4096).refine(value => !/[\r\n]/.test(value)) }).strict().parse(raw);
        if (!target.isFocused()) throw new Error('Focus CoS to configure dictation.');
        retire(active, 'Dictation cancelled because its API key changed.');
        await setSecret('dictationApiKey', value); return { ok: true, data: await status() };
      }
      const id = z.object({ id: z.string().uuid() }).passthrough().parse(raw).id;
      if (action === 'cancel') {
        idSchema.extend({ action: z.literal('cancel') }).parse(raw);
        if (active?.id === id && active.owner === event.sender) retire(active);
        return { ok: true, data: undefined };
      }
      if (action === 'begin') {
        idSchema.extend({ action: z.literal('begin') }).parse(raw);
        if (active) throw new Error('Finish or cancel the current dictation first.');
        if (!target.isFocused() || !target.isVisible()) throw new Error('Focus CoS to start dictation.');
        const owner = event.sender;
        const ended = (): void => retire(job, 'Dictation cancelled because its window changed.');
        const job: Active = { id, owner, url: owner.mainFrame.url, phase: 'permission', abort: new AbortController(),
          dispose: () => { owner.removeListener('destroyed', ended); owner.removeListener('did-start-loading', ended); target.removeListener('hide', ended); } };
        active = job;
        owner.once('destroyed', ended); owner.once('did-start-loading', ended); target.once('hide', ended);
        job.timer = setTimeout(() => retire(job, 'Dictation reached its five-minute recording limit.'), DICTATION.maxRecordingMs);
        job.timer.unref?.();
        try {
          if (!await hasSecret('dictationApiKey')) throw new Error('Configure a separate OpenAI API key for dictation.');
          if (active !== job) throw new Error('Dictation cancelled.');
          if (consentOwner !== owner) {
            const result = await dialog.showMessageBox(target, { type: 'question', title: 'Voice to text',
              message: 'Allow microphone dictation in CoS?',
              detail: 'Recording starts only when you press Record. Finish sends this audio to the OpenAI transcription API using your separate API key; API billing applies. CoS does not save the audio. The transcript is a draft and is never sent automatically.',
              buttons: ['Allow dictation', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true });
            if (result.response !== 0 || active !== job) throw new Error('Microphone permission was not granted.');
            consentOwner = owner;
          }
          if (process.platform === 'darwin' && !await systemPreferences.askForMediaAccess('microphone')) throw new Error('Microphone access is disabled in system settings.');
          if (active !== job || owner.mainFrame.url !== job.url || !target.isFocused()) throw new Error('Dictation cancelled because its window changed.');
          job.phase = 'recording';
          clearTimeout(job.timer);
          job.timer = setTimeout(() => retire(job, 'Dictation reached its five-minute recording limit.'), DICTATION.maxRecordingMs);
          job.timer.unref?.();
          return { ok: true, data: undefined };
        } catch (error) { retire(job); throw error; }
      }
      const audio = z.object({ action: z.literal('transcribe'), id: z.string().uuid(),
        bytes: z.instanceof(Uint8Array).refine(bytes => bytes.byteLength >= 4 && bytes.byteLength <= DICTATION.maxAudioBytes),
        mime: z.literal('audio/webm'), language: z.string().regex(/^(?:[a-z]{2})?$/) }).strict().parse(raw);
      const job = active;
      if (!job || job.id !== id || job.owner !== event.sender || job.phase !== 'recording' || job.url !== event.sender.mainFrame.url)
        throw new Error('This recording no longer owns a dictation request.');
      job.phase = 'transcribing'; clearTimeout(job.timer);
      job.timer = setTimeout(() => retire(job, 'Transcription timed out. No automatic retry was made.'), DICTATION.requestTimeoutMs);
      job.timer.unref?.();
      try {
        const key = await getSecret('dictationApiKey');
        if (active !== job || !key) throw new Error('Dictation cancelled or its API key is unavailable.');
        const text = await transcribeDictation({ bytes: audio.bytes, language: audio.language, key, signal: job.abort.signal,
          progress: text => emit(job, { text }) });
        if (active !== job) throw new Error('Dictation cancelled.');
        return { ok: true, data: text };
      } finally { retire(job); }
    } catch (error) {
      return { ok: false, error: error instanceof z.ZodError ? 'Invalid dictation request.' : error instanceof Error ? error.message : 'Dictation failed.' };
    }
  });
}
