import type { InputEntry } from './input.js';
import { browserInputModel } from '../../shared/input.js';
import { getSession, observeSessionModel, readAsset, readEvents, upsertMessageEvent, writeAsset } from './store.js';
import { validateInputImages } from './input-images.js';
import sharp from 'sharp';

/** Project a tool handout or proven delivery into history, never the enqueue intent. */
export async function recordDeliveredInput(entry: Readonly<InputEntry>): Promise<boolean> {
  const sessionId = entry.sessionId ?? entry.deliveredSessionId;
  const offered = entry.state === 'tool' && !!entry.owner && Number.isFinite(entry.offeredAt);
  const confirmed = ['sent', 'cancelled'].includes(entry.state) && !!entry.messageId && Number.isFinite(entry.deliveredAt);
  if ((!offered && !confirmed) || !sessionId || entry.purpose === 'decision') return false;
  const messageId = offered ? `input:${entry.id}` : entry.messageId!;
  const time = offered ? entry.offeredAt! : entry.deliveredAt!;
  if (!await getSession(sessionId)) return false;
  const images = [...entry.images ?? [], ...entry.toolImages ?? []];
  const text = entry.deliveryText ?? entry.text;
  await validateInputImages(images);
  const assets = [];
  for (const image of images) {
    assets.push(await writeAsset(sessionId, Buffer.from(image.dataUrl.split(',')[1]!, 'base64'), 'image/webp'));
  }
  // Only an explicit native picker request proves model selection. Finish tasks
  // inherit the page model, so their old queued settings cannot become evidence.
  const selection = browserInputModel(entry);
  if (!messageId.startsWith('input:') && selection.model && entry.conversationId) {
    await observeSessionModel(sessionId, entry.conversationId, selection.model, entry.deliveredAt!, selection.reasoningEffort ?? undefined);
  }
  await upsertMessageEvent(sessionId, {
    time, source: 'app', kind: 'user_message',
    // Browser delivery uses its exact native key, so a later page echo updates this row.
    // Tool delivery has no native user row and keeps the stable input id as its key.
    messageId, inputId: entry.id, inputDelivery: offered ? 'offered' : 'confirmed', authoredText: entry.text,
    ...(entry.attachments?.length && entry.attachmentDelivery !== 'tool' ? { attachments: entry.attachments } : {}),
    // Injection does not change the running model. Only the native send path verifies
    // picker selection before delivery; a later sparse browser echo keeps this evidence.
    ...(!messageId.startsWith('input:') && selection.model
      ? { model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }
      : {}),
    message: { text, chars: text.length, truncated: false },
    ...(assets.length ? { assets } : {})
  });
  return true;
}

/** Recorded membership, not a supplied filename, grants the renderer image access. */
export async function recordedInputImage(sessionId: string, assetId: string): Promise<string | null> {
  const events = await readEvents(sessionId, { kinds: ['user_message', 'tool_call'] });
  const referenced = events.flatMap(event => event.kind === 'user_message' ? event.assets ?? [] :
    event.kind === 'tool_call' ? event.call.assets ?? [] : [])
    .find(asset => asset.id === assetId && ['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType));
  if (!referenced) return null;
  const data = await readAsset(sessionId, assetId, 16 * 1024 * 1024);
  if (!data) return null;
  try {
    const image = sharp(data, { limitInputPixels: 36000000 });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || `image/${metadata.format}` !== referenced.mimeType) return null;
    // Decode fully before any bytes reach the renderer; metadata alone accepts broken images.
    await image.stats();
    return `data:${referenced.mimeType};base64,${data.toString('base64')}`;
  } catch { return null; }
}
