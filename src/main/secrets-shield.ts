/**
 * Hides unmistakable credentials in what a tool call returns to ChatGPT.
 *
 * A command's output, a file the model reads or a search result can carry an API key, a token or a
 * private key, and everything a tool returns becomes part of the chat on OpenAI's side. This masks
 * only values whose shape alone proves what they are (a provider's key prefix and length, a private
 * key block, a JSON Web Token) and the values of settings whose names say they are secrets. It never
 * guesses from randomness: hashes, commit ids, UUIDs and ordinary words stay as they are, so the model
 * loses nothing it needs to do the work.
 *
 * A masked value keeps a short readable marker saying what it was, so the model knows a value is
 * there without seeing it. Only the reply that goes to ChatGPT changes (and the app's record of that
 * reply, which shows what ChatGPT received); files and the terminal keep the real text.
 */

type Kind = 'private key' | 'OpenAI key' | 'Anthropic key' | 'GitHub token' | 'AWS access key' | 'Stripe key' |
  'Slack token' | 'Google API key' | 'JSON Web Token' | 'secret setting';

const marker = (kind: string): string => `[${kind} hidden by Chat On Steroids]`;
const VALUE_MARKER = '[value hidden by Chat On Steroids]';

/** Prefixes and names any maskable value contains; text without one is returned untouched at once. */
const TRIGGER = /sk-|gh[pousr]_|github_pat_|AKIA|ASIA|[sr]k_(?:live|test)_|xox[abprs]-|AIza|eyJ|PRIVATE KEY|(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASS|CREDENTIALS?|AUTH)["']?\s*[:=]/;

/** Each provider's own key shape. Order matters only for overlaps: earlier wins. */
const TOKEN_PATTERNS: ReadonlyArray<readonly [RegExp, Kind]> = [
  [/\bsk-ant-[A-Za-z0-9_-]{32,}/g, 'Anthropic key'],
  [/\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g, 'OpenAI key'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g, 'GitHub token'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 'AWS access key'],
  [/\b[sr]k_(?:live|test)_[0-9a-zA-Z]{24,}\b/g, 'Stripe key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, 'Google API key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'JSON Web Token']
];

/** PEM (`-----BEGIN OPENSSH PRIVATE KEY-----`) and PGP (`-----BEGIN PGP PRIVATE KEY BLOCK-----`) blocks. */
const PRIVATE_KEY = /(-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----)[\s\S]*?(-----END \2PRIVATE KEY\3-----)/g;

/**
 * The start of `NAME=value`, `export NAME="value"`, `NAME: value` or JSON's `"NAME": "value",` on a
 * line of its own, where NAME ends in a word that means a secret. `MAX_TOKENS`, `TOKEN_COUNT` or
 * `PASSWORD_MIN_LENGTH` do not end in one, and a generic `…_KEY` (a sort key, a cache key) is
 * deliberately not on the list. Only the head is a regular expression; the value is cut by hand, so
 * a very long line costs one pass (a lazy value before trailing spaces was quadratic).
 */
const SETTING_HEAD = /^([ \t]*(?:export[ \t]+)?)(["']?)([A-Z][A-Z0-9_]*)\2[ \t]*[:=][ \t]*/;
const SECRET_NAME = /(?:^|_)(?:API_?KEY|SECRET(?:_KEY)?|TOKEN|PASSWORD|PASSWD|PASS|PRIVATE_KEY|ACCESS_KEY(?:_ID)?|SIGNING_KEY|ENCRYPTION_KEY|MASTER_KEY|CLIENT_SECRET|CREDENTIALS?|AUTH_TOKEN)$/;
/**
 * Examples and references are not secrets: an empty value, `${VAR}`, `$VAR`, `<your key>`,
 * `{{ secrets.X }}`, `%VAR%`, `changeme`, `xxxx`. A real value that merely starts with `$` or `<`
 * is still a secret.
 */
const PLACEHOLDER = /^(?:\$\{[^{}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|<[^<>]*>|\{\{[^{}]*\}\}|%[A-Za-z_][A-Za-z0-9_]*%|x{4,}|\*{3,}|change[-_ ]?me|your[-_ a-z]*|example[-_a-z]*|placeholder|todo|none|null|true|false|redacted|\.\.\.)$/i;

/** Secret-named settings, as hits on their values. One pass over the lines. */
function settingHits(text: string): Hit[] {
  const hits: Hit[] = [];
  // "PASS: name" is a test runner's result line (make check, TAP-like logs) only in a test log:
  // two or more result lines, or a "# TOTAL:" summary. A lone "PASS: value" is a setting.
  const testLog = /^# TOTAL: \d/m.test(text) || (text.match(/^(?:PASS|FAIL|XFAIL|XPASS|SKIP|ERROR): \S/gm)?.length ?? 0) >= 2;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    let line = text.slice(lineStart, lineEnd);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    // The head pattern is anchored and short, so even a very long line costs one pass.
    const head = SETTING_HEAD.exec(line);
    if (head && SECRET_NAME.test(head[3]!) && !(testLog && head[3] === 'PASS' && head[0].trimEnd().endsWith(':'))) {
      // The rest of the line, without trailing spaces and one trailing comma (JSON).
      let rest = line.slice(head[0].length).replace(/[ \t]+$/, '');
      if (rest.endsWith(',')) rest = rest.slice(0, -1).replace(/[ \t]+$/, '');
      const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : '';
      const value = quote ? (rest.length >= 2 && rest.endsWith(quote) ? rest.slice(1, -1) : null) : rest;
      // A quoted value may hold the other quote ("hunter2'plus"); an unquoted one that holds a quote
      // is code reading the setting (getenv("TOKEN")), not its value.
      const plain = value !== null && (quote ? !value.includes(quote) : !/["']/.test(value));
      if (value && plain && !PLACEHOLDER.test(value)) {
        const start = lineStart + head[0].length + quote.length;
        hits.push({ start, end: start + value.length, kind: 'secret setting', replacement: VALUE_MARKER });
      }
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  return hits;
}

interface Hit { start: number; end: number; kind: Kind; replacement: string }

/** The text with every recognised credential masked, and what was masked, in order of appearance. */
export function maskSecrets(text: string): { text: string; masked: Kind[] } {
  if (!text || !TRIGGER.test(text)) return { text, masked: [] };
  const hits: Hit[] = [];
  for (const match of text.matchAll(PRIVATE_KEY)) {
    hits.push({ start: match.index!, end: match.index! + match[0].length, kind: 'private key',
      replacement: `${match[1]}\n${marker('private key')}\n${match[4]}` });
  }
  for (const [pattern, kind] of TOKEN_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      hits.push({ start: match.index!, end: match.index! + match[0].length, kind, replacement: marker(kind) });
    }
  }
  // Only a setting's value is replaced; its name and quotes stay so the line still reads as a setting.
  hits.push(...settingHits(text));
  if (!hits.length) return { text, masked: [] };
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = '', at = 0;
  const masked: Kind[] = [];
  for (const hit of hits) {
    if (hit.start < at) continue; // Inside a value already masked (a key inside a private key block).
    out += text.slice(at, hit.start) + hit.replacement;
    at = hit.end;
    masked.push(hit.kind);
  }
  return { text: out + text.slice(at), masked };
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Result = { content: Content[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function maskValue(value: unknown, masked: Kind[]): unknown {
  if (typeof value === 'string') {
    const shielded = maskSecrets(value);
    if (!shielded.masked.length) return value;
    masked.push(...shielded.masked);
    return shielded.text;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map(item => { const out = maskValue(item, masked); if (out !== item) changed = true; return out; });
    return changed ? next : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const out = maskValue(item, masked);
      if (out !== item) changed = true;
      next[key] = out;
    }
    return changed ? next : value;
  }
  return value;
}

/**
 * A tool result as ChatGPT should receive it. Images pass unchanged. The same object comes back when
 * nothing was masked, so the common case allocates nothing.
 */
export function shieldToolResult<T extends Result>(result: T): { result: T; masked: Kind[] } {
  const masked: Kind[] = [];
  let changed = false;
  const content = result.content.map(item => {
    if (item.type !== 'text') return item;
    const shielded = maskSecrets(item.text);
    if (!shielded.masked.length) return item;
    changed = true;
    masked.push(...shielded.masked);
    return { ...item, text: shielded.text };
  });
  // Hosts get the same output twice (text and a structured copy); a value is still one value.
  const alsoStructured: Kind[] = [];
  const structured = result.structuredContent === undefined ? undefined : maskValue(result.structuredContent, alsoStructured);
  if (structured !== result.structuredContent) changed = true;
  for (const kind of new Set(alsoStructured)) {
    const extra = alsoStructured.filter(k => k === kind).length - masked.filter(k => k === kind).length;
    for (let i = 0; i < extra; i++) masked.push(kind);
  }
  if (!changed) return { result, masked };
  return { result: { ...result, content, ...(structured !== undefined ? { structuredContent: structured as Record<string, unknown> } : {}) }, masked };
}
