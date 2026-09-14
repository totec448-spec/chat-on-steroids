import type { ChatgptPermissionNotice } from '../shared/chatgpt-permission-notice.js';
import { readDurable, writeDurableNow } from './durable.js';
import { logWarn } from './logger.js';

const key = 'chatgpt-permission-notice';
let record = { requested: false, acknowledged: false };
let revision = 0;
let loaded: Promise<void> | null = null;
let mutation: Promise<unknown> = Promise.resolve();

function load(): Promise<void> {
  return loaded ??= (async () => {
    const saved = await readDurable(key);
    if (saved && typeof saved === 'object') {
      const value = saved as Record<string, unknown>;
      record = { requested: value.requested === true, acknowledged: value.acknowledged === true };
    }
    revision++;
  })();
}

const snapshot = (): ChatgptPermissionNotice => ({ pending: record.requested && !record.acknowledged, revision });

function serialize(action: () => Promise<ChatgptPermissionNotice>): Promise<ChatgptPermissionNotice> {
  const work = mutation.then(action);
  mutation = work.catch(() => undefined);
  return work;
}

export async function getChatgptPermissionNotice(): Promise<ChatgptPermissionNotice> {
  await load();
  return snapshot();
}

/** Called after an explicit model-discovery browser opening succeeds. */
export function requestChatgptPermissionNotice(): Promise<ChatgptPermissionNotice> {
  return serialize(async () => {
    await load();
    if (!record.requested && !record.acknowledged) {
      record = { requested: true, acknowledged: false };
      revision++;
      try { await writeDurableNow(key, record); }
      catch (error) {
        // A failed optional notice save must not invalidate successful model discovery.
        logWarn(`Could not retain the ChatGPT permission notice: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return snapshot();
  });
}

/** Persist dismissal before telling the renderer to close; no provider permission is changed. */
export function acknowledgeChatgptPermissionNotice(): Promise<ChatgptPermissionNotice> {
  return serialize(async () => {
    await load();
    if (!record.acknowledged) {
      const next = { requested: record.requested, acknowledged: true };
      await writeDurableNow(key, next);
      record = next;
      revision++;
    }
    return snapshot();
  });
}

export function resetChatgptPermissionNoticeForTests(): void {
  record = { requested: false, acknowledged: false };
  revision = 0;
  loaded = null;
  mutation = Promise.resolve();
}
