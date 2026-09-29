/**
 * Recognizable API credentials in authored text, including keys pasted into browser form/code
 * arguments rather than configured as plugin secrets. Do not treat arbitrary long identifiers,
 * hashes or image bytes as credentials: those must survive tool results and exact recordings.
 */
export function redactCredentialText(text: string): string {
  return text.replace(/\bsk-(?:or-v1-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g, '[redacted]');
}

const SECRET_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g, '[redacted]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '[redacted]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[redacted]'],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, '[redacted]'],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted]'],
  [/\b(Authorization:\s*(?:Basic|Bearer|Token))\s+[^\s"']+/gi, '$1 [redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, 'Bearer [redacted]'],
  // A password inside a URL: scheme://user:secret@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[redacted]@'],
  // The secret path segment of one of this app's MCP endpoints.
  [/(\/mcp\/[a-z0-9-]+\/)[A-Za-z0-9_-]{20,}/g, '$1[redacted]']
];

/**
 * For text handed to another process rather than kept: everything `redactCredentialText` masks,
 * plus the credential shapes that turn up in chat and tool text (vendor-prefixed tokens, bearer
 * and basic auth headers, JWTs, URL passwords, private keys, MCP endpoint paths).
 *
 * It is a list of known shapes, not a promise: a password or an unlabelled secret in prose passes
 * through. It is kept apart from `redactCredentialText` because that one guards exact recordings.
 * Like it, this never treats a bare hash or other long identifier as a credential.
 */
export function redactSecretText(text: string): string {
  let out = redactCredentialText(text);
  for (const [pattern, replacement] of SECRET_SHAPES) out = out.replace(pattern, replacement);
  return out;
}
