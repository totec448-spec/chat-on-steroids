import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/exec-hints.test.ts',
      'test/exec-shell-regressions.test.ts',
      'test/exec-completed-results.test.ts'
    ],
    setupFiles: ['rust/crates/cos-exec/differential/record.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    env: {
      CLF_BRIDGE_PORTS: '0',
      CLF_EVIDENCE_MS: '1500'
    }
  }
});
