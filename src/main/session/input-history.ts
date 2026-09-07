import type { InputEntry } from './input.js';
import { getSession, observeSessionModel, readAsset, readEvents, upsertMessageEvent, writeAsset } from './store.js';
import { validateInputImages } from './input-images.js';

/** Project a tool handout or proven delivery into history, never the enqueue intent. */
export async function recordDeliveredInput(entry: Readonly<InputEntry>): Promise<boolean> {
  const sessionId = entry.sessionId ?? entry.deliveredSessionId;
  const offered = entry.state === 'tool' && !!entry.owner && Number.isFinite(entry.offeredAt);
  const confirmed = ['sent', 'cancelled'].includes(entry.state) && !!entry.messageId && Number.isFinite(entry.deliveredAt);
  if ((!offered && !confirmed) || !sessionId || entry.purpose === 'decision') return false;
  const messageId = offered ? `input:${entry.id}` : entry.messageId!;
  const time = offered ? entry.offeredAt! : entry.deliveredAt!;
  if (!await getSession(sessionId)) return false;
  const images = entry.images ?? [];
  const text = entry.deliveryText ?? entry.text;
  await validateInputImages(images);
  const assets = [];
  for (const image of images) {
    assets.push(await writeAsset(sessionId, Buffer.from(image.dataUrl.split(',')[1]!, 'base64'), 'image/webp'));
  }
  // Native delivery proves the picker was applied. Tool injection carries future send intent
  // only; a receipt from a replaced frontend is rejected by the session's attachment fence.
  if (!messageId.startsWith('input:') && entry.model && entry.conversationId) {
    await observeSessionModel(sessionId, entry.conversationId, entry.model, entry.deliveredAt!, entry.reasoningEffort ?? undefined);
  }
  await upsertMessageEvent(sessionId, {
    time, source: 'app', kind: 'user_message',
    // Browser delivery uses its exact native key, so a later page echo updates this row.
    // Tool delivery has no native user row and keeps the stable input id as its key.
    messageId, inputId: entry.id, inputDelivery: offered ? 'offered' : 'confirmed', authoredText: entry.text,
    ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
    // Injection does not change the running model. Only the native send path verifies
    // picker selection before delivery; a later sparse browser echo keeps this evidence.
    ...(!messageId.startsWith('input:') && entry.model
      ? { model: entry.model, ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}) }
      : {}),
    message: { text, chars: text.length, truncated: false },
    ...(assets.length ? { assets } : {})
  });
  return true;
}

/** The renderer may load only images actually attached to a user message in this session. */
export async function recordedInputImage(sessionId: string, assetId: string): Promise<string | null> {
  const events = await readEvents(sessionId, { kinds: ['user_message'] });
  const referenced = events.some(event => event.kind === 'user_message' &&
    event.assets?.some(asset => asset.id === assetId && asset.mimeType === 'image/webp'));
  if (!referenced) return null;
  const data = await readAsset(sessionId, assetId);
  if (!data || data.length > 384000) return null;
  const dataUrl = `data:image/webp;base64,${data.toString('base64')}`;
  await validateInputImages([{ name: 'attachment.webp', dataUrl }]);
  return dataUrl;
}
