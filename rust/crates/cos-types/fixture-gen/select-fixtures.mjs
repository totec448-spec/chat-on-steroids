/**
 * Turns a raw harvest into the committed fixtures.
 *
 * Captures are grouped by kind (a durable file, a session record, an HTTP route), then by
 * shape: the set of key paths a value has, with discriminator values (`kind`, `state`, `type`)
 * folded in. One capture per distinct shape is kept, richest shapes first, up to a cap per kind,
 * so the fixtures cover every variant the tests produced without thousands of near-duplicates.
 *
 * Machine-specific paths (the temp folder, the checkout, the home folder) are rewritten to fixed
 * placeholders, and the result keeps the capture's own JSON.stringify layout.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CAP_PER_KIND = 12;
const CAP_PER_EVENT_KIND = 10;
const CAP_PER_ROUTE = 4;
const CAP_PER_STREAM = 8;
/** Stress captures (megabyte messages, hundred-row ledgers) add bulk, not shapes worth reviewing. */
const MAX_FIXTURE_CHARS = 64 * 1024;
const TEST_ONLY_LEDGERS = new Set(['message-atomicity-race', 'other-ledger']);
const DISCRIMINATORS = new Set(['kind', 'state', 'type', 'outcome', 'role', 'delivery', 'stage']);

function localPrefixes() {
  const prefixes = new Map();
  const add = (value, placeholder) => {
    if (!value) return;
    for (const form of new Set([value, safeRealpath(value)])) {
      prefixes.set(form, placeholder);
      prefixes.set(form.replace(/\\/g, '/'), placeholder.replace(/\\/g, '/'));
    }
  };
  add(os.tmpdir(), process.platform === 'win32' ? 'C:\\Temp' : '/tmp');
  add(path.resolve(fileURLToPath(new URL('../../../../', import.meta.url))), process.platform === 'win32' ? 'C:\\cos' : '/cos');
  add(os.homedir(), process.platform === 'win32' ? 'C:\\Users\\user' : '/home/user');
  // Longest first, so the temp folder inside the home folder wins over the home folder.
  return [...prefixes].sort((a, b) => b[0].length - a[0].length);
}

function safeRealpath(value) {
  try { return realpathSync(value); } catch { return value; }
}

const PREFIXES = localPrefixes();
/** The home folder as plain text and as it appears inside a JSON string. */
const HOME_FORMS = [os.homedir(), JSON.stringify(os.homedir()).slice(1, -1)];

function scrubString(text) {
  let out = text;
  for (const [prefix, placeholder] of PREFIXES) {
    if (!prefix) continue;
    out = out.split(prefix).join(placeholder);
    const lower = prefix.toLowerCase();
    if (lower !== prefix) out = out.split(lower).join(placeholder.toLowerCase());
  }
  return out;
}

/** 2026-01-01T00:00:00.000Z, the one time every wall-clock value in a fixture becomes. */
const FIXED_MS = Date.UTC(2026, 0, 1);
const FIXED_DAY = '2026-01-01';
const isEpochMs = (value) => Number.isInteger(value) && value >= 1e12 && value < 4.1e12;
const isEpochSeconds = (value) => !Number.isInteger(value) && value >= 1e9 && value < 4.1e9;
/** Ports the OS hands out for `listen(0)`; the bridge's fixed ports stay as they are. */
const isEphemeralPort = (value) => Number.isInteger(value) && value >= 32768 && value <= 65535;

/**
 * Clock values, which differ on every harvest even though harvest-setup.ts makes the random ids
 * and temp folder names repeat. Times all become FIXED_MS, because the gaps between them depend
 * on how fast the tests ran.
 */
const TEXT_RULES = [
  [/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, (_, millis) => `${FIXED_DAY}T00:00:00${millis ? '.000' : ''}Z`],
  // Session and handoff ids start with the day they were made.
  [/\b\d{4}-\d\d-\d\d(?=-[0-9a-f]{8}\b)/g, () => FIXED_DAY],
  // `goal-${Date.now().toString(36)}-${random}` (goal.ts).
  [/\bgoal-[0-9a-z]{8,9}-/g, () => `goal-${FIXED_MS.toString(36)}-`],
  // How many keep-alive frames an event stream sent depends on how long it stayed open.
  [/(?:: keep-alive\n\n){2,}/g, () => ': keep-alive\n\n'],
  // Clock milliseconds inside text, such as JSON carried in a string.
  [/(?<![0-9A-Za-z.])(?:1\d{12}|[23]\d{12}|40\d{11})(?![0-9A-Za-z])/g, () => String(FIXED_MS)]
];

/**
 * Values that come from the clock or the OS, by the key that holds them. A `token` can be drawn
 * after a timing-dependent number of retries, so even the seeded generator does not repeat it.
 */
const KEY_RULES = new Map(Object.entries({
  token: (value) => (typeof value === 'string' ? 'T'.repeat(value.length) : value),
  durationMs: () => 0,
  pid: () => 4242,
  port: (value) => (isEphemeralPort(value) ? 49152 : value)
}));

function normalizeText(text) {
  let out = scrubString(text);
  for (const [pattern, replace] of TEXT_RULES) out = out.replace(pattern, replace);
  return out;
}

function normalizeValue(value, key) {
  if (typeof value === 'string') return normalizeText(KEY_RULES.get(key)?.(value) ?? value);
  if (typeof value === 'number') {
    if (isEpochMs(value)) return FIXED_MS;
    if (isEpochSeconds(value)) return FIXED_MS / 1000;
    return KEY_RULES.get(key)?.(value) ?? value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, key));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([name, item]) => [normalizeText(name), normalizeValue(item, name)]);
    // A map from ids to times (`conversationActivityAt`) is ordered by those times. Once they are
    // all FIXED_MS, that order only says how fast the tests ran, so the keys are sorted.
    const timeMap = entries.length > 1 && Object.values(value).every(isEpochMs);
    return Object.fromEntries(timeMap ? entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) : entries);
  }
  return value;
}

/**
 * Rewrites private paths and run-dependent values, and keeps the capture's own layout: compact,
 * or two-space pretty.
 */
function scrubText(text) {
  const pretty = /^[[{]\n {2}/.test(text);
  const value = normalizeValue(JSON.parse(text));
  return { text: pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value), value };
}

function shapeOf(value, prefix = '', into = new Set()) {
  if (Array.isArray(value)) {
    into.add(`${prefix}[]`);
    for (const item of value.slice(0, 50)) shapeOf(item, `${prefix}[]`, into);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const name = /^[0-9a-f-]{16,}$|^\d+$|^[a-z]+_[A-Za-z0-9]{16,}$/i.test(key) ? '*' : key;
      const at = `${prefix}.${name}`;
      into.add(item === null ? `${at}=null` : at);
      if (DISCRIMINATORS.has(key) && typeof item === 'string') into.add(`${at}=${item}`);
      shapeOf(item, at, into);
    }
  }
  return into;
}

/** An event stream's frames as values, so its shape is the events it carried and how it ended. */
function streamFrames(text) {
  return String(text).split('\n\n').filter(Boolean).map((frame) => {
    const lines = frame.split('\n');
    const data = lines.find((line) => line.startsWith('data: '));
    let parsed = null;
    try { parsed = data ? JSON.parse(data.slice(6)) : null; } catch { parsed = 'invalid'; }
    return { type: lines.find((line) => line.startsWith('event: '))?.slice(7) ?? lines[0], data: parsed };
  });
}

function shapeKey(kind, value, request) {
  if (kind === 'ws/wake') return `${value.from}:${value.message}`;
  if (kind.startsWith('sse/')) return [...shapeOf(streamFrames(value.stream))].sort().join('|');
  return [...shapeOf(value)].sort().join('|') + (request ? `||${[...shapeOf(request.value)].sort().join('|')}` : '');
}

function groupKey(kind, capture, value) {
  if (kind === 'session/events' || kind === 'session/message') return `${kind}/${value?.kind ?? 'unknown'}`;
  if (kind.startsWith('http/') || kind.startsWith('sse/')) {
    const route = String(capture.route ?? '').replace(/\/[0-9a-f-]{8,}(?=\/|$)/gi, '/{id}');
    return `${kind}/${capture.method ?? 'GET'} ${route}`;
  }
  return kind;
}

function capFor(group) {
  if (group.startsWith('session/events/') || group.startsWith('session/message/')) return CAP_PER_EVENT_KIND;
  if (group.startsWith('http/')) return CAP_PER_ROUTE;
  if (group.startsWith('sse/')) return CAP_PER_STREAM;
  return CAP_PER_KIND;
}

function fileStem(group) {
  const http = /^(http|sse)\/([^/]+)\/(\S+) (.*)$/.exec(group);
  const name = http ? `${http[1]}/${http[2]}/${http[3]}${http[4].replace(/[\\/]+/g, '_')}` : group;
  return name.replace(/[{}]/g, '').replace(/[^A-Za-z0-9_./-]/g, '-');
}

function* captures(root, relative = '') {
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) yield* captures(root, next);
    else if (entry.name.endsWith('.json')) yield JSON.parse(readFileSync(path.join(root, next), 'utf8'));
  }
}

export function selectFixtures({ harvest, fixtures }) {
  const groups = new Map();
  let seeded = 0;
  for (const capture of captures(path.join(harvest, 'raw'))) {
    if (capture.kind.startsWith('state/') && TEST_ONLY_LEDGERS.has(capture.kind.slice(6))) continue;
    // Inputs a test wrote by hand (legacy versions, damaged values) are loader cases, not app output.
    if (capture.writer === 'test') { seeded += 1; continue; }
    const route = capture.route === undefined ? undefined : normalizeText(String(capture.route));
    const request = capture.request ? (() => { try { return scrubText(capture.request); } catch { return null; } })() : null;
    let scrubbed;
    try { scrubbed = scrubText(capture.text); } catch { continue; }
    const group = groupKey(capture.kind, capture, scrubbed.value);
    const shape = shapeKey(capture.kind, scrubbed.value, request);
    const digest = createHash('sha1').update(route ?? '').update(scrubbed.text).update(request?.text ?? '').digest('hex');
    const bucket = groups.get(group) ?? new Map();
    const held = bucket.get(shape);
    const length = scrubbed.text.length + (request?.text.length ?? 0);
    if (length > MAX_FIXTURE_CHARS) continue;
    // The smallest capture of a shape is the easiest to read and keeps the fixture set small.
    if (!held || length < held.length || (length === held.length && digest < held.digest)) {
      bucket.set(shape, { digest, length, capture, route, scrubbed, request, size: shape.split('|').length, shapeDigest: createHash('sha1').update(shape).digest('hex') });
    }
    groups.set(group, bucket);
  }

  rmSync(fixtures, { recursive: true, force: true });
  const summary = {};
  for (const [group, bucket] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const chosen = [...bucket.values()]
      .sort((a, b) => b.size - a.size || a.shapeDigest.localeCompare(b.shapeDigest))
      .slice(0, capFor(group));
    const stem = fileStem(group);
    mkdirSync(path.join(fixtures, path.dirname(stem)), { recursive: true });
    chosen.forEach((item, index) => {
      const name = `${stem}.${String(index + 1).padStart(2, '0')}`;
      const envelope = item.capture.kind.startsWith('http/')
        ? { method: item.capture.method, route: item.route, status: item.capture.status,
            request: item.request ? item.request.value : null, response: item.scrubbed.value }
        : item.capture.kind.startsWith('sse/')
          ? { method: item.capture.method, route: item.route, status: item.capture.status, stream: item.scrubbed.value.stream }
          : null;
      const text = envelope ? `${JSON.stringify(envelope, null, 2)}\n` : item.scrubbed.text;
      if (HOME_FORMS.some((form) => text.includes(form))) {
        throw new Error(`A private path survived scrubbing in ${name}`);
      }
      writeFileSync(path.join(fixtures, `${name}.json`), text);
    });
    summary[group] = chosen.length;
  }
  summary['(skipped: written by a test, not the app)'] = seeded;
  return summary;
}
