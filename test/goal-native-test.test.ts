import { describe, expect, it } from 'vitest';
import type { SessionEvent, ToolOutcome } from '../src/shared/session.js';
import { hasFailedNativeGoalTest, NATIVE_GOAL_TEST_RECONSIDERATION } from '../src/main/goal-native-test.js';

type ToolEvent = Extract<SessionEvent, { kind: 'tool_call' }>;
const CHAT = 'test-conversation';
const TURN = 'test-source-turn';

function receipt(command: string | null, outcome: ToolOutcome, options: {
  seq?: number; tool?: string; chat?: string | null; turn?: string; requestId?: string | null;
  source?: string; attribution?: string; attributionMethod?: string; truncated?: boolean;
  cmds?: string[]; process?: ToolEvent['call']['process'];
} = {}): ToolEvent {
  const args = JSON.stringify(options.cmds ? { cmds: options.cmds } : command === null ? {} : { cmd: command });
  return {
    kind: 'tool_call', seq: options.seq ?? 1, time: options.seq ?? 1,
    source: options.source ?? 'mcp', turnId: options.turn ?? TURN,
    call: {
      callId: String(options.seq ?? 1), tool: options.tool ?? 'exec_command',
      conversationId: options.chat === undefined ? CHAT : options.chat,
      requestId: options.requestId === undefined ? 'exact-request' : options.requestId,
      attribution: options.attribution ?? 'request_id',
      attributionMethod: options.attributionMethod ?? 'request_id',
      args: { text: args, truncated: options.truncated ?? false, chars: args.length },
      result: { text: 'opaque test output that must remain private', truncated: false, chars: 43 },
      outcome, durationMs: 12, summary: { title: 'Native command', tone: 'neutral' },
      ...(options.process ? { process: options.process } : {})
    }
  } as ToolEvent;
}

const failed = (cmd = 'npm test', seq = 1) => receipt(cmd, 'process_exit_nonzero', { seq });

describe('informational first-party Goal failed-test evidence', () => {
  it('recognizes a completed nonzero native test, but never a plain failed command', () => {
    expect(hasFailedNativeGoalTest([failed()], CHAT, TURN)).toBe(true);
    expect(hasFailedNativeGoalTest([failed('npx vitest run test/a.test.ts')], CHAT, TURN)).toBe(true);
    expect(hasFailedNativeGoalTest([failed('rg needle file')], CHAT, TURN)).toBe(false);
    expect(hasFailedNativeGoalTest([receipt('npm test', 'ok')], CHAT, TURN)).toBe(false);
  });

  it('clears evidence after the latest same-turn apply_patch, regardless of patch outcome', () => {
    for (const outcome of ['ok', 'tool_rejected', 'tool_execution_error'] as const) {
      const patch = receipt(null, outcome, { tool: 'apply_patch', seq: 2 });
      expect(hasFailedNativeGoalTest([patch, failed()], CHAT, TURN)).toBe(false);
      expect(hasFailedNativeGoalTest([patch, failed(), failed('npm test', 3)], CHAT, TURN)).toBe(true);
      expect(hasFailedNativeGoalTest([patch], CHAT, TURN)).toBe(false); // patch failure alone is not v1 evidence
    }
  });

  it('does not let another chat or an unproven patch invalidate our test', () => {
    const outside = receipt(null, 'ok', { seq: 2, tool: 'apply_patch', chat: 'other-chat' });
    const uncertain = receipt(null, 'ok', { seq: 3, tool: 'apply_patch', attribution: 'generation' });
    expect(hasFailedNativeGoalTest([failed(), outside, uncertain], CHAT, TURN)).toBe(true);
  });

  it('later same-command completed success cancels failure; unrelated success does not', () => {
    const other = receipt('npm run test:other', 'ok', { seq: 2 });
    const fixed = receipt('npm test', 'ok', { seq: 3 });
    expect(hasFailedNativeGoalTest([other, failed()], CHAT, TURN)).toBe(true);
    expect(hasFailedNativeGoalTest([fixed, other, failed()], CHAT, TURN)).toBe(false);
  });

  it('requires an exact completed exit for detached tools', () => {
    const pending = receipt('npm test', 'ok', { process: { sessionId: 'a' } });
    const rejected = receipt('npm test', 'tool_rejected', { process: { sessionId: 'a', completedAt: 100, exitCode: 1 } });
    const ended = receipt('npm test', 'ok', { process: { sessionId: 'a', completedAt: 100, exitCode: 1 } });
    const done = receipt('npm test', 'ok', { process: { sessionId: 'a', completedAt: 100, exitCode: 0 } });
    expect(hasFailedNativeGoalTest([pending, rejected], CHAT, TURN)).toBe(false);
    expect(hasFailedNativeGoalTest([ended], CHAT, TURN)).toBe(true);
    expect(hasFailedNativeGoalTest([done], CHAT, TURN)).toBe(false);
    expect(hasFailedNativeGoalTest([failed(), receipt('npm test', 'ok', { seq: 2, process: { sessionId: 'b' } })], CHAT, TURN)).toBe(true);
  });

  it('ignores other conversations, turns, tools, guessed ownership and missing IDs', () => {
    for (const options of [
      { chat: 'other' }, { chat: null }, { turn: 'old' }, { requestId: null },
      { requestId: '' }, { source: 'extension' }, { attribution: 'generation' },
      { attributionMethod: 'unattributed' }, { tool: 'mcp__Other__exec_command' }
    ]) expect(hasFailedNativeGoalTest([receipt('npm test', 'process_exit_nonzero', options)], CHAT, TURN)).toBe(false);
  });

  it('rejects ambiguous shell invocation and truncated arguments', () => {
    for (const call of [failed('npm test && echo done'), failed('npm test | tee log'), failed('npm test; exit 1'),
      receipt('npm test', 'process_exit_nonzero', { truncated: true }),
      receipt(null, 'process_exit_nonzero', { cmds: ['npm test', 'npm run build'] })
    ]) expect(hasFailedNativeGoalTest([call], CHAT, TURN)).toBe(false);
  });

  it('keeps native result text private, leaves Stop a possible answer and sends no new commands', () => {
    expect(NATIVE_GOAL_TEST_RECONSIDERATION).toContain('may still STOP');
    expect(NATIVE_GOAL_TEST_RECONSIDERATION).toContain('Do not run tools');
    expect(NATIVE_GOAL_TEST_RECONSIDERATION).not.toContain('opaque test output');
  });
});
