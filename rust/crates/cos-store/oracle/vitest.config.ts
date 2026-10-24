import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import base from '../../../../vitest.config';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');

export default defineConfig({
  ...base,
  root: repo,
  test: {
    ...base.test,
    include: ['rust/crates/cos-store/oracle/*.oracle.ts'],
    reporters: ['dot'],
    retry: 0,
    fileParallelism: false
  }
});
