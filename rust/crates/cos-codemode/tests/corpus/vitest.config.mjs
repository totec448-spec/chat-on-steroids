import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['rust/crates/cos-codemode/tests/corpus/record.test.ts'],
    environment: 'node'
  }
});
