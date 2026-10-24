import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['rust/crates/cos-patch/differential/ts-oracle.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
    env: {
      // Never bind the shipped bridge range, and never wait long for browser evidence.
      CLF_BRIDGE_PORTS: '0',
      CLF_EVIDENCE_MS: '50'
    }
  }
});
