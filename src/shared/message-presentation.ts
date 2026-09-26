/** Public presentation metadata. Never contains signed download URLs, tool payloads or reasoning. */
import { safeExternalLink } from './external-link.js';

export interface WebMessageReference {
  index: number;
  type: 'web';
  sources: Array<{ title: string; url: string }>;
}
export interface FileMessageReference {
  index: number;
  type: 'file';
  name: string;
  /** Provider sandbox identity, not a path on this computer. */
  path: string;
  sourceMessageId: string;
}
export type MessageReference = WebMessageReference | FileMessageReference;
export interface MessagePresentation {
  /** Original provider conversation; it must not follow a later Compact & Resume binding. */
  conversationId: string;
  references: MessageReference[];
}
export const MAX_MESSAGE_REFERENCES = 64;
export const MAX_PRESENTATION_BYTES = 48 * 1024;
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const label = (value: unknown, max: number): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

export function providerSandboxPath(value: unknown): value is string {
  return label(value, 1024) && value.startsWith('/mnt/data/') &&
    !value.includes('\\') && !value.includes('?') && !value.includes('#') &&
    value.split('/').every(part => part !== '.' && part !== '..');
}

/** Revalidate every trust boundary, including old/corrupted recordings. Duplicate indexes abstain. */
export function messagePresentation(value: unknown): MessagePresentation | undefined {
  const row = object(value);
  if (!row || typeof row.conversationId !== 'string' || !uuid.test(row.conversationId) ||
      !Array.isArray(row.references) || row.references.length > MAX_MESSAGE_REFERENCES) return undefined;
  const references: MessageReference[] = [], seen = new Set<number>();
  let size = 0;
  for (const raw of row.references) {
    const item = object(raw);
    if (!item || !Number.isSafeInteger(item.index) || (item.index as number) < 0 || (item.index as number) >= MAX_MESSAGE_REFERENCES) return undefined;
    const index = item.index as number;
    if (seen.has(index)) return undefined;
    seen.add(index);
    if (item.type === 'file') {
      if (!label(item.name, 300) || !providerSandboxPath(item.path) ||
          typeof item.sourceMessageId !== 'string' || !uuid.test(item.sourceMessageId)) continue;
      references.push({ index, type: 'file', name: item.name, path: item.path, sourceMessageId: item.sourceMessageId });
    } else if (item.type === 'web' && Array.isArray(item.sources) && item.sources.length <= 8) {
      const sources: WebMessageReference['sources'] = [];
      for (const rawSource of item.sources) {
        const source = object(rawSource);
        if (!source || !label(source.url, 2048) || !/^https?:\/\//i.test(source.url) || !safeExternalLink(source.url)) continue;
        const url = new URL(source.url);
        if (url.username || url.password) continue;
        const title = label(source.title, 300) ? source.title : url.hostname;
        if (!sources.some(s => s.url === source.url)) sources.push({ title, url: source.url });
      }
      if (sources.length) references.push({ index, type: 'web', sources });
    }
    // String length times three bounds UTF-8, including surrogate pairs (four bytes for two units).
    size = JSON.stringify(references).length * 3;
    if (size > MAX_PRESENTATION_BYTES) return undefined;
  }
  return { conversationId: row.conversationId, references };
}
