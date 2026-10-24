/**
 * Writes what the TypeScript Goal module answers for a fixed corpus to `COS_GOAL_ORACLE`:
 * `humanReply`, `goalErrorMessage`/`goalErrorKey`, `resolveGoalBaseUrl`, `applyGoalSwitch` and
 * `templateGoalDecision`. `cos-goal/tests/oracle.rs` replays the same inputs through the Rust
 * port and compares. Regenerate with `node rust/crates/cos-goal/differential/oracle.mjs`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { on: vi.fn(), getPath: () => '', getVersion: () => '0.0.0', isPackaged: false }, safeStorage: {} }));

const out = process.env.COS_GOAL_ORACLE;

it.runIf(out)('answers the corpus', async () => {
  const goal = await import('../../../../src/main/goal.js');
  const errors = await import('../../../../src/shared/goal-errors.js');
  const templates = await import('../../../../src/shared/goal-templates.js');
  const corpus = JSON.parse(readFileSync(new URL('./corpus.json', import.meta.url), 'utf8')) as {
    replies: string[]; errors: string[]; urls: string[]; templates: Array<[string, number, number]>;
  };
  const result = {
    replies: corpus.replies.map((reply) => goal.humanReply(reply)),
    errors: corpus.errors.map((error) => ({ message: errors.goalErrorMessage(error), key: errors.goalErrorKey(error) })),
    urls: corpus.urls.map((baseUrl) => {
      try { return { ok: goal.resolveGoalBaseUrl({ kind: 'custom', baseUrl }) }; }
      catch (error) { return { error: (error as Error).message }; }
    }),
    templates: corpus.templates.map(([final, slot, second]) => templates.templateGoalDecision(final, slot, second)),
    continuations: templates.GOAL_CONTINUATIONS
  };
  writeFileSync(out!, JSON.stringify(result, null, 2) + '\n');
  expect(result.replies.length).toBe(corpus.replies.length);
});
