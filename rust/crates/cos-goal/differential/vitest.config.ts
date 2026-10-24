import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import base from '../../../../vitest.config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  ...base,
  root: path.resolve(here, '../../../..'),
  test: {
    ...base.test,
    include: ['rust/crates/cos-goal/differential/*.gen.ts'],
    reporters: ['dot'],
    retry: 0
  }
});
