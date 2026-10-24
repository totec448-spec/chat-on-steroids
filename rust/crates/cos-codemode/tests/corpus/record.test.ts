// Records corpus.json from the TypeScript runtime. From the repository root:
//   npx vitest run --config rust/crates/cos-codemode/tests/corpus/vitest.config.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { CODE_MODE_LIMITS, runCodeMode } from '../../../../../src/main/mcp/code-mode-runtime.js';
import type { ToolResult } from '../../../../../src/main/mcp/kernel.js';
import { cases, fixtures, tools } from './cases.mjs';

it('records every corpus case through runCodeMode', async () => {
  const recorded = [];
  for (const entry of cases) {
    const calls: Array<[string, unknown]> = [];
    const invoke = async (name: string, args: unknown): Promise<ToolResult> => {
      calls.push([name, args]);
      return await (fixtures as Record<string, (args: any) => Promise<ToolResult>>)[name]!(args);
    };
    const limits = { ...CODE_MODE_LIMITS, ...(entry.limits ?? {}) };
    const result = await runCodeMode(entry.code, tools, invoke, limits, { windowsDesktop: entry.windowsDesktop === true });
    // Children a script did not await still run under their own owner; let them finish so a
    // case's calls are complete before the next case starts.
    await new Promise(resolve => setTimeout(resolve, 700));
    recorded.push({ ...entry, result, calls });
  }
  const file = fileURLToPath(new URL('./corpus.json', import.meta.url));
  writeFileSync(file, JSON.stringify({ tools, cases: recorded }, null, 1) + '\n');
  expect(recorded).toHaveLength(cases.length);
}, 120_000);
