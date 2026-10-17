/**
 * Lowercase without accents ("Prüfung", "café" and "İstanbul" match "prufung", "cafe" and
 * "istanbul") that keeps every character's length, so match offsets in it are offsets in the
 * original. A character whose folded form would change length keeps a same-length form or itself.
 */
export function foldCase(text: string): string {
  return text.replace(/[A-Z]+|[^\x00-\x7f]/gu, chunk => {
    if (chunk.charCodeAt(0) < 0x80) return chunk.toLowerCase();
    const lower = chunk.toLowerCase();
    const base = lower.length === chunk.length ? lower : chunk;
    const bare = base.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
    return bare.length === chunk.length ? bare : base;
  });
}
