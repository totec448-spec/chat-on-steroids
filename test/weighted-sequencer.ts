/**
 * Test order and CI shards by measured duration (2026-10-31, CI speed-up).
 *
 * Vitest's own shards split the file list by path hash into equal counts, so one shard could get
 * several of the three-minute renderer files while another got none. On a cold CI runner it also
 * orders files by size, so a long file could start last and hold the whole run open.
 *
 * Here every file weighs its seconds from `test-weights.json` (the slowest OS of a recent green
 * run; a file not listed weighs the median). Shards are filled by scripts/shard-plan.mjs, and every
 * run starts its longest files first. Refresh the weights with `node scripts/update-ci-weights.mjs`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { byWeight, planShards, readWeights } from '../scripts/shard-plan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/** Repository-relative, forward slashes: the same key on every OS. */
export function weightKey(moduleId: string): string {
  return path.relative(root, moduleId).split(path.sep).join('/');
}

function loadWeights(): Map<string, number> {
  try { return readWeights(readFileSync(path.join(here, 'test-weights.json'), 'utf8')); } catch { return new Map(); }
}

export default class WeightedSequencer extends BaseSequencer {
  private readonly weights = loadWeights();

  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!;
    const plan = planShards(files.map(spec => weightKey(spec.moduleId)), this.weights, count);
    return files.filter(spec => plan.get(weightKey(spec.moduleId)) === index - 1);
  }

  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const order = byWeight(files.map(spec => weightKey(spec.moduleId)), this.weights);
    const rank = new Map(order.map((key, position) => [key, position]));
    return [...files].sort((a, b) => rank.get(weightKey(a.moduleId))! - rank.get(weightKey(b.moduleId))!);
  }
}
