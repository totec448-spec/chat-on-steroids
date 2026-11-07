/**
 * A first-party, informational Goal STOP signal from the Core recorder.
 * It cannot authorize a Stop, run a command, or veto a second helper decision.
 */
import type { SessionEvent } from '../shared/session.js';

type ToolEvent = Extract<SessionEvent, { kind: 'tool_call' }>;

function directTestCommand(event: ToolEvent): string | null {
  const args = event.call.args;
  if (args.truncated || args.text.length > 2048) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(args.text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (typeof row.cmd !== 'string' || row.cmds !== undefined || row.cmd.length > 512) return null;
  const command = row.cmd.trim().replace(/\s+/g, ' ');
  // This only recognizes unambiguous direct tests; it never executes them.
  if (!/^[\w./:\\= +@-]+$/.test(command)) return null;
  return /^(?:npm(?:\.cmd)? (?:test|run (?:test(?::[\w-]+)?|verify(?::[\w-]+)?|typecheck|lint))(?: |$)|(?:npx |npm exec -- )?(?:vitest run|jest|pytest)(?: |$)|python(?:3)? -m pytest(?: |$)|cargo test(?: |$)|go test(?: |$)|dotnet test(?: |$))/.test(command)
    ? command : null;
}

function finishedTestStatus(event: ToolEvent): 'failed' | 'passed' | null {
  const call = event.call;
  if (call.process) {
    if (call.outcome !== 'ok' || call.process.completedAt === undefined || call.process.exitCode == null) return null;
    return call.process.exitCode === 0 || call.process.benignExit === true ? 'passed' : 'failed';
  }
  if (call.outcome === 'process_exit_nonzero') return 'failed';
  if (call.outcome === 'ok') return 'passed';
  return null;
}

function exactOwner(event: ToolEvent, conversationId: string, turnId: string): boolean {
  const call = event.call;
  return event.source === 'mcp' && event.turnId === turnId && call.conversationId === conversationId &&
    call.attribution === 'request_id' && call.attributionMethod === 'request_id' &&
    typeof call.requestId === 'string' && call.requestId.length > 0;
}

/**
 * A later native apply_patch (successful or rejected) invalidates earlier tests.
 * A later *completed* same-command success discharges that failure. Nothing from
 * another chat/turn or an unproven caller may influence this Goal decision.
 * Only boolean evidence leaves the function; no command, path or output is sent.
 */
export function hasFailedNativeGoalTest(
  events: readonly ToolEvent[], conversationId: string, turnId: string
): boolean {
  if (!conversationId || !turnId) return false;
  const tests = new Map<string, 'failed' | 'passed'>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!exactOwner(event, conversationId, turnId)) continue;
    if (event.call.tool === 'apply_patch') {
      tests.clear(); // Anything tested before a subsequent patch is stale.
      continue;      // Patch rejection itself is not a v1 STOP signal.
    }
    if (event.call.tool !== 'exec_command') continue;
    const command = directTestCommand(event);
    if (!command) continue;
    const status = finishedTestStatus(event);
    if (status) tests.set(command, status);
  }
  return [...tests.values()].includes('failed');
}

export const NATIVE_GOAL_TEST_RECONSIDERATION =
  'A first-party Core test command in this exact source turn completed with a nonzero exit. ' +
  'This is evidence of failed verification, not proof that the whole user objective is unfinished. ' +
  'Reconsider your proposed STOP once against the original objective. You may still STOP if the ' +
  'objective was to demonstrate a failing test or otherwise really is complete; otherwise CONTINUE ' +
  'with one concrete safe next step. Do not run tools or repeat the test in this helper.';
