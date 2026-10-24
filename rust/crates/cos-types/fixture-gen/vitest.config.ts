import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import base from '../../../../vitest.config';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');

/** The app's own test files whose writes and HTTP exchanges become fixtures. */
export const HARVESTED_TESTS = [
  'agent-plan', 'agents', 'blocked-chats', 'bridge', 'chat-models', 'config', 'connector-identity',
  'continuation', 'control-api', 'control-api-actions', 'control-api-reads', 'control-api-stream',
  'correlation', 'goal', 'goal-control-race', 'goal-resume-handoff', 'image-recording', 'input-delivery-integration', 'input-startup',
  'main-texts', 'pet-library', 'plugin-refresh', 'plugins-manager', 'projects', 'recorder-final-identity',
  'resume', 'session', 'session-finish', 'session-input', 'session-input-attachments', 'session-usage',
  'swarm', 'task-progress', 'trusted-chats', 'usage-week', 'window-layout'
];

export default defineConfig({
  ...base,
  root: repo,
  test: {
    ...base.test,
    include: [
      ...HARVESTED_TESTS.map((name) => `test/${name}.test.ts`),
      'rust/crates/cos-types/fixture-gen/*.gen.ts'
    ],
    setupFiles: [path.join(here, 'harvest-setup.ts')],
    reporters: ['dot'],
    retry: 0
  }
});
