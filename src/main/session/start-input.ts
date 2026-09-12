/** Explicit desktop sends bring up the existing connection/browser authorities. */
import { connect, getStatus, onStatusChange } from '../connection.js';
import { startBridge } from '../bridge.js';
import { wakeBrowserUrl, resetBrowserStartupForTests } from '../browser-startup.js';
import { getConfig } from '../config.js';
import { enqueueInput, cancelInput, listInputs, noteInputStartupError, type InputArgs, type InputEntry } from './input.js';

function wakeBrowser(entry: InputEntry, retry = false): Promise<void> {
  const marker = `cos-input=${encodeURIComponent(entry.id)}`;
  return wakeBrowserUrl(entry.conversationId ? `https://chatgpt.com/c/${encodeURIComponent(entry.conversationId)}` : `https://chatgpt.com/?${marker}#${marker}`, retry, getConfig().ui.backgroundChats === true);
}
async function ready(signal?: AbortSignal): Promise<void> {
  await connect();
  signal?.throwIfAborted();
  // startTunnel returns a lifecycle handle before OpenAI /readyz or cloudflared's URL.
  // Await that existing status authority for this operation; never publish input early.
  await new Promise<void>((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => { unsubscribe(); signal?.removeEventListener('abort', abort); reject(new Error('The connector did not become ready. Check its connection status and try again.')); }, 65000);
    timer.unref?.();
    const abort = () => { clearTimeout(timer); unsubscribe(); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    const inspect = () => {
      const status = getStatus();
      if (['starting-server', 'connecting-tunnel', 'offline'].includes(status.state)) return;
      clearTimeout(timer); unsubscribe(); signal?.removeEventListener('abort', abort);
      if (status.state === 'connected') resolve();
      else reject(new Error(status.detail || 'Finish connection setup before sending.'));
    };
    unsubscribe = onStatusChange(inspect); inspect();
  });
  if (!await startBridge()) throw new Error('The browser bridge could not start. Your message has not been queued.');
}
async function deliver(entry: InputEntry, retry = false): Promise<InputEntry> {
  try {
    await wakeBrowser(entry, retry);
    return await noteInputStartupError(entry.id, null) ?? entry;
  } catch (error) {
    return await noteInputStartupError(entry.id, `Message queued. Browser startup failed: ${(error as Error).message}`) ?? entry;
  }
}
// Only in-progress pre-publication work lives here; durable outbox state owns delivery.
const starting = new Map<string, AbortController>();
export async function cancelDesktopInput(id: string): Promise<boolean> {
  const start = starting.get(id);
  if (start) { start.abort(new Error('Input cancelled')); return true; }
  return cancelInput(id);
}
export async function sendDesktopInput(input: InputArgs): Promise<InputEntry> {
  if (input.mode === 'finish') return enqueueInput(input);
  if (starting.has(input.id)) throw new Error('Input already starting');
  const controller = new AbortController(); starting.set(input.id, controller);
  try {
    await ready(controller.signal);
    controller.signal.throwIfAborted();
    const entry = await enqueueInput(input);
    // Cancellation can arrive while the durable enqueue is committing.
    if (controller.signal.aborted) { await cancelInput(input.id); controller.signal.throwIfAborted(); }
    starting.delete(input.id);
    if (entry.state !== 'queued' || entry.attachmentDelivery === 'tool') return entry;
    return deliver(entry);
  } finally { if (starting.get(input.id) === controller) starting.delete(input.id); }
}
export async function retryQueuedInputBrowser(id: string): Promise<InputEntry | null> {
  const eligible = (entry: InputEntry | undefined): entry is InputEntry => !!entry && entry.state === 'queued' && entry.purpose !== 'decision' && !!entry.error?.startsWith('Message queued. Browser startup failed:');
  if (!eligible((await listInputs()).find(entry => entry.id === id))) return null;
  await ready();
  const entry = (await listInputs()).find(row => row.id === id);
  return eligible(entry) ? deliver(entry, true) : null;
}
export function resetInputStartupForTests(): void { resetBrowserStartupForTests(); starting.clear(); }
