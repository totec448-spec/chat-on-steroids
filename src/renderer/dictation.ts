import { DICTATION, type DictationApi, type DictationReply } from '../shared/dictation.js';
import { t, ui } from './i18n.js';

type Draft = { owner: string; text: string; start: number; end: number };
/** The result is editable text, never a Send receipt or executable instruction. */
export function insertDictation(input: HTMLTextAreaElement, owner: string, draft: Draft, transcript: string): boolean {
  const text = transcript.trim();
  if (owner !== draft.owner || input.value !== draft.text || !text || text.length > DICTATION.maxTextChars ||
      draft.start < 0 || draft.end < draft.start || draft.end > draft.text.length) return false;
  const before = draft.text.slice(0, draft.start), after = draft.text.slice(draft.end);
  // Separate adjacent words without inserting a space inside opening brackets
  // or before existing punctuation outside the explicitly selected range.
  const inserted = (/[\p{L}\p{N}\p{Pe}\p{Pf}.,:;!?…]$/u.test(before) && /^[\p{L}\p{N}]/u.test(text) ? ' ' : '') + text +
    (/[\p{L}\p{N}]$/u.test(text) && /^[\p{L}\p{N}]/u.test(after) ? ' ' : '');
  if (before.length + inserted.length + after.length > 96_000) return false;
  input.setRangeText(inserted, draft.start, draft.end, 'end');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

export function initDictation(options: { input: HTMLTextAreaElement; button: HTMLButtonElement; owner: () => string;
  api: DictationApi; copy: (text: string) => Promise<unknown> }): { cancel: () => void; dispose: () => void } {
  const { input, button, api } = options;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag); node.className = className;
    if (text) ui(node, 'textContent', () => t(text)); return node;
  };
  const control = (label: string, id: string): HTMLButtonElement => {
    const node = make('button', 'dictation-button', label); node.id = id; node.type = 'button'; return node;
  };
  const modal = make('dialog', 'dictation-dialog'); modal.id = 'dictationDialog'; modal.setAttribute('aria-labelledby', 'dictationTitle');
  const head = make('div', 'dictation-head'), title = make('h2', '', 'Voice to text'); title.id = 'dictationTitle';
  const close = control('Close', 'dictationClose'); head.append(title, close);
  const note = make('p', 'dictation-note', 'Record, review, then insert. Nothing is sent to your chat automatically.');
  const status = make('p', 'dictation-status'); status.id = 'dictationStatus'; status.setAttribute('role', 'status');
  const config = make('div', 'dictation-config');
  const keyLabel = make('label', '', 'OpenAI transcription API key'), key = make('input');
  key.id = 'dictationKey'; key.type = 'password'; key.autocomplete = 'off'; key.spellcheck = false; key.maxLength = 4096; keyLabel.htmlFor = key.id;
  const save = control('Save key', 'dictationSaveKey'), remove = control('Remove key', 'dictationRemoveKey');
  const keyActions = make('div', 'dictation-actions'); keyActions.append(save, remove); config.append(keyLabel, key, keyActions);
  const disclosure = make('p', 'dictation-disclosure', 'Audio is sent to the OpenAI API when you finish recording. Separate API billing applies. CoS keeps audio in memory only; your tunnel key is never used.');
  const languageRow = make('label', 'dictation-language'), language = make('select'); language.id = 'dictationLanguage';
  languageRow.htmlFor = language.id;
  for (const [value, label] of [['','Detect automatically'],['en','English'],['fr','Français'],['es','Español'],['de','Deutsch'],['it','Italiano'],['pt','Português'],['tr','Türkçe'],['ar','العربية'],['ja','日本語'],['zh','中文']]) {
    const option = make('option'); option.value = value!; option.textContent = label!;
    if (value) option.setAttribute('translate', 'no'); else ui(option, 'textContent', () => t('Detect automatically'));
    language.append(option);
  }
  // Bind only the caption, not the label's aggregate text including its select.
  languageRow.append(make('span', '', 'Speech language'), language);
  const visual = make('div', 'dictation-visual'), clock = make('span', 'dictation-clock'); clock.textContent = '0:00';
  const bars = make('div', 'dictation-wave'); bars.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 40; i++) bars.append(make('span'));
  visual.append(bars, clock);
  const previewLabel = make('label', 'dictation-preview-label', 'Review transcription'), preview = make('textarea', 'dictation-preview');
  preview.id = 'dictationPreview'; previewLabel.htmlFor = preview.id; preview.rows = 6; preview.dir = 'auto'; preview.maxLength = DICTATION.maxTextChars;
  const actions = make('div', 'dictation-actions');
  const record = control('Record', 'dictationRecord'), finish = control('Finish recording', 'dictationFinish'),
    pause = control('Pause', 'dictationPause'), insert = control('Insert into draft', 'dictationInsert'),
    copy = control('Copy transcript', 'dictationCopy'), settings = control('API key', 'dictationSettings');
  record.classList.add('is-primary'); insert.classList.add('is-primary');
  actions.append(settings, record, pause, finish, copy, insert);
  modal.append(head, note, status, config, languageRow, visual, previewLabel, preview, actions, disclosure);
  document.body.append(modal);
  type Phase = 'loading' | 'ready' | 'requesting' | 'recording' | 'paused' | 'transcribing' | 'review' | 'error';
  let phase: Phase = 'loading', configured = false, showConfig = false, disposed = false, generation = 0;
  let id: string | null = null, draft: Draft | null = null, stream: MediaStream | null = null, recorder: MediaRecorder | null = null;
  let audio: AudioContext | null = null, analyser: AnalyserNode | null = null, frame: number | undefined, limit: number | undefined;
  let chunks: Blob[] = [], bytes = 0, startedAt = 0, lastPaint = 0;
  const unwrap = <T>(reply: DictationReply<T>): T => { if (!reply.ok) throw new Error(reply.error); return reply.data; };
  const message = (text: string): void => { ui(status, 'textContent', () => t(text)); };
  const paint = (): void => {
    modal.dataset.phase = phase;
    config.hidden = configured && !showConfig;
    remove.hidden = !configured;
    settings.hidden = !configured || ['requesting','recording','paused','transcribing'].includes(phase);
    record.hidden = !['ready','error','review'].includes(phase) || !configured || showConfig;
    record.disabled = !configured;
    pause.hidden = !['recording','paused'].includes(phase);
    ui(pause, 'textContent', () => phase === 'paused' ? t('Resume recording') : t('Pause'));
    finish.hidden = !['recording','paused'].includes(phase);
    insert.hidden = phase !== 'review'; insert.disabled = !preview.value.trim();
    copy.hidden = !preview.value || !['review','error'].includes(phase);
    preview.hidden = !['transcribing','review'].includes(phase) && !preview.value;
    previewLabel.hidden = preview.hidden; preview.readOnly = phase !== 'review';
    visual.hidden = !['recording','paused','requesting'].includes(phase);
    language.disabled = ['requesting','recording','paused','transcribing'].includes(phase);
    ui(close, 'textContent', () => t(['requesting','recording','paused','transcribing'].includes(phase) ? 'Cancel' : 'Close'));
  };
  const releaseCapture = (): void => {
    clearTimeout(limit); cancelAnimationFrame(frame ?? 0); frame = undefined;
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    if (audio) void audio.close().catch(() => {}); audio = null; analyser = null;
  };
  const cancelOperation = (): void => {
    generation++;
    const previous = id; id = null;
    if (recorder) { recorder.ondataavailable = null; recorder.onstop = null; recorder.onerror = null;
      if (recorder.state !== 'inactive') recorder.stop(); recorder = null; }
    releaseCapture(); chunks = []; bytes = 0;
    if (previous) void api.dictationCancel(previous).catch(() => {});
  };
  const fail = (text: string): void => { cancelOperation(); phase = 'error'; message(text); paint(); };
  const meter = (now: number): void => {
    if (!modal.open || !['recording','paused'].includes(phase)) return;
    if (now - lastPaint > 65) {
      lastPaint = now;
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      clock.textContent = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2,'0')}`;
      let level = 0;
      if (analyser && phase === 'recording') { const samples = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(samples);
        for (const sample of samples) level += ((sample - 128) / 128) ** 2; level = Math.min(1, Math.sqrt(level / samples.length) * 5); }
      if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        const nodes = [...bars.children] as HTMLElement[];
        for (let i = 0; i < nodes.length - 1; i++) nodes[i]!.style.height = nodes[i + 1]!.style.height;
        nodes.at(-1)!.style.height = `${4 + level * 44}px`;
      }
    }
    frame = requestAnimationFrame(meter);
  };
  const completeRecording = (): void => {
    if (!recorder || !['recording','paused'].includes(phase)) return;
    phase = 'transcribing'; message('Transcribing…'); paint();
    recorder.stop(); releaseCapture();
  };
  const begin = async (): Promise<void> => {
    if (!configured || !['ready','review','error'].includes(phase)) return;
    cancelOperation(); const owner = options.owner(), baseline = input.value;
    draft = { owner, text: baseline, start: input.selectionStart, end: input.selectionEnd };
    preview.value = ''; clock.textContent = '0:00'; phase = 'requesting'; message('Waiting for microphone permission…'); paint();
    const operation = ++generation, requestId = crypto.randomUUID(); id = requestId;
    const current = (): boolean => !disposed && modal.open && generation === operation && id === requestId && owner === options.owner();
    try {
      if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder || !MediaRecorder.isTypeSupported('audio/webm'))
        throw new Error('Audio recording is not supported by this runtime.');
      unwrap(await api.dictationBegin(requestId));
      if (!current()) { void api.dictationCancel(requestId); return; }
      const captured = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (!current()) { captured.getTracks().forEach(track => track.stop()); void api.dictationCancel(requestId); return; }
      stream = captured;
      recorder = new MediaRecorder(captured, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm', audioBitsPerSecond: 64_000 });
      const recording = recorder;
      recording.ondataavailable = event => {
        if (!current()) return;
        bytes += event.data.size;
        if (bytes > DICTATION.maxAudioBytes) { fail('Recording exceeds the audio size limit. Please record a shorter message.'); return; }
        if (event.data.size) chunks.push(event.data);
      };
      recording.onerror = () => { if (current()) fail('The microphone recording failed. Your draft was not changed.'); };
      recording.onstop = () => { void (async () => {
        if (!current() || phase !== 'transcribing') return;
        recorder = null;
        // Detach this recording's bytes before yielding. An older Blob read must
        // never clear the header/chunks of a newer recording opened meanwhile.
        const recorded = new Blob(chunks, { type:'audio/webm' }); chunks = [];
        const recordingBytes = new Uint8Array(await recorded.arrayBuffer());
        if (!current()) return;
        if (recordingBytes.byteLength < 4) { fail('No audio was recorded. Try again.'); return; }
        try {
          const text = unwrap(await api.dictationTranscribe({ id: requestId, bytes: recordingBytes, mime:'audio/webm', language: language.value }));
          if (!current()) return;
          id = null; preview.value = text; phase = 'review'; message('Review the text before inserting it.'); paint(); preview.focus();
        } catch (error) { if (current()) fail(error instanceof Error ? error.message : 'Transcription failed.'); }
      })().catch(() => { if (current()) fail('The recording could not be prepared.'); }); };
      for (const track of captured.getAudioTracks()) track.onended = () => { if (current() && ['recording','paused'].includes(phase)) fail('The microphone disconnected. Your draft was not changed.'); };
      try { audio = new AudioContext(); analyser = audio.createAnalyser(); analyser.fftSize = 256; audio.createMediaStreamSource(captured).connect(analyser); }
      catch { /* The level meter is optional; recording has independent native ownership. */ }
      recording.start(250); startedAt = Date.now(); phase = 'recording'; message('Listening…'); paint();
      limit = window.setTimeout(completeRecording, DICTATION.maxRecordingMs - 1000); frame = requestAnimationFrame(meter);
    } catch (error) {
      if (!current()) return;
      const denied = error instanceof DOMException && ['NotAllowedError','PermissionDeniedError'].includes(error.name);
      fail(denied ? 'Microphone access was denied. Enable it in system settings to record.' : error instanceof Error ? error.message : 'Could not start the microphone.');
    }
  };
  const open = async (): Promise<void> => {
    if (modal.open || disposed) return;
    cancelOperation(); preview.value = ''; showConfig = false; phase = 'loading'; message('Loading dictation settings…'); paint(); modal.showModal();
    const operation = generation;
    try { const value = unwrap(await api.dictationStatus());
      if (disposed || !modal.open || operation !== generation) return;
      configured = value.configured; phase = 'ready'; message(configured ? 'Ready to record. Five-minute maximum.' : 'Add a transcription API key to use voice to text.'); paint();
      (configured ? record : key).focus();
    } catch { if (operation === generation) fail('Could not load dictation settings.'); }
  };
  const saveKey = async (value: string): Promise<void> => {
    save.disabled = remove.disabled = true; const operation = generation;
    try { const result = unwrap(await api.dictationSetKey(value));
      if (disposed || !modal.open || operation !== generation) return;
      configured = result.configured; key.value = ''; showConfig = !configured; phase = 'ready'; message(configured ? 'API key saved securely. Ready to record.' : 'Dictation API key removed.'); paint();
    } catch (error) { if (operation === generation) message(error instanceof Error ? error.message : 'Could not save the API key.'); }
    finally { save.disabled = remove.disabled = false; }
  };
  const click = (): void => { void open(); }; button.addEventListener('click', click);
  record.onclick = () => { void begin(); }; finish.onclick = completeRecording;
  pause.onclick = () => {
    if (!recorder || !['recording','paused'].includes(phase)) return;
    if (phase === 'recording') { recorder.pause(); phase = 'paused'; } else { recorder.resume(); phase = 'recording'; }
    stream?.getAudioTracks().forEach(track => { track.enabled = phase === 'recording'; });
    message(phase === 'paused' ? 'Paused. The five-minute limit still applies.' : 'Listening…'); paint();
  };
  save.onclick = () => { if (key.value.trim()) void saveKey(key.value); };
  remove.onclick = () => { void saveKey(''); }; settings.onclick = () => { showConfig = !showConfig; paint(); if(showConfig)key.focus(); };
  insert.onclick = () => {
    if (phase !== 'review' || !draft) return;
    if (!insertDictation(input, options.owner(), draft, preview.value)) { message('The original draft changed. Copy the transcript instead; nothing was overwritten.'); return; }
    closeModal(input);
  };
  copy.onclick = () => {
    const operation = generation;
    void options.copy(preview.value).then(() => { if(modal.open && operation === generation) message('Transcript copied.'); })
      .catch(() => { if(modal.open && operation === generation) message('Could not copy the transcript.'); });
  };
  preview.oninput = paint;
  const closeModal = (focus: HTMLElement = button): void => {
    // Native `close` is queued. Retire this operation now, not in a late close
    // listener that could steal insertion focus or cancel a newly opened capture.
    cancelOperation(); key.value = ''; preview.value = ''; draft = null;
    if(modal.open)modal.close(); focus.focus();
  };
  close.onclick = () => closeModal();
  modal.addEventListener('cancel', event => { event.preventDefault(); closeModal(); });
  const unsubscribe = api.onDictationEvent(event => {
    if (event.id !== id) return;
    if (event.error) fail(event.error);
    else if (phase === 'transcribing' && typeof event.text === 'string' && event.text.length <= DICTATION.maxTextChars) preview.value = event.text;
  });
  const hidden = (): void => { if (document.hidden && id) fail('Dictation cancelled because its window was hidden.'); };
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('beforeunload', cancelOperation);
  return { cancel: () => { if (id) fail('Dictation cancelled because the draft changed.'); },
    dispose: () => { disposed = true; closeModal(); unsubscribe(); modal.remove(); button.removeEventListener('click', click);
      document.removeEventListener('visibilitychange', hidden); window.removeEventListener('beforeunload', cancelOperation); } };
}
