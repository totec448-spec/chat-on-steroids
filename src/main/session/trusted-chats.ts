/**
 * Exact ChatGPT conversations the user explicitly trusts while strict chat allowlisting is on.
 *
 * This is deliberately separate from blocked chats. Releasing a block says only that a chat is
 * no longer forcibly stopped; it does not grant access under a default-deny policy. Likewise,
 * Compact & Resume creates a different ChatGPT conversation and does not inherit trust.
 */
import { readDurable, writeDurableSoon } from '../durable.js';

const MAX_TRUSTED_CHATS = 200;
const TRUSTED_STATE = 'trusted-chats';
const TRUSTED_STATE_VERSION = 1;

const trusted = new Set<string>();
let restored = false;

interface PersistedTrustedChats {
  version: number;
  entries: string[];
}

function validConversationId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-z-]{8,64}$/i.test(value);
}

function snapshot(): PersistedTrustedChats {
  return { version: TRUSTED_STATE_VERSION, entries: [...trusted] };
}

export async function restoreTrustedChats(): Promise<void> {
  if (restored) return;
  restored = true;
  const saved = await readDurable<PersistedTrustedChats>(TRUSTED_STATE);
  if (!saved || saved.version !== TRUSTED_STATE_VERSION || !Array.isArray(saved.entries)) return;
  for (const conversationId of saved.entries.slice(0, MAX_TRUSTED_CHATS)) {
    if (validConversationId(conversationId)) trusted.add(conversationId);
  }
}

export function isChatTrusted(conversationId: string | null | undefined): boolean {
  return Boolean(conversationId && trusted.has(conversationId));
}

export function trustedChatIds(): string[] {
  return [...trusted];
}

export function setChatTrusted(conversationId: string, next: boolean): void {
  if (!validConversationId(conversationId)) throw new Error('Not a ChatGPT conversation id');
  if (next === trusted.has(conversationId)) return;
  if (next) {
    if (trusted.size >= MAX_TRUSTED_CHATS) {
      throw new Error(`Too many trusted chats (${MAX_TRUSTED_CHATS}). Untrust one before trusting another.`);
    }
    trusted.add(conversationId);
  } else {
    trusted.delete(conversationId);
  }
  writeDurableSoon(TRUSTED_STATE, snapshot());
}

export function resetTrustedChatsForTests(): void {
  trusted.clear();
  restored = false;
}
