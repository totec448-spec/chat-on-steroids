/** URLs authored in chat may open in the OS browser/mail app, never as executable schemes. */
export function safeExternalLink(value: string): boolean {
  if (!value || value.length > 8192 || /[\s\\\u0000-\u001f\u007f]/.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (/^https?:\/\//i.test(value)) return Boolean(url.hostname);
    return url.protocol === 'mailto:' && value.toLowerCase().startsWith('mailto:') && Boolean(url.pathname);
  } catch {
    return false;
  }
}
