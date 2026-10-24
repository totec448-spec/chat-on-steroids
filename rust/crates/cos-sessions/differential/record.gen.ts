/**
 * Feeds `ops.json` to the TypeScript session recorder and leaves its `sessions/` tree in
 * `COS_SESSIONS_OUT`. `run.mjs` feeds the same script to the Rust store and compares the trees.
 */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../../../../src/main/config.js';
import { initDurableStore } from '../../../../src/main/durable.js';
import { emptyEvidence } from '../../../../src/main/mcp/call-context.js';
import { flushRecorder, recordToolCall } from '../../../../src/main/session/recorder.js';
import { flushSessions, initSessionStore } from '../../../../src/main/session/store.js';
import type { FileChange, ToolOutcome } from '../../../../src/shared/session.js';

interface Call {
  tool: string;
  nested?: boolean;
  args: unknown;
  text?: string[];
  repeat?: { line: string; count: number };
  image?: string;
  outcome: ToolOutcome;
  startedAt: number;
  durationMs: number;
  count?: number;
  detail?: string;
  process?: { exitCode?: number; running?: boolean; timedOut?: boolean; benignExit?: boolean; durationMs?: number; sessionId?: string };
  changes?: FileChange[];
  manyChanges?: number;
}

export function contentOf(call: Call): Array<{ type: string; text?: string; data?: string; mimeType?: string }> {
  const texts = call.repeat
    ? [Array.from({ length: call.repeat.count }, (_, n) => call.repeat!.line.replace('{n}', String(n + 1))).join('\n')]
    : call.text ?? [];
  return [
    ...texts.map((text) => ({ type: 'text', text })),
    ...(call.image ? [{ type: 'image', data: call.image, mimeType: 'image/png' }] : [])
  ];
}

export function changesOf(call: Call): FileChange[] {
  if (call.manyChanges) {
    return Array.from({ length: call.manyChanges }, (_, index) => ({
      path: `/project/${index}/${'p'.repeat(200)}`, added: 1, removed: 0, approximate: false
    }));
  }
  return call.changes ?? [];
}

const out = process.env.COS_SESSIONS_OUT;

it.runIf(out)('records the operation script', async () => {
  const ops = JSON.parse(readFileSync(new URL('./ops.json', import.meta.url), 'utf8')) as { calls: Call[] };
  initConfigPath(out!);
  initDurableStore(out!);
  initSessionStore(out!);
  await saveConfig(defaultConfig());
  for (const call of ops.calls) {
    await recordToolCall({
      nested: call.nested,
      tool: call.tool,
      args: call.args,
      content: contentOf(call),
      outcome: call.outcome,
      durationMs: call.durationMs,
      startedAt: call.startedAt,
      evidence: {
        ...emptyEvidence(),
        changes: changesOf(call),
        count: call.count ?? null,
        detail: call.detail ?? null,
        exitCode: call.process?.exitCode ?? null,
        running: call.process?.running ?? null,
        timedOut: call.process?.timedOut === true,
        benignExit: call.process?.benignExit === true,
        durationMs: call.process?.durationMs ?? null,
        processSessionId: call.process?.sessionId ?? null
      },
      requestId: null,
      conversationId: null
    });
  }
  await flushRecorder();
  await flushSessions();
  expect(true).toBe(true);
});
