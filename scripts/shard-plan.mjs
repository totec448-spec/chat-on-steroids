// One shard plan for the unit tests (test/weighted-sequencer.ts) and the UI checks (verify-ui.mjs).
//
// Each item weighs its measured seconds; an item without a measurement weighs the median. Items are
// placed longest first, each into the lightest shard so far (ties: lower shard, then name), so the
// shards end close together and every job that sees the same list computes the same plan.

/** The median of the known weights, or 1 when nothing is known. */
export function fallbackWeight(weights) {
  const known = [...weights.values()].sort((a, b) => a - b);
  return known.length ? known[Math.floor(known.length / 2)] : 1;
}

/** Items, longest first; equal weights by name. */
export function byWeight(items, weights) {
  const fallback = fallbackWeight(weights);
  const weigh = item => weights.get(item) ?? fallback;
  return [...new Set(items)].sort((a, b) => weigh(b) - weigh(a) || (a < b ? -1 : a > b ? 1 : 0));
}

/** Each item's 0-based shard among `count`. */
export function planShards(items, weights, count) {
  const fallback = fallbackWeight(weights);
  const loads = Array.from({ length: Math.max(1, count) }, () => 0);
  const plan = new Map();
  for (const item of byWeight(items, weights)) {
    let lightest = 0;
    for (let index = 1; index < loads.length; index++) if (loads[index] < loads[lightest]) lightest = index;
    loads[lightest] += weights.get(item) ?? fallback;
    plan.set(item, lightest);
  }
  return plan;
}

/** `1/3` style shard (1-based) from an environment value, or null when unset or malformed. */
export function parseShard(value) {
  const match = /^(\d+)\/(\d+)$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const index = Number(match[1]), count = Number(match[2]);
  return index >= 1 && index <= count ? { index, count } : null;
}

/** A `{ name: seconds }` file as a map; unreadable or damaged rows weigh nothing known. */
export function readWeights(text) {
  try {
    const raw = JSON.parse(text);
    return new Map(Object.entries(raw).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0));
  } catch {
    return new Map();
  }
}
