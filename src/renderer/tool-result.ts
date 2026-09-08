/** Presentation only. The stored result and overflow asset remain byte-for-byte intact. */
export function toolResultText(text: string, truncated: boolean, hasImages: boolean): string {
  try {
    const value = JSON.parse(text);
    if (value && Array.isArray(value.content)) {
      const readable = value.content.flatMap((block: any) => {
        if (block?.type === 'text' && typeof block.text === 'string') return [block.text];
        if (block?.type === 'resource' && typeof block.resource?.text === 'string') return [block.resource.text];
        return [];
      });
      if (readable.length) return readable.join('\n\n');
      if (value.structuredContent !== undefined) return JSON.stringify(value.structuredContent, null, 2);
      if (hasImages) return '';
    }
  } catch { /* An overflow prefix may end inside a binary field; never paint that payload. */ }
  if (hasImages && truncated) return 'Image result. Full response retained in the recording.';
  return text;
}
