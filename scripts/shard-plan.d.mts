export function fallbackWeight(weights: ReadonlyMap<string, number>): number;
export function byWeight(items: readonly string[], weights: ReadonlyMap<string, number>): string[];
export function planShards(items: readonly string[], weights: ReadonlyMap<string, number>, count: number): Map<string, number>;
export function shardChecks(found: readonly string[], skip: ReadonlySet<string>, weights: ReadonlyMap<string, number>, shard: { index: number; count: number } | null): string[];
export function parseShard(value: string | undefined | null): { index: number; count: number } | null;
export function readWeights(text: string): Map<string, number>;
