// Turns one recorded exchange into its golden form: every value that changes between launches
// or machines becomes a named placeholder. The rules are listed in rust/golden/README.md; keep
// the two in step.
import { createHash } from 'node:crypto';

const ISO_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const STORE_SESSION = /\b\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\b/g;
const HTTP_DATE = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT\b/g;
const EXEC_SESSION_TEXT = /((?:\bsession(?: ID)?:?|"session_id":|"completed_session_id":)\s*)(\d+)/gi;
const EPOCH_KEY = /(?:At|_at|Time|time|Timestamp|timestamp|^at|^since|^ts|^mtime|^ctime|^modified|^created)$/;
const DURATION_KEY = /^(?:wall_time_seconds|uptimeSeconds|uptime|durationMs|duration_ms|elapsedMs|elapsed_ms|ms|latencyMs|tookMs)$/;
const EXEC_SESSION_KEY = /^(?:session_id|completed_session_id)$/;
// Sizes of recorded text that embeds per-launch ids (chunk and session ids vary in length).
const DERIVED_COUNT_KEY = /^(?:chars|estimatedTokens|contextTokens)$/;
const TEXT_RULES = [
  [/\b(Wall time:?\s*)\d+(?:\.\d+)?/gi, '$1<DURATION>'],
  [/\b\d+(?:\.\d+)?ms\b/g, '<N>ms'],
  [/("wall_time_seconds":)\d+(?:\.\d+)?/g, '$1"<DURATION>"'],
  [/\b(elapsed_ms:\s*)\d+/g, '$1<DURATION>'],
  // A pseudo-terminal sets its window title, which names the shell and whether it is elevated.
  [/(\u001b\]0;)[^\u0007]*(\u0007)/g, '$1<CONSOLE_TITLE>$2'],
  [/(Chunk ID:\s*)[0-9a-f]+/g, '$1<CHUNK_ID>'],
  [/("chunk_id":\s*")[0-9a-f]+"/g, '$1<CHUNK_ID>"']
];

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every spelling a Windows path takes in tool output: native, forward-slashed, JSON-escaped. */
function spellings(native) {
  const forward = native.replace(/\\/g, '/');
  const escaped = native.replace(/\\/g, '\\\\');
  const escapedTwice = native.replace(/\\/g, '\\\\\\\\');
  return [...new Set([escapedTwice, escaped, native, forward])];
}

/**
 * `known` holds the values of this launch: { paths: [[native, placeholder]], secrets: [[value,
 * placeholder]], ports: [[port, placeholder]], numbers: [[value, placeholder]] }. Numbers are
 * replaced under any key, and in text only where a JSON key or the word pid/id precedes them.
 * Exec session ids and store session ids are numbered in order of first sight across the whole
 * variant, so a later case that names an earlier session still matches it.
 */
export function createNormalizer(known) {
  const textRules = [];
  for (const [value, placeholder] of known.secrets ?? []) if (value) textRules.push([new RegExp(escapeRegExp(value), 'g'), placeholder]);
  const pathRules = (known.paths ?? [])
    .filter(([native]) => native)
    .flatMap(([native, placeholder]) => spellings(native).map(spelling => [spelling, placeholder]))
    .sort((a, b) => b[0].length - a[0].length);
  for (const [spelling, placeholder] of pathRules) textRules.push([new RegExp(escapeRegExp(spelling), 'gi'), placeholder]);
  for (const [port, placeholder] of known.ports ?? []) if (port) textRules.push([new RegExp(`((?:127\\.0\\.0\\.1|localhost):|"[A-Za-z]*[pP]ort":\\s*)${port}\\b`, 'g'), `$1${placeholder}`]);
  for (const [value, placeholder] of known.numbers ?? []) {
    if (value) textRules.push([new RegExp(`((?:"[A-Za-z_]+":\\s*|\\b(?:pid|PID|id|hwnd)[ :=#]+))${value}(?![\\d.])`, 'g'), `$1${placeholder}`]);
  }
  const numberPlaceholders = new Map((known.numbers ?? []).filter(([value]) => value).map(([value, placeholder]) => [Number(value), placeholder]));
  const portPlaceholders = new Map((known.ports ?? []).filter(([port]) => port).map(([port, placeholder]) => [Number(port), placeholder]));
  const execSessions = new Map();
  const storeSessions = new Map();
  const ordinal = (map, key, label) => {
    if (!map.has(key)) map.set(key, `<${label}:${map.size + 1}>`);
    return map.get(key);
  };

  return function normalize(value, { volatileImages = false } = {}) {
    const uuids = new Map();
    const text = input => {
      let out = input;
      for (const [pattern, placeholder] of textRules) out = out.replace(pattern, placeholder);
      out = out.replace(ISO_TIME, '<ISO_TIME>').replace(HTTP_DATE, '<HTTP_DATE>');
      for (const [pattern, replacement] of TEXT_RULES) out = out.replace(pattern, replacement);
      out = out.replace(STORE_SESSION, match => ordinal(storeSessions, match, 'SESSION'));
      out = out.replace(EXEC_SESSION_TEXT, (_, prefix, id) => prefix + ordinal(execSessions, Number(id), 'EXEC_SESSION'));
      out = out.replace(UUID, match => ordinal(uuids, match.toLowerCase(), 'UUID'));
      return out;
    };
    const walk = (node, key) => {
      if (typeof node === 'string') {
        if (key === 'data' && node.length > 256 && /^[A-Za-z0-9+/]+=*$/.test(node)) {
          return volatileImages ? '<IMAGE_DATA>' : `<BASE64 sha256:${createHash('sha256').update(node).digest('hex').slice(0, 16)}>`;
        }
        if (key === 'chunk_id') return '<CHUNK_ID>';
        // A timeline metric such as "✓ 395ms" switches unit with magnitude ("✓ 1.4s").
        if (key === 'metric') return text(node).replace(/(?:<N>ms|\b\d+(?:\.\d+)?(?:ms|s|m|h))\b/g, '<DURATION>');
        return text(node);
      }
      if (typeof node === 'number') {
        if (key && DURATION_KEY.test(key)) return '<DURATION>';
        if (key && EPOCH_KEY.test(key) && node >= 1e12 && node < 1e13) return '<EPOCH_MS>';
        if (key && EXEC_SESSION_KEY.test(key)) return ordinal(execSessions, node, 'EXEC_SESSION');
        if (key && DERIVED_COUNT_KEY.test(key)) return `<${key.toUpperCase()}>`;
        // The activity log ring fills with runtime noise, so its length varies between launches.
        if (key === 'ringSize') return '<RING_SIZE>';
        if (key && /^(?:pid|processId|process_id)$/.test(key)) return numberPlaceholders.get(node) ?? '<PID>';
        if (key && /port$/i.test(key)) return portPlaceholders.get(node) ?? '<PORT>';
        if (numberPlaceholders.has(node)) return numberPlaceholders.get(node);
        return node;
      }
      if (Array.isArray(node)) return node.map(item => walk(item, key));
      if (node && typeof node === 'object') {
        const out = {};
        for (const [childKey, child] of Object.entries(node)) out[text(childKey)] = walk(child, childKey);
        return out;
      }
      return node;
    };
    return walk(value, null);
  };
}

/**
 * For bodies whose values are runtime noise by design (the activity log ring): keeps every key
 * and the type of every leaf, and the first array element as the shape of all of them.
 */
export function shapeOf(node) {
  if (Array.isArray(node)) return node.length ? [shapeOf(node[0])] : [];
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, shapeOf(value)]));
  return node === null ? 'null' : `<${typeof node}>`;
}
