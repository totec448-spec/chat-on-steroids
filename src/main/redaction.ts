/**
 * Recognizable API credentials in authored text, including keys pasted into browser form/code
 * arguments rather than configured as plugin secrets. Do not treat arbitrary long identifiers,
 * hashes or image bytes as credentials: those must survive tool results and exact recordings.
 */
export function redactCredentialText(text: string): string {
  return text.replace(/\bsk-(?:or-v1-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g, '[redacted]');
}
