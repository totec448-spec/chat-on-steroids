import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '..', 'tests', 'oracle');
export const SHIPPED_PATH = path.resolve(here, '..', 'src', 'shipped.json');

/**
 * The long shipped prompts appear in nearly every recorded config. Each one is written once in
 * src/shipped.json and referenced here as "$shipped:<JSON pointer>", which the Rust tests expand.
 */
function shippedStrings(): Map<string, string> {
  const shipped = JSON.parse(readFileSync(SHIPPED_PATH, 'utf8'));
  const table = new Map<string, string>();
  const windows = shipped.firstLaunch.windows;
  for (const key of ['prompt', 'objectivePrompt', 'loopPrompt'] as const) table.set(windows.goal[key], `/firstLaunch/windows/goal/${key}`);
  table.set(windows.compaction.handoffPrompt, '/firstLaunch/windows/compaction/handoffPrompt');
  for (const [list, values] of Object.entries(shipped.superseded as Record<string, string[]>)) {
    values.forEach((value, index) => { if (value.length > 200) table.set(value, `/superseded/${list}/${index}`); });
  }
  return table;
}

function compact(value: unknown, table: Map<string, string>): unknown {
  if (typeof value === 'string') return table.has(value) ? `$shipped:${table.get(value)}` : value;
  if (Array.isArray(value)) return value.map((item) => compact(item, table));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compact(item, table)]));
  }
  return value;
}

/** One JSON document per area, read by the Rust differential tests. */
export function record(area: string, cases: unknown): void {
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, `${area}.json`), `${JSON.stringify(compact(cases, shippedStrings()), null, 2)}\n`, 'utf8');
}

/**
 * File contents: `{ json }` when the bytes are exactly that value written with two-space
 * indentation (the way the app writes it), `{ text }` for other UTF-8, `{ bytes }` otherwise.
 */
export function contents(bytes: Buffer): { json: unknown } | { text: string } | { bytes: number[] } {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return { bytes: [...bytes] };
  try {
    const value = JSON.parse(text);
    if (value !== null && typeof value === 'object' && JSON.stringify(value, null, 2) === text) return { json: value };
  } catch { /* Not JSON: kept as text. */ }
  return { text };
}
