import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UnifiedExecProcessManager } from '../src/main/codex/unified-exec.js';

// The OS owns repaint bytes. Control that external boundary, while exercising the real
// manager, unread buffer, collection loop and completion behavior without a native console.
const pty = vi.hoisted(() => ({
  data: null as ((data: string) => void) | null,
  exit: null as ((event: { exitCode: number }) => void) | null
}));
vi.mock('node-pty', () => ({
  default: { spawn: () => ({
    pid: 0,
    onData: (listener: (data: string) => void) => { pty.data = listener; },
    onExit: (listener: (event: { exitCode: number }) => void) => { pty.exit = listener; },
    write: () => {},
    resize: () => {},
    kill: () => { pty.exit?.({ exitCode: 0 }); }
  }) }
}));

let manager: UnifiedExecProcessManager;
const truncationPolicy = { kind: 'tokens' as const, tokens: 10_000 };
beforeEach(() => { pty.data = null; pty.exit = null; manager = new UnifiedExecProcessManager(1_000); });
afterEach(async () => { await manager.terminateAllProcesses(); });

it('drains each PTY chunk once without suppressing a newly emitted screen repaint', async () => {
  const processId = manager.allocateProcessId();
  const started = await manager.execCommand({
    command: ['fixture-pty'], shellType: 'bash', hookCommand: 'controlled terminal stream',
    processId, yieldTimeMs: 1, maxOutputTokens: undefined, truncationPolicy,
    cwd: process.cwd(), displayCwd: '/fixture', env: {}, tty: true
  });
  expect(started.processId).toBe(processId);
  expect(started.rawOutput.toString()).toBe('');
  const poll = () => manager.writeStdin({ processId, input: '', yieldTimeMs: 1,
    maxOutputTokens: undefined, truncationPolicy });

  pty.data!('first=received\r\n');
  expect((await poll()).rawOutput.toString()).toBe('first=received\r\n');
  expect((await poll()).rawOutput.toString()).toBe('');

  const repaint = '\u001b[Hfirst=received\r\nsecond=done\r\n';
  pty.data!(repaint);
  pty.exit!({ exitCode: 0 });
  const finished = await poll();
  expect(finished.rawOutput.toString()).toBe(repaint);
  expect(finished.exitCode).toBe(0);
  expect(finished.replayed).not.toBe(true);
  // Historical rereads remain possible, but are explicitly labelled rather than presented
  // as newly produced output. The live unread cursor above must never read this history.
  const retained = await poll();
  expect(retained.replayed).toBe(true);
  expect(retained.rawOutput.toString()).toBe('first=received\r\n' + repaint);
});
