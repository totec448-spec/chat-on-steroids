export function fallbackWeight(weights: ReadonlyMap<string, number>): number;
export function byWeight(items: readonly string[], weights: ReadonlyMap<string, number>): string[];
export function planShards(items: readonly string[], weights: ReadonlyMap<string, number>, count: number): Map<string, number>;
export function parseShard(value: string | undefined | null): { index: number; count: number } | null;
export function readWeights(text: string): Map<string, number>;
