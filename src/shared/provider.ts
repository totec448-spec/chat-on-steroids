/**
 * Shared provider definitions, canonical conversation IDs, and URL helpers for
 * supported web chat targets (`chatgpt` and `gemini`).
 */

export const CHAT_PROVIDERS = ['chatgpt', 'gemini'] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

const CHATGPT_ID_RE = /^[0-9a-f-]{8,64}$/i;
const LEGACY_ALNUM_ID_RE = /^[0-9a-z-]{8,64}$/i;
const LEGACY_WIDE_ID_RE = /^[0-9a-z-]{8,256}$/i;
const GEMINI_ID_RE = /^gemini-[A-Za-z0-9_-]{4,56}$/;
const GEMINI_SLUG_RE = /^[A-Za-z0-9_-]{4,56}$/;
const GEMINI_URL_SLUG_RE = /^[A-Za-z0-9_-]{8,56}$/;
const GEMINI_RESERVED_SLUGS = new Set([
  'app',
  'apps',
  'auth',
  'download',
  'edit',
  'extensions',
  'faq',
  'gem',
  'gems',
  'help',
  'login',
  'logout',
  'new',
  'saved-info',
  'scheduled',
  'settings',
  'share',
  'updates',
  'workspace'
]);

export function isChatProvider(value: unknown): value is ChatProvider {
  return value === 'chatgpt' || value === 'gemini';
}

export function isChatGptConversationId(value: unknown): value is string {
  return typeof value === 'string' && CHATGPT_ID_RE.test(value);
}

export function isGeminiConversationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    GEMINI_ID_RE.test(value) &&
    !GEMINI_RESERVED_SLUGS.has(value.slice('gemini-'.length).toLowerCase())
  );
}

export function isValidConversationId(value: unknown): value is string {
  return isChatGptConversationId(value) || isGeminiConversationId(value);
}

/**
 * Accepts canonical ChatGPT UUIDs, canonical `gemini-*` ids, and legacy test/store alphanumeric ids.
 * @param wide Allow up to 256 chars where callers historically accepted longer ids.
 */
export function isAcceptedConversationId(value: unknown, wide = false): value is string {
  if (typeof value !== 'string') return false;
  if (isGeminiConversationId(value)) return true;
  return wide ? LEGACY_WIDE_ID_RE.test(value) : LEGACY_ALNUM_ID_RE.test(value);
}

export function providerForConversationId(value: unknown): ChatProvider | null {
  if (isGeminiConversationId(value)) return 'gemini';
  if (isChatGptConversationId(value)) return 'chatgpt';
  return null;
}

export function geminiSlugFromConversationId(conversationId: string): string | null {
  if (!isGeminiConversationId(conversationId)) return null;
  return conversationId.slice('gemini-'.length);
}

export function toGeminiConversationId(rawSlug: unknown): string | null {
  if (typeof rawSlug !== 'string') return null;
  const trimmed = rawSlug.trim();
  if (GEMINI_ID_RE.test(trimmed)) return trimmed;
  if (GEMINI_SLUG_RE.test(trimmed) && !GEMINI_RESERVED_SLUGS.has(trimmed.toLowerCase())) {
    return `gemini-${trimmed}`;
  }
  return null;
}

export function homeUrlForProvider(provider: ChatProvider = 'chatgpt'): string {
  return provider === 'gemini' ? 'https://gemini.google.com/app' : 'https://chatgpt.com/';
}

export function conversationUrl(conversationId: string): string {
  const geminiSlug = geminiSlugFromConversationId(conversationId);
  if (geminiSlug) {
    return `https://gemini.google.com/app/${encodeURIComponent(geminiSlug)}`;
  }
  return `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`;
}

export function inputBrowserUrl(options: {
  id: string;
  conversationId?: string | null;
  provider?: ChatProvider | null;
  temporary?: boolean;
}): string {
  if (options.conversationId) return conversationUrl(options.conversationId);
  const marker = `cos-input=${encodeURIComponent(options.id)}`;
  if (options.provider === 'gemini') {
    return `${homeUrlForProvider('gemini')}?${marker}#${marker}`;
  }
  const query = options.temporary ? `temporary-chat=true&${marker}` : marker;
  return `${homeUrlForProvider('chatgpt')}?${query}#${marker}`;
}

export function isGeminiHost(hostname: string): boolean {
  return hostname === 'gemini.google.com';
}

export function isChatGptHost(hostname: string): boolean {
  return hostname === 'chatgpt.com' || hostname === 'chat.openai.com';
}

export function providerForUrl(value: unknown): ChatProvider | null {
  try {
    const parsed = new URL(String(value ?? ''));
    if (parsed.protocol !== 'https:') return null;
    if (isGeminiHost(parsed.hostname)) return 'gemini';
    if (isChatGptHost(parsed.hostname)) return 'chatgpt';
    return null;
  } catch {
    return null;
  }
}

export function conversationFromUrl(
  value: unknown
): { provider: ChatProvider; conversationId: string; rawId: string } | null {
  try {
    const parsed = new URL(String(value ?? ''));
    if (parsed.protocol !== 'https:') return null;

    if (isChatGptHost(parsed.hostname)) {
      const match = /^\/(?:g\/[^/]+\/)?c\/([0-9a-f-]{8,64})(?:\/|$)/i.exec(parsed.pathname);
      const rawId = match?.[1];
      if (!rawId) return null;
      return { provider: 'chatgpt', conversationId: rawId, rawId };
    }

    if (isGeminiHost(parsed.hostname)) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      const start = parts[0] === 'u' && /^\d+$/.test(parts[1] ?? '') ? 2 : 0;
      const tail = parts.slice(start);
      let rawSlug: string | undefined;
      if (tail[0] === 'app' && tail.length === 2) {
        rawSlug = tail[1];
      } else if (tail[0] === 'gem' && tail.length === 3) {
        rawSlug = tail[2];
      }
      if (rawSlug && GEMINI_URL_SLUG_RE.test(rawSlug) && !GEMINI_RESERVED_SLUGS.has(rawSlug.toLowerCase())) {
        return { provider: 'gemini', conversationId: `gemini-${rawSlug}`, rawId: rawSlug };
      }
      return null;
    }

    return null;
  } catch {
    return null;
  }
}
